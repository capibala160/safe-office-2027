/*
 * SFC1 掉电保存实现（M1）。详见 sfc1_nv.h 的记录格式与边界。
 *
 * NV 项 key 选在 region 0 的 0x0F01；SDK 样例见 0x20A0 / SLE_RSSI_CAL_NV_ID，
 * 若将来与 SDK 冲突，只改 SFC1_NV_KEY 这一处。
 */
#include "sfc1_nv.h"

#include <stdio.h>
#include <string.h>
#include "securec.h"
#include "nv.h"
#include "sfc1_hmac.h"

#define SFC1_NV_KEY 0x0F01u
#define SFC1_NV_MAGIC_LEN 8u
#define SFC1_NV_VERSION 1u
#define SFC1_NV_HEAD_LEN 16u
#define SFC1_NV_BODY_LEN (SFC1_NV_HEAD_LEN + (PROTO_NONCE_LEN * PROTO_REPLAY_WINDOW))
#define SFC1_NV_TAG_LEN 16u
#define SFC1_NV_SIZE (SFC1_NV_BODY_LEN + SFC1_NV_TAG_LEN)

static const uint8_t SFC1_NV_MAGIC[SFC1_NV_MAGIC_LEN] = { 'S', 'F', 'C', '1', 'N', 'V', '1', '\0' };
static uint32_t g_nv_seq;

static void put_u32(uint8_t *p, uint32_t v)
{
    p[0] = (uint8_t)(v & 0xFFu);
    p[1] = (uint8_t)((v >> 8) & 0xFFu);
    p[2] = (uint8_t)((v >> 16) & 0xFFu);
    p[3] = (uint8_t)((v >> 24) & 0xFFu);
}

static uint32_t get_u32(const uint8_t *p)
{
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

int sfc1_nv_load(uint8_t used[PROTO_REPLAY_WINDOW][PROTO_NONCE_LEN], uint8_t *count, const uint8_t *key)
{
    uint8_t buf[SFC1_NV_SIZE];
    uint8_t mac[32];
    uint16_t len = 0;
    uint8_t n;

    if (used == NULL || count == NULL || key == NULL) {
        return 0;
    }
    (void)memset_s(used, (size_t)PROTO_REPLAY_WINDOW * PROTO_NONCE_LEN, 0,
                   (size_t)PROTO_REPLAY_WINDOW * PROTO_NONCE_LEN);
    *count = 0;

    uapi_nv_init();
    if (uapi_nv_read(SFC1_NV_KEY, (uint16_t)sizeof(buf), &len, buf) != 0) {
        printf("SFC1 NV: no record\r\n");
        return 0;
    }
    if (len != SFC1_NV_SIZE) {
        printf("SFC1 NV: size mismatch (%u)\r\n", (unsigned)len);
        return 0;
    }
    if (memcmp(buf, SFC1_NV_MAGIC, SFC1_NV_MAGIC_LEN) != 0 || buf[8] != SFC1_NV_VERSION) {
        printf("SFC1 NV: magic/version mismatch\r\n");
        return 0;
    }
    if (sfc1_hmac_sha256(buf, SFC1_NV_BODY_LEN, mac, (void *)key) != 0) {
        printf("SFC1 NV: hmac error\r\n");
        return 0;
    }
    if (memcmp(mac, buf + SFC1_NV_BODY_LEN, SFC1_NV_TAG_LEN) != 0) {
        printf("SFC1 NV: tag mismatch, ignored\r\n");
        return 0;
    }

    n = buf[9];
    if (n > PROTO_REPLAY_WINDOW) {
        n = PROTO_REPLAY_WINDOW;
    }
    (void)memcpy_s(used, (size_t)PROTO_REPLAY_WINDOW * PROTO_NONCE_LEN,
                   buf + SFC1_NV_HEAD_LEN, (size_t)n * PROTO_NONCE_LEN);
    *count = n;
    g_nv_seq = get_u32(buf + 12);
    return 1;
}

int sfc1_nv_save(const uint8_t used[PROTO_REPLAY_WINDOW][PROTO_NONCE_LEN], uint8_t count, const uint8_t *key)
{
    uint8_t buf[SFC1_NV_SIZE];
    uint8_t mac[32];
    uint8_t n;

    if (used == NULL || key == NULL) {
        return -1;
    }
    n = (count > PROTO_REPLAY_WINDOW) ? PROTO_REPLAY_WINDOW : count;

    (void)memset_s(buf, sizeof(buf), 0, sizeof(buf));
    (void)memcpy_s(buf, sizeof(buf), SFC1_NV_MAGIC, SFC1_NV_MAGIC_LEN);
    buf[8] = (uint8_t)SFC1_NV_VERSION;
    buf[9] = n;
    put_u32(buf + 12, ++g_nv_seq);
    (void)memcpy_s(buf + SFC1_NV_HEAD_LEN, sizeof(buf) - SFC1_NV_HEAD_LEN,
                   used, (size_t)n * PROTO_NONCE_LEN);

    if (sfc1_hmac_sha256(buf, SFC1_NV_BODY_LEN, mac, (void *)key) != 0) {
        return -1;
    }
    (void)memcpy_s(buf + SFC1_NV_BODY_LEN, SFC1_NV_TAG_LEN, mac, SFC1_NV_TAG_LEN);

    if (uapi_nv_write(SFC1_NV_KEY, buf, (uint16_t)sizeof(buf)) != 0) {
        return -1;
    }
    return 0;
}
