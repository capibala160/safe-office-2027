#ifndef WS63_WIFI_COEXIST_H
#define WS63_WIFI_COEXIST_H

/*
 * WiFi 与 SLE 共存观测（2026-11-16，可选构建 SFC1_WITH_WIFI=1）
 *
 * 只做一件事：等 SDK 把 WiFi 初始化好后，把 STA 打开，并每 10 秒发起一次扫描，
 * 制造真实的 WiFi 射频活动；同时 SLE 心跳照常跑。用链路计数判断共存是否稳定。
 *
 * 不连接任何 AP、不配 IP、不传数据——因此不需要 WiFi 密码，
 * 也**不能**用来宣称"WiFi 数据业务与 SLE 共存通过"。
 */

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* 返回 1=STA 已使能；0=还在等 SDK 初始化；-1=使能失败 */
int wifi_coexist_start(void);

/* 主循环周期调用；内部按 10s 节流发扫描，打印 WIFI COEX 日志 */
void wifi_coexist_poll(uint64_t now_ms);

#ifdef __cplusplus
}
#endif

#endif /* WS63_WIFI_COEXIST_H */
