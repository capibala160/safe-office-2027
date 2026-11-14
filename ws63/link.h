#ifndef WS63_LINK_H
#define WS63_LINK_H

/*
 * SFC1 双板链路保活层（M2，平台无关 C）
 *
 * 作用：
 *   - 定义 16 字节固定链路心跳帧（magic "SFCL"），只做存活判定
 *   - 维护链路状态机：DOWN（未连接）→ CONNECTED（已连接未收到心跳）→ ALIVE（心跳新鲜）
 *   - 心跳发送节奏、超时判定、丢包/重连计数
 *
 * 安全边界（必须如实写）：
 *   - 心跳帧**没有 MAC**，不是认证协议：它只回答“链路对端还在不在”
 *   - 不做距离证明、不证明本人身份、不防中继
 *   - 任何安全决策（批准/执行）仍必须走 SFC1 的 HMAC 帧，不能用心跳替代
 *
 * 传输无关：板端由 SLE 适配器（sle_link.c）收发；PC 测试用假时钟/假链路驱动。
 */

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define SFCL_FRAME_LEN 16u
#define SFCL_VERSION 0x01u
#define SFCL_TYPE_HEARTBEAT 0x01u

#define SFCL_ROLE_EXEC 0u    /* 执行端 A（SLE client） */
#define SFCL_ROLE_CONFIRM 1u /* 确认端 B（SLE server） */

#define SFCL_OK 0
#define SFCL_ERR_ARG (-1)
#define SFCL_ERR_FRAME (-2)

typedef enum {
    SFCL_STATE_DOWN = 0,      /* 传输层未连接 */
    SFCL_STATE_CONNECTED = 1, /* 传输层已连接，但还没收到新鲜心跳 */
    SFCL_STATE_ALIVE = 2      /* 心跳在 timeout_ms 内到达过 */
} sfcl_state_t;

typedef struct {
    uint32_t seq;       /* 发送方序号，每发一帧 +1 */
    uint32_t uptime_ms; /* 发送方开机毫秒数（32 位，49 天回绕） */
    uint8_t role;       /* SFCL_ROLE_* */
} sfcl_heartbeat_t;

typedef struct {
    /* 配置（init 后不变） */
    uint8_t role;
    uint16_t heartbeat_ms;
    uint16_t timeout_ms;

    /* 运行状态 */
    sfcl_state_t state;
    uint8_t transport_up;
    uint8_t has_peer;    /* 是否至少收到过一帧（跨连接保留，仅诊断） */
    uint8_t peer_role;   /* 对端最近一次上报的角色 */
    uint8_t tx_started;  /* 本连接是否已经发过心跳（0 时刻也合法，不能用时间戳当哨兵） */
    uint8_t rx_started;  /* 本连接是否已经收到过心跳 */
    uint8_t seq_started; /* 本连接是否已经建立对端序号基线（重连/对端重启后重置） */
    uint64_t last_rx_ms; /* 最近一次有效心跳的本地时刻 */
    uint64_t last_tx_ms; /* 最近一次发送的本地时刻 */
    uint32_t tx_seq;       /* 下一帧要用的序号 */
    uint32_t last_peer_seq; /* 本连接对端序号基线（seq_started=1 时有效） */

    /* 诊断计数 */
    uint32_t tx_count;
    uint32_t rx_count;
    uint32_t rx_bad;
    uint32_t rx_gap;    /* 按序号推断的丢失心跳数 */
    uint32_t rx_stale;  /* 重复/倒序心跳数 */
    uint32_t up_count;
    uint32_t down_count;
    uint32_t timeout_count;
    uint32_t send_fail_count;
} sfcl_link_t;

/* 字节流 → 16B 帧。SLE 消息天然有边界，但板端环形缓冲区可能把多帧拼在一起，
 * 所以板端也走这个解析器；PC 测试可逐字节喂。 */
typedef struct {
    uint8_t buf[SFCL_FRAME_LEN];
    uint8_t len;
} sfcl_parser_t;

int sfcl_link_init(sfcl_link_t *l, uint8_t role, uint16_t heartbeat_ms, uint16_t timeout_ms);

/* 编码固定 16B；role 非法返回 0。 */
size_t sfcl_link_encode(uint8_t out[SFCL_FRAME_LEN], uint8_t role, uint32_t seq, uint32_t uptime_ms);

/* 校验 magic/version/type/role；成功返回 SFCL_OK。 */
int sfcl_link_decode(const uint8_t *buf, size_t len, sfcl_heartbeat_t *out);

void sfcl_link_transport_up(sfcl_link_t *l, uint64_t now_ms);
void sfcl_link_transport_down(sfcl_link_t *l, uint64_t now_ms);

/* 周期调用（建议 10–50ms）。需要发心跳时返回 1 并填 out（16B）；否则返回 0。
 * 本函数同时做超时判定：心跳超时后状态降为 CONNECTED（传输仍连着），
 * 之后任意一帧有效心跳会直接恢复到 ALIVE——不要求重连，即“丢包可恢复”。 */
int sfcl_link_tick(sfcl_link_t *l, uint64_t now_ms, uint8_t out[SFCL_FRAME_LEN]);

/* 收到一帧完整候选帧；坏帧返回 SFCL_ERR_FRAME 且只增加 rx_bad，不影响状态。 */
int sfcl_link_on_frame(sfcl_link_t *l, const uint8_t *buf, size_t len, uint64_t now_ms);

/* 传输层发送失败时调用，只增加诊断计数（不改变状态）。 */
void sfcl_link_on_send_fail(sfcl_link_t *l);

void sfcl_parser_init(sfcl_parser_t *p);

/* 喂一个字节；拼出有效帧时返回 1 并填 out。坏帧会滑动 1 字节继续找 magic。 */
int sfcl_parser_feed(sfcl_parser_t *p, uint8_t byte, uint8_t out[SFCL_FRAME_LEN]);

const char *sfcl_link_state_str(sfcl_state_t state);
const char *sfcl_link_role_str(uint8_t role);

#ifdef __cplusplus
}
#endif

#endif /* WS63_LINK_H */
