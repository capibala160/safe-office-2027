/*
 * M2 · WS63 近场确认器（2026-10-29）
 *   - 实测：按下 KEY2 时 IO2 与 IO3 同时被拉高（高电平有效），故按键 = 候选脚任一为高
 *   - 候选脚启用内部下拉，避免悬空脚噪声（IO14 曾自触发）
 *   - 短按（<600ms）= 批准，长按（>=600ms）= 取消；屏上显示实际触发的脚号
 * 边界：本版只做本机按键 + 显示，不含 SFC1 帧收发（M3 再接）
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
#include "hal_bsp_oled/hal_bsp_ssd1306.h"
#include "app_init.h"

osThreadId_t task1_ID;

#define POLL_MS       20
#define LONG_PRESS_MS 600
#define DEBOUNCE_N    2   /* 连续 N 次采样一致才认 */

/* 候选按键脚：排除 IO10(蜂鸣器)、IO13(LED)、IO15/16(OLED I2C)、IO17/18(UART0) */
static const pin_t CANDIDATE_PINS[] = {
    GPIO_02, GPIO_03, GPIO_04, GPIO_05, GPIO_06, GPIO_07, GPIO_08, GPIO_09, GPIO_11, GPIO_12, GPIO_14,
};
#define PIN_COUNT (sizeof(CANDIDATE_PINS) / sizeof(CANDIDATE_PINS[0]))

static void show_status(const char *status, const char *hint, int pin)
{
    char line[24] = {0};
    ssd1306_cls();
    ssd1306_show_str(OLED_TEXT16_COLUMN_0, OLED_TEXT16_LINE_0, "WS63 CONFIRM", TEXT_SIZE_16);
    ssd1306_show_str(OLED_TEXT16_COLUMN_0, OLED_TEXT16_LINE_1, (char *)status, TEXT_SIZE_16);
    if (pin >= 0) {
        if (sprintf_s(line, sizeof(line), "KEY = IO%d", pin) > 0) {
            ssd1306_show_str(OLED_TEXT16_COLUMN_0, OLED_TEXT16_LINE_2, line, TEXT_SIZE_8);
        }
    }
    ssd1306_show_str(OLED_TEXT16_COLUMN_0, OLED_TEXT16_LINE_3, (char *)hint, TEXT_SIZE_8);
}

static void key_pins_init(void)
{
    for (size_t i = 0; i < PIN_COUNT; i++) {
        uapi_pin_set_mode(CANDIDATE_PINS[i], HAL_PIO_FUNC_GPIO);
        uapi_pin_set_pull(CANDIDATE_PINS[i], PIN_PULL_TYPE_DOWN);
        uapi_gpio_set_dir(CANDIDATE_PINS[i], GPIO_DIRECTION_INPUT);
    }
}

/* 任一候选脚为高即视为按下；返回触发脚（都低则 -1） */
static int read_active_pin(void)
{
    for (size_t i = 0; i < PIN_COUNT; i++) {
        if (uapi_gpio_get_val(CANDIDATE_PINS[i]) == GPIO_LEVEL_HIGH) {
            return (int)CANDIDATE_PINS[i];
        }
    }
    return -1;
}

static void key_task(const char *arg)
{
    unused(arg);
    uint8_t pressed = 0;
    int pressed_pin = -1;
    uint64_t press_start_ms = 0;
    uint8_t stable = 0;

    /* OLED 初始化内部会 osDelay，必须在任务上下文（调度器起来后）调用 */
    uint32_t ret = ssd1306_init();
    printf("ssd1306_init ret=%u\r\n", ret);
    ssd1306_cls();

    key_pins_init();
    printf("M2 confirm ready: short=approve long=cancel\r\n");
    show_status("WAITING", "SHORT=OK LONG=NO", -1);

    for (;;) {
        int pin = read_active_pin();
        uint8_t down = (pin >= 0) ? 1 : 0;
        uint64_t now_ms = (uint64_t)osKernelGetTickCount() * 1000ULL / osKernelGetTickFreq();

        if (down != pressed) {
            if (++stable < DEBOUNCE_N) {
                osDelay(POLL_MS);
                continue;
            }
            stable = 0;
            if (down) {
                pressed = 1;
                pressed_pin = pin;
                press_start_ms = now_ms;
                printf("KEY down on IO%d\r\n", pin);
            } else {
                uint32_t held = (uint32_t)(now_ms - press_start_ms);
                pressed = 0;
                if (held >= LONG_PRESS_MS) {
                    printf("KEY LONG %ums on IO%d -> CANCEL\r\n", held, pressed_pin);
                    show_status("CANCELLED", "LONG PRESS", pressed_pin);
                } else {
                    printf("KEY SHORT %ums on IO%d -> APPROVE\r\n", held, pressed_pin);
                    show_status("APPROVED", "SHORT PRESS", pressed_pin);
                }
            }
        } else {
            stable = 0;
        }
        osDelay(POLL_MS);
    }
}

static void base_ssd1306_demo(void)
{
    printf("Enter confirm demo (M2)!\r\n");

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

app_run(base_ssd1306_demo);
