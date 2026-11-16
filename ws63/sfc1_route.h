#ifndef SFC1_ROUTE_H
#define SFC1_ROUTE_H

/*
 * SLE 字节流分发（M3'，平台无关 C）
 *
 * 同一传输上同时跑两类帧：
 *   - 链路心跳 "SFCL"（16B 定长，由 link.c 处理）
 *   - 业务帧   "SFC1"（变长，由 protocol.c 处理）
 *
 * 本模块只按 magic 分流并做帧组装，不解析业务语义、不校验 MAC。
 *
 * 安全边界：
 *   - 分流不是安全判断；业务帧仍必须由持有密钥的一端验 MAC。
 *   - 这里不做去重、不去重放，重放窗口仍在 SFC1 状态机里。
 */

#include <stdint.h>

#include "link.h"
#include "protocol.h"

#ifdef __cplusplus
extern "C" {
#endif

#define SFC1_ROUTE_MODE_UNKNOWN 0u
#define SFC1_ROUTE_MODE_LINK 1u
#define SFC1_ROUTE_MODE_BIZ 2u

typedef struct {
    uint8_t mode;    /* SFC1_ROUTE_MODE_* */
    uint8_t hdr[4];  /* magic 判别窗口 */
    uint8_t hdr_len;

    sfcl_parser_t link_parser; /* 心跳帧组装 */

    uint8_t frame[PROTO_CHALLENGE_MAX + 1u]; /* 业务帧组装（CHALLENGE 最大） */
    uint16_t frame_len;
    uint16_t frame_need;
} sfc1_route_t;

typedef enum {
    SFC1_ROUTE_EV_NONE = 0, /* 本字节没有凑出完整帧 */
    SFC1_ROUTE_EV_LINK = 1, /* link_out 填好 16B 心跳帧 */
    SFC1_ROUTE_EV_BIZ = 2    /* biz_frame/biz_len/biz_type 有效（指向内部缓冲） */
} sfc1_route_ev_t;

void sfc1_route_init(sfc1_route_t *r);

/* 喂一个字节。
 * 返回 EV_BIZ 时，*biz_frame 指向内部缓冲，内容在下一次 feed 前有效。
 * 返回 EV_LINK 时，link_out 填 16B（调用方交给 sfcl_link_on_frame）。 */
sfc1_route_ev_t sfc1_route_feed(sfc1_route_t *r, uint8_t byte,
                                uint8_t link_out[SFCL_FRAME_LEN],
                                const uint8_t **biz_frame, uint16_t *biz_len,
                                uint8_t *biz_type);

#ifdef __cplusplus
}
#endif

#endif /* SFC1_ROUTE_H */
