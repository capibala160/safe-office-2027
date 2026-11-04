#ifndef SFC1_KEY_STORE_H
#define SFC1_KEY_STORE_H

/*
 * 一机一钥的板端存储（docs/60 方案 A）。
 *
 * NV key 0x0F02，记录 64 字节：
 *   0..7    magic "SFC1KEY1"
 *   8       version
 *   9       flags（保留）
 *   10..11  保留
 *   12..15  provisioned_at（小端，秒）
 *   16..47  key[32]
 *   48..63  tag[16] = HMAC-SHA256(integrity_key, 前 48 字节)
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

/* 成功返回 0 */
int sfc1_key_store_save(const sfc1_key_record_t *rec, const char *label);

/* 擦除（写一条 magic 无效的记录）成功返回 0 */
int sfc1_key_store_erase(const char *label);

#endif /* SFC1_KEY_STORE_H */
