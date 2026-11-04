#ifndef WS63_PROTOCOL_H
#define WS63_PROTOCOL_H

/*
 * WS63 双板近场确认协议 v0.1（平台无关 C）
 *
 * 设计原则：
 *   - 固定二进制帧，不用 JSON（WS63 资源有限）
 *   - 小端字节序，显式编解码（不依赖结构体对齐）
 *   - HMAC 由调用方注入（板端用 mbedTLS，PC 测试用 stub）
 *   - 状态机只做“挑战 -> 决定”的一次性确认；重放由 used-nonce 窗口拦截
 *
 * 帧格式：
 *   header(10B) + payload + mac(32B)
 *   header: magic[4] version type flags reserved length_le16
 *   length = payload_len + 32（包含 MAC）
 *
 * 安全边界：
 *   - 预共享密钥；密钥不在协议层，调用方负责保管
 *   - 不证明距离/本人身份/防中继；只证明“持有密钥的确认端对这条内容按了确认”
 */

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define PROTO_MAGIC_0 'S'
#define PROTO_MAGIC_1 'F'
#define PROTO_MAGIC_2 'C'
#define PROTO_MAGIC_3 '1'

#define PROTO_VERSION 0x01u
#define PROTO_TYPE_CHALLENGE 0x01u
#define PROTO_TYPE_DECISION 0x02u
/* 执行帧（v0.52）：确认通过后由主机下发，板端验 MAC 后驱动 GPIO，再回 ACK */
#define PROTO_TYPE_ACTUATOR 0x21u
#define PROTO_TYPE_ACTUATOR_ACK 0x22u

#define PROTO_HEADER_LEN 10u
#define PROTO_TASK_ID_LEN 8u
#define PROTO_NONCE_LEN 16u
#define PROTO_HASH_LEN 32u
#define PROTO_MAC_LEN 32u
#define PROTO_SUMMARY_MAX 96u
#define PROTO_REPLAY_WINDOW 8u

/* action 只允许 1–4（两端必须一致；新增动作需升级协议版本） */
#define PROTO_ACTION_SEND_EXTERNAL 1u
#define PROTO_ACTION_DELETE 2u
#define PROTO_ACTION_PRINT 3u
#define PROTO_ACTION_DEVICE 4u
#define PROTO_ACTION_MIN PROTO_ACTION_SEND_EXTERNAL
#define PROTO_ACTION_MAX PROTO_ACTION_DEVICE

#define PROTO_CHALLENGE_PAYLOAD_FIXED (PROTO_TASK_ID_LEN + PROTO_NONCE_LEN + 1u + PROTO_HASH_LEN + 4u + 4u + 1u)
#define PROTO_DECISION_PAYLOAD_LEN (PROTO_TASK_ID_LEN + PROTO_NONCE_LEN + 1u + 8u + 4u)
#define PROTO_CHALLENGE_MAX (PROTO_HEADER_LEN + PROTO_CHALLENGE_PAYLOAD_FIXED + PROTO_SUMMARY_MAX + PROTO_MAC_LEN)
#define PROTO_DECISION_MAX (PROTO_HEADER_LEN + PROTO_DECISION_PAYLOAD_LEN + PROTO_MAC_LEN)

typedef enum {
    PROTO_OK = 0,
    PROTO_ERR_ARG = -1,
    PROTO_ERR_BUFFER = -2,
    PROTO_ERR_FRAME = -3,
    PROTO_ERR_VERSION = -4,
    PROTO_ERR_TYPE = -5,
    PROTO_ERR_MAC = -6,
    PROTO_ERR_EXPIRED = -7,
    PROTO_ERR_TASK = -8,
    PROTO_ERR_NONCE = -9,
    PROTO_ERR_REPLAY = -10,
    PROTO_ERR_DECISION = -11,
    PROTO_ERR_STATE = -12,
    PROTO_ERR_DEVICE = -13,
    PROTO_ERR_OPERATION = -14
} proto_status_t;

/* HMAC-SHA256：data -> out[32]；成功返回 0，失败返回非 0 */
typedef int (*proto_mac_fn)(const uint8_t *data, size_t len,
                            uint8_t out[PROTO_MAC_LEN], void *ctx);

typedef struct {
    uint8_t task_id[PROTO_TASK_ID_LEN];
    uint8_t nonce[PROTO_NONCE_LEN];
    uint8_t action;                      /* PROTO_ACTION_*，只允许 1–4 */
    uint8_t target_hash[PROTO_HASH_LEN]; /* SHA-256(操作摘要) */
    uint32_t issued_at;
    uint32_t expires_at;
    uint8_t summary_len;
    char summary[PROTO_SUMMARY_MAX + 1]; /* 解码时补 '\0' */
    uint8_t mac[PROTO_MAC_LEN];
} proto_challenge_t;

typedef struct {
    uint8_t task_id[PROTO_TASK_ID_LEN];
    uint8_t nonce[PROTO_NONCE_LEN];
    uint8_t decision;                    /* 0=取消 1=确认 */
    uint8_t device_id[8];
    uint32_t decided_at;
    uint8_t mac[PROTO_MAC_LEN];
} proto_decision_t;

/* 执行帧：nonce 用于板端重放窗口；pin 只允许 GPIO_10(蜂鸣器)/GPIO_13(LED) */
#define PROTO_ACTUATOR_PAYLOAD_LEN (PROTO_NONCE_LEN + 2u)
#define PROTO_ACTUATOR_ACK_PAYLOAD_LEN 3u

typedef struct {
    uint8_t nonce[PROTO_NONCE_LEN];
    uint8_t pin;
    uint8_t level;                       /* 0/1 */
    uint8_t mac[PROTO_MAC_LEN];
} proto_actuator_t;

typedef struct {
    uint8_t status;                      /* 0=成功 */
    uint8_t pin;
    uint8_t level;
    uint8_t mac[PROTO_MAC_LEN];
} proto_actuator_ack_t;

typedef struct {
    int pending;
    uint8_t task_id[PROTO_TASK_ID_LEN];
    uint8_t nonce[PROTO_NONCE_LEN];
    uint8_t action;
    uint8_t target_hash[PROTO_HASH_LEN];
    uint32_t expires_at;
    /* 已消费 nonce 的环形窗口（重放拒绝） */
    uint8_t used[PROTO_REPLAY_WINDOW][PROTO_NONCE_LEN];
    uint8_t used_count;
} proto_pending_t;

/* ---- 状态机（执行端 A） ---- */
void proto_pending_init(proto_pending_t *p);

/* 开始任务：不覆盖未过期待确认任务；TTL 须 >0 且不得溢出。
 * 已过期待确认 nonce 会被消费；已消费 nonce 返回 PROTO_ERR_REPLAY。 */
int proto_pending_begin(proto_pending_t *p,
                        const uint8_t task_id[PROTO_TASK_ID_LEN],
                        const uint8_t nonce[PROTO_NONCE_LEN],
                        uint8_t action,
                        const uint8_t target_hash[PROTO_HASH_LEN],
                        uint32_t now, uint32_t ttl_sec);

int proto_nonce_used(const proto_pending_t *p, const uint8_t nonce[PROTO_NONCE_LEN]);
void proto_mark_used(proto_pending_t *p, const uint8_t nonce[PROTO_NONCE_LEN]);

/* 底层校验：不核对配对设备/最终操作；部署时使用下面的 bound 入口。 */
int proto_accept_decision(proto_pending_t *p, const proto_decision_t *d,
                          uint32_t now, proto_mac_fn mac, void *ctx);

/* 部署入口：同时核对配对设备及即将执行的操作。调用方须冻结该操作直到执行结束。 */
int proto_accept_bound_decision(proto_pending_t *p, const proto_decision_t *d,
                                const uint8_t expected_device[8], uint8_t action,
                                const uint8_t target_hash[PROTO_HASH_LEN],
                                uint32_t now, proto_mac_fn mac, void *ctx);

/* ---- 编解码 ---- */
/* 返回写入字节数；0 = 失败（参数/缓冲/MAC） */
size_t proto_encode_challenge(const proto_challenge_t *c, uint8_t *out, size_t cap,
                              proto_mac_fn mac, void *ctx);
size_t proto_encode_decision(const proto_decision_t *d, uint8_t *out, size_t cap,
                             proto_mac_fn mac, void *ctx);

/* 解码并校验 MAC；成功返回 PROTO_OK。out->mac 保留原始 MAC 供状态机复核 */
int proto_decode_challenge(const uint8_t *buf, size_t len, proto_challenge_t *out,
                           proto_mac_fn mac, void *ctx);
int proto_decode_decision(const uint8_t *buf, size_t len, proto_decision_t *out,
                          proto_mac_fn mac, void *ctx);

/* 执行帧解码（板端）与 ACK 编码（板端） */
int proto_decode_actuator(const uint8_t *buf, size_t len, proto_actuator_t *out,
                          proto_mac_fn mac, void *ctx);
size_t proto_encode_actuator_ack(const proto_actuator_ack_t *a, uint8_t *out, size_t cap,
                                 proto_mac_fn mac, void *ctx);

const char *proto_status_str(int status);

#ifdef __cplusplus
}
#endif

#endif /* WS63_PROTOCOL_H */
