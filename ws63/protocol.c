#include "protocol.h"

#include <string.h>

/* ---------------- 小端读写 ---------------- */

static void put_u16le(uint8_t *p, uint16_t v)
{
    p[0] = (uint8_t)(v & 0xffu);
    p[1] = (uint8_t)((v >> 8) & 0xffu);
}

static uint16_t get_u16le(const uint8_t *p)
{
    return (uint16_t)((uint16_t)p[0] | ((uint16_t)p[1] << 8));
}

static void put_u32le(uint8_t *p, uint32_t v)
{
    p[0] = (uint8_t)(v & 0xffu);
    p[1] = (uint8_t)((v >> 8) & 0xffu);
    p[2] = (uint8_t)((v >> 16) & 0xffu);
    p[3] = (uint8_t)((v >> 24) & 0xffu);
}

static uint32_t get_u32le(const uint8_t *p)
{
    return ((uint32_t)p[0]) | ((uint32_t)p[1] << 8) |
           ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

/* 恒定时间比较，避免 MAC 比较的时序侧信道 */
static int ct_equal(const uint8_t *a, const uint8_t *b, size_t n)
{
    uint8_t diff = 0;
    size_t i;
    for (i = 0; i < n; i++) {
        diff |= (uint8_t)(a[i] ^ b[i]);
    }
    return diff == 0;
}

/* 拒绝 NUL 与非法 UTF-8，与 Node TextDecoder(fatal) 的行为对齐。
 * 摘要会显示在确认端，坏字节应尽早拒绝，而不是留给 UI。 */
static int summary_valid(const uint8_t *s, size_t n)
{
    size_t i = 0;
    while (i < n) {
        uint8_t c = s[i];
        size_t len;
        uint32_t cp;
        size_t j;

        if (c == 0) return 0;
        if (c < 0x80u) { i++; continue; }
        if ((c & 0xE0u) == 0xC0u) { len = 2; cp = (uint32_t)(c & 0x1Fu); }
        else if ((c & 0xF0u) == 0xE0u) { len = 3; cp = (uint32_t)(c & 0x0Fu); }
        else if ((c & 0xF8u) == 0xF0u) { len = 4; cp = (uint32_t)(c & 0x07u); }
        else return 0;

        if (i + len > n) return 0;
        for (j = 1; j < len; j++) {
            if ((s[i + j] & 0xC0u) != 0x80u) return 0;
            cp = (cp << 6) | (uint32_t)(s[i + j] & 0x3Fu);
        }
        /* 拒绝 overlong、代理区、超出 U+10FFFF */
        if ((len == 2 && cp < 0x80u) || (len == 3 && cp < 0x800u) ||
            (len == 4 && cp < 0x10000u)) return 0;
        if (cp >= 0xD800u && cp <= 0xDFFFu) return 0;
        if (cp > 0x10FFFFu) return 0;
        i += len;
    }
    return 1;
}

/* ---------------- 帧头 ---------------- */

static void write_header(uint8_t *out, uint8_t type, uint16_t payload_and_mac_len)
{
    out[0] = PROTO_MAGIC_0;
    out[1] = PROTO_MAGIC_1;
    out[2] = PROTO_MAGIC_2;
    out[3] = PROTO_MAGIC_3;
    out[4] = PROTO_VERSION;
    out[5] = type;
    out[6] = 0; /* flags */
    out[7] = 0; /* reserved */
    put_u16le(out + 8, payload_and_mac_len);
}

static int check_header(const uint8_t *buf, size_t len, uint8_t want_type,
                        uint16_t *payload_len)
{
    uint16_t body_len;

    if (buf == NULL || len < PROTO_HEADER_LEN + PROTO_MAC_LEN) {
        return PROTO_ERR_FRAME;
    }
    if (buf[0] != PROTO_MAGIC_0 || buf[1] != PROTO_MAGIC_1 ||
        buf[2] != PROTO_MAGIC_2 || buf[3] != PROTO_MAGIC_3) {
        return PROTO_ERR_FRAME;
    }
    if (buf[4] != PROTO_VERSION) {
        return PROTO_ERR_VERSION;
    }
    if (buf[5] != want_type) {
        return PROTO_ERR_TYPE;
    }
    if (buf[6] != 0 || buf[7] != 0) return PROTO_ERR_FRAME;
    body_len = get_u16le(buf + 8);
    if ((size_t)body_len + PROTO_HEADER_LEN != len) {
        return PROTO_ERR_FRAME;
    }
    if (body_len < PROTO_MAC_LEN) {
        return PROTO_ERR_FRAME;
    }
    *payload_len = (uint16_t)(body_len - PROTO_MAC_LEN);
    return PROTO_OK;
}

static int verify_frame_mac(const uint8_t *buf, uint16_t payload_len,
                            proto_mac_fn mac, void *ctx)
{
    uint8_t expected[PROTO_MAC_LEN];
    const uint8_t *actual = buf + PROTO_HEADER_LEN + payload_len;

    if (mac == NULL) {
        return PROTO_ERR_ARG;
    }
    if (mac(buf, PROTO_HEADER_LEN + payload_len, expected, ctx) != 0) {
        return PROTO_ERR_MAC;
    }
    return ct_equal(expected, actual, PROTO_MAC_LEN) ? PROTO_OK : PROTO_ERR_MAC;
}

static int finish_frame(uint8_t *out, size_t total, size_t cap, uint16_t payload_len,
                        proto_mac_fn mac, void *ctx)
{
    if (out == NULL || mac == NULL || total > cap) {
        return PROTO_ERR_BUFFER;
    }
    if (mac(out, PROTO_HEADER_LEN + payload_len, out + PROTO_HEADER_LEN + payload_len, ctx) != 0) {
        return PROTO_ERR_MAC;
    }
    return PROTO_OK;
}

/* ---------------- 编码 ---------------- */

size_t proto_encode_challenge(const proto_challenge_t *c, uint8_t *out, size_t cap,
                              proto_mac_fn mac, void *ctx)
{
    uint16_t payload_len;
    size_t total;
    uint8_t *p;

    if (c == NULL || out == NULL || mac == NULL ||
        c->summary_len > PROTO_SUMMARY_MAX) {
        return 0;
    }
    if (c->expires_at <= c->issued_at) {
        return 0;
    }
    if (c->action < PROTO_ACTION_MIN || c->action > PROTO_ACTION_MAX) {
        return 0;
    }
    if (!summary_valid((const uint8_t *)c->summary, c->summary_len)) {
        return 0;
    }

    payload_len = (uint16_t)(PROTO_CHALLENGE_PAYLOAD_FIXED + c->summary_len);
    total = (size_t)PROTO_HEADER_LEN + payload_len + PROTO_MAC_LEN;
    if (total > cap) {
        return 0;
    }

    write_header(out, PROTO_TYPE_CHALLENGE, (uint16_t)(payload_len + PROTO_MAC_LEN));
    p = out + PROTO_HEADER_LEN;
    memcpy(p, c->task_id, PROTO_TASK_ID_LEN);
    p += PROTO_TASK_ID_LEN;
    memcpy(p, c->nonce, PROTO_NONCE_LEN);
    p += PROTO_NONCE_LEN;
    *p++ = c->action;
    memcpy(p, c->target_hash, PROTO_HASH_LEN);
    p += PROTO_HASH_LEN;
    put_u32le(p, c->issued_at);
    p += 4;
    put_u32le(p, c->expires_at);
    p += 4;
    *p++ = c->summary_len;
    if (c->summary_len > 0) {
        memcpy(p, c->summary, c->summary_len);
    }

    if (finish_frame(out, total, cap, payload_len, mac, ctx) != PROTO_OK) {
        return 0;
    }
    return total;
}

size_t proto_encode_decision(const proto_decision_t *d, uint8_t *out, size_t cap,
                             proto_mac_fn mac, void *ctx)
{
    const uint16_t payload_len = PROTO_DECISION_PAYLOAD_LEN;
    const size_t total = (size_t)PROTO_HEADER_LEN + payload_len + PROTO_MAC_LEN;
    uint8_t *p;

    if (d == NULL || out == NULL || mac == NULL || total > cap || d->decision > 1) {
        return 0;
    }

    write_header(out, PROTO_TYPE_DECISION, (uint16_t)(payload_len + PROTO_MAC_LEN));
    p = out + PROTO_HEADER_LEN;
    memcpy(p, d->task_id, PROTO_TASK_ID_LEN);
    p += PROTO_TASK_ID_LEN;
    memcpy(p, d->nonce, PROTO_NONCE_LEN);
    p += PROTO_NONCE_LEN;
    *p++ = d->decision;
    memcpy(p, d->device_id, 8);
    p += 8;
    put_u32le(p, d->decided_at);

    if (finish_frame(out, total, cap, payload_len, mac, ctx) != PROTO_OK) {
        return 0;
    }
    return total;
}

/* ---------------- 解码 ---------------- */

int proto_decode_challenge(const uint8_t *buf, size_t len, proto_challenge_t *out,
                           proto_mac_fn mac, void *ctx)
{
    uint16_t payload_len = 0;
    const uint8_t *p;
    uint8_t summary_len;
    int rc;

    if (out == NULL) {
        return PROTO_ERR_ARG;
    }
    memset(out, 0, sizeof(*out));

    rc = check_header(buf, len, PROTO_TYPE_CHALLENGE, &payload_len);
    if (rc != PROTO_OK) {
        return rc;
    }
    if (payload_len < PROTO_CHALLENGE_PAYLOAD_FIXED ||
        payload_len > PROTO_CHALLENGE_PAYLOAD_FIXED + PROTO_SUMMARY_MAX) {
        return PROTO_ERR_FRAME;
    }

    p = buf + PROTO_HEADER_LEN;
    summary_len = p[PROTO_TASK_ID_LEN + PROTO_NONCE_LEN + 1u + PROTO_HASH_LEN + 4u + 4u];
    if ((uint16_t)(PROTO_CHALLENGE_PAYLOAD_FIXED + summary_len) != payload_len) {
        return PROTO_ERR_FRAME;
    }

    rc = verify_frame_mac(buf, payload_len, mac, ctx);
    if (rc != PROTO_OK) {
        return rc;
    }

    memcpy(out->task_id, p, PROTO_TASK_ID_LEN);
    p += PROTO_TASK_ID_LEN;
    memcpy(out->nonce, p, PROTO_NONCE_LEN);
    p += PROTO_NONCE_LEN;
    out->action = *p++;
    if (out->action < PROTO_ACTION_MIN || out->action > PROTO_ACTION_MAX) {
        return PROTO_ERR_OPERATION;
    }
    memcpy(out->target_hash, p, PROTO_HASH_LEN);
    p += PROTO_HASH_LEN;
    out->issued_at = get_u32le(p);
    p += 4;
    out->expires_at = get_u32le(p);
    p += 4;
    out->summary_len = *p++;
    if (out->summary_len > 0) {
        memcpy(out->summary, p, out->summary_len);
    }
    out->summary[out->summary_len] = '\0';
    if (out->expires_at <= out->issued_at) {
        return PROTO_ERR_FRAME;
    }
    if (!summary_valid((const uint8_t *)out->summary, out->summary_len)) {
        return PROTO_ERR_FRAME;
    }
    memcpy(out->mac, buf + PROTO_HEADER_LEN + payload_len, PROTO_MAC_LEN);
    return PROTO_OK;
}

int proto_decode_decision(const uint8_t *buf, size_t len, proto_decision_t *out,
                          proto_mac_fn mac, void *ctx)
{
    uint16_t payload_len = 0;
    const uint8_t *p;
    int rc;

    if (out == NULL) {
        return PROTO_ERR_ARG;
    }
    memset(out, 0, sizeof(*out));

    rc = check_header(buf, len, PROTO_TYPE_DECISION, &payload_len);
    if (rc != PROTO_OK) {
        return rc;
    }
    if (payload_len != PROTO_DECISION_PAYLOAD_LEN) {
        return PROTO_ERR_FRAME;
    }

    rc = verify_frame_mac(buf, payload_len, mac, ctx);
    if (rc != PROTO_OK) {
        return rc;
    }

    p = buf + PROTO_HEADER_LEN;
    memcpy(out->task_id, p, PROTO_TASK_ID_LEN);
    p += PROTO_TASK_ID_LEN;
    memcpy(out->nonce, p, PROTO_NONCE_LEN);
    p += PROTO_NONCE_LEN;
    out->decision = *p++;
    if (out->decision > 1) {
        return PROTO_ERR_DECISION;
    }
    memcpy(out->device_id, p, 8);
    p += 8;
    out->decided_at = get_u32le(p);
    memcpy(out->mac, buf + PROTO_HEADER_LEN + payload_len, PROTO_MAC_LEN);
    return PROTO_OK;
}

size_t proto_encode_actuator_ack(const proto_actuator_ack_t *a, uint8_t *out, size_t cap,
                                 proto_mac_fn mac, void *ctx)
{
    const uint16_t payload_len = PROTO_ACTUATOR_ACK_PAYLOAD_LEN;
    const size_t total = (size_t)PROTO_HEADER_LEN + payload_len + PROTO_MAC_LEN;
    uint8_t *p;

    if (a == NULL || out == NULL || mac == NULL || total > cap) {
        return 0;
    }

    write_header(out, PROTO_TYPE_ACTUATOR_ACK, (uint16_t)(payload_len + PROTO_MAC_LEN));
    p = out + PROTO_HEADER_LEN;
    memcpy(p, a->nonce, PROTO_NONCE_LEN);
    p += PROTO_NONCE_LEN;
    *p++ = a->status;
    *p++ = a->pin;
    *p++ = a->level;

    if (finish_frame(out, total, cap, payload_len, mac, ctx) != PROTO_OK) {
        return 0;
    }
    return total;
}

int proto_decode_actuator(const uint8_t *buf, size_t len, proto_actuator_t *out,
                          proto_mac_fn mac, void *ctx)
{
    uint16_t payload_len = 0;
    const uint8_t *p;
    int rc;

    if (out == NULL) {
        return PROTO_ERR_ARG;
    }
    memset(out, 0, sizeof(*out));

    rc = check_header(buf, len, PROTO_TYPE_ACTUATOR, &payload_len);
    if (rc != PROTO_OK) {
        return rc;
    }
    if (payload_len != PROTO_ACTUATOR_PAYLOAD_LEN) {
        return PROTO_ERR_FRAME;
    }
    rc = verify_frame_mac(buf, payload_len, mac, ctx);
    if (rc != PROTO_OK) {
        return rc;
    }

    p = buf + PROTO_HEADER_LEN;
    memcpy(out->nonce, p, PROTO_NONCE_LEN);
    p += PROTO_NONCE_LEN;
    out->pin = *p++;
    out->level = *p++;
    if (out->level > 1) {
        return PROTO_ERR_ARG;
    }
    memcpy(out->mac, buf + PROTO_HEADER_LEN + payload_len, PROTO_MAC_LEN);
    return PROTO_OK;
}

/* ---------------- 状态机 ---------------- */

void proto_pending_init(proto_pending_t *p)
{
    if (p != NULL) {
        memset(p, 0, sizeof(*p));
    }
}

int proto_nonce_used(const proto_pending_t *p, const uint8_t nonce[PROTO_NONCE_LEN])
{
    uint8_t i;
    if (p == NULL || nonce == NULL) {
        return 0;
    }
    for (i = 0; i < p->used_count && i < PROTO_REPLAY_WINDOW; i++) {
        if (memcmp(p->used[i], nonce, PROTO_NONCE_LEN) == 0) {
            return 1;
        }
    }
    return 0;
}

void proto_mark_used(proto_pending_t *p, const uint8_t nonce[PROTO_NONCE_LEN])
{
    if (p == NULL || nonce == NULL) {
        return;
    }
    if (p->used_count < PROTO_REPLAY_WINDOW) {
        memcpy(p->used[p->used_count], nonce, PROTO_NONCE_LEN);
        p->used_count++;
    } else {
        /* 窗口满：整体前移，丢掉最旧的一条 */
        memmove(p->used[0], p->used[1], PROTO_NONCE_LEN * (PROTO_REPLAY_WINDOW - 1u));
        memcpy(p->used[PROTO_REPLAY_WINDOW - 1u], nonce, PROTO_NONCE_LEN);
    }
}

int proto_pending_begin(proto_pending_t *p,
                        const uint8_t task_id[PROTO_TASK_ID_LEN],
                        const uint8_t nonce[PROTO_NONCE_LEN],
                        uint8_t action,
                        const uint8_t target_hash[PROTO_HASH_LEN],
                        uint32_t now, uint32_t ttl_sec)
{
    if (p == NULL || task_id == NULL || nonce == NULL || target_hash == NULL) {
        return PROTO_ERR_ARG;
    }
    if (action < PROTO_ACTION_MIN || action > PROTO_ACTION_MAX) {
        return PROTO_ERR_ARG;
    }
    if (ttl_sec == 0 || ttl_sec > UINT32_MAX - now) return PROTO_ERR_ARG;
    if (p->pending && now < p->expires_at) return PROTO_ERR_STATE;
    if (p->pending) {
        proto_mark_used(p, p->nonce);
        p->pending = 0;
    }
    if (proto_nonce_used(p, nonce)) {
        return PROTO_ERR_REPLAY;
    }
    memcpy(p->task_id, task_id, PROTO_TASK_ID_LEN);
    memcpy(p->nonce, nonce, PROTO_NONCE_LEN);
    memcpy(p->target_hash, target_hash, PROTO_HASH_LEN);
    p->action = action;
    p->expires_at = now + ttl_sec;
    p->pending = 1;
    return PROTO_OK;
}

static int accept_decision_internal(proto_pending_t *p, const proto_decision_t *d,
                                    const uint8_t *expected_device, uint8_t action,
                                    const uint8_t *target_hash, int check_binding,
                                    uint32_t now, proto_mac_fn mac, void *ctx)
{
    uint8_t frame[PROTO_DECISION_MAX];
    size_t n;

    if (p == NULL || d == NULL || mac == NULL) {
        return PROTO_ERR_ARG;
    }
    if (check_binding && (expected_device == NULL || target_hash == NULL)) {
        return PROTO_ERR_ARG;
    }
    if (!p->pending) {
        return PROTO_ERR_STATE;
    }
    if (memcmp(p->task_id, d->task_id, PROTO_TASK_ID_LEN) != 0) {
        return PROTO_ERR_TASK;
    }
    if (memcmp(p->nonce, d->nonce, PROTO_NONCE_LEN) != 0) {
        return PROTO_ERR_NONCE;
    }
    if (proto_nonce_used(p, d->nonce)) {
        return PROTO_ERR_REPLAY;
    }
    if (now >= p->expires_at) {
        proto_mark_used(p, p->nonce);
        p->pending = 0;
        return PROTO_ERR_EXPIRED;
    }
    if (d->decision > 1) {
        return PROTO_ERR_DECISION;
    }

    /* 先验 MAC，再核对设备/操作：无密钥者不能靠错误码探测绑定信息 */
    n = proto_encode_decision(d, frame, sizeof(frame), mac, ctx);
    if (n == 0 || !ct_equal(frame + n - PROTO_MAC_LEN, d->mac, PROTO_MAC_LEN)) {
        return PROTO_ERR_MAC;
    }

    if (check_binding) {
        if (!ct_equal(expected_device, d->device_id, 8)) {
            return PROTO_ERR_DEVICE;
        }
        if (p->action != action || !ct_equal(p->target_hash, target_hash, PROTO_HASH_LEN)) {
            return PROTO_ERR_OPERATION;
        }
    }

    if (d->decision == 0) {
        proto_mark_used(p, d->nonce);
        p->pending = 0;
        return PROTO_ERR_DECISION; /* 取消：显式返回拒绝 */
    }

    proto_mark_used(p, d->nonce);
    p->pending = 0;
    return PROTO_OK;
}

int proto_accept_decision(proto_pending_t *p, const proto_decision_t *d,
                          uint32_t now, proto_mac_fn mac, void *ctx)
{
    return accept_decision_internal(p, d, NULL, 0, NULL, 0, now, mac, ctx);
}

int proto_accept_bound_decision(proto_pending_t *p, const proto_decision_t *d,
                                const uint8_t expected_device[8], uint8_t action,
                                const uint8_t target_hash[PROTO_HASH_LEN],
                                uint32_t now, proto_mac_fn mac, void *ctx)
{
    if (action < PROTO_ACTION_MIN || action > PROTO_ACTION_MAX) {
        return PROTO_ERR_ARG;
    }
    return accept_decision_internal(p, d, expected_device, action, target_hash, 1, now, mac, ctx);
}

const char *proto_status_str(int status)
{
    switch (status) {
    case PROTO_OK: return "OK";
    case PROTO_ERR_ARG: return "ARG";
    case PROTO_ERR_BUFFER: return "BUFFER";
    case PROTO_ERR_FRAME: return "FRAME";
    case PROTO_ERR_VERSION: return "VERSION";
    case PROTO_ERR_TYPE: return "TYPE";
    case PROTO_ERR_MAC: return "MAC";
    case PROTO_ERR_EXPIRED: return "EXPIRED";
    case PROTO_ERR_TASK: return "TASK";
    case PROTO_ERR_NONCE: return "NONCE";
    case PROTO_ERR_REPLAY: return "REPLAY";
    case PROTO_ERR_DECISION: return "DECISION";
    case PROTO_ERR_STATE: return "STATE";
    case PROTO_ERR_DEVICE: return "DEVICE";
    case PROTO_ERR_OPERATION: return "OPERATION";
    default: return "UNKNOWN";
    }
}
