/* eFuse 客户预留区 KEK 的读写与状态记录（docs/60 阶段 B）。 */
#include "efuse_kek.h"

#include <stdio.h>
#include <string.h>
#include "securec.h"
#include "efuse.h"
#include "efuse_user.h"
#include "trng.h"
#include "nv.h"
#include "sfc1_hmac.h"

#define EFUSE_KEK_USER_ABS_OFFSET 222u
#define EFUSE_KEK_STATE_NV_ID 0x0F04u
#define EFUSE_KEK_STATE_MAGIC "SFC1KST1"
#define EFUSE_KEK_STATE_MAGIC_LEN 8u
#define EFUSE_KEK_STATE_VERSION 1u
#define EFUSE_KEK_STATE_REC_LEN 16u

static int all_zero(const uint8_t *buf, uint16_t len)
{
    uint16_t i;
    for (i = 0; i < len; i++) {
        if (buf[i] != 0) {
            return 0;
        }
    }
    return 1;
}

int efuse_kek_read(uint8_t out[EFUSE_KEK_LEN])
{
    uint8_t user[EFUSE_KEK_LEN] = {0};
    uint8_t direct[EFUSE_KEK_LEN] = {0};

    if (out == NULL) {
        return -1;
    }
    if (uapi_efuse_user_read_buffer(0, user, (uint16_t)sizeof(user)) != ERRCODE_SUCC ||
        uapi_efuse_read_buffer(direct, EFUSE_KEK_USER_ABS_OFFSET, (uint16_t)sizeof(direct)) != ERRCODE_SUCC) {
        return -1;
    }
    if (memcmp(user, direct, sizeof(user)) != 0) {
        printf("SFC1 KEK: read paths disagree\r\n");
        return -1;
    }
    (void)memcpy_s(out, EFUSE_KEK_LEN, user, EFUSE_KEK_LEN);
    return all_zero(out, EFUSE_KEK_LEN) ? 0 : 1;
}

int efuse_kek_blank(void)
{
    uint8_t buf[EFUSE_KEK_LEN];
    int rc = efuse_kek_read(buf);

    if (rc < 0) {
        return -1;
    }
    return rc == 0 ? 1 : 0;
}

int efuse_kek_generate(uint8_t out[EFUSE_KEK_LEN])
{
    if (out == NULL) {
        return -1;
    }
    return uapi_drv_cipher_trng_get_random_bytes(out, EFUSE_KEK_LEN) == ERRCODE_SUCC ? 0 : -1;
}

int efuse_kek_burn(const uint8_t kek[EFUSE_KEK_LEN], uint8_t readback[EFUSE_KEK_LEN])
{
    uint8_t rb1[EFUSE_KEK_LEN] = {0};
    uint8_t rb2[EFUSE_KEK_LEN] = {0};
    int blank;
    int rc;

    if (kek == NULL || readback == NULL) {
        return -1;
    }
    blank = efuse_kek_blank();
    if (blank < 0) {
        return -2;
    }
    if (blank == 0) {
        return -2;
    }
    if (uapi_efuse_user_write_buffer(0, kek, (uint16_t)EFUSE_KEK_LEN) != ERRCODE_SUCC) {
        return -3;
    }
    if (uapi_efuse_user_read_buffer(0, rb1, (uint16_t)sizeof(rb1)) != ERRCODE_SUCC ||
        uapi_efuse_read_buffer(rb2, EFUSE_KEK_USER_ABS_OFFSET, (uint16_t)sizeof(rb2)) != ERRCODE_SUCC) {
        return -4;
    }
    if (memcmp(rb1, rb2, sizeof(rb1)) != 0) {
        printf("SFC1 KEK: readback paths disagree\r\n");
        return -4;
    }
    if (all_zero(rb1, sizeof(rb1))) {
        return -5;
    }
    if (memcmp(rb1, kek, sizeof(rb1)) != 0) {
        printf("SFC1 KEK: readback differs from written value\r\n");
        return -6;
    }
    (void)memcpy_s(readback, EFUSE_KEK_LEN, rb1, EFUSE_KEK_LEN);
    rc = 0;
    (void)memset_s(rb1, sizeof(rb1), 0, sizeof(rb1));
    (void)memset_s(rb2, sizeof(rb2), 0, sizeof(rb2));
    return rc;
}

int efuse_kek_fingerprint(const uint8_t kek[EFUSE_KEK_LEN], uint8_t fp[4])
{
    uint8_t digest[32];

    if (kek == NULL || fp == NULL) {
        return -1;
    }
    if (sfc1_sha256(kek, EFUSE_KEK_LEN, digest) != 0) {
        return -1;
    }
    (void)memcpy_s(fp, 4, digest, 4);
    (void)memset_s(digest, sizeof(digest), 0, sizeof(digest));
    return 0;
}

static uint8_t state_checksum(const uint8_t *buf)
{
    uint8_t sum = 0;
    uint16_t i;

    for (i = 0; i < 12u; i++) {
        sum = (uint8_t)(sum + buf[i]);
    }
    return sum;
}

int efuse_kek_state_get(void)
{
    uint8_t buf[EFUSE_KEK_STATE_REC_LEN] = {0};
    uint16_t len = 0;

    uapi_nv_init();
    if (uapi_nv_read(EFUSE_KEK_STATE_NV_ID, (uint16_t)sizeof(buf), &len, buf) != ERRCODE_SUCC ||
        len != EFUSE_KEK_STATE_REC_LEN) {
        return EFUSE_KEK_STATE_NONE;
    }
    if (memcmp(buf, EFUSE_KEK_STATE_MAGIC, EFUSE_KEK_STATE_MAGIC_LEN) != 0 ||
        buf[8] != EFUSE_KEK_STATE_VERSION || buf[12] != state_checksum(buf)) {
        printf("SFC1 KEK: state record corrupt, treated as NONE\r\n");
        return EFUSE_KEK_STATE_NONE;
    }
    if (buf[9] > EFUSE_KEK_STATE_FAILED) {
        return EFUSE_KEK_STATE_NONE;
    }
    return (int)buf[9];
}

int efuse_kek_state_set(uint8_t state)
{
    uint8_t buf[EFUSE_KEK_STATE_REC_LEN] = {0};

    if (state > EFUSE_KEK_STATE_FAILED) {
        return -1;
    }
    (void)memcpy_s(buf, sizeof(buf), EFUSE_KEK_STATE_MAGIC, EFUSE_KEK_STATE_MAGIC_LEN);
    buf[8] = (uint8_t)EFUSE_KEK_STATE_VERSION;
    buf[9] = state;
    buf[12] = state_checksum(buf);
    uapi_nv_init();
    return uapi_nv_write(EFUSE_KEK_STATE_NV_ID, buf, (uint16_t)sizeof(buf)) == ERRCODE_SUCC ? 0 : -1;
}

int efuse_kek_active(uint8_t out[EFUSE_KEK_LEN])
{
    uint8_t kek[EFUSE_KEK_LEN] = {0};
    int rc;

    if (efuse_kek_state_get() != EFUSE_KEK_STATE_OK) {
        return 0;
    }
    rc = efuse_kek_read(kek);
    if (rc < 0) {
        return -1;
    }
    if (rc == 0) {
        printf("SFC1 KEK: state OK but eFuse blank, ignoring\r\n");
        return 0;
    }
    if (out != NULL) {
        (void)memcpy_s(out, EFUSE_KEK_LEN, kek, EFUSE_KEK_LEN);
    }
    (void)memset_s(kek, sizeof(kek), 0, sizeof(kek));
    return 1;
}
