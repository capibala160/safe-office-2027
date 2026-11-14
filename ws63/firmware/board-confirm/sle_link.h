#ifndef SFC1_SLE_LINK_H
#define SFC1_SLE_LINK_H

/*
 * SFC1 SLE 传输适配器（M2）
 *
 * 角色映射：
 *   - 确认端 B（持 KEY/OLED）：SLE server，广播名 sfc1-confirm，用 notification 发、write request 收
 *   - 执行端 A（接 PC）：SLE client，扫描该名字、配对、MTU、服务发现，用 write request 发、notification 收
 *
 * 只负责“收/发 16B 链路心跳和后续 SFC1 帧字节”，不解析业务语义。
 * 回调运行在 SLE/BT 任务上下文：实现里只能做入队等短操作，不要直接跑 OLED/耗时逻辑。
 */

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define SFC1_SLE_NAME "sfc1-confirm"
#define SFC1_SLE_MTU 520

typedef void (*sle_link_rx_cb)(const uint8_t *data, uint16_t len);
typedef void (*sle_link_state_cb)(uint8_t connected);

/* 成功返回 0；失败返回负值。name 最长 15 字符（超出截断）。 */
int sle_link_server_start(const char *name, sle_link_rx_cb rx_cb, sle_link_state_cb state_cb);
int sle_link_client_start(const char *name, sle_link_rx_cb rx_cb, sle_link_state_cb state_cb);

/* 发送一段字节。未连接/未就绪返回 -1。 */
int sle_link_send(const uint8_t *data, uint16_t len);

int sle_link_is_connected(void);

#ifdef __cplusplus
}
#endif

#endif /* SFC1_SLE_LINK_H */
