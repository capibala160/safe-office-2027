/*
 * SLE 字节流分发（M3'）PC 侧测试，不依赖 WS63 SDK。
 *
 * 构建/运行（Git Bash / MSYS2）：
 *   gcc -std=c11 -Wall -Wextra -Werror -O2 -o test_route link.c sfc1_route.c test_route.c
 *   ./test_route
 */

#include "link.h"
#include "protocol.h"
#include "sfc1_route.h"

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

/* 造一个最小合法形态的业务帧：header(10) + payload + MAC(32)。分流不验 MAC。 */
static size_t build_biz_frame(uint8_t *out, size_t cap, uint8_t type,
                              const uint8_t *payload, uint16_t payload_len)
{
    uint16_t len = (uint16_t)(payload_len + PROTO_MAC_LEN);
    size_t total = (size_t)PROTO_HEADER_LEN + len;
    size_t i;

    if (total > cap) {
        return 0;
    }
    out[0] = 'S'; out[1] = 'F'; out[2] = 'C'; out[3] = '1';
    out[4] = 1; out[5] = type; out[6] = 0; out[7] = 0;
    out[8] = (uint8_t)(len & 0xFFu);
    out[9] = (uint8_t)(len >> 8);
    for (i = 0; i < payload_len; i++) {
        out[PROTO_HEADER_LEN + i] = payload[i];
    }
    for (i = 0; i < PROTO_MAC_LEN; i++) {
        out[PROTO_HEADER_LEN + payload_len + i] = (uint8_t)(0xA0u + i);
    }
    return total;
}

static void feed_all(sfc1_route_t *r, const uint8_t *data, size_t len,
                     int *link_events, int *biz_events,
                     uint8_t *last_biz_type, uint16_t *last_biz_len)
{
    size_t i;
    uint8_t link_out[SFCL_FRAME_LEN];
    const uint8_t *biz = NULL;
    uint16_t biz_len = 0;
    uint8_t biz_type = 0;

    for (i = 0; i < len; i++) {
        sfc1_route_ev_t ev = sfc1_route_feed(r, data[i], link_out, &biz, &biz_len, &biz_type);
        if (ev == SFC1_ROUTE_EV_LINK) {
            (*link_events)++;
        } else if (ev == SFC1_ROUTE_EV_BIZ) {
            (*biz_events)++;
            if (last_biz_type != NULL) {
                *last_biz_type = biz_type;
            }
            if (last_biz_len != NULL) {
                *last_biz_len = biz_len;
            }
        }
    }
}

static void test_link_only(void)
{
    sfc1_route_t r;
    uint8_t frame[SFCL_FRAME_LEN];
    int link_events = 0;
    int biz_events = 0;

    sfc1_route_init(&r);
    CHECK(sfcl_link_encode(frame, SFCL_ROLE_CONFIRM, 3, 1000) == SFCL_FRAME_LEN, "encode heartbeat");
    feed_all(&r, frame, sizeof(frame), &link_events, &biz_events, NULL, NULL);
    CHECK(link_events == 1, "one heartbeat event");
    CHECK(biz_events == 0, "no biz event for heartbeat");
}

static void test_biz_only(void)
{
    sfc1_route_t r;
    uint8_t frame[PROTO_CHALLENGE_MAX + 1u];
    uint8_t payload[8] = { 1, 2, 3, 4, 5, 6, 7, 8 };
    size_t n;
    int link_events = 0;
    int biz_events = 0;
    uint8_t type = 0;
    uint16_t len = 0;

    sfc1_route_init(&r);
    n = build_biz_frame(frame, sizeof(frame), PROTO_TYPE_CHALLENGE, payload, sizeof(payload));
    CHECK(n > 0, "build biz frame");
    feed_all(&r, frame, n, &link_events, &biz_events, &type, &len);
    CHECK(biz_events == 1, "one biz event");
    CHECK(link_events == 0, "no link event for biz frame");
    CHECK(type == PROTO_TYPE_CHALLENGE, "biz type preserved");
    CHECK(len == n, "biz length preserved");
}

static void test_interleaved(void)
{
    sfc1_route_t r;
    uint8_t stream[128];
    uint8_t hb[SFCL_FRAME_LEN];
    uint8_t biz[PROTO_DECISION_MAX + 1u];
    uint8_t payload[4] = { 9, 9, 9, 9 };
    size_t biz_len;
    size_t pos = 0;
    int link_events = 0;
    int biz_events = 0;
    uint8_t type = 0;

    sfc1_route_init(&r);
    (void)sfcl_link_encode(hb, SFCL_ROLE_EXEC, 1, 10);
    biz_len = build_biz_frame(biz, sizeof(biz), PROTO_TYPE_DECISION, payload, sizeof(payload));
    CHECK(biz_len > 0, "build decision");

    (void)memcpy(stream + pos, hb, sizeof(hb));
    pos += sizeof(hb);
    (void)memcpy(stream + pos, biz, biz_len);
    pos += biz_len;
    (void)sfcl_link_encode(hb, SFCL_ROLE_EXEC, 2, 20);
    (void)memcpy(stream + pos, hb, sizeof(hb));
    pos += sizeof(hb);

    feed_all(&r, stream, pos, &link_events, &biz_events, &type, NULL);
    CHECK(link_events == 2, "two heartbeats in stream");
    CHECK(biz_events == 1, "one biz frame in stream");
    CHECK(type == PROTO_TYPE_DECISION, "interleaved type");
}

static void test_noise_before_magic(void)
{
    sfc1_route_t r;
    uint8_t stream[64];
    uint8_t hb[SFCL_FRAME_LEN];
    static const uint8_t noise[] = { 0x00, 0xFF, 'S', 0x13, 'A' };
    int link_events = 0;
    int biz_events = 0;

    sfc1_route_init(&r);
    (void)sfcl_link_encode(hb, SFCL_ROLE_CONFIRM, 5, 55);
    (void)memcpy(stream, noise, sizeof(noise));
    (void)memcpy(stream + sizeof(noise), hb, sizeof(hb));
    feed_all(&r, stream, sizeof(noise) + sizeof(hb), &link_events, &biz_events, NULL, NULL);
    CHECK(link_events == 1, "resync after noise");
    CHECK(biz_events == 0, "noise does not fake biz event");
}

static void test_bad_biz_length_resync(void)
{
    sfc1_route_t r;
    uint8_t stream[80];
    uint8_t hb[SFCL_FRAME_LEN];
    uint8_t bad[PROTO_HEADER_LEN];
    int link_events = 0;
    int biz_events = 0;

    sfc1_route_init(&r);
    /* header 声明 length=0（< MAC 长度）→ 应被丢弃并重新找 magic */
    bad[0] = 'S'; bad[1] = 'F'; bad[2] = 'C'; bad[3] = '1';
    bad[4] = 1; bad[5] = PROTO_TYPE_CHALLENGE; bad[6] = 0; bad[7] = 0;
    bad[8] = 0; bad[9] = 0;
    (void)memcpy(stream, bad, sizeof(bad));
    (void)sfcl_link_encode(hb, SFCL_ROLE_CONFIRM, 1, 1);
    (void)memcpy(stream + sizeof(bad), hb, sizeof(hb));

    feed_all(&r, stream, sizeof(bad) + sizeof(hb), &link_events, &biz_events, NULL, NULL);
    CHECK(biz_events == 0, "invalid length dropped");
    CHECK(link_events == 1, "resync to heartbeat after bad length");
}

static void test_byte_by_byte(void)
{
    sfc1_route_t r;
    uint8_t frame[PROTO_CHALLENGE_MAX + 1u];
    uint8_t payload[1] = { 7 };
    size_t n;
    int link_events = 0;
    int biz_events = 0;

    sfc1_route_init(&r);
    n = build_biz_frame(frame, sizeof(frame), 0x33, payload, sizeof(payload));
    CHECK(n > 0, "build byte-by-byte frame");
    feed_all(&r, frame, n, &link_events, &biz_events, NULL, NULL);
    CHECK(biz_events == 1, "byte-by-byte still assembles");
}

static void test_null_args(void)
{
    sfc1_route_t r;
    uint8_t out[SFCL_FRAME_LEN];
    const uint8_t *biz = NULL;
    uint16_t len = 0;
    uint8_t type = 0;

    sfc1_route_init(NULL); /* 不应崩 */
    CHECK(sfc1_route_feed(NULL, 'S', out, &biz, &len, &type) == SFC1_ROUTE_EV_NONE, "null route");
    sfc1_route_init(&r);
    CHECK(sfc1_route_feed(&r, 'S', NULL, &biz, &len, &type) == SFC1_ROUTE_EV_NONE, "null out");
    CHECK(sfc1_route_feed(&r, 'S', out, NULL, &len, &type) == SFC1_ROUTE_EV_NONE, "null biz ptr");
}

int main(void)
{
    test_link_only();
    test_biz_only();
    test_interleaved();
    test_noise_before_magic();
    test_bad_biz_length_resync();
    test_byte_by_byte();
    test_null_args();

    if (g_failures == 0) {
        printf("PASS: all route tests\n");
        return 0;
    }
    printf("FAILED: %d route test(s)\n", g_failures);
    return 1;
}
