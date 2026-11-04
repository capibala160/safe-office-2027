#ifndef SFC1_PROVISION_H
#define SFC1_PROVISION_H

/*
 * 板端配网状态机（docs/60 方案 A）：把一机一钥写进 NV。
 *
 * 时间线：
 *   未配置 -> begin() 生成 8 位临时码并打开窗口（默认 10 分钟）
 *   INIT(0x10)    -> 生成 device_nonce，派生会话密钥，回 CHALLENGE(0x11)
 *   COMMIT(0x12)  -> 验 MAC/绑定，解出新密钥，写 NV + 回 OK(0x13)
 *   失败 3 次或窗口过期 -> 关闭窗口
 *
 * 诚实边界：临时码 32 bit，物理接触者可离线爆破；它防旁观与误配网，不防物理攻击。
 * 会话密钥 = SHA-256("safe-office/provision/v1\0" || code(小写) || host_nonce || device_nonce)。
 */

#include <stddef.h>
#include <stdint.h>
#include "sfc1_hmac.h"

#define SFC1_PROV_CODE_LEN 8
#define SFC1_PROV_MAX_ATTEMPTS 3
#define SFC1_PROV_FRAME_MAX 160

typedef struct {
    int active;                 /* 配网窗口是否打开 */
    int have_session;           /* 是否已收到 INIT 并派生会话密钥 */
    uint8_t attempts;
    char code[SFC1_PROV_CODE_LEN + 1];
    uint8_t device_id[SFC1_DEVICE_ID_LEN];
    uint8_t host_nonce[16];
    uint8_t device_nonce[16];
    uint8_t session_key[32];
    uint64_t deadline_ms;
    const char *label;
    /* COMMIT 成功后的新密钥，由调用方接手（已是内存里的新 key，不需要重启） */
    int has_new_key;
    uint8_t new_key[SFC1_KEY_LEN];
} sfc1_prov_t;

/* 打开配网窗口并生成临时码；成功返回 1 */
int sfc1_prov_begin(sfc1_prov_t *p, const char *label, uint64_t now_ms, uint64_t window_ms);

/* 窗口是否仍有效（过期会自动关闭） */
int sfc1_prov_active(sfc1_prov_t *p, uint64_t now_ms);

/* 处理一帧：需要回复时写 out/out_len 并返回 1；忽略返回 0；参数错返回 -1 */
int sfc1_prov_handle(sfc1_prov_t *p, const uint8_t *frame, size_t len, uint64_t now_ms,
                     uint8_t *out, size_t out_cap, size_t *out_len);

#endif /* SFC1_PROVISION_H */
