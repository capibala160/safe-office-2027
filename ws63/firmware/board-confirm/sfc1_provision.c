/* 板端配网状态机实现。协议与边界见 sfc1_provision.h / docs/60。 */
#include "sfc1_provision.h"

#include <stdio.h>
#include <string.h>
#include "securec.h"
#include "trng.h"
#include "sfc1_key_store.h"

#define PROV_HDR_LEN 10u
#define PROV_MAC_LEN 32u
#define PROV_TYPE_INIT 0x10u
#define PROV_TYPE_CHALLENGE 0x11u
#define PROV_TYPE_COMMIT 0x12u
#define PROV_TYPE_OK 0x13u
#define PROV_TYPE_ERR 0x14u

#define PROV_STATUS_OK 0u
#define PROV_STATUS_BAD_CODE 1u
#define PROV_STATUS_BAD_MAC 2u
#define PROV_STATUS_BAD_STATE 3u
#define PROV_STATUS_NO_SPACE 4u
#define PROV_STATUS_TOO_MANY 5u

static const char PROV_DOMAIN[] = "safe-office/provision/v1";
static const char PROV_KEY_DOMAIN[] = "safe-office/provision/key/v1";
#define PROV_DOMAIN_LEN (sizeof(PROV_DOMAIN))         /* 含 NUL，与 Node 侧一致 */
#define PROV_KEY_DOMAIN_LEN (sizeof(PROV_KEY_DOMAIN))

static void put_u16(uint8_t *p, uint16_t v)
{
    p[0] = (uint8_t)(v & 0xFFu);
    p[1] = (uint8_t)((v >> 8) & 0xFFu);
}

static uint16_t get_u16(const uint8_t *p)
{
    return (uint16_t)((uint16_t)p[0] | ((uint16_t)p[1] << 8));
}

static size_t build_frame(uint8_t type, const uint8_t *payload, size_t plen, const uint8_t *key,
                          uint8_t *out, size_t cap)
{
    size_t total = PROV_HDR_LEN + plen + PROV_MAC_LEN;
    uint8_t mac[32];

    if (out == NULL || total > cap) {
        return 0;
    }
    out[0] = 'S';
    out[1] = 'F';
    out[2] = 'C';
    out[3] = '1';
    out[4] = 1;
    out[5] = type;
    out[6] = 0;
    out[7] = 0;
    put_u16(out + 8, (uint16_t)(plen + PROV_MAC_LEN));
    if (plen > 0 && payload != NULL) {
        (void)memcpy_s(out + PROV_HDR_LEN, cap - PROV_HDR_LEN, payload, plen);
    }
    if (key == NULL) {
        (void)memset_s(out + PROV_HDR_LEN + plen, PROV_MAC_LEN, 0, PROV_MAC_LEN);
    } else if (sfc1_hmac_sha256(out, PROV_HDR_LEN + plen, mac, (void *)key) != 0) {
        return 0;
    } else {
        (void)memcpy_s(out + PROV_HDR_LEN + plen, PROV_MAC_LEN, mac, PROV_MAC_LEN);
    }
    return total;
}

static int parse_frame(const uint8_t *buf, size_t len, uint8_t *type, const uint8_t **payload,
                       size_t *plen, const uint8_t **mac)
{
    uint16_t field;

    if (buf == NULL || len < PROV_HDR_LEN + PROV_MAC_LEN) {
        return -1;
    }
    if (buf[0] != 'S' || buf[1] != 'F' || buf[2] != 'C' || buf[3] != '1' || buf[4] != 1 ||
        buf[6] != 0 || buf[7] != 0) {
        return -1;
    }
    field = get_u16(buf + 8);
    if ((size_t)field + PROV_HDR_LEN != len) {
        return -1;
    }
    *type = buf[5];
    *payload = buf + PROV_HDR_LEN;
    *plen = (size_t)field - PROV_MAC_LEN;
    *mac = buf + len - PROV_MAC_LEN;
    return 0;
}

static int verify_mac(const uint8_t *frame, size_t data_len, const uint8_t *mac, const uint8_t *key)
{
    uint8_t expected[32];

    if (sfc1_hmac_sha256(frame, data_len, expected, (void *)key) != 0) {
        return 0;
    }
    return memcmp(expected, mac, PROV_MAC_LEN) == 0 ? 1 : 0;
}

static int derive_session(const char *code, const uint8_t host[16], const uint8_t dev[16], uint8_t out[32])
{
    uint8_t buf[PROV_DOMAIN_LEN + SFC1_PROV_CODE_LEN + 32];
    char lower[SFC1_PROV_CODE_LEN];
    size_t i;

    if (code == NULL) {
        return -1;
    }
    for (i = 0; i < SFC1_PROV_CODE_LEN; i++) {
        char c = code[i];
        if (c >= 'A' && c <= 'Z') {
            c = (char)(c - 'A' + 'a');
        }
        lower[i] = c;
    }
    (void)memcpy_s(buf, sizeof(buf), PROV_DOMAIN, PROV_DOMAIN_LEN);
    (void)memcpy_s(buf + PROV_DOMAIN_LEN, sizeof(buf) - PROV_DOMAIN_LEN, lower, SFC1_PROV_CODE_LEN);
    (void)memcpy_s(buf + PROV_DOMAIN_LEN + SFC1_PROV_CODE_LEN, 16, host, 16);
    (void)memcpy_s(buf + PROV_DOMAIN_LEN + SFC1_PROV_CODE_LEN + 16, 16, dev, 16);
    return sfc1_sha256(buf, PROV_DOMAIN_LEN + SFC1_PROV_CODE_LEN + 32, out);
}

static int key_stream(const uint8_t session[32], const uint8_t host[16], const uint8_t dev[16], uint8_t out[32])
{
    uint8_t buf[PROV_KEY_DOMAIN_LEN + 32];

    (void)memcpy_s(buf, sizeof(buf), PROV_KEY_DOMAIN, PROV_KEY_DOMAIN_LEN);
    (void)memcpy_s(buf + PROV_KEY_DOMAIN_LEN, 16, host, 16);
    (void)memcpy_s(buf + PROV_KEY_DOMAIN_LEN + 16, 16, dev, 16);
    return sfc1_hmac_sha256(buf, sizeof(buf), out, (void *)session);
}

static int random_bytes(uint8_t *buf, size_t len)
{
    return uapi_drv_cipher_trng_get_random_bytes(buf, (uint32_t)len) == 0 ? 0 : -1;
}

int sfc1_prov_begin(sfc1_prov_t *p, const char *label, uint64_t now_ms, uint64_t window_ms)
{
    uint8_t rnd[4];

    if (p == NULL || label == NULL) {
        return 0;
    }
    (void)memset_s(p, sizeof(*p), 0, sizeof(*p));
    if (sfc1_derive_device_id(label, p->device_id) != 0) {
        return 0;
    }
    if (random_bytes(rnd, sizeof(rnd)) != 0) {
        return 0;
    }
    (void)snprintf(p->code, sizeof(p->code), "%02x%02x%02x%02x", rnd[0], rnd[1], rnd[2], rnd[3]);
    p->label = label;
    p->deadline_ms = now_ms + window_ms;
    p->attempts = SFC1_PROV_MAX_ATTEMPTS;
    p->active = 1;
    p->have_session = 0;
    return 1;
}

int sfc1_prov_active(sfc1_prov_t *p, uint64_t now_ms)
{
    if (p == NULL || !p->active) {
        return 0;
    }
    if (now_ms >= p->deadline_ms) {
        p->active = 0;
        p->have_session = 0;
        printf("SFC1 PROV: window expired\r\n");
        return 0;
    }
    return 1;
}

static int reply_err(uint8_t status, const char *reason, const uint8_t *key,
                     uint8_t *out, size_t out_cap, size_t *out_len)
{
    uint8_t payload[34];
    size_t len = strlen(reason);

    if (len > 32) {
        len = 32;
    }
    payload[0] = status;
    payload[1] = (uint8_t)len;
    (void)memcpy_s(payload + 2, sizeof(payload) - 2, reason, len);
    *out_len = build_frame(PROV_TYPE_ERR, payload, 2 + len, key, out, out_cap);
    return *out_len > 0 ? 1 : 0;
}

int sfc1_prov_handle(sfc1_prov_t *p, const uint8_t *frame, size_t len, uint64_t now_ms,
                     uint8_t *out, size_t out_cap, size_t *out_len)
{
    uint8_t type;
    const uint8_t *payload = NULL;
    const uint8_t *mac = NULL;
    size_t plen = 0;
    uint8_t payload_out[128];
    uint8_t stream[32];

    if (p == NULL || out == NULL || out_len == NULL) {
        return -1;
    }
    *out_len = 0;
    if (!sfc1_prov_active(p, now_ms)) {
        return 0; /* 窗口关闭：静默，主机自然超时 */
    }
    if (parse_frame(frame, len, &type, &payload, &plen, &mac) != 0) {
        return -1;
    }

    if (type == PROV_TYPE_INIT) {
        if (plen != 16) {
            return -1;
        }
        if (random_bytes(p->device_nonce, sizeof(p->device_nonce)) != 0) {
            return -1;
        }
        (void)memcpy_s(p->host_nonce, sizeof(p->host_nonce), payload, 16);
        if (derive_session(p->code, p->host_nonce, p->device_nonce, p->session_key) != 0) {
            return -1;
        }
        p->have_session = 1;
        (void)memcpy_s(payload_out, sizeof(payload_out), p->device_id, SFC1_DEVICE_ID_LEN);
        (void)memcpy_s(payload_out + SFC1_DEVICE_ID_LEN, 16, p->host_nonce, 16);
        (void)memcpy_s(payload_out + SFC1_DEVICE_ID_LEN + 16, 16, p->device_nonce, 16);
        *out_len = build_frame(PROV_TYPE_CHALLENGE, payload_out, SFC1_DEVICE_ID_LEN + 32,
                               p->session_key, out, out_cap);
        return *out_len > 0 ? 1 : -1;
    }

    if (type == PROV_TYPE_COMMIT) {
        if (!p->have_session || plen != 72) {
            return 0;
        }
        if (!verify_mac(frame, len - PROV_MAC_LEN, mac, p->session_key)) {
            p->attempts = (uint8_t)(p->attempts > 0 ? p->attempts - 1u : 0u);
            if (p->attempts == 0) {
                p->active = 0;
                p->have_session = 0;
                printf("SFC1 PROV: too many failures, window closed\r\n");
            }
            return reply_err(PROV_STATUS_BAD_MAC, "BAD_MAC", NULL, out, out_cap, out_len);
        }
        if (memcmp(payload, p->device_id, SFC1_DEVICE_ID_LEN) != 0 ||
            memcmp(payload + 8, p->host_nonce, 16) != 0 ||
            memcmp(payload + 24, p->device_nonce, 16) != 0) {
            return reply_err(PROV_STATUS_BAD_STATE, "BAD_BINDING", p->session_key, out, out_cap, out_len);
        }
        if (key_stream(p->session_key, p->host_nonce, p->device_nonce, stream) != 0) {
            return -1;
        }
        {
            sfc1_key_record_t rec;
            (void)memset_s(&rec, sizeof(rec), 0, sizeof(rec));
            for (size_t i = 0; i < SFC1_KEY_LEN; i++) {
                rec.key[i] = payload[40 + i] ^ stream[i];
            }
            rec.provisioned_at = (uint32_t)(now_ms / 1000ULL);
            if (sfc1_key_store_save(&rec, p->label) != 0) {
                return reply_err(PROV_STATUS_NO_SPACE, "NV_WRITE_FAIL", p->session_key, out, out_cap, out_len);
            }
            (void)memcpy_s(p->new_key, sizeof(p->new_key), rec.key, SFC1_KEY_LEN);
            p->has_new_key = 1;
        }
        p->active = 0;
        p->have_session = 0;
        (void)memcpy_s(payload_out, sizeof(payload_out), p->device_id, SFC1_DEVICE_ID_LEN);
        payload_out[SFC1_DEVICE_ID_LEN] = PROV_STATUS_OK;
        *out_len = build_frame(PROV_TYPE_OK, payload_out, SFC1_DEVICE_ID_LEN + 1,
                               p->session_key, out, out_cap);
        return *out_len > 0 ? 1 : -1;
    }

    return 0; /* 其它类型不归配网管 */
}
