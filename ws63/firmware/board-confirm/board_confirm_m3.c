/*
 * M3 · WS63 近场确认器（SFC1 串口版，2026-11-04）
 *
 * 数据流：
 *   PC --USB-UART(UART0, 115200)--> CHALLENGE(SFC1) --> 本机
 *   本机 OLED 显示 动作/摘要/TTL --> KEY2 短按=批准、长按=取消
 *   本机 --> DECISION(SFC1, HMAC-SHA256) --> PC
 *
 * 与 PC 侧约定（必须逐字节一致）：
 *   - 帧格式/字段顺序：ws63/protocol.h（同一份源码）
 *   - PSK：DEMO_KEY（演示密钥，真实部署必须换）
 *   - device_id：SHA-256("safe-office/ws63/device-id/v1\0" + "ws63-A") 前 8 字节
 *
 * 边界：
 *   - 本固件不含距离/身份证明，只证明"持有 PSK 的确认端对这条内容按了确认"
 *   - 板上无 RTC：用本地毫秒时钟推进 TTL（接收时按 expires_at-issued_at 换算）
 *   - OLED 字体只保证 ASCII 可读；摘要含中文时显示会退化为占位符
 */
#include "stdio.h"
#include "string.h"
#include "securec.h"
#include "soc_osal.h"
#include "i2c.h"
#include "pinctrl.h"
#include "gpio.h"
#include "cmsis_os2.h"
#include "platform_core_rom.h"
#include "uart.h"
#include "hal_bsp_oled/hal_bsp_ssd1306.h"
#include "app_init.h"
#include "protocol.h"
#include "sfc1_hmac.h"
#include "sfc1_nv.h"
#include "sfc1_key_store.h"
#include "sfc1_provision.h"

osThreadId_t task1_ID;

#define POLL_MS        10
#define LONG_PRESS_MS  600
#define DEBOUNCE_N     2
#define RX_RING_SIZE   1024
#define UART_BAUD      115200
#define MAX_TTL_SEC    300u

/* 执行输出：IO13 板载 LED、IO10 蜂鸣器、IO12 继电器（驱动锁体；未接线时只翻转电平） */
#define PIN_LED        GPIO_13
#define PIN_BUZZER     GPIO_10
#define PIN_RELAY      GPIO_12

/* 演示 PSK：与 PC 侧 --demo-key 对应；真实部署必须改为每台设备独立密钥 */
static const uint8_t DEMO_KEY[SFC1_KEY_LEN] = {
    0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42,
    0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42,
    0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42,
    0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42,
};
#define DEVICE_LABEL "ws63-A"

static uint8_t g_device_id[SFC1_DEVICE_ID_LEN];

/* 一机一钥（docs/60）：NV 里有 key 就用它；没有则回落到演示 key，并打开配网窗口 */
static uint8_t g_key[SFC1_KEY_LEN];
static int g_provisioned;
static sfc1_prov_t g_prov;
#define PROV_WINDOW_MS (10ULL * 60ULL * 1000ULL)

/* ---------------- UART 接收环形缓冲 ---------------- */
static uint8_t g_rx_ring[RX_RING_SIZE];
static volatile uint32_t g_rx_head;
static volatile uint32_t g_rx_tail;
static uint8_t g_uart_dma_buf[512];

static void uart_rx_cb(const void *buffer, uint16_t length, bool error)
{
    const uint8_t *p = (const uint8_t *)buffer;
    uint16_t i;

    if (error || p == NULL) {
        return;
    }
    for (i = 0; i < length; i++) {
        uint32_t next = (g_rx_head + 1u) % RX_RING_SIZE;
        if (next == g_rx_tail) {
            break; /* 满：丢新字节，等任务消费 */
        }
        g_rx_ring[g_rx_head] = p[i];
        g_rx_head = next;
    }
}

static int uart_ring_pop(uint8_t *out)
{
    if (g_rx_tail == g_rx_head) {
        return 0;
    }
    *out = g_rx_ring[g_rx_tail];
    g_rx_tail = (g_rx_tail + 1u) % RX_RING_SIZE;
    return 1;
}

/* ---------------- 帧组装 ---------------- */
static uint8_t g_frame[PROTO_CHALLENGE_MAX + 1u];
static uint16_t g_frame_len;
static uint16_t g_frame_need;

/* ---------------- 待确认任务 ---------------- */
typedef struct {
    int active;
    uint8_t task_id[PROTO_TASK_ID_LEN];
    uint8_t nonce[PROTO_NONCE_LEN];
    uint8_t action;
    uint8_t target_hash[PROTO_HASH_LEN];
    char summary[PROTO_SUMMARY_MAX + 1];
    uint8_t summary_len;
    uint64_t deadline_ms;
} pending_t;

static pending_t g_pending;

/* 已消费 nonce 的环形窗口（重放拒绝） */
static uint8_t g_used[PROTO_REPLAY_WINDOW][PROTO_NONCE_LEN];
static uint8_t g_used_count;
static uint8_t g_used_next;

static int nonce_used(const uint8_t nonce[PROTO_NONCE_LEN])
{
    uint8_t i;
    for (i = 0; i < g_used_count; i++) {
        if (memcmp(g_used[i], nonce, PROTO_NONCE_LEN) == 0) {
            return 1;
        }
    }
    return 0;
}

static void mark_used(const uint8_t nonce[PROTO_NONCE_LEN])
{
    memcpy(g_used[g_used_next], nonce, PROTO_NONCE_LEN);
    g_used_next = (uint8_t)((g_used_next + 1u) % PROTO_REPLAY_WINDOW);
    if (g_used_count < PROTO_REPLAY_WINDOW) {
        g_used_count++;
    }
    /* M1：窗口落 NV，重启后仍能拒绝旧 nonce；写失败只告警，不阻断确认流程。
     * 注意必须用当前生效的 g_key（一机一钥后会与 DEMO_KEY 不同），否则重启时加载校验必失败。 */
    if (sfc1_nv_save(g_used, g_used_count, g_key) != 0) {
        printf("SFC1 NV: save failed\r\n");
    }
}

static uint64_t now_ms(void)
{
    return (uint64_t)osKernelGetTickCount() * 1000ULL / osKernelGetTickFreq();
}

/* ---------------- OLED ---------------- */
#define OLED_LINE_CHARS 20

static void oled_clear_line(void)
{
    ssd1306_cls();
}

/* 只保留可打印 ASCII；非 ASCII 用 '?' 占位（字体不含中文） */
static void ascii_only(char *dst, size_t cap, const char *src, size_t src_len)
{
    size_t i;
    size_t out = 0;

    if (cap == 0) {
        return;
    }
    for (i = 0; i < src_len && out + 1u < cap && out < OLED_LINE_CHARS; i++) {
        unsigned char c = (unsigned char)src[i];
        dst[out++] = (c >= 0x20u && c < 0x7fu) ? (char)c : '?';
    }
    dst[out] = '\0';
}

static const char *action_label(uint8_t action)
{
    switch (action) {
        case PROTO_ACTION_SEND_EXTERNAL: return "SEND EXT";
        case PROTO_ACTION_DELETE:        return "DELETE";
        case PROTO_ACTION_PRINT:         return "PRINT";
        case PROTO_ACTION_DEVICE:        return "DEVICE";
        default:                         return "ACTION";
    }
}

static void show_idle(void)
{
    oled_clear_line();
    ssd1306_show_str(OLED_TEXT16_COLUMN_0, OLED_TEXT16_LINE_0, "WS63 CONFIRM", TEXT_SIZE_16);
    ssd1306_show_str(OLED_TEXT16_COLUMN_0, OLED_TEXT16_LINE_1, "WAITING", TEXT_SIZE_16);
    ssd1306_show_str(OLED_TEXT16_COLUMN_0, OLED_TEXT16_LINE_2, "SFC1 115200 8N1", TEXT_SIZE_8);
    ssd1306_show_str(OLED_TEXT16_COLUMN_0, OLED_TEXT16_LINE_3, "PC -> CHALLENGE", TEXT_SIZE_8);
}

static void show_result(const char *status)
{
    oled_clear_line();
    ssd1306_show_str(OLED_TEXT16_COLUMN_0, OLED_TEXT16_LINE_0, "WS63 CONFIRM", TEXT_SIZE_16);
    ssd1306_show_str(OLED_TEXT16_COLUMN_0, OLED_TEXT16_LINE_1, (char *)status, TEXT_SIZE_16);
}

/* 未配置：显示一次性配网码（docs/60） */
static void show_pairing(const char *code)
{
    oled_clear_line();
    ssd1306_show_str(OLED_TEXT16_COLUMN_0, OLED_TEXT16_LINE_0, "WS63 PROVISION", TEXT_SIZE_16);
    ssd1306_show_str(OLED_TEXT16_COLUMN_0, OLED_TEXT16_LINE_1, "PAIR CODE", TEXT_SIZE_8);
    ssd1306_show_str(OLED_TEXT16_COLUMN_0, OLED_TEXT16_LINE_2, (char *)code, TEXT_SIZE_16);
}

static void show_challenge(const pending_t *p)
{
    char line[OLED_LINE_CHARS + 1];
    char hint[24];
    uint64_t left_ms = p->deadline_ms > now_ms() ? p->deadline_ms - now_ms() : 0;

    oled_clear_line();
    ssd1306_show_str(OLED_TEXT16_COLUMN_0, OLED_TEXT16_LINE_0, "WS63 CONFIRM", TEXT_SIZE_16);
    ssd1306_show_str(OLED_TEXT16_COLUMN_0, OLED_TEXT16_LINE_1, (char *)action_label(p->action), TEXT_SIZE_16);
    ascii_only(line, sizeof(line), p->summary, p->summary_len);
    ssd1306_show_str(OLED_TEXT16_COLUMN_0, OLED_TEXT16_LINE_2, line, TEXT_SIZE_8);
    (void)sprintf_s(hint, sizeof(hint), "OK:SHORT NO:LONG %us", (unsigned)(left_ms / 1000u));
    ssd1306_show_str(OLED_TEXT16_COLUMN_0, OLED_TEXT16_LINE_3, hint, TEXT_SIZE_8);
}

/* ---------------- 决策 ---------------- */
static void send_decision(int approve)
{
    proto_decision_t d;
    uint8_t out[PROTO_DECISION_MAX];
    size_t n;

    if (!g_pending.active) {
        return;
    }
    (void)memset_s(&d, sizeof(d), 0, sizeof(d));
    (void)memcpy_s(d.task_id, sizeof(d.task_id), g_pending.task_id, PROTO_TASK_ID_LEN);
    (void)memcpy_s(d.nonce, sizeof(d.nonce), g_pending.nonce, PROTO_NONCE_LEN);
    d.decision = approve ? 1u : 0u;
    (void)memcpy_s(d.device_id, sizeof(d.device_id), g_device_id, SFC1_DEVICE_ID_LEN);
    d.decided_at = (uint32_t)(now_ms() / 1000u);

    n = proto_encode_decision(&d, out, sizeof(out), sfc1_hmac_sha256, (void *)g_key);
    if (n == 0) {
        printf("SFC1 encode decision failed\r\n");
        return;
    }
    (void)uapi_uart_write(UART_BUS_0, out, (uint32_t)n, 0);

    mark_used(g_pending.nonce);
    g_pending.active = 0;
    printf("SFC1 decision=%u sent (%u bytes)\r\n", (unsigned)d.decision, (unsigned)n);
    show_result(approve ? "APPROVED" : "CANCELLED");
}

/* 配网恢复探活（docs/60 复核问题 2）：PING(0x20) -> PONG(0x21)，用当前设备密钥验签/签名。
 * 回执丢失后主机用它确认"板子到底有没有写进这把钥匙"，不依赖配网窗口。 */
static void handle_ping(const uint8_t *frame, size_t len)
{
    uint8_t expected[32];
    uint8_t mac[32];
    uint8_t out[10 + 24 + 32];

    if (!g_provisioned || len != (size_t)(10 + 16 + 32)) {
        return;
    }
    if (sfc1_hmac_sha256(frame, len - 32, expected, (void *)g_key) != 0) {
        return;
    }
    if (memcmp(expected, frame + len - 32, 32) != 0) {
        printf("SFC1 PING rejected: MAC\r\n");
        return;
    }
    out[0] = 'S'; out[1] = 'F'; out[2] = 'C'; out[3] = '1';
    out[4] = 1; out[5] = 0x21; out[6] = 0; out[7] = 0;
    out[8] = (uint8_t)(24 + 32); out[9] = 0;
    (void)memcpy_s(out + 10, sizeof(out) - 10, g_device_id, SFC1_DEVICE_ID_LEN);
    (void)memcpy_s(out + 18, sizeof(out) - 18, frame + 10, 16);
    if (sfc1_hmac_sha256(out, 34, mac, (void *)g_key) != 0) {
        return;
    }
    (void)memcpy_s(out + 34, sizeof(out) - 34, mac, 32);
    (void)uapi_uart_write(UART_BUS_0, out, (uint32_t)sizeof(out), 0);
}

/* ---------------- 挑战处理 ---------------- */
/* ---------------- 执行帧（GPIO，2026-11-04） ---------------- */
/* 允许的输出：IO13 LED、IO10 蜂鸣器、IO12 继电器（锁体，docs/68） */
static int actuator_pin_allowed(uint8_t pin)
{
    return pin == (uint8_t)PIN_LED || pin == (uint8_t)PIN_BUZZER || pin == (uint8_t)PIN_RELAY;
}

static void show_device(uint8_t pin, uint8_t level)
{
    char line[24] = {0};
    ssd1306_cls();
    ssd1306_show_str(OLED_TEXT16_COLUMN_0, OLED_TEXT16_LINE_0, "WS63 DEVICE", TEXT_SIZE_16);
    if (sprintf_s(line, sizeof(line), "IO%u = %s", (unsigned)pin, level ? "ON" : "OFF") > 0) {
        ssd1306_show_str(OLED_TEXT16_COLUMN_0, OLED_TEXT16_LINE_2, line, TEXT_SIZE_16);
    }
    ssd1306_show_str(OLED_TEXT16_COLUMN_0, OLED_TEXT16_LINE_3, "after approval", TEXT_SIZE_8);
}

static void handle_actuator(const uint8_t *frame, size_t len)
{
    proto_actuator_t act;
    proto_actuator_ack_t ack;
    uint8_t out[PROTO_HEADER_LEN + PROTO_ACTUATOR_ACK_PAYLOAD_LEN + PROTO_MAC_LEN];
    size_t out_len;
    int rc;

    rc = proto_decode_actuator(frame, len, &act, sfc1_hmac_sha256, (void *)g_key);
    if (rc != PROTO_OK) {
        printf("SFC1 actuator rejected: %s\r\n", proto_status_str(rc));
        return;
    }
    if (!actuator_pin_allowed(act.pin)) {
        printf("SFC1 actuator rejected: PIN\r\n");
        return;
    }
    if (nonce_used(act.nonce)) {
        printf("SFC1 actuator rejected: REPLAY\r\n");
        return;
    }
    mark_used(act.nonce);

    uapi_pin_set_mode((pin_t)act.pin, HAL_PIO_FUNC_GPIO);
    uapi_gpio_set_dir((pin_t)act.pin, GPIO_DIRECTION_OUTPUT);
    uapi_gpio_set_val((pin_t)act.pin, act.level ? GPIO_LEVEL_HIGH : GPIO_LEVEL_LOW);
    /* 继电器动作时用板载 LED 做同状态指示，现场不接锁也能看到执行结果 */
    if ((uint8_t)act.pin == (uint8_t)PIN_RELAY) {
        uapi_pin_set_mode(PIN_LED, HAL_PIO_FUNC_GPIO);
        uapi_gpio_set_dir(PIN_LED, GPIO_DIRECTION_OUTPUT);
        uapi_gpio_set_val(PIN_LED, act.level ? GPIO_LEVEL_HIGH : GPIO_LEVEL_LOW);
    }
    printf("SFC1 actuator: IO%u -> %u\r\n", (unsigned)act.pin, (unsigned)act.level);
    show_device(act.pin, act.level);

    ack.status = 0;
    ack.pin = act.pin;
    ack.level = act.level;
    (void)memcpy_s(ack.nonce, sizeof(ack.nonce), act.nonce, PROTO_NONCE_LEN);
    out_len = proto_encode_actuator_ack(&ack, out, sizeof(out), sfc1_hmac_sha256, (void *)g_key);
    if (out_len > 0) {
        (void)uapi_uart_write(UART_BUS_0, out, (uint32_t)out_len, 0);
    }
}

static void handle_frame(const uint8_t *frame, size_t len)
{
    proto_challenge_t ch;
    uint32_t ttl;
    int rc;

    /* 配网恢复探活：不依赖配网窗口 */
    if (frame[5] == 0x20) {
        handle_ping(frame, len);
        return;
    }

    /* 配网帧（0x10 INIT / 0x12 COMMIT）先交给配网状态机，不受未配置状态限制 */
    if (frame[5] == 0x10 || frame[5] == 0x12) {
        uint8_t out[SFC1_PROV_FRAME_MAX];
        size_t out_len = 0;
        int handled = sfc1_prov_handle(&g_prov, frame, len, now_ms(), out, sizeof(out), &out_len);
        if (handled > 0 && out_len > 0) {
            (void)uapi_uart_write(UART_BUS_0, out, (uint32_t)out_len, 0);
        }
        if (g_prov.has_new_key) {
            (void)memcpy_s(g_key, sizeof(g_key), g_prov.new_key, SFC1_KEY_LEN);
            g_prov.has_new_key = 0;
            g_provisioned = 1;
            printf("SFC1 PROV: key installed, device %s provisioned\r\n", DEVICE_LABEL);
            /* 换钥后把当前 nonce 窗口用新 key 重写，避免下次启动 tag 失配丢窗口 */
            if (sfc1_nv_save(g_used, g_used_count, g_key) != 0) {
                printf("SFC1 NV: re-save with new key failed\r\n");
            }
            show_idle();
        }
        return;
    }

    /* 未配置：只接受配网帧，普通确认一律拒绝（docs/60 §5.2） */
    if (!g_provisioned) {
        printf("SFC1 challenge rejected: UNPROVISIONED\r\n");
        return;
    }

    if (frame[5] == PROTO_TYPE_ACTUATOR) {
        handle_actuator(frame, len);
        return;
    }

    if (frame[5] != PROTO_TYPE_CHALLENGE) {
        return;
    }
    rc = proto_decode_challenge(frame, len, &ch, sfc1_hmac_sha256, (void *)g_key);
    if (rc != PROTO_OK) {
        printf("SFC1 challenge rejected: %s\r\n", proto_status_str(rc));
        return;
    }
    if (nonce_used(ch.nonce)) {
        printf("SFC1 challenge rejected: REPLAY\r\n");
        return;
    }
    if (g_pending.active) {
        if (now_ms() < g_pending.deadline_ms) {
            printf("SFC1 challenge rejected: BUSY\r\n");
            return;
        }
        mark_used(g_pending.nonce);
        g_pending.active = 0;
    }

    ttl = ch.expires_at - ch.issued_at;
    if (ttl == 0) {
        return;
    }
    if (ttl > MAX_TTL_SEC) {
        ttl = MAX_TTL_SEC;
    }

    (void)memset_s(&g_pending, sizeof(g_pending), 0, sizeof(g_pending));
    g_pending.active = 1;
    (void)memcpy_s(g_pending.task_id, sizeof(g_pending.task_id), ch.task_id, PROTO_TASK_ID_LEN);
    (void)memcpy_s(g_pending.nonce, sizeof(g_pending.nonce), ch.nonce, PROTO_NONCE_LEN);
    g_pending.action = ch.action;
    (void)memcpy_s(g_pending.target_hash, sizeof(g_pending.target_hash),
                   ch.target_hash, PROTO_HASH_LEN);
    g_pending.summary_len = ch.summary_len;
    (void)memcpy_s(g_pending.summary, sizeof(g_pending.summary), ch.summary, ch.summary_len);
    g_pending.summary[ch.summary_len] = '\0';
    g_pending.deadline_ms = now_ms() + (uint64_t)ttl * 1000ULL;

    printf("SFC1 challenge: action=%u ttl=%us summary=%s\r\n",
           (unsigned)ch.action, (unsigned)ttl, g_pending.summary);
    show_challenge(&g_pending);
}

static void feed_byte(uint8_t b)
{
    static const uint8_t MAGIC[4] = { 'S', 'F', 'C', '1' };

    if (g_frame_len < 4) {
        if (b == MAGIC[g_frame_len]) {
            g_frame[g_frame_len++] = b;
        } else {
            g_frame_len = (b == MAGIC[0]) ? 1u : 0u;
            if (g_frame_len == 1) {
                g_frame[0] = b;
            }
        }
        return;
    }
    if (g_frame_len < PROTO_HEADER_LEN) {
        g_frame[g_frame_len++] = b;
        if (g_frame_len == PROTO_HEADER_LEN) {
            uint16_t len = (uint16_t)((uint16_t)g_frame[8] | ((uint16_t)g_frame[9] << 8));
            uint32_t total = (uint32_t)PROTO_HEADER_LEN + len;
            if (len < PROTO_MAC_LEN || total > sizeof(g_frame)) {
                g_frame_len = 0;
                g_frame_need = 0;
            } else {
                g_frame_need = (uint16_t)total;
            }
        }
        return;
    }
    if (g_frame_need == 0) {
        g_frame_len = 0;
        return;
    }
    g_frame[g_frame_len++] = b;
    if (g_frame_len >= g_frame_need) {
        handle_frame(g_frame, g_frame_len);
        g_frame_len = 0;
        g_frame_need = 0;
    }
}

/* ---------------- 按键 ---------------- */
/* IO12 留给继电器输出，不再参与按键候选扫描 */
static const pin_t CANDIDATE_PINS[] = {
    GPIO_02, GPIO_03, GPIO_04, GPIO_05, GPIO_06, GPIO_07, GPIO_08, GPIO_09, GPIO_11, GPIO_14,
};
#define PIN_COUNT (sizeof(CANDIDATE_PINS) / sizeof(CANDIDATE_PINS[0]))

static void key_pins_init(void)
{
    size_t i;
    for (i = 0; i < PIN_COUNT; i++) {
        uapi_pin_set_mode(CANDIDATE_PINS[i], HAL_PIO_FUNC_GPIO);
        uapi_pin_set_pull(CANDIDATE_PINS[i], PIN_PULL_TYPE_DOWN);
        uapi_gpio_set_dir(CANDIDATE_PINS[i], GPIO_DIRECTION_INPUT);
    }
}

static int read_active_pin(void)
{
    size_t i;
    for (i = 0; i < PIN_COUNT; i++) {
        if (uapi_gpio_get_val(CANDIDATE_PINS[i]) == GPIO_LEVEL_HIGH) {
            return (int)CANDIDATE_PINS[i];
        }
    }
    return -1;
}

/* ---------------- 主任务 ---------------- */
static errcode_t sfc1_uart_init(void)
{
    uart_attr_t attr = {
        .baud_rate = UART_BAUD,
        .data_bits = UART_DATA_BIT_8,
        .stop_bits = UART_STOP_BIT_1,
        .parity = UART_PARITY_NONE,
    };
    uart_pin_config_t pins = {
        .tx_pin = S_MGPIO17,
        .rx_pin = S_MGPIO18,
        .cts_pin = PIN_NONE,
        .rts_pin = PIN_NONE,
    };
    uart_buffer_config_t buffer = {
        .rx_buffer = g_uart_dma_buf,
        .rx_buffer_size = sizeof(g_uart_dma_buf),
    };
    errcode_t ret;

    /* 控制台已经初始化过 UART0 时，直接注册接收回调；否则先按 115200 8N1 初始化 */
    ret = uapi_uart_register_rx_callback(UART_BUS_0, UART_RX_CONDITION_FULL_OR_SUFFICIENT_DATA_OR_IDLE,
                                         1, uart_rx_cb);
    if (ret == ERRCODE_SUCC) {
        return ret;
    }
    ret = uapi_uart_init(UART_BUS_0, &pins, &attr, NULL, &buffer);
    if (ret != ERRCODE_SUCC) {
        return ret;
    }
    return uapi_uart_register_rx_callback(UART_BUS_0, UART_RX_CONDITION_FULL_OR_SUFFICIENT_DATA_OR_IDLE,
                                         1, uart_rx_cb);
}

static void key_task(const char *arg)
{
    uint8_t pressed = 0;
    int pressed_pin = -1;
    uint64_t press_start_ms = 0;
    uint8_t stable = 0;
    uint32_t ret;
    errcode_t uart_ret;

    unused(arg);

    ret = ssd1306_init();
    printf("ssd1306_init ret=%u\r\n", ret);

    if (sfc1_derive_device_id(DEVICE_LABEL, g_device_id) != 0) {
        printf("SFC1 device id derive failed\r\n");
    }

    key_pins_init();
    /* 继电器/锁体：上电默认低（继电器不吸合=上锁）；未接线时不影响现有演示 */
    uapi_pin_set_mode(PIN_RELAY, HAL_PIO_FUNC_GPIO);
    uapi_gpio_set_dir(PIN_RELAY, GPIO_DIRECTION_OUTPUT);
    uapi_gpio_set_val(PIN_RELAY, GPIO_LEVEL_LOW);
    printf("SFC1 relay: IO%u idle LOW\r\n", (unsigned)PIN_RELAY);
    uart_ret = sfc1_uart_init();
    printf("M3 SFC1 ready: uart=%d device=%s\r\n", (int)uart_ret, DEVICE_LABEL);

    /* 未配置：显示一次性配网码（此时 OLED 已初始化）；已配置则显示待机页 */
    if (!g_provisioned && g_prov.active) {
        show_pairing(g_prov.code);
    } else {
        show_idle();
    }

    for (;;) {
        uint8_t b;

        while (uart_ring_pop(&b)) {
            feed_byte(b);
        }

        uint64_t now = now_ms();
        if (g_pending.active && now >= g_pending.deadline_ms) {
            mark_used(g_pending.nonce);
            g_pending.active = 0;
            printf("SFC1 pending expired\r\n");
            show_result("EXPIRED");
        }

        {
            int pin = read_active_pin();
            uint8_t down = (pin >= 0) ? 1u : 0u;

            if (down != pressed) {
                if (++stable < DEBOUNCE_N) {
                    osDelay(POLL_MS);
                    continue;
                }
                stable = 0;
                if (down) {
                    pressed = 1;
                    pressed_pin = pin;
                    press_start_ms = now;
                } else {
                    uint32_t held = (uint32_t)(now - press_start_ms);
                    pressed = 0;
                    if (g_pending.active) {
                        if (held >= LONG_PRESS_MS) {
                            printf("KEY LONG %ums on IO%d -> CANCEL\r\n", held, pressed_pin);
                            send_decision(0);
                        } else {
                            printf("KEY SHORT %ums on IO%d -> APPROVE\r\n", held, pressed_pin);
                            send_decision(1);
                        }
                    } else {
                        show_result("NO PENDING");
                    }
                }
            } else {
                stable = 0;
            }
        }
        osDelay(POLL_MS);
    }
}

static void board_confirm_entry(void)
{
    printf("Enter board confirm (M3)!\r\n");

    /* 一机一钥（docs/60）：NV 有 key 用它；否则回落演示 key 并打开配网窗口 */
    {
        sfc1_key_record_t rec;
        if (sfc1_key_store_load(&rec, DEVICE_LABEL)) {
            (void)memcpy_s(g_key, sizeof(g_key), rec.key, SFC1_KEY_LEN);
            g_provisioned = 1;
            printf("SFC1 KEY: provisioned (at %u)\r\n", (unsigned)rec.provisioned_at);
        } else {
            (void)memcpy_s(g_key, sizeof(g_key), DEMO_KEY, SFC1_KEY_LEN);
            g_provisioned = 0;
            printf("SFC1 KEY: DEMO (unprovisioned)\r\n");
            if (sfc1_prov_begin(&g_prov, DEVICE_LABEL, now_ms(), PROV_WINDOW_MS)) {
                /* 只打印；屏幕显示交给 key_task（这里 OLED 还没初始化） */
                printf("SFC1 PROV: pairing code %s (10 min, 3 attempts)\r\n", g_prov.code);
            }
        }
    }

    /* M1：启动时恢复已消费 nonce 窗口（无记录/损坏则从空窗口开始） */
    if (sfc1_nv_load(g_used, &g_used_count, g_key)) {
        g_used_next = (uint8_t)(g_used_count % PROTO_REPLAY_WINDOW);
        printf("SFC1 NV: restored %u nonces\r\n", (unsigned)g_used_count);
    } else {
        g_used_next = 0;
        printf("SFC1 NV: empty replay window\r\n");
    }

    osThreadAttr_t attr;
    attr.name = "KeyTask";
    attr.attr_bits = 0U;
    attr.cb_mem = NULL;
    attr.cb_size = 0U;
    attr.stack_mem = NULL;
    attr.stack_size = 0x2000;
    attr.priority = osPriorityNormal;

    task1_ID = osThreadNew((osThreadFunc_t)key_task, NULL, &attr);
    if (task1_ID != NULL) {
        printf("ID = %d, Create KeyTask is OK!\r\n", task1_ID);
    }
}

app_run(board_confirm_entry);
