#ifndef SFC1_NV_H
#define SFC1_NV_H

/*
 * SFC1 掉电保存（M1）：把"已消费 nonce 的窗口"写进 NV。
 *
 * 为什么存这个：nonce 窗口原来只在 RAM，重启即清空——同一帧在断电重上电后
 * 又能被接受。落 NV 之后，重启仍会拒绝旧 nonce。
 *
 * 记录格式（160 字节）：
 *   0..7    magic "SFC1NV1\0"
 *   8       version
 *   9       count（0..PROTO_REPLAY_WINDOW）
 *   10..11  保留
 *   12..15  write_seq（小端，调试用）
 *   16..143 nonces[8][16]
 *   144..159 HMAC-SHA256(psk, 前 144 字节) 的前 16 字节
 *
 * 边界：PSK 仍是编译进镜像的演示密钥；NV 项被擦除/损坏时按"空窗口"启动并打印，
 *       不做回滚保护（写 seq 只用于调试）。
 */

#include <stdint.h>
#include "protocol.h"

/* 有有效记录返回 1；无记录/损坏返回 0，并把 count 置 0 */
int sfc1_nv_load(uint8_t used[PROTO_REPLAY_WINDOW][PROTO_NONCE_LEN], uint8_t *count, const uint8_t *key);

/* 保存当前窗口；成功返回 0 */
int sfc1_nv_save(const uint8_t used[PROTO_REPLAY_WINDOW][PROTO_NONCE_LEN], uint8_t count, const uint8_t *key);

#endif /* SFC1_NV_H */
