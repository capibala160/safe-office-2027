#ifndef EFUSE_KEK_H
#define EFUSE_KEK_H

/*
 * eFuse 客户预留区 KEK（docs/60 阶段 B，2026-11-06 拍板）
 *
 * 安全约束：
 *   - 写接口只出现在 efuse_kek.c，efuse_probe.c 保持纯只读；
 *   - KEK 由板端 TRNG 生成，不经串口/主机；
 *   - 写入不可逆（OTP 只能 0→1），本模块不做任何自动重试。
 *
 * 预留区：第 222 字节起 16B；空白（全 0）才允许写。
 * 状态记录：NV 0x0F04，只在 state=OK 时才允许 v2 key 记录使用 KEK。
 */

#include <stdint.h>

#define EFUSE_KEK_LEN 16u

#define EFUSE_KEK_STATE_NONE    0u  /* 未启用/无记录 */
#define EFUSE_KEK_STATE_BURNING 1u  /* 已开始写，尚未确认 */
#define EFUSE_KEK_STATE_OK      2u  /* 回读校验通过 */
#define EFUSE_KEK_STATE_FAILED  3u  /* 写入/回读失败，放弃使用 */

/* 读客户预留区：1=非空，0=全 0，-1=读失败（两路读都要求成功） */
int efuse_kek_read(uint8_t out[EFUSE_KEK_LEN]);

/* 预留区是否全 0：1=空白，0=非空，-1=读失败 */
int efuse_kek_blank(void);

/* 板端 TRNG 生成 16B：0=成功，-1=失败 */
int efuse_kek_generate(uint8_t out[EFUSE_KEK_LEN]);

/*
 * 写入并回读校验（一次成功，失败不重试）：
 *   0   成功，readback 为硬件实际回读值
 *  -1   参数错误
 *  -2   预留区非空（已烧过）
 *  -3   写接口失败
 *  -4   回读失败或两路不一致
 *  -5   回读全 0（假成功）
 *  -6   回读值与写入值不一致
 */
int efuse_kek_burn(const uint8_t kek[EFUSE_KEK_LEN], uint8_t readback[EFUSE_KEK_LEN]);

/* 指纹 = SHA-256(KEK) 前 4 字节，用于串口/文档核对；不泄露明文 */
int efuse_kek_fingerprint(const uint8_t kek[EFUSE_KEK_LEN], uint8_t fp[4]);

/* NV 状态记录：返回状态值；读失败/损坏按 NONE 处理 */
int efuse_kek_state_get(void);
/* 写状态：0=成功，-1=失败 */
int efuse_kek_state_set(uint8_t state);

/*
 * 是否可启用 KEK：state==OK 且 eFuse 非空。
 * 返回 1=启用（out 写入 16B），0=未启用，-1=读失败。
 */
int efuse_kek_active(uint8_t out[EFUSE_KEK_LEN]);

#endif /* EFUSE_KEK_H */
