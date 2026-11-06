/* 一机一钥的板端存储实现：v1 明文 / v2 eFuse-KEK 包装。格式见 sfc1_key_store.h。 */
#include "sfc1_key_store.h"

#include <stdio.h>
#include <string.h>
#include "securec.h"
#include "nv.h"
#include "trng.h"
#include "mbedtls/gcm.h"
#include "efuse_kek.h"

#define SFC1_KEY_V1_NV_ID 0x0F02u
#define SFC1_KEY_V2_NV_ID 0x0F03u
#define SFC1_KEY_TEST_NV_ID 0x0F05u

#define SFC1_KEY_V1_MAGIC "SFC1KEY1"
#define SFC1_KEY_V2_MAGIC "SFC1KEY2"
#define SFC1_KEY_MAGIC_LEN 8u
#define SFC1_KEY_V1_VERSION 1u
#define SFC1_KEY_V2_VERSION 2u
#define SFC1_KEY_V1_BODY_LEN 48u
#define SFC1_KEY_V1_TAG_LEN 16u
#define SFC1_KEY_V1_SIZE (SFC1_KEY_V1_BODY_LEN + SFC1_KEY_V1_TAG_LEN)

#define SFC1_KEY_V2_HEADER_LEN 16u
#define SFC1_KEY_V2_NONCE_LEN 12u
#define SFC1_KEY_V2_TAG_LEN 16u
#define SFC1_KEY_V2_CT_OFFSET 28u
#define SFC1_KEY_V2_TAG_OFFSET 60u
#define SFC1_KEY_V2_SIZE 76u
#define SFC1_KEY_V2_AAD_LEN (SFC1_KEY_V2_HEADER_LEN + SFC1_DEVICE_ID_LEN)

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

static int random_bytes(uint8_t *buf, size_t len)
{
    return uapi_drv_cipher_trng_get_random_bytes(buf, (uint32_t)len) == ERRCODE_SUCC ? 0 : -1;
}

static int erase_nv(uint16_t nv_id, uint16_t len)
{
    uint8_t buf[SFC1_KEY_V2_SIZE];

    if (len > sizeof(buf)) {
        return -1;
    }
    (void)memset_s(buf, sizeof(buf), 0, sizeof(buf));
    uapi_nv_init();
    return uapi_nv_write(nv_id, buf, len) == ERRCODE_SUCC ? 0 : -1;
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

/* ---------------- v1：明文记录（兼容旧固件） ---------------- */

static int build_v1_record(const sfc1_key_record_t *rec, const char *label, uint8_t out[SFC1_KEY_V1_SIZE])
{
    uint8_t ikey[32];
    uint8_t mac[32];

    if (rec == NULL || label == NULL || integrity_key(label, ikey) != 0) {
        return -1;
    }
    (void)memset_s(out, SFC1_KEY_V1_SIZE, 0, SFC1_KEY_V1_SIZE);
    (void)memcpy_s(out, SFC1_KEY_V1_SIZE, SFC1_KEY_V1_MAGIC, SFC1_KEY_MAGIC_LEN);
    out[8] = (uint8_t)SFC1_KEY_V1_VERSION;
    put_u32(out + 12, rec->provisioned_at);
    (void)memcpy_s(out + 16, SFC1_KEY_V1_SIZE - 16u, rec->key, SFC1_KEY_LEN);

    if (sfc1_hmac_sha256(out, SFC1_KEY_V1_BODY_LEN, mac, (void *)ikey) != 0) {
        return -1;
    }
    (void)memcpy_s(out + SFC1_KEY_V1_BODY_LEN, SFC1_KEY_V1_TAG_LEN, mac, SFC1_KEY_V1_TAG_LEN);
    return 0;
}

static int load_v1(sfc1_key_record_t *out, const char *label)
{
    uint8_t buf[SFC1_KEY_V1_SIZE];
    uint8_t ikey[32];
    uint8_t mac[32];
    uint16_t len = 0;

    if (out == NULL || label == NULL) {
        return 0;
    }
    (void)memset_s(out, sizeof(*out), 0, sizeof(*out));
    uapi_nv_init();
    if (uapi_nv_read(SFC1_KEY_V1_NV_ID, (uint16_t)sizeof(buf), &len, buf) != 0 || len != SFC1_KEY_V1_SIZE) {
        return 0;
    }
    if (memcmp(buf, SFC1_KEY_V1_MAGIC, SFC1_KEY_MAGIC_LEN) != 0 || buf[8] != SFC1_KEY_V1_VERSION) {
        return 0;
    }
    if (integrity_key(label, ikey) != 0) {
        return 0;
    }
    if (sfc1_hmac_sha256(buf, SFC1_KEY_V1_BODY_LEN, mac, (void *)ikey) != 0) {
        return 0;
    }
    if (memcmp(mac, buf + SFC1_KEY_V1_BODY_LEN, SFC1_KEY_V1_TAG_LEN) != 0) {
        printf("SFC1 KEY: v1 tag mismatch, ignored\r\n");
        return 0;
    }
    (void)memcpy_s(out->key, sizeof(out->key), buf + 16, SFC1_KEY_LEN);
    out->provisioned_at = get_u32(buf + 12);
    return 1;
}

static int save_v1(const sfc1_key_record_t *rec, const char *label)
{
    uint8_t buf[SFC1_KEY_V1_SIZE];

    if (build_v1_record(rec, label, buf) != 0) {
        return -1;
    }
    uapi_nv_init();
    return uapi_nv_write(SFC1_KEY_V1_NV_ID, buf, (uint16_t)sizeof(buf)) == 0 ? 0 : -1;
}

static int erase_v1(void)
{
    return erase_nv(SFC1_KEY_V1_NV_ID, (uint16_t)SFC1_KEY_V1_SIZE);
}

/* ---------------- v2：AES-128-GCM(KEK, key) ---------------- */

static void build_v2_header(uint8_t header[SFC1_KEY_V2_HEADER_LEN], uint32_t provisioned_at)
{
    (void)memset_s(header, SFC1_KEY_V2_HEADER_LEN, 0, SFC1_KEY_V2_HEADER_LEN);
    (void)memcpy_s(header, SFC1_KEY_V2_HEADER_LEN, SFC1_KEY_V2_MAGIC, SFC1_KEY_MAGIC_LEN);
    header[8] = (uint8_t)SFC1_KEY_V2_VERSION;
    put_u32(header + 12, provisioned_at);
}

static int build_v2_aad(const char *label, const uint8_t header[SFC1_KEY_V2_HEADER_LEN],
                        uint8_t aad[SFC1_KEY_V2_AAD_LEN])
{
    uint8_t device_id[SFC1_DEVICE_ID_LEN];

    if (sfc1_derive_device_id(label, device_id) != 0) {
        return -1;
    }
    (void)memcpy_s(aad, SFC1_KEY_V2_AAD_LEN, header, SFC1_KEY_V2_HEADER_LEN);
    (void)memcpy_s(aad + SFC1_KEY_V2_HEADER_LEN, SFC1_DEVICE_ID_LEN, device_id, SFC1_DEVICE_ID_LEN);
    return 0;
}

static int save_v2_with_kek(const sfc1_key_record_t *rec, const char *label,
                            const uint8_t kek[EFUSE_KEK_LEN], uint16_t nv_id)
{
    uint8_t buf[SFC1_KEY_V2_SIZE];
    uint8_t aad[SFC1_KEY_V2_AAD_LEN];
    mbedtls_gcm_context ctx;
    int rc;

    if (rec == NULL || label == NULL || kek == NULL) {
        return -1;
    }
    (void)memset_s(buf, sizeof(buf), 0, sizeof(buf));
    build_v2_header(buf, rec->provisioned_at);
    if (build_v2_aad(label, buf, aad) != 0) {
        return -1;
    }
    if (random_bytes(buf + SFC1_KEY_V2_HEADER_LEN, SFC1_KEY_V2_NONCE_LEN) != 0) {
        return -1;
    }

    mbedtls_gcm_init(&ctx);
    rc = mbedtls_gcm_setkey(&ctx, MBEDTLS_CIPHER_ID_AES, kek, (int)(EFUSE_KEK_LEN * 8u));
    if (rc == 0) {
        rc = mbedtls_gcm_crypt_and_tag(&ctx, MBEDTLS_GCM_ENCRYPT, SFC1_KEY_LEN,
                                       buf + SFC1_KEY_V2_HEADER_LEN, SFC1_KEY_V2_NONCE_LEN,
                                       aad, sizeof(aad), rec->key,
                                       buf + SFC1_KEY_V2_CT_OFFSET, SFC1_KEY_V2_TAG_LEN,
                                       buf + SFC1_KEY_V2_TAG_OFFSET);
    }
    mbedtls_gcm_free(&ctx);
    if (rc != 0) {
        printf("SFC1 KEY: v2 encrypt failed rc=%d\r\n", rc);
        (void)memset_s(buf, sizeof(buf), 0, sizeof(buf));
        return -1;
    }

    uapi_nv_init();
    if (uapi_nv_write(nv_id, buf, (uint16_t)sizeof(buf)) != ERRCODE_SUCC) {
        (void)memset_s(buf, sizeof(buf), 0, sizeof(buf));
        return -1;
    }
    (void)memset_s(buf, sizeof(buf), 0, sizeof(buf));
    return 0;
}

static int load_v2_with_kek(sfc1_key_record_t *out, const char *label,
                            const uint8_t kek[EFUSE_KEK_LEN], uint16_t nv_id)
{
    uint8_t buf[SFC1_KEY_V2_SIZE];
    uint8_t aad[SFC1_KEY_V2_AAD_LEN];
    uint16_t len = 0;
    mbedtls_gcm_context ctx;
    int rc;

    if (out == NULL || label == NULL || kek == NULL) {
        return 0;
    }
    (void)memset_s(out, sizeof(*out), 0, sizeof(*out));
    uapi_nv_init();
    if (uapi_nv_read(nv_id, (uint16_t)sizeof(buf), &len, buf) != ERRCODE_SUCC || len != SFC1_KEY_V2_SIZE) {
        return 0;
    }
    if (memcmp(buf, SFC1_KEY_V2_MAGIC, SFC1_KEY_MAGIC_LEN) != 0 || buf[8] != SFC1_KEY_V2_VERSION) {
        return 0;
    }
    if (build_v2_aad(label, buf, aad) != 0) {
        return 0;
    }

    mbedtls_gcm_init(&ctx);
    rc = mbedtls_gcm_setkey(&ctx, MBEDTLS_CIPHER_ID_AES, kek, (int)(EFUSE_KEK_LEN * 8u));
    if (rc == 0) {
        rc = mbedtls_gcm_auth_decrypt(&ctx, SFC1_KEY_LEN,
                                      buf + SFC1_KEY_V2_HEADER_LEN, SFC1_KEY_V2_NONCE_LEN,
                                      aad, sizeof(aad),
                                      buf + SFC1_KEY_V2_TAG_OFFSET, SFC1_KEY_V2_TAG_LEN,
                                      buf + SFC1_KEY_V2_CT_OFFSET, out->key);
    }
    mbedtls_gcm_free(&ctx);
    if (rc != 0) {
        (void)memset_s(out, sizeof(*out), 0, sizeof(*out));
        return 0;
    }
    out->provisioned_at = get_u32(buf + 12);
    (void)memset_s(buf, sizeof(buf), 0, sizeof(buf));
    return 1;
}

static int erase_v2(void)
{
    return erase_nv(SFC1_KEY_V2_NV_ID, (uint16_t)SFC1_KEY_V2_SIZE);
}

/* ---------------- 对外接口 ---------------- */

int sfc1_key_store_load(sfc1_key_record_t *out, const char *label)
{
    uint8_t kek[EFUSE_KEK_LEN] = {0};
    sfc1_key_record_t check;
    int active;

    if (out == NULL || label == NULL) {
        return 0;
    }
    active = efuse_kek_active(kek);
    if (active == 1) {
        if (load_v2_with_kek(out, label, kek, SFC1_KEY_V2_NV_ID) == 1) {
            printf("SFC1 KEY: provisioned v2/kek (at %u)\r\n", (unsigned)out->provisioned_at);
            (void)memset_s(kek, sizeof(kek), 0, sizeof(kek));
            return 1;
        }
        if (load_v1(out, label) == 1) {
            sfc1_key_record_t v1rec = *out;
            if (save_v2_with_kek(&v1rec, label, kek, SFC1_KEY_V2_NV_ID) == 0 &&
                load_v2_with_kek(&check, label, kek, SFC1_KEY_V2_NV_ID) == 1 &&
                memcmp(check.key, v1rec.key, SFC1_KEY_LEN) == 0) {
                if (erase_v1() != 0) {
                    printf("SFC1 KEY: v1 erase failed, plaintext record remains\r\n");
                }
                printf("SFC1 KEY: migrated v1 -> v2/kek (at %u)\r\n", (unsigned)v1rec.provisioned_at);
            } else {
                printf("SFC1 KEY: v2 migration failed, keeping v1\r\n");
            }
            (void)memset_s(&check, sizeof(check), 0, sizeof(check));
            (void)memset_s(&v1rec, sizeof(v1rec), 0, sizeof(v1rec));
            (void)memset_s(kek, sizeof(kek), 0, sizeof(kek));
            return 1;
        }
        (void)memset_s(kek, sizeof(kek), 0, sizeof(kek));
        return 0;
    }
    if (active < 0) {
        printf("SFC1 KEK: read failed, fallback to v1\r\n");
    }
    return load_v1(out, label);
}

int sfc1_key_store_save(const sfc1_key_record_t *rec, const char *label)
{
    uint8_t kek[EFUSE_KEK_LEN] = {0};
    sfc1_key_record_t check;
    int active;
    int rc;

    if (rec == NULL || label == NULL) {
        return -1;
    }
    active = efuse_kek_active(kek);
    if (active < 0) {
        printf("SFC1 KEK: read failed, refusing to save\r\n");
        return -1;
    }
    if (active == 0) {
        return save_v1(rec, label);
    }

    rc = save_v2_with_kek(rec, label, kek, SFC1_KEY_V2_NV_ID);
    if (rc == 0 &&
        (load_v2_with_kek(&check, label, kek, SFC1_KEY_V2_NV_ID) != 1 ||
         memcmp(check.key, rec->key, SFC1_KEY_LEN) != 0)) {
        rc = -1;
    }
    (void)memset_s(&check, sizeof(check), 0, sizeof(check));
    (void)memset_s(kek, sizeof(kek), 0, sizeof(kek));
    if (rc != 0) {
        printf("SFC1 KEY: v2 save/verify failed\r\n");
        return -1;
    }
    if (erase_v1() != 0) {
        printf("SFC1 KEY: v1 erase failed, plaintext record remains\r\n");
    }
    return 0;
}

int sfc1_key_store_erase(const char *label)
{
    int rc1;
    int rc2;

    (void)label;
    rc1 = erase_v1();
    rc2 = erase_v2();
    return (rc1 == 0 && rc2 == 0) ? 0 : -1;
}

int sfc1_key_store_selftest(const char *label)
{
    static const char SELFTEST_DOMAIN[] = "safe-office/ws63/kek-selftest/v1";
    uint8_t digest[32] = {0};
    uint8_t kek[EFUSE_KEK_LEN] = {0};
    uint8_t raw[SFC1_KEY_V2_SIZE] = {0};
    sfc1_key_record_t rec;
    sfc1_key_record_t check;
    uint16_t len = 0;
    int rc = -1;

    if (label == NULL) {
        return -1;
    }
    if (sfc1_sha256((const uint8_t *)SELFTEST_DOMAIN, sizeof(SELFTEST_DOMAIN), digest) != 0) {
        printf("SFC1 KEK SELFTEST: sha256 failed\r\n");
        return -1;
    }
    (void)memcpy_s(kek, sizeof(kek), digest, EFUSE_KEK_LEN);
    (void)memset_s(&rec, sizeof(rec), 0xA5, sizeof(rec));
    rec.provisioned_at = 0x5E1F7E57u;

    if (save_v2_with_kek(&rec, label, kek, SFC1_KEY_TEST_NV_ID) != 0) {
        printf("SFC1 KEK SELFTEST: save failed\r\n");
        goto out;
    }
    if (load_v2_with_kek(&check, label, kek, SFC1_KEY_TEST_NV_ID) != 1 ||
        memcmp(check.key, rec.key, SFC1_KEY_LEN) != 0) {
        printf("SFC1 KEK SELFTEST: round-trip mismatch\r\n");
        goto out;
    }

    /* 篡改 GCM tag，必须解不出来 */
    uapi_nv_init();
    if (uapi_nv_read(SFC1_KEY_TEST_NV_ID, (uint16_t)sizeof(raw), &len, raw) != ERRCODE_SUCC ||
        len != SFC1_KEY_V2_SIZE) {
        printf("SFC1 KEK SELFTEST: read-back failed\r\n");
        goto out;
    }
    raw[SFC1_KEY_V2_TAG_OFFSET] ^= 0x01u;
    if (uapi_nv_write(SFC1_KEY_TEST_NV_ID, raw, (uint16_t)sizeof(raw)) != ERRCODE_SUCC) {
        printf("SFC1 KEK SELFTEST: tamper write failed\r\n");
        goto out;
    }
    if (load_v2_with_kek(&check, label, kek, SFC1_KEY_TEST_NV_ID) == 1) {
        printf("SFC1 KEK SELFTEST: tampered record accepted\r\n");
        goto out;
    }

    rc = 0;

out:
    (void)erase_nv(SFC1_KEY_TEST_NV_ID, (uint16_t)SFC1_KEY_V2_SIZE);
    (void)memset_s(digest, sizeof(digest), 0, sizeof(digest));
    (void)memset_s(kek, sizeof(kek), 0, sizeof(kek));
    (void)memset_s(&rec, sizeof(rec), 0, sizeof(rec));
    (void)memset_s(&check, sizeof(check), 0, sizeof(check));
    (void)memset_s(raw, sizeof(raw), 0, sizeof(raw));
    return rc;
}
