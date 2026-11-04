/* 一机一钥的板端存储实现。记录格式与边界见 sfc1_key_store.h。 */
#include "sfc1_key_store.h"

#include <stdio.h>
#include <string.h>
#include "securec.h"
#include "nv.h"

#define SFC1_KEY_NV_ID 0x0F02u
#define SFC1_KEY_MAGIC "SFC1KEY1"
#define SFC1_KEY_MAGIC_LEN 8u
#define SFC1_KEY_VERSION 1u
#define SFC1_KEY_BODY_LEN 48u   /* magic..key */
#define SFC1_KEY_TAG_LEN 16u
#define SFC1_KEY_SIZE (SFC1_KEY_BODY_LEN + SFC1_KEY_TAG_LEN)

static const char KEY_INTEGRITY_DOMAIN[] = "safe-office/ws63/key-integrity/v1";
#define KEY_INTEGRITY_DOMAIN_LEN (sizeof(KEY_INTEGRITY_DOMAIN)) /* 含 NUL，与 Node 侧一致 */

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

/* integrity_key = SHA-256(domain || device_id[8])；device_id 由标签派生（非秘密） */
static int integrity_key(const char *label, uint8_t out[32])
{
    uint8_t device_id[SFC1_DEVICE_ID_LEN];
    uint8_t buf[KEY_INTEGRITY_DOMAIN_LEN + SFC1_DEVICE_ID_LEN];

    if (sfc1_derive_device_id(label, device_id) != 0) {
        return -1;
    }
    (void)memcpy_s(buf, sizeof(buf), KEY_INTEGRITY_DOMAIN, KEY_INTEGRITY_DOMAIN_LEN);
    (void)memcpy_s(buf + KEY_INTEGRITY_DOMAIN_LEN, SFC1_DEVICE_ID_LEN, device_id, SFC1_DEVICE_ID_LEN);
    return sfc1_sha256(buf, sizeof(buf), out);
}

static int build_record(const sfc1_key_record_t *rec, const char *label, uint8_t out[SFC1_KEY_SIZE])
{
    uint8_t ikey[32];
    uint8_t mac[32];

    if (rec == NULL || label == NULL || integrity_key(label, ikey) != 0) {
        return -1;
    }
    (void)memset_s(out, SFC1_KEY_SIZE, 0, SFC1_KEY_SIZE);
    (void)memcpy_s(out, SFC1_KEY_SIZE, SFC1_KEY_MAGIC, SFC1_KEY_MAGIC_LEN);
    out[8] = (uint8_t)SFC1_KEY_VERSION;
    put_u32(out + 12, rec->provisioned_at);
    (void)memcpy_s(out + 16, SFC1_KEY_SIZE - 16u, rec->key, SFC1_KEY_LEN);

    if (sfc1_hmac_sha256(out, SFC1_KEY_BODY_LEN, mac, (void *)ikey) != 0) {
        return -1;
    }
    (void)memcpy_s(out + SFC1_KEY_BODY_LEN, SFC1_KEY_TAG_LEN, mac, SFC1_KEY_TAG_LEN);
    return 0;
}

int sfc1_key_store_load(sfc1_key_record_t *out, const char *label)
{
    uint8_t buf[SFC1_KEY_SIZE];
    uint8_t ikey[32];
    uint8_t mac[32];
    uint16_t len = 0;

    if (out == NULL || label == NULL) {
        return 0;
    }
    (void)memset_s(out, sizeof(*out), 0, sizeof(*out));
    uapi_nv_init();
    if (uapi_nv_read(SFC1_KEY_NV_ID, (uint16_t)sizeof(buf), &len, buf) != 0 || len != SFC1_KEY_SIZE) {
        return 0;
    }
    if (memcmp(buf, SFC1_KEY_MAGIC, SFC1_KEY_MAGIC_LEN) != 0 || buf[8] != SFC1_KEY_VERSION) {
        return 0;
    }
    if (integrity_key(label, ikey) != 0) {
        return 0;
    }
    if (sfc1_hmac_sha256(buf, SFC1_KEY_BODY_LEN, mac, (void *)ikey) != 0) {
        return 0;
    }
    if (memcmp(mac, buf + SFC1_KEY_BODY_LEN, SFC1_KEY_TAG_LEN) != 0) {
        printf("SFC1 KEY: tag mismatch, ignored\r\n");
        return 0;
    }
    (void)memcpy_s(out->key, sizeof(out->key), buf + 16, SFC1_KEY_LEN);
    out->provisioned_at = get_u32(buf + 12);
    return 1;
}

int sfc1_key_store_save(const sfc1_key_record_t *rec, const char *label)
{
    uint8_t buf[SFC1_KEY_SIZE];

    if (build_record(rec, label, buf) != 0) {
        return -1;
    }
    uapi_nv_init();
    return uapi_nv_write(SFC1_KEY_NV_ID, buf, (uint16_t)sizeof(buf)) == 0 ? 0 : -1;
}

int sfc1_key_store_erase(const char *label)
{
    uint8_t buf[SFC1_KEY_SIZE];

    (void)memset_s(buf, sizeof(buf), 0, sizeof(buf));
    (void)label;
    uapi_nv_init();
    return uapi_nv_write(SFC1_KEY_NV_ID, buf, (uint16_t)sizeof(buf)) == 0 ? 0 : -1;
}
