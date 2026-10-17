# WS63 双板近场确认 · 协议核心

> 目标平台：WS63（fbb_ws63 / HiSpark SDK，OpenHarmony 5.1.0 轻量系统）
> 本目录是与 SDK 无关的协议核心 + PC 侧测试；板端接入见下文。

## 这是什么

- `protocol.h` / `protocol.c`：挑战-应答帧的编解码、MAC 校验、nonce/过期/重放状态机
- `test_protocol.c`：PC 侧测试（不需要板子）
- 已测：帧往返、正常确认、取消、过期、错任务、错 nonce、重放、篡改、缓冲不足、MAC 复核

**没有测**：真实 SLE 链路、真实 mbedTLS HMAC、按键/屏幕/继电器、Flash 审计。这些在板端接。

## PC 上跑测试

需要 gcc（Git Bash/MSYS2 自带即可）：

```bash
cd ws63
gcc -std=c11 -Wall -Wextra -Werror -O2 -o test_protocol protocol.c test_protocol.c
./test_protocol
# 期望输出：PASS: all protocol tests
```

或：

```bash
sh run_tests.sh
```

> 测试里的 `test_mac` 是**确定性伪 MAC**，只用于验证帧和状态机，不是密码学 MAC。板端必须换成 mbedTLS 的 HMAC-SHA256。

## 帧格式（v0.1）

```
header(10B) + payload + mac(32B)
header: magic "SFC1" | version 0x01 | type | flags | reserved | length_le16
length = payload_len + 32（含 MAC）
```

- CHALLENGE：task_id(8) + nonce(16) + action(1) + target_hash(32) + issued_at(4) + expires_at(4) + summary_len(1) + summary(≤96)
- DECISION：task_id(8) + nonce(16) + decision(1) + device_id(8) + decided_at(4)
- MAC 覆盖 header + payload（不含 MAC 本身）
- 全部小端；显式编解码，不依赖结构体对齐

## 接到 fbb_ws63（步骤）

### 1. 放进工程

把 `protocol.c` / `protocol.h` 拷到你的应用目录（例如 `src/application/samples/your_app/`），并把该目录加入编译（CMakeLists 的源文件列表/头文件路径，按 fbb_ws63 的样例改）。

### 2. 准备 HMAC 适配器

板端用 mbedTLS：

```c
#include "mbedtls/md.h"
#include "protocol.h"

/* key 是 32B 预共享密钥；ctx 传 key */
static int board_hmac(const uint8_t *data, size_t len,
                      uint8_t out[PROTO_MAC_LEN], void *ctx)
{
    const uint8_t *key = (const uint8_t *)ctx;
    const mbedtls_md_info_t *md = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
    if (md == NULL) return -1;
    return mbedtls_md_hmac(md, key, 32, data, len, out) == 0 ? 0 : -1;
}
```

> 以 fbb_ws63 实际携带的 mbedTLS 头文件/路径为准；若 SDK 没开 HMAC，打开对应宏或换用 SDK 自带 crypto 接口。

### 3. 预共享密钥

演示用编译期常量：

```c
static const uint8_t PRE_SHARED_KEY[32] = { /* 32 bytes */ };
```

- 两块板必须一致
- **边界**：密钥在 Flash/固件里，能读固件就能读密钥；这不是 HUKS/TEE
- 生产应改为安全分发/安全元件；材料里不要写“硬件密钥库”

### 4. 执行端 A：发起挑战

```c
proto_pending_t pending;
proto_pending_init(&pending);

uint8_t task_id[8]  = { /* 任务号 */ };
uint8_t nonce[16];  /* 用 SDK 随机源填充 */
uint8_t target_hash[32]; /* SHA-256(操作摘要) */

proto_pending_begin(&pending, task_id, nonce, ACTION_SEND_EXTERNAL,
                    target_hash, now_sec, 30);

proto_challenge_t ch;
memset(&ch, 0, sizeof(ch));
memcpy(ch.task_id, task_id, 8);
memcpy(ch.nonce, nonce, 16);
memcpy(ch.target_hash, target_hash, 32);
ch.action = ACTION_SEND_EXTERNAL;
ch.issued_at = now_sec;
ch.expires_at = now_sec + 30;
ch.summary_len = (uint8_t)strlen(summary);
memcpy(ch.summary, summary, ch.summary_len);

uint8_t frame[PROTO_CHALLENGE_MAX];
size_t n = proto_encode_challenge(&ch, frame, sizeof(frame), board_hmac, (void *)PRE_SHARED_KEY);
/* 把 frame[0..n) 通过 SLE 发给 B */
```

### 5. 确认端 B：解码 + 按键 + 回决定

```c
proto_challenge_t ch;
int rc = proto_decode_challenge(rx, rx_len, &ch, board_hmac, (void *)PRE_SHARED_KEY);
if (rc == PROTO_OK) {
    show_summary(ch.summary);          /* OLED / LED 模式 / 串口 */
    int approve = wait_button(30);     /* 1=确认 0=取消 -1=超时 */

    proto_decision_t d;
    memset(&d, 0, sizeof(d));
    memcpy(d.task_id, ch.task_id, 8);
    memcpy(d.nonce, ch.nonce, 16);
    d.decision = approve == 1 ? 1 : 0;
    fill_device_id(d.device_id);
    d.decided_at = now_sec;

    uint8_t out[PROTO_DECISION_MAX];
    size_t n = proto_encode_decision(&d, out, sizeof(out), board_hmac, (void *)PRE_SHARED_KEY);
    /* 把 out[0..n) 通过 SLE 回给 A */
}
```

### 6. 执行端 A：验决定 + 执行/拒绝

```c
proto_decision_t d;
if (proto_decode_decision(rx, rx_len, &d, board_hmac, (void *)PRE_SHARED_KEY) == PROTO_OK) {
    int rc = proto_accept_decision(&pending, &d, now_sec,
                                   board_hmac, (void *)PRE_SHARED_KEY);
    if (rc == PROTO_OK) {
        execute_action();   /* 继电器/LED/串口日志 */
        audit_append("approved");
    } else {
        deny(rc);           /* 红灯/蜂鸣；rc 见 proto_status_str */
        audit_append(proto_status_str(rc));
    }
}
```

### 7. 定时/超时

- A 在 `pending.expires_at` 到点后主动拒绝并清状态
- B 在 `wait_button` 超时后回 `decision=0`
- 无 RTC 时用开机秒表；重启后的过期策略要重新评估（演示可接受）

## 状态码

| 值 | 含义 |
|---|---|
| `PROTO_OK` | 确认通过 |
| `PROTO_ERR_MAC` | MAC 校验失败（篡改/错密钥） |
| `PROTO_ERR_EXPIRED` | 超时 |
| `PROTO_ERR_TASK` | task_id 不匹配 |
| `PROTO_ERR_NONCE` | nonce 不匹配 |
| `PROTO_ERR_REPLAY` | nonce 已消费（重放） |
| `PROTO_ERR_DECISION` | 取消，或 decision 值非法 |
| `PROTO_ERR_STATE` | 当前没有待确认任务 |
| `PROTO_ERR_FRAME` / `VERSION` / `TYPE` | 帧格式错误 |

## 还没做的（下一步）

- [ ] SLE 收发接入（用 fbb_ws63 的 SLE 例程改）
- [ ] GPIO 按键 + LED/蜂鸣器
- [ ] 2.8" 屏/OLED 显示操作摘要（有驱动再用）
- [ ] Flash 审计环形缓冲
- [ ] 继电器/门锁执行
- [ ] 双板联调：正常 / 不在场 / 取消 / 重放 / 篡改 / 错设备

## 边界

- 不证明距离、不防中继、不做本人身份认证
- 密钥在 Flash，不是 HUKS/TEE
- 协议核心已在 PC 上测通；**板端 SLE/mbedTLS/按键仍需实测**
