# 串口日志存档

| 文件 | 时间 | 内容 | 说明 |
|---|---|---|---|
| `boot-20261027.txt` | 2026-10-27 | 出厂固件启动日志 | `flashboot 1.10.102` / `I2C SSD1306 Init succ!` / `cpu 0 entering scheduler`；含 `init_sle_mac failed!`（星闪 MAC 未初始化，待查） |
| `m3-sfc1-20261104.txt` | 2026-11-04 | **M3 固件真机启动日志** | `Enter board confirm (M3)!` / `I2C SSD1306 Init succ!` / `M3 SFC1 ready: uart=0 device=ws63-A`；烧录 1,469,032B，批准/取消闭环见 [docs/57](../../docs/57-M3板端SFC1与串口CLI-2026-11-04.md) §6 |
| `m1-nv-20261104.txt` | 2026-11-04 | **M1 掉电保存启动日志** | `SFC1 NV: no record` → `SFC1 NV: empty replay window`；固件 1,469,736B（含 `sfc1_nv.c`），断电重上电后旧 nonce 返回 `REPLAY`，见 [docs/57](../../docs/57-M3板端SFC1与串口CLI-2026-11-04.md) §6.7 |

## 采集方法

```bash
# 115200 8N1，COM11（以实际枚举为准）
python -m serial.tools.miniterm COM11 115200
# 或 HiSpark Studio 的串口监视器
```

## 归档约定

- 文件名：`<场景>-<YYYYMMDD>.txt`（如 `m1-key-20261029.txt`、`m3-sfc1-202xxxxx.txt`）。
- 只存**文本串口日志**；不存含密钥/配对码的会话。
- 每次验收同时记录：固件版本、烧录命令、现象（屏显/串口）、是否通过。
- 敏感信息（PSK、MAC 地址如涉及）先脱敏再入库。
