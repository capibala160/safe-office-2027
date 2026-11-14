/*
 * SFC1 双板链路保活层（M2）
 *
 * 帧格式（16B，固定长度，小端）：
 *   0..3   magic "SFCL"
 *   4      version = 0x01
 *   5      type    = 0x01 HEARTBEAT
 *   6      role    = 0 执行端 / 1 确认端
 *   7      flags   = 0（保留）
 *   8..11  seq     发送序号（每帧 +1）
 *   12..15 uptime_ms 发送方开机毫秒数
 *
 * 不做校验和/MAC：心跳只用于存活判定，安全决策必须走 SFC1 HMAC 帧。
 */

#include "link.h"

#include <string.h>

static const uint8_t SFCL_MAGIC[4] = { 'S', 'F', 'C', 'L' };

static void put_le32(uint8_t *p, uint32_t v)
{
    p[0] = (uint8_t)(v & 0xffu);
    p[1] = (uint8_t)((v >> 8) & 0xffu);
    p[2] = (uint8_t)((v >> 16) & 0xffu);
    p[3] = (uint8_t)((v >> 24) & 0xffu);
}

static uint32_t get_le32(const uint8_t *p)
{
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

int sfcl_link_init(sfcl_link_t *l, uint8_t role, uint16_t heartbeat_ms, uint16_t timeout_ms)
{
    if (l == NULL || role > SFCL_ROLE_CONFIRM || heartbeat_ms == 0 || timeout_ms <= heartbeat_ms) {
        return SFCL_ERR_ARG;
    }
    (void)memset(l, 0, sizeof(*l));
    l->role = role;
    l->heartbeat_ms = heartbeat_ms;
    l->timeout_ms = timeout_ms;
    l->state = SFCL_STATE_DOWN;
    return SFCL_OK;
}

size_t sfcl_link_encode(uint8_t out[SFCL_FRAME_LEN], uint8_t role, uint32_t seq, uint32_t uptime_ms)
{
    if (out == NULL || role > SFCL_ROLE_CONFIRM) {
        return 0;
    }
    (void)memcpy(out, SFCL_MAGIC, sizeof(SFCL_MAGIC));
    out[4] = SFCL_VERSION;
    out[5] = SFCL_TYPE_HEARTBEAT;
    out[6] = role;
    out[7] = 0;
    put_le32(&out[8], seq);
    put_le32(&out[12], uptime_ms);
    return SFCL_FRAME_LEN;
}

int sfcl_link_decode(const uint8_t *buf, size_t len, sfcl_heartbeat_t *out)
{
    if (buf == NULL || out == NULL) {
        return SFCL_ERR_ARG;
    }
    if (len != SFCL_FRAME_LEN) {
        return SFCL_ERR_FRAME;
    }
    if (memcmp(buf, SFCL_MAGIC, sizeof(SFCL_MAGIC)) != 0) {
        return SFCL_ERR_FRAME;
    }
    if (buf[4] != SFCL_VERSION || buf[5] != SFCL_TYPE_HEARTBEAT) {
        return SFCL_ERR_FRAME;
    }
    if (buf[6] > SFCL_ROLE_CONFIRM) {
        return SFCL_ERR_FRAME;
    }
    out->seq = get_le32(&buf[8]);
    out->uptime_ms = get_le32(&buf[12]);
    out->role = buf[6];
    return SFCL_OK;
}

void sfcl_link_transport_up(sfcl_link_t *l, uint64_t now_ms)
{
    if (l == NULL || l->transport_up) {
        return;
    }
    (void)now_ms;
    l->transport_up = 1;
    l->state = SFCL_STATE_CONNECTED;
    l->tx_started = 0; /* 强制下一次 tick 立即发首帧 */
    l->rx_started = 0; /* 新连接不继承旧连接的存活时间 */
    l->seq_started = 0; /* 对端可能重启、seq 从 0 开始，不能拿旧基线判 stale/gap */
    l->last_peer_seq = 0;
    l->last_tx_ms = 0;
    l->last_rx_ms = 0;
    l->up_count++;
}

void sfcl_link_transport_down(sfcl_link_t *l, uint64_t now_ms)
{
    if (l == NULL || !l->transport_up) {
        return;
    }
    (void)now_ms;
    l->transport_up = 0;
    l->state = SFCL_STATE_DOWN;
    l->tx_started = 0;
    l->rx_started = 0;
    l->seq_started = 0;
    l->last_peer_seq = 0;
    l->last_tx_ms = 0;
    l->last_rx_ms = 0;
    l->down_count++;
}

int sfcl_link_tick(sfcl_link_t *l, uint64_t now_ms, uint8_t out[SFCL_FRAME_LEN])
{
    if (l == NULL || out == NULL) {
        return 0;
    }
    if (!l->transport_up) {
        return 0;
    }

    /* 超时判定：只在“本连接收到过心跳”时生效；没收到过就一直是 CONNECTED。 */
    if (l->rx_started && l->state == SFCL_STATE_ALIVE &&
        (now_ms - l->last_rx_ms) > (uint64_t)l->timeout_ms) {
        l->state = SFCL_STATE_CONNECTED;
        l->timeout_count++;
    }

    if (!l->tx_started || (now_ms - l->last_tx_ms) >= (uint64_t)l->heartbeat_ms) {
        if (sfcl_link_encode(out, l->role, l->tx_seq, (uint32_t)now_ms) == 0) {
            return 0;
        }
        l->tx_seq++;
        l->tx_started = 1;
        l->last_tx_ms = now_ms;
        l->tx_count++;
        return 1;
    }
    return 0;
}

int sfcl_link_on_frame(sfcl_link_t *l, const uint8_t *buf, size_t len, uint64_t now_ms)
{
    sfcl_heartbeat_t hb;
    int rc;

    if (l == NULL) {
        return SFCL_ERR_ARG;
    }
    rc = sfcl_link_decode(buf, len, &hb);
    if (rc != SFCL_OK) {
        l->rx_bad++;
        return rc;
    }

    l->rx_count++;
    if (l->seq_started) {
        if (hb.seq > l->last_peer_seq) {
            l->rx_gap += hb.seq - l->last_peer_seq - 1u;
            l->last_peer_seq = hb.seq;
        } else {
            /* 重复或倒序：仍算一次有效接收（存活），但单独计数。 */
            l->rx_stale++;
        }
    } else {
        /* 本连接的第一帧建立基线：对端可能是刚重启、seq 从 0 开始。 */
        l->last_peer_seq = hb.seq;
        l->seq_started = 1;
    }
    l->has_peer = 1;
    l->peer_role = hb.role;
    l->rx_started = 1;
    l->last_rx_ms = now_ms;
    if (l->transport_up) {
        l->state = SFCL_STATE_ALIVE;
    }
    return SFCL_OK;
}

void sfcl_link_on_send_fail(sfcl_link_t *l)
{
    if (l != NULL) {
        l->send_fail_count++;
    }
}

void sfcl_parser_init(sfcl_parser_t *p)
{
    if (p != NULL) {
        (void)memset(p, 0, sizeof(*p));
    }
}

int sfcl_parser_feed(sfcl_parser_t *p, uint8_t byte, uint8_t out[SFCL_FRAME_LEN])
{
    sfcl_heartbeat_t hb;
    uint8_t i;

    if (p == NULL || out == NULL || p->len >= SFCL_FRAME_LEN) {
        return 0;
    }
    p->buf[p->len++] = byte;
    if (p->len < SFCL_FRAME_LEN) {
        return 0;
    }
    if (sfcl_link_decode(p->buf, SFCL_FRAME_LEN, &hb) == SFCL_OK) {
        (void)memcpy(out, p->buf, SFCL_FRAME_LEN);
        p->len = 0;
        return 1;
    }
    /* 坏窗口：丢掉首字节，滑动 1 字节继续找 magic。 */
    for (i = 0; i < (uint8_t)(SFCL_FRAME_LEN - 1u); i++) {
        p->buf[i] = p->buf[i + 1u];
    }
    p->len = (uint8_t)(SFCL_FRAME_LEN - 1u);
    return 0;
}

const char *sfcl_link_state_str(sfcl_state_t state)
{
    switch (state) {
        case SFCL_STATE_DOWN:
            return "DOWN";
        case SFCL_STATE_CONNECTED:
            return "CONNECTED";
        case SFCL_STATE_ALIVE:
            return "ALIVE";
        default:
            return "?";
    }
}

const char *sfcl_link_role_str(uint8_t role)
{
    switch (role) {
        case SFCL_ROLE_EXEC:
            return "exec";
        case SFCL_ROLE_CONFIRM:
            return "confirm";
        default:
            return "?";
    }
}
