#ifndef SFC1_KEY_STORE_H
#define SFC1_KEY_STORE_H

/*
 * 一机一钥的板端存储（docs/60）。
 *
 * v1（无 KEK，NV key 0x0F02，64 字节）：
 *   0..7    magic "SFC1KEY1"
 *   8       version
 *   9       flags（保留）
 *   10..11  保留
 *   12..15  provisioned_at（小端，秒）
 *   16..47  key[32]（明文）
 *   48..63  tag[16] = HMAC-SHA256(integrity_key, 前 48 字节)
 *
 * v2（eFuse KEK，NV key 0x0F03，76 字节）：
 *   0..7    magic "SFC1KEY2"
 *   8       version = 2
 *   9       flags（保留）
 *   10..11  保留
 *   12..15  provisioned_at（小端，秒）
 *   16..27  nonce[12]（TRNG）
 *   28..59  ciphertext[32] = AES-128-GCM(KEK, key)
 *   60..75  tag[16]
 *   AAD = 记录头 0..15 || device_id[8]
 *
 * KEK 来自 eFuse 客户预留区（第 222 字节起 16B），只在
 * efuse_kek_state == OK 时启用；见 efuse_kek.h。
 *
 * 选择规则：
 *   - KEK 启用：优先 v2；v2 无效但 v1 有 key → 迁移为 v2 并擦除 v1；
 *   - KEK 未启用/读失败：继续用 v1（失败策略：保留可用性）。
 *
 * integrity_key = SHA-256("safe-office/ws63/key-integrity/v1\0" || device_id[8])。
 * 它由设备身份派生、**不是秘密**——只防误写/位翻转，不防主动篡改；
 * 材料里不能声称 NV 里的 key 被密码学保护（见 docs/60 §5.2）。
 */

#include <stdint.h>
#include "sfc1_hmac.h"

typedef struct {
    uint8_t key[SFC1_KEY_LEN];
    uint32_t provisioned_at;
} sfc1_key_record_t;

/* 有有效记录返回 1；无记录/损坏返回 0 */
int sfc1_key_store_load(sfc1_key_record_t *out, const char *label);

/* 成功返回 0；KEK 启用时写 v2，否则写 v1 */
int sfc1_key_store_save(const sfc1_key_record_t *rec, const char *label);

/* 擦除 v1 + v2 记录（不动 eFuse KEK）成功返回 0 */
int sfc1_key_store_erase(const char *label);

/*
 * 预演：用内存里的测试 KEK 走一遍 v2 写/读/篡改拒绝，使用临时 NV ID 0x0F05，
 * 不接触 eFuse，也不碰真实 key 记录。成功返回 0。
 */
int sfc1_key_store_selftest(const char *label);

#endif /* SFC1_KEY_STORE_H */
