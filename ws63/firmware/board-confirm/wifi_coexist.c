/*
 * WiFi 与 SLE 共存观测（可选构建 SFC1_WITH_WIFI=1）。
 * 说明见 wifi_coexist.h：只开 STA + 周期扫描，不连 AP、不传数据。
 */

#include "wifi_coexist.h"

#include "wifi_device.h"
#include "errcode.h"

#include <stdio.h>

#define WIFI_COEX_SCAN_INTERVAL_MS 10000u

static int g_state; /* 0=等 SDK 初始化 1=就绪 -1=失败 */
static uint8_t g_warned_not_inited;
static uint64_t g_last_scan_ms;
static unsigned g_scan_count;

int wifi_coexist_start(void)
{
    if (g_state != 0) {
        return g_state;
    }
    if (wifi_is_wifi_inited() == 0) {
        if (!g_warned_not_inited) {
            g_warned_not_inited = 1;
            printf("WIFI COEX: waiting for sdk wifi init\r\n");
        }
        return 0;
    }
    if (wifi_sta_enable() != (errcode_t)ERRCODE_SUCC) {
        g_state = -1;
        printf("WIFI COEX: sta enable failed\r\n");
        return -1;
    }
    g_state = 1;
    printf("WIFI COEX: sta enabled, scan every %ums\r\n", (unsigned)WIFI_COEX_SCAN_INTERVAL_MS);
    return 1;
}

void wifi_coexist_poll(uint64_t now_ms)
{
    errcode_t rc;

    if (g_state == 0) {
        (void)wifi_coexist_start();
        return;
    }
    if (g_state != 1) {
        return;
    }
    if (g_last_scan_ms != 0u && (now_ms - g_last_scan_ms) < WIFI_COEX_SCAN_INTERVAL_MS) {
        return;
    }
    g_last_scan_ms = now_ms;
    rc = wifi_sta_scan();
    g_scan_count++;
    printf("WIFI COEX: scan #%u ret=%d\r\n", g_scan_count, (int)rc);
}
