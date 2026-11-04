#ifndef SFC1_HMAC_H
#define SFC1_HMAC_H

/*
 * SFC1 板端密码学适配（WS63 / mbedTLS 3.6）
 *   - sfc1_hmac_sha256：协议层 proto_mac_fn 的实现，密钥由 ctx 传入（32B）
 *   - sfc1_derive_device_id：与 PC 侧 deriveDeviceId 同域同算法（SHA-256 前 8 字节）
 *
 * 边界：演示固件把 PSK 编译进镜像（见 board_confirm_m3.c 的 DEMO_KEY），
 *       真实部署必须改为每台设备独立密钥 + 安全存储；本文件不负责密钥管理。
 */

#include <stddef.h>
#include <stdint.h>

#define SFC1_KEY_LEN 32
#define SFC1_DEVICE_ID_LEN 8

/* data -> HMAC-SHA256；成功返回 0，失败返回非 0 */
int sfc1_hmac_sha256(const uint8_t *data, size_t len, uint8_t out[32], void *ctx);

/* label -> device_id（domain || label 的 SHA-256 前 8 字节） */
int sfc1_derive_device_id(const char *label, uint8_t out[SFC1_DEVICE_ID_LEN]);

#endif /* SFC1_HMAC_H */
