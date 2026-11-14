/*
 * 链路保活层（M2）PC 侧测试，不依赖 WS63 SDK。
 *
 * 构建/运行（Git Bash / MSYS2）：
 *   gcc -std=c11 -Wall -Wextra -Werror -O2 -o test_link link.c test_link.c
 *   ./test_link
 */

#include "link.h"

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

static void test_init_args(void)
{
    sfcl_link_t l;

    CHECK(sfcl_link_init(NULL, SFCL_ROLE_EXEC, 1000, 3500) == SFCL_ERR_ARG, "null link rejected");
    CHECK(sfcl_link_init(&l, 2, 1000, 3500) == SFCL_ERR_ARG, "bad role rejected");
    CHECK(sfcl_link_init(&l, SFCL_ROLE_EXEC, 0, 3500) == SFCL_ERR_ARG, "zero heartbeat rejected");
    CHECK(sfcl_link_init(&l, SFCL_ROLE_EXEC, 1000, 1000) == SFCL_ERR_ARG, "timeout <= heartbeat rejected");
    CHECK(sfcl_link_init(&l, SFCL_ROLE_CONFIRM, 1000, 3500) == SFCL_OK, "valid init accepted");
    CHECK(l.state == SFCL_STATE_DOWN, "initial state DOWN");
    CHECK(l.transport_up == 0, "initial transport down");
}

static void test_encode_decode(void)
{
    uint8_t frame[SFCL_FRAME_LEN];
    sfcl_heartbeat_t hb;

    CHECK(sfcl_link_encode(frame, SFCL_ROLE_EXEC, 7, 123456) == SFCL_FRAME_LEN, "encode length");
    CHECK(frame[0] == 'S' && frame[1] == 'F' && frame[2] == 'C' && frame[3] == 'L', "magic SFCL");
    CHECK(frame[4] == SFCL_VERSION, "version");
    CHECK(frame[5] == SFCL_TYPE_HEARTBEAT, "type heartbeat");
    CHECK(frame[6] == SFCL_ROLE_EXEC, "role exec");
    CHECK(frame[7] == 0, "flags reserved");

    CHECK(sfcl_link_decode(frame, sizeof(frame), &hb) == SFCL_OK, "decode ok");
    CHECK(hb.seq == 7, "seq roundtrip");
    CHECK(hb.uptime_ms == 123456, "uptime roundtrip");
    CHECK(hb.role == SFCL_ROLE_EXEC, "role roundtrip");

    CHECK(sfcl_link_encode(frame, 2, 1, 1) == 0, "encode bad role rejected");
    CHECK(sfcl_link_encode(NULL, SFCL_ROLE_EXEC, 1, 1) == 0, "encode null rejected");
}

static void test_decode_rejects(void)
{
    uint8_t frame[SFCL_FRAME_LEN];
    uint8_t bad[SFCL_FRAME_LEN];
    sfcl_heartbeat_t hb;

    (void)sfcl_link_encode(frame, SFCL_ROLE_CONFIRM, 1, 1);
    CHECK(sfcl_link_decode(frame, SFCL_FRAME_LEN - 1, &hb) == SFCL_ERR_FRAME, "short frame rejected");
    CHECK(sfcl_link_decode(frame, SFCL_FRAME_LEN + 1, &hb) == SFCL_ERR_FRAME, "long frame rejected");
    CHECK(sfcl_link_decode(NULL, SFCL_FRAME_LEN, &hb) == SFCL_ERR_ARG, "null buffer rejected");
    CHECK(sfcl_link_decode(frame, SFCL_FRAME_LEN, NULL) == SFCL_ERR_ARG, "null out rejected");

    (void)memcpy(bad, frame, sizeof(bad));
    bad[0] = 'X';
    CHECK(sfcl_link_decode(bad, sizeof(bad), &hb) == SFCL_ERR_FRAME, "bad magic rejected");

    (void)memcpy(bad, frame, sizeof(bad));
    bad[4] = 2;
    CHECK(sfcl_link_decode(bad, sizeof(bad), &hb) == SFCL_ERR_FRAME, "bad version rejected");

    (void)memcpy(bad, frame, sizeof(bad));
    bad[5] = 2;
    CHECK(sfcl_link_decode(bad, sizeof(bad), &hb) == SFCL_ERR_FRAME, "bad type rejected");

    (void)memcpy(bad, frame, sizeof(bad));
    bad[6] = 2;
    CHECK(sfcl_link_decode(bad, sizeof(bad), &hb) == SFCL_ERR_FRAME, "bad role rejected");
}

static void test_tick_requires_transport(void)
{
    sfcl_link_t l;
    uint8_t out[SFCL_FRAME_LEN];

    CHECK(sfcl_link_init(&l, SFCL_ROLE_EXEC, 1000, 3500) == SFCL_OK, "init");
    CHECK(sfcl_link_tick(&l, 0, out) == 0, "no heartbeat while transport down");
    CHECK(sfcl_link_tick(&l, 10000, out) == 0, "still no heartbeat after 10s");
    CHECK(l.tx_count == 0, "tx count stays zero");
}

static void test_heartbeat_cadence(void)
{
    sfcl_link_t l;
    uint8_t out[SFCL_FRAME_LEN];
    sfcl_heartbeat_t hb;

    CHECK(sfcl_link_init(&l, SFCL_ROLE_EXEC, 1000, 3500) == SFCL_OK, "init");
    sfcl_link_transport_up(&l, 0);
    CHECK(l.state == SFCL_STATE_CONNECTED, "connected after transport up");

    CHECK(sfcl_link_tick(&l, 0, out) == 1, "first heartbeat immediately");
    CHECK(sfcl_link_decode(out, sizeof(out), &hb) == SFCL_OK, "first decode");
    CHECK(hb.seq == 0, "first seq 0");
    CHECK(hb.uptime_ms == 0, "uptime 0");

    CHECK(sfcl_link_tick(&l, 10, out) == 0, "no beat before interval");
    CHECK(sfcl_link_tick(&l, 999, out) == 0, "still before interval");
    CHECK(sfcl_link_tick(&l, 1000, out) == 1, "beat at interval");
    CHECK(sfcl_link_decode(out, sizeof(out), &hb) == SFCL_OK, "second decode");
    CHECK(hb.seq == 1, "second seq 1");

    CHECK(sfcl_link_tick(&l, 2000, out) == 1, "beat at 2s");
    CHECK(sfcl_link_decode(out, sizeof(out), &hb) == SFCL_OK, "third decode");
    CHECK(hb.seq == 2, "third seq 2");
    CHECK(l.tx_count == 3, "three sends");
    CHECK(l.tx_seq == 3, "next seq 3");
}

static void test_alive_timeout_recovery(void)
{
    sfcl_link_t l;
    uint8_t frame[SFCL_FRAME_LEN];
    uint8_t out[SFCL_FRAME_LEN];

    CHECK(sfcl_link_init(&l, SFCL_ROLE_CONFIRM, 1000, 3500) == SFCL_OK, "init");
    sfcl_link_transport_up(&l, 0);
    (void)sfcl_link_encode(frame, SFCL_ROLE_EXEC, 1, 100);
    CHECK(sfcl_link_on_frame(&l, frame, sizeof(frame), 100) == SFCL_OK, "valid heartbeat");
    CHECK(l.state == SFCL_STATE_ALIVE, "alive after heartbeat");
    CHECK(l.peer_role == SFCL_ROLE_EXEC, "peer role saved");
    CHECK(l.has_peer == 1, "peer recorded");

    (void)sfcl_link_tick(&l, 2000, out); /* 心跳仍新鲜 */
    CHECK(l.state == SFCL_STATE_ALIVE, "still alive at 2s");
    (void)sfcl_link_tick(&l, 3600, out); /* 3500ms 边界内 */
    CHECK(l.state == SFCL_STATE_ALIVE, "alive at timeout boundary");
    (void)sfcl_link_tick(&l, 3601, out);
    CHECK(l.state == SFCL_STATE_CONNECTED, "timeout downgrades to CONNECTED");
    CHECK(l.timeout_count == 1, "timeout counted once");

    (void)sfcl_link_encode(frame, SFCL_ROLE_EXEC, 2, 3700);
    CHECK(sfcl_link_on_frame(&l, frame, sizeof(frame), 3700) == SFCL_OK, "recovery heartbeat");
    CHECK(l.state == SFCL_STATE_ALIVE, "recovered without reconnect");
    CHECK(l.transport_up == 1, "transport still up");
    CHECK(l.up_count == 1, "no extra transport up event");
    CHECK(l.timeout_count == 1, "timeout count unchanged on recovery");

    (void)sfcl_link_tick(&l, 7201, out); /* 3700 + 3500 + 1 */
    CHECK(l.state == SFCL_STATE_CONNECTED, "second timeout");
    CHECK(l.timeout_count == 2, "second timeout counted");
}

static void test_transport_down_up(void)
{
    sfcl_link_t l;
    uint8_t frame[SFCL_FRAME_LEN];

    CHECK(sfcl_link_init(&l, SFCL_ROLE_EXEC, 1000, 3500) == SFCL_OK, "init");
    sfcl_link_transport_up(&l, 0);
    CHECK(l.up_count == 1, "up counted");
    (void)sfcl_link_encode(frame, SFCL_ROLE_CONFIRM, 1, 10);
    CHECK(sfcl_link_on_frame(&l, frame, sizeof(frame), 10) == SFCL_OK, "heartbeat");
    CHECK(l.state == SFCL_STATE_ALIVE, "alive");

    sfcl_link_transport_down(&l, 20);
    CHECK(l.state == SFCL_STATE_DOWN, "down");
    CHECK(l.down_count == 1, "down counted");
    CHECK(l.last_rx_ms == 0, "rx timestamp cleared");
    CHECK(l.has_peer == 1, "peer identity retained for diagnostics");

    sfcl_link_transport_up(&l, 30);
    CHECK(l.state == SFCL_STATE_CONNECTED, "reconnect starts CONNECTED, not stale ALIVE");
    CHECK(l.up_count == 2, "second up counted");
    CHECK(l.last_rx_ms == 0, "no stale rx after reconnect");

    /* 重复的 up/down 事件不应重复计数 */
    sfcl_link_transport_up(&l, 40);
    CHECK(l.up_count == 2, "duplicate up ignored");
}

/* 对端重启后 seq 从 0 开始：重连时必须重建基线，不能把旧基线拿来判 stale/gap。 */
static void test_reconnect_seq_reset(void)
{
    sfcl_link_t l;
    uint8_t frame[SFCL_FRAME_LEN];

    CHECK(sfcl_link_init(&l, SFCL_ROLE_CONFIRM, 1000, 3500) == SFCL_OK, "init");
    sfcl_link_transport_up(&l, 0);
    (void)sfcl_link_encode(frame, SFCL_ROLE_EXEC, 100, 1000);
    CHECK(sfcl_link_on_frame(&l, frame, sizeof(frame), 10) == SFCL_OK, "pre-reboot heartbeat");
    CHECK(l.last_peer_seq == 100, "old baseline 100");
    CHECK(l.seq_started == 1, "seq baseline established");

    sfcl_link_transport_down(&l, 20);
    CHECK(l.seq_started == 0, "seq baseline cleared on disconnect");
    CHECK(l.last_peer_seq == 0, "peer seq cleared on disconnect");
    sfcl_link_transport_up(&l, 30);

    (void)sfcl_link_encode(frame, SFCL_ROLE_EXEC, 0, 100);
    CHECK(sfcl_link_on_frame(&l, frame, sizeof(frame), 31) == SFCL_OK, "post-reboot seq 0");
    CHECK(l.state == SFCL_STATE_ALIVE, "alive after reboot");
    CHECK(l.rx_stale == 0, "seq 0 not counted stale after reconnect");
    CHECK(l.rx_gap == 0, "seq 0 adds no bogus gap");

    (void)sfcl_link_encode(frame, SFCL_ROLE_EXEC, 1, 1100);
    CHECK(sfcl_link_on_frame(&l, frame, sizeof(frame), 32) == SFCL_OK, "post-reboot seq 1");
    CHECK(l.rx_stale == 0, "still no stale");
    CHECK(l.rx_gap == 0, "still no gap");
    CHECK(l.rx_count == 3, "rx count across reconnect");
}

static void test_parser(void)
{
    uint8_t stream[64];
    uint8_t frame1[SFCL_FRAME_LEN];
    uint8_t frame2[SFCL_FRAME_LEN];
    uint8_t got[SFCL_FRAME_LEN];
    sfcl_heartbeat_t hb;
    sfcl_parser_t p;
    size_t n = 0;
    size_t i;
    int count = 0;
    uint32_t seqs[2] = { 0, 0 };

    (void)sfcl_link_encode(frame1, SFCL_ROLE_EXEC, 5, 1000);
    (void)sfcl_link_encode(frame2, SFCL_ROLE_CONFIRM, 6, 2000);

    /* 噪声 + 帧1 + 噪声 + 帧2；噪声里故意带一个 SFC1 magic 干扰 */
    stream[n++] = 0x00;
    stream[n++] = 0x11;
    stream[n++] = 0x22;
    (void)memcpy(&stream[n], frame1, SFCL_FRAME_LEN);
    n += SFCL_FRAME_LEN;
    stream[n++] = 'S';
    stream[n++] = 'F';
    stream[n++] = 'C';
    stream[n++] = '1';
    stream[n++] = 0xff;
    (void)memcpy(&stream[n], frame2, SFCL_FRAME_LEN);
    n += SFCL_FRAME_LEN;

    sfcl_parser_init(&p);
    for (i = 0; i < n; i++) {
        if (sfcl_parser_feed(&p, stream[i], got)) {
            CHECK(count < 2, "parser produced at most two frames");
            if (count < 2 && sfcl_link_decode(got, sizeof(got), &hb) == SFCL_OK) {
                seqs[count] = hb.seq;
            }
            count++;
        }
    }
    CHECK(count == 2, "parser found two frames through noise");
    CHECK(seqs[0] == 5, "first parsed seq 5");
    CHECK(seqs[1] == 6, "second parsed seq 6");

    /* 全 0xFF 不应产出帧 */
    sfcl_parser_init(&p);
    count = 0;
    for (i = 0; i < SFCL_FRAME_LEN * 2; i++) {
        if (sfcl_parser_feed(&p, 0xff, got)) {
            count++;
        }
    }
    CHECK(count == 0, "0xFF noise yields no frame");
}

static void test_seq_counters(void)
{
    sfcl_link_t l;
    uint8_t frame[SFCL_FRAME_LEN];

    CHECK(sfcl_link_init(&l, SFCL_ROLE_CONFIRM, 1000, 3500) == SFCL_OK, "init");
    sfcl_link_transport_up(&l, 0);

    (void)sfcl_link_encode(frame, SFCL_ROLE_EXEC, 1, 1);
    CHECK(sfcl_link_on_frame(&l, frame, sizeof(frame), 1) == SFCL_OK, "seq 1");
    CHECK(l.rx_gap == 0, "no gap for first");

    (void)sfcl_link_encode(frame, SFCL_ROLE_EXEC, 4, 4);
    CHECK(sfcl_link_on_frame(&l, frame, sizeof(frame), 4) == SFCL_OK, "seq 4");
    CHECK(l.rx_gap == 2, "gap counts two missing");

    CHECK(sfcl_link_on_frame(&l, frame, sizeof(frame), 5) == SFCL_OK, "duplicate seq 4");
    CHECK(l.rx_stale == 1, "duplicate counted stale");

    (void)sfcl_link_encode(frame, SFCL_ROLE_EXEC, 3, 3);
    CHECK(sfcl_link_on_frame(&l, frame, sizeof(frame), 6) == SFCL_OK, "out-of-order seq 3");
    CHECK(l.rx_stale == 2, "out-of-order counted stale");

    (void)sfcl_link_encode(frame, SFCL_ROLE_EXEC, 5, 5);
    CHECK(sfcl_link_on_frame(&l, frame, sizeof(frame), 7) == SFCL_OK, "seq 5");
    CHECK(l.rx_gap == 2, "in-order frame adds no gap");
    CHECK(l.rx_count == 5, "rx count");

    /* 坏帧只增加 rx_bad，不影响 ALIVE */
    CHECK(l.state == SFCL_STATE_ALIVE, "alive before bad frame");
    frame[0] = 'X';
    CHECK(sfcl_link_on_frame(&l, frame, sizeof(frame), 8) == SFCL_ERR_FRAME, "bad frame rejected");
    CHECK(l.rx_bad == 1, "bad frame counted");
    CHECK(l.state == SFCL_STATE_ALIVE, "bad frame does not kill link");

    sfcl_link_on_send_fail(&l);
    CHECK(l.send_fail_count == 1, "send failure counted");
}

/* 两个节点在 10% 丢包 + 一次 5s 断链（传输不断）下互发心跳：
 * 断言两边都超时、都恢复 ALIVE，且没有触发重连计数。 */
static void test_two_node_simulation(void)
{
    sfcl_link_t a;
    sfcl_link_t b;
    uint8_t fa[SFCL_FRAME_LEN];
    uint8_t fb[SFCL_FRAME_LEN];
    uint64_t t;
    int a_down_at_9500 = 0;
    int b_down_at_9500 = 0;

    CHECK(sfcl_link_init(&a, SFCL_ROLE_EXEC, 1000, 3500) == SFCL_OK, "init a");
    CHECK(sfcl_link_init(&b, SFCL_ROLE_CONFIRM, 1000, 3500) == SFCL_OK, "init b");
    sfcl_link_transport_up(&a, 0);
    sfcl_link_transport_up(&b, 0);

    for (t = 0; t <= 16000; t += 10) {
        if (sfcl_link_tick(&a, t, fa)) {
            int outage = (t >= 5000 && t < 10000);
            int loss = ((fa[8] % 5u) == 2u);
            if (!outage && !loss) {
                (void)sfcl_link_on_frame(&b, fa, sizeof(fa), t);
            }
        }
        if (sfcl_link_tick(&b, t, fb)) {
            int outage = (t >= 5000 && t < 10000);
            int loss = ((fb[8] % 5u) == 2u);
            if (!outage && !loss) {
                (void)sfcl_link_on_frame(&a, fb, sizeof(fb), t);
            }
        }
        if (t == 9500) {
            a_down_at_9500 = (a.state == SFCL_STATE_CONNECTED);
            b_down_at_9500 = (b.state == SFCL_STATE_CONNECTED);
        }
    }

    CHECK(a_down_at_9500, "A detected peer loss during outage");
    CHECK(b_down_at_9500, "B detected peer loss during outage");
    CHECK(a.state == SFCL_STATE_ALIVE, "A recovered alive");
    CHECK(b.state == SFCL_STATE_ALIVE, "B recovered alive");
    CHECK(a.up_count == 1 && b.up_count == 1, "no transport re-up");
    CHECK(a.down_count == 0 && b.down_count == 0, "no transport down");
    CHECK(a.timeout_count >= 1 && b.timeout_count >= 1, "both counted timeout");
    CHECK(a.rx_gap > 0 && b.rx_gap > 0, "both observed dropped heartbeats");
    CHECK(a.peer_role == SFCL_ROLE_CONFIRM, "A sees confirm peer");
    CHECK(b.peer_role == SFCL_ROLE_EXEC, "B sees exec peer");
}

int main(void)
{
    test_init_args();
    test_encode_decode();
    test_decode_rejects();
    test_tick_requires_transport();
    test_heartbeat_cadence();
    test_alive_timeout_recovery();
    test_transport_down_up();
    test_reconnect_seq_reset();
    test_parser();
    test_seq_counters();
    test_two_node_simulation();

    if (g_failures == 0) {
        printf("PASS: all link tests\n");
        return 0;
    }
    printf("FAILED: %d check(s)\n", g_failures);
    return 1;
}
