/*
 * 协议核心的 PC 侧测试（不依赖 WS63 SDK）
 *
 * 构建/运行（Git Bash / MSYS2）：
 *   gcc -std=c11 -Wall -Wextra -O2 -o test_protocol protocol.c test_protocol.c
 *   ./test_protocol
 *
 * 说明：这里的 mac 是测试用确定性伪 MAC，不是 HMAC-SHA256。
 *       板端用 mbedTLS 的 HMAC-SHA256 替换（见 README 的接入示例）。
 */

#include "protocol.h"

#include <stdio.h>
#include <string.h>

static int g_failures = 0;

#define CHECK(cond, msg)                                                        \
    do {                                                                        \
        if (!(cond)) {                                                          \
            printf("FAIL line %d: %s\n", __LINE__, (msg));                      \
            g_failures++;                                                       \
        }                                                                       \
    } while (0)

#define CHECK_STATUS(actual, expected, msg)                                     \
    do {                                                                        \
        int a_ = (actual);                                                      \
        int e_ = (expected);                                                    \
        if (a_ != e_) {                                                         \
            printf("FAIL line %d: %s (got %s=%d, want %s=%d)\n",                \
                   __LINE__, (msg), proto_status_str(a_), a_,                   \
                   proto_status_str(e_), e_);                                   \
            g_failures++;                                                       \
        }                                                                       \
    } while (0)

/* 测试用确定性 MAC：只用于验证帧/状态机，不是密码学 MAC */
static int test_mac(const uint8_t *data, size_t len,
                    uint8_t out[PROTO_MAC_LEN], void *ctx)
{
    uint64_t h = 1469598103934665603ULL;
    size_t i;
    (void)ctx;
    for (i = 0; i < len; i++) {
        h ^= data[i];
        h *= 1099511628211ULL;
    }
    for (i = 0; i < PROTO_MAC_LEN; i++) {
        h ^= h >> 33;
        h *= 0xff51afd7ed558ccdULL;
        out[i] = (uint8_t)(h >> (8u * (i % 8u)));
    }
    return 0;
}

static void fill_bytes(uint8_t *out, size_t n, uint8_t seed)
{
    size_t i;
    for (i = 0; i < n; i++) {
        out[i] = (uint8_t)(seed + (uint8_t)i);
    }
}

static void make_challenge(proto_challenge_t *c, uint8_t seed, uint32_t now)
{
    static const char summary[] = "send M1 to partner@example.com";
    memset(c, 0, sizeof(*c));
    fill_bytes(c->task_id, PROTO_TASK_ID_LEN, seed);
    fill_bytes(c->nonce, PROTO_NONCE_LEN, (uint8_t)(seed + 1));
    fill_bytes(c->target_hash, PROTO_HASH_LEN, (uint8_t)(seed + 2));
    c->action = 1;
    c->issued_at = now;
    c->expires_at = now + 30;
    c->summary_len = (uint8_t)(sizeof(summary) - 1u);
    memcpy(c->summary, summary, c->summary_len);
    c->summary[c->summary_len] = '\0';
}

static void make_decision(proto_decision_t *d, const proto_challenge_t *c,
                          uint8_t decision, uint32_t now)
{
    memset(d, 0, sizeof(*d));
    memcpy(d->task_id, c->task_id, PROTO_TASK_ID_LEN);
    memcpy(d->nonce, c->nonce, PROTO_NONCE_LEN);
    d->decision = decision;
    fill_bytes(d->device_id, 8, 0xA0);
    d->decided_at = now;
}

static void test_challenge_roundtrip(void)
{
    proto_challenge_t c, out;
    uint8_t frame[PROTO_CHALLENGE_MAX];
    size_t n;

    make_challenge(&c, 0x10, 1000);
    n = proto_encode_challenge(&c, frame, sizeof(frame), test_mac, NULL);
    CHECK(n == PROTO_HEADER_LEN + PROTO_CHALLENGE_PAYLOAD_FIXED + c.summary_len + PROTO_MAC_LEN,
          "challenge frame length");
    CHECK_STATUS(proto_decode_challenge(frame, n, &out, test_mac, NULL), PROTO_OK,
                 "challenge decode");
    CHECK(memcmp(c.task_id, out.task_id, PROTO_TASK_ID_LEN) == 0, "task id roundtrip");
    CHECK(memcmp(c.nonce, out.nonce, PROTO_NONCE_LEN) == 0, "nonce roundtrip");
    CHECK(memcmp(c.target_hash, out.target_hash, PROTO_HASH_LEN) == 0, "hash roundtrip");
    CHECK(out.action == c.action, "action roundtrip");
    CHECK(out.issued_at == c.issued_at && out.expires_at == c.expires_at, "time roundtrip");
    CHECK(out.summary_len == c.summary_len, "summary len roundtrip");
    CHECK(strcmp(out.summary, c.summary) == 0, "summary roundtrip");
}

static void test_decision_roundtrip(void)
{
    proto_challenge_t c;
    proto_decision_t d, out;
    uint8_t frame[PROTO_DECISION_MAX];
    size_t n;

    make_challenge(&c, 0x20, 1000);
    make_decision(&d, &c, 1, 1005);
    n = proto_encode_decision(&d, frame, sizeof(frame), test_mac, NULL);
    CHECK(n == PROTO_DECISION_MAX, "decision frame length");
    CHECK_STATUS(proto_decode_decision(frame, n, &out, test_mac, NULL), PROTO_OK,
                 "decision decode");
    CHECK(memcmp(d.task_id, out.task_id, PROTO_TASK_ID_LEN) == 0, "decision task roundtrip");
    CHECK(memcmp(d.nonce, out.nonce, PROTO_NONCE_LEN) == 0, "decision nonce roundtrip");
    CHECK(out.decision == 1, "decision value roundtrip");
    CHECK(out.decided_at == d.decided_at, "decision time roundtrip");
}

static void test_accept_ok_and_replay(void)
{
    proto_challenge_t c;
    proto_decision_t d, decoded;
    proto_pending_t p;
    uint8_t frame[PROTO_DECISION_MAX];
    size_t n;

    make_challenge(&c, 0x30, 1000);
    proto_pending_init(&p);
    CHECK_STATUS(proto_pending_begin(&p, c.task_id, c.nonce, c.action,
                                     c.target_hash, 1000, 30),
                 PROTO_OK, "pending begin");
    make_decision(&d, &c, 1, 1005);
    n = proto_encode_decision(&d, frame, sizeof(frame), test_mac, NULL);
    CHECK(n > 0, "decision encode");
    CHECK_STATUS(proto_decode_decision(frame, n, &decoded, test_mac, NULL), PROTO_OK,
                 "decision decode for accept");
    CHECK_STATUS(proto_accept_decision(&p, &decoded, 1005, test_mac, NULL), PROTO_OK,
                 "accept approve");
    CHECK(p.pending == 0, "pending cleared after approve");
    CHECK(proto_nonce_used(&p, c.nonce) == 1, "nonce marked used");

    /* 同一决定再投一次：pending 已清空 → 状态拒绝 */
    CHECK_STATUS(proto_accept_decision(&p, &decoded, 1006, test_mac, NULL), PROTO_ERR_STATE,
                 "replay after accept rejected");

    /* 同一 nonce 不能再开新任务 */
    CHECK_STATUS(proto_pending_begin(&p, c.task_id, c.nonce, c.action,
                                     c.target_hash, 1007, 30),
                 PROTO_ERR_REPLAY, "nonce reuse rejected");
}

static void test_cancel(void)
{
    proto_challenge_t c;
    proto_decision_t d;
    proto_pending_t p;
    uint8_t frame[PROTO_DECISION_MAX];
    size_t n;

    make_challenge(&c, 0x40, 2000);
    proto_pending_init(&p);
    CHECK_STATUS(proto_pending_begin(&p, c.task_id, c.nonce, c.action,
                                     c.target_hash, 2000, 30),
                 PROTO_OK, "cancel pending begin");
    make_decision(&d, &c, 0, 2005);
    n = proto_encode_decision(&d, frame, sizeof(frame), test_mac, NULL);
    CHECK(n > 0, "cancel decision encodes");
    memcpy(d.mac, frame + n - PROTO_MAC_LEN, PROTO_MAC_LEN);
    CHECK_STATUS(proto_accept_decision(&p, &d, 2005, test_mac, NULL), PROTO_ERR_DECISION,
                 "cancel rejected");
    CHECK(p.pending == 0, "pending cleared after cancel");
}

static void test_expired(void)
{
    proto_challenge_t c;
    proto_decision_t d;
    proto_pending_t p;

    make_challenge(&c, 0x50, 3000);
    proto_pending_init(&p);
    CHECK_STATUS(proto_pending_begin(&p, c.task_id, c.nonce, c.action,
                                     c.target_hash, 3000, 10),
                 PROTO_OK, "expire pending begin");
    make_decision(&d, &c, 1, 3011);
    CHECK_STATUS(proto_accept_decision(&p, &d, 3011, test_mac, NULL), PROTO_ERR_EXPIRED,
                 "expired decision rejected");
    CHECK(p.pending == 0, "pending cleared after expiry");
}

static void test_wrong_task_and_nonce(void)
{
    proto_challenge_t c;
    proto_decision_t d;
    proto_pending_t p;

    make_challenge(&c, 0x60, 4000);
    proto_pending_init(&p);
    CHECK_STATUS(proto_pending_begin(&p, c.task_id, c.nonce, c.action,
                                     c.target_hash, 4000, 30),
                 PROTO_OK, "wrong-task pending begin");

    make_decision(&d, &c, 1, 4005);
    d.task_id[0] ^= 0xffu;
    CHECK_STATUS(proto_accept_decision(&p, &d, 4005, test_mac, NULL), PROTO_ERR_TASK,
                 "wrong task rejected");

    make_decision(&d, &c, 1, 4005);
    d.nonce[0] ^= 0xffu;
    CHECK_STATUS(proto_accept_decision(&p, &d, 4005, test_mac, NULL), PROTO_ERR_NONCE,
                 "wrong nonce rejected");
}

static void test_tamper(void)
{
    proto_challenge_t c, out;
    uint8_t frame[PROTO_CHALLENGE_MAX];
    size_t n;

    make_challenge(&c, 0x70, 5000);
    n = proto_encode_challenge(&c, frame, sizeof(frame), test_mac, NULL);
    CHECK(n > 0, "tamper encode");
    /* summary 第一个字节位于 10 + 66 */
    frame[PROTO_HEADER_LEN + PROTO_CHALLENGE_PAYLOAD_FIXED] ^= 0x01u;
    CHECK_STATUS(proto_decode_challenge(frame, n, &out, test_mac, NULL), PROTO_ERR_MAC,
                 "tampered summary rejected by MAC");
}

static void test_header_and_buffer(void)
{
    proto_challenge_t c;
    uint8_t frame[PROTO_CHALLENGE_MAX];
    size_t n;

    make_challenge(&c, 0x80, 6000);
    CHECK(proto_encode_challenge(&c, frame, 10, test_mac, NULL) == 0,
          "small buffer rejected");

    n = proto_encode_challenge(&c, frame, sizeof(frame), test_mac, NULL);
    CHECK(n > 0, "header encode");
    frame[0] = 'X';
    CHECK_STATUS(proto_decode_challenge(frame, n, &c, test_mac, NULL), PROTO_ERR_FRAME,
                 "bad magic rejected");
}

static void test_decision_mac_recheck(void)
{
    proto_challenge_t c;
    proto_decision_t d, decoded;
    proto_pending_t p;
    uint8_t frame[PROTO_DECISION_MAX];
    size_t n;

    make_challenge(&c, 0x90, 7000);
    proto_pending_init(&p);
    CHECK_STATUS(proto_pending_begin(&p, c.task_id, c.nonce, c.action,
                                     c.target_hash, 7000, 30),
                 PROTO_OK, "recheck pending begin");
    make_decision(&d, &c, 1, 7005);
    n = proto_encode_decision(&d, frame, sizeof(frame), test_mac, NULL);
    CHECK_STATUS(proto_decode_decision(frame, n, &decoded, test_mac, NULL), PROTO_OK,
                 "recheck decode");
    /* 解码后篡改结构体：accept 必须重新验 MAC */
    decoded.decision = 0;
    CHECK_STATUS(proto_accept_decision(&p, &decoded, 7005, test_mac, NULL), PROTO_ERR_MAC,
                 "accept re-verifies MAC");
}

int main(void)
{
    test_challenge_roundtrip();
    test_decision_roundtrip();
    test_accept_ok_and_replay();
    test_cancel();
    test_expired();
    test_wrong_task_and_nonce();
    test_tamper();
    test_header_and_buffer();
    test_decision_mac_recheck();

    if (g_failures == 0) {
        printf("PASS: all protocol tests\n");
        return 0;
    }
    printf("FAILED: %d check(s)\n", g_failures);
    return 1;
}
