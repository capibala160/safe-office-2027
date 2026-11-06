/*
 * eFuse 客户预留区只读探测（docs/60 阶段 B）
 *
 * 只读保证：
 *   - 本文件只包含 uapi_efuse_user_read_buffer / uapi_efuse_read_buffer 两个读接口；
 *   - 不包含、不调用任何 write/write_bit 接口，避免误烧 OTP。
 */
#include "efuse_probe.h"
#include "efuse.h"
#include "efuse_user.h"
#include "stdio.h"
#include "string.h"
#include "securec.h"
#include "sfc1_hmac.h"

static void probe_print_hex(const char *tag, const uint8_t *buf, uint16_t len)
{
    uint16_t i;

    printf("%s", tag);
    for (i = 0; i < len; i++) {
        printf(" %02x", (unsigned)buf[i]);
    }
    printf("\r\n");
}

/* 空白区打印原始值（排查用）；一旦烧过就只打印指纹，避免把 KEK 打到串口 */
static void probe_print_value(const char *tag, const uint8_t *buf, uint16_t len, int blank)
{
    uint8_t digest[32];

    if (blank) {
        probe_print_hex(tag, buf, len);
        return;
    }
    if (sfc1_sha256(buf, len, digest) == 0) {
        printf("%s <redacted> fingerprint=%02x%02x%02x%02x\r\n", tag,
               (unsigned)digest[0], (unsigned)digest[1], (unsigned)digest[2], (unsigned)digest[3]);
    } else {
        printf("%s <redacted>\r\n", tag);
    }
    (void)memset_s(digest, sizeof(digest), 0, sizeof(digest));
}

static uint16_t probe_count_ones(const uint8_t *buf, uint16_t len)
{
    uint16_t i;
    uint16_t ones = 0;

    for (i = 0; i < len; i++) {
        uint8_t v = buf[i];
        while (v != 0) {
            ones = (uint16_t)(ones + (v & 1u));
            v = (uint8_t)(v >> 1);
        }
    }
    return ones;
}

static int probe_is_zero(const uint8_t *buf, uint16_t len)
{
    uint16_t i;

    for (i = 0; i < len; i++) {
        if (buf[i] != 0) {
            return 0;
        }
    }
    return 1;
}

void efuse_probe_report(void)
{
    uint8_t user[EFUSE_PROBE_USER_LEN] = {0};
    uint8_t direct[EFUSE_PROBE_USER_LEN] = {0};
    errcode_t rc_user;
    errcode_t rc_direct;
    int blank;

    printf("=== EFUSE PROBE (READ-ONLY) ===\r\n");
    printf("user_area: abs=%u len=%u\r\n",
           (unsigned)EFUSE_PROBE_USER_ABS_OFFSET, (unsigned)EFUSE_PROBE_USER_LEN);

    /* 1) 用户预留区接口：offset 相对预留区起点（0..15） */
    rc_user = uapi_efuse_user_read_buffer(0, user, (uint16_t)sizeof(user));
    printf("user_read rc=%u\r\n", (unsigned)rc_user);

    /* 2) 绝对地址读：byte 222 起 16B，与上面交叉核对 */
    rc_direct = uapi_efuse_read_buffer(direct, EFUSE_PROBE_USER_ABS_OFFSET,
                                       (uint16_t)sizeof(direct));
    printf("direct_read rc=%u\r\n", (unsigned)rc_direct);

    /* 两路都为空才打印原始值；任一路非空（含两路不一致）一律脱敏，避免泄漏 KEK */
    blank = probe_is_zero(user, (uint16_t)sizeof(user)) &&
            probe_is_zero(direct, (uint16_t)sizeof(direct));
    probe_print_value("user_hex:", user, (uint16_t)sizeof(user), blank);
    probe_print_value("direct_hex:", direct, (uint16_t)sizeof(direct), blank);

    printf("match=%s\r\n",
           (rc_user == ERRCODE_SUCC && rc_direct == ERRCODE_SUCC &&
            memcmp(user, direct, sizeof(user)) == 0) ? "yes" : "no");
    printf("ones=%u all_zero=%s\r\n",
           (unsigned)probe_count_ones(direct, (uint16_t)sizeof(direct)),
           blank ? "yes" : "no");
    printf("=== END EFUSE PROBE ===\r\n");
}
