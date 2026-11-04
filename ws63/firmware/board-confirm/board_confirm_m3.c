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

osThreadId_t task1_ID;

#define POLL_MS        10
#define LONG_PRESS_MS  600
#define DEBOUNCE_N     2
#define RX_RING_SIZE   1024
#define UART_BAUD      115200
#define MAX_TTL_SEC    300u

/* 演示 PSK：与 PC 侧 --demo-key 对应；真实部署必须改为每台设备独立密钥 */
static const uint8_t DEMO_KEY[SFC1_KEY_LEN] = {
    0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42,
    0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42,
    0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42,
    0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42,
};
#define DEVICE_LABEL "ws63-A"

static uint8_t g_device_id[SFC1_DEVICE_ID_LEN];

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
    /* M1：窗口落 NV，重启后仍能拒绝旧 nonce；写失败只告警，不阻断确认流程 */
    if (sfc1_nv_save(g_used, g_used_count, DEMO_KEY) != 0) {
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

    n = proto_encode_decision(&d, out, sizeof(out), sfc1_hmac_sha256, (void *)DEMO_KEY);
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

/* ---------------- 挑战处理 ---------------- */
static void handle_frame(const uint8_t *frame, size_t len)
{
    proto_challenge_t ch;
    uint32_t ttl;
    int rc;

    if (frame[5] != PROTO_TYPE_CHALLENGE) {
        return;
    }
    rc = proto_decode_challenge(frame, len, &ch, sfc1_hmac_sha256, (void *)DEMO_KEY);
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
static const pin_t CANDIDATE_PINS[] = {
    GPIO_02, GPIO_03, GPIO_04, GPIO_05, GPIO_06, GPIO_07, GPIO_08, GPIO_09, GPIO_11, GPIO_12, GPIO_14,
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
    uart_ret = sfc1_uart_init();
    printf("M3 SFC1 ready: uart=%d device=%s\r\n", (int)uart_ret, DEVICE_LABEL);
    show_idle();

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

    /* M1：启动时恢复已消费 nonce 窗口（无记录/损坏则从空窗口开始） */
    if (sfc1_nv_load(g_used, &g_used_count, DEMO_KEY)) {
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
