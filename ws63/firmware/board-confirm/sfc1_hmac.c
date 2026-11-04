#include "sfc1_hmac.h"

#include <string.h>

#include "mbedtls/md.h"
#include "mbedtls/sha256.h"

/* 与 PC 侧 nearfield-confirm.cjs 的 DEVICE_DOMAIN 逐字节一致（含末尾 NUL） */
static const char DEVICE_DOMAIN[] = "safe-office/ws63/device-id/v1";
#define DEVICE_LABEL_MAX 64

int sfc1_hmac_sha256(const uint8_t *data, size_t len, uint8_t out[32], void *ctx)
{
    const mbedtls_md_info_t *info;

    if (data == NULL || out == NULL || ctx == NULL) {
        return -1;
    }
    info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
    if (info == NULL) {
        return -1;
    }
    return mbedtls_md_hmac(info, (const unsigned char *)ctx, SFC1_KEY_LEN,
                           data, len, out) == 0 ? 0 : -1;
}

int sfc1_sha256(const uint8_t *data, size_t len, uint8_t out[32])
{
    if (data == NULL || out == NULL) {
        return -1;
    }
    return mbedtls_sha256(data, len, out, 0) == 0 ? 0 : -1;
}

int sfc1_derive_device_id(const char *label, uint8_t out[SFC1_DEVICE_ID_LEN])
{
    uint8_t digest[32];
    uint8_t buf[sizeof(DEVICE_DOMAIN) + DEVICE_LABEL_MAX];
    size_t domain_len = sizeof(DEVICE_DOMAIN); /* 含 '\0'，与 Node Buffer.from(...,'utf8')+'\0' 对齐 */
    size_t label_len;
    int rc;

    if (label == NULL || out == NULL) {
        return -1;
    }
    label_len = strlen(label);
    if (label_len == 0 || label_len > DEVICE_LABEL_MAX) {
        return -1;
    }
    memcpy(buf, DEVICE_DOMAIN, domain_len);
    memcpy(buf + domain_len, label, label_len);

    rc = mbedtls_sha256(buf, domain_len + label_len, digest, 0);
    if (rc != 0) {
        return -1;
    }
    memcpy(out, digest, SFC1_DEVICE_ID_LEN);
    return 0;
}
