/*
 * SLE 字节流分发（M3'）：把 "SFCL" 心跳与 "SFC1" 业务帧分开。
 * 说明见 sfc1_route.h。
 */

#include "sfc1_route.h"

#include <string.h>

#define MAGIC_LINK "SFCL"
#define MAGIC_BIZ "SFC1"

/* 业务帧组装：与板端 UART 的 feed_byte 规则一致（小端长度、含 MAC）。
 * 返回 1 = 凑出完整帧；0 = 继续；-1 = 长度非法已丢弃，需要重新找 magic。 */
static int biz_feed(sfc1_route_t *r, uint8_t b)
{
    static const uint8_t MAGIC[4] = { 'S', 'F', 'C', '1' };

    if (r->frame_len < 4u) {
        if (b == MAGIC[r->frame_len]) {
            r->frame[r->frame_len++] = b;
        } else {
            r->frame_len = (b == MAGIC[0]) ? 1u : 0u;
            if (r->frame_len == 1u) {
                r->frame[0] = b;
            }
        }
        return 0;
    }
    if (r->frame_len < PROTO_HEADER_LEN) {
        r->frame[r->frame_len++] = b;
        if (r->frame_len == PROTO_HEADER_LEN) {
            uint16_t len = (uint16_t)((uint16_t)r->frame[8] | ((uint16_t)r->frame[9] << 8));
            uint32_t total = (uint32_t)PROTO_HEADER_LEN + (uint32_t)len;
            if (len < PROTO_MAC_LEN || total > sizeof(r->frame)) {
                r->frame_len = 0;
                r->frame_need = 0;
                return -1;
            }
            r->frame_need = (uint16_t)total;
        }
        return 0;
    }
    if (r->frame_need == 0) {
        r->frame_len = 0;
        return -1;
    }
    r->frame[r->frame_len++] = b;
    return (r->frame_len >= r->frame_need) ? 1 : 0;
}

void sfc1_route_init(sfc1_route_t *r)
{
    if (r == NULL) {
        return;
    }
    (void)memset(r, 0, sizeof(*r));
    sfcl_parser_init(&r->link_parser);
}

/* 把已经判定出 magic 的 4 个字节喂进对应解析器。
 * 4 字节不可能凑出完整帧（心跳 16B、业务帧最小 10+32B），所以不带出事件。 */
static void feed_magic(sfc1_route_t *r)
{
    uint8_t i;
    uint8_t dummy[SFCL_FRAME_LEN];

    for (i = 0; i < 4u; i++) {
        if (r->mode == SFC1_ROUTE_MODE_LINK) {
            (void)sfcl_parser_feed(&r->link_parser, r->hdr[i], dummy);
        } else {
            (void)biz_feed(r, r->hdr[i]);
        }
    }
    r->hdr_len = 0;
}

sfc1_route_ev_t sfc1_route_feed(sfc1_route_t *r, uint8_t byte,
                                uint8_t link_out[SFCL_FRAME_LEN],
                                const uint8_t **biz_frame, uint16_t *biz_len,
                                uint8_t *biz_type)
{
    if (r == NULL || link_out == NULL || biz_frame == NULL || biz_len == NULL || biz_type == NULL) {
        return SFC1_ROUTE_EV_NONE;
    }
    *biz_frame = NULL;
    *biz_len = 0;
    *biz_type = 0;

    if (r->mode == SFC1_ROUTE_MODE_UNKNOWN) {
        r->hdr[r->hdr_len++] = byte;
        if (r->hdr_len < 4u) {
            return SFC1_ROUTE_EV_NONE;
        }
        if (memcmp(r->hdr, MAGIC_LINK, 4) == 0) {
            r->mode = SFC1_ROUTE_MODE_LINK;
        } else if (memcmp(r->hdr, MAGIC_BIZ, 4) == 0) {
            r->mode = SFC1_ROUTE_MODE_BIZ;
        } else {
            /* 不是任一 magic：滑动 1 字节继续找 */
            r->hdr[0] = r->hdr[1];
            r->hdr[1] = r->hdr[2];
            r->hdr[2] = r->hdr[3];
            r->hdr_len = 3;
            return SFC1_ROUTE_EV_NONE;
        }
        feed_magic(r);
        return SFC1_ROUTE_EV_NONE;
    }

    if (r->mode == SFC1_ROUTE_MODE_LINK) {
        if (sfcl_parser_feed(&r->link_parser, byte, link_out)) {
            r->mode = SFC1_ROUTE_MODE_UNKNOWN;
            return SFC1_ROUTE_EV_LINK;
        }
        return SFC1_ROUTE_EV_NONE;
    }

    {
        int rc = biz_feed(r, byte);
        if (rc == 1) {
            *biz_frame = r->frame;
            *biz_len = r->frame_len;
            *biz_type = r->frame[5];
            r->mode = SFC1_ROUTE_MODE_UNKNOWN;
            r->frame_len = 0;
            r->frame_need = 0;
            return SFC1_ROUTE_EV_BIZ;
        }
        if (rc < 0) {
            /* 帧头长度非法：丢弃，交给 magic 判别重新同步 */
            r->mode = SFC1_ROUTE_MODE_UNKNOWN;
            r->hdr_len = 0;
        }
    }
    return SFC1_ROUTE_EV_NONE;
}
