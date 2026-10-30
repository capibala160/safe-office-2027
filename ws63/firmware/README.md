# WS63 板端固件（可复现产物）

> 目标：把散落在 `D:\fbb_ws63` 与 `D:\HiSparkToolchain` 的板端改动收进仓库，
> 让另一台机器按本页步骤能重新编译、烧录、看到同样的现象。

## 1. 当前进度（诚实边界）

| 能力 | 状态 | 证据 |
|---|---|---|
| 烧录 / 启动 | ✅ 2026-10-29 M0 | `ws63/logs/boot-20261027.txt`（出厂固件启动日志） |
| 板载 SSD1306 OLED | ✅ 2026-10-29 M1 | 时钟正常跳动（用户目视） |
| 用户键 KEY2 | ✅ 2026-10-29 M1 | 短按 → 屏显 `APPROVED`，长按 ≥600ms → `CANCELLED`；串口同步打印 |
| 蜂鸣器 | ⏸ 按用户要求不启用 | — |
| SFC1 帧收发 / HMAC | ❌ 未做（M3） | 本固件只做按键+显示 |
| 双板 SLE / 断线重连 | ❌ 未做（M2） | 下一步 |

> 本目录的 `base_ssd1306_demo.c` 是在厂商样例 `vendor/Hqyj_Ws63/Farsight/base_03_ssd1306`
> 基础上改的按键确认版；OLED 驱动 `hal_bsp_oled/` 仍由 SDK 提供，未复制进仓库。

## 2. 依赖

| 项 | 值 |
|---|---|
| SDK | `D:\fbb_ws63`（官方 `HiSpark/fbb_ws63` master `67afcd8`，2026-10-12） |
| 工具链 | `D:\HiSparkToolchain`（HiSpark Studio VS Code 插件 26.9.1 下载） |
| 构建目标 | `ws63-liteos-app`（LiteOS，不是 OH 轻量） |
| 烧录工具 | `hsflash.exe`（工具链内） |
| 串口 | USB-UART0，**115200 8N1**；SW1 拨码 = 0 |

## 3. 编译

1. 把本目录复制进 SDK 样例目录：

   ```bash
   cp -r ws63/firmware/board-confirm D:/fbb_ws63/src/application/samples/base_03_ssd1306
   ```

   > 目录名保持 `base_03_ssd1306`，与 SDK 的 `samples/CMakeLists.txt` / Kconfig 对齐。

2. `src/application/samples/CMakeLists.txt` 只启用一个样例（`base_01_ledblink` 与
   `base_03_ssd1306` 都定义 `task1_ID` / `app_run`，同时开会 `multiple definition`）：

   ```cmake
   add_subdirectory_if_exist(base_03_ssd1306)
   # add_subdirectory_if_exist(base_01_ledblink)  ← 注释掉
   ```

3. 清掉旧目标文件（切换样例后必须做，否则旧 `libsamples.a` 仍链接 `base_01`）：

   ```bash
   rm -f D:/fbb_ws63/src/output/ws63/application/samples/libsamples.a
   rm -rf D:/fbb_ws63/src/output/ws63/application/samples/CMakeFiles/samples.dir/base_01_ledblink
   ```

4. 用 HiSpark Studio 构建 `ws63-liteos-app`，或在 SDK 根目录用 CMake 构建。
   产物：

   ```
   D:\fbb_ws63\src\output\ws63\fwpkg\ws63-liteos-app\ws63-liteos-app_all.fwpkg
   ```

## 4. 烧录

```bash
hsflash.exe write -c ws63 -p COM11 \
  -f D:/fbb_ws63/src/output/ws63/fwpkg/ws63-liteos-app/ws63-liteos-app_all.fwpkg \
  -b 921600 --switch-after-loader --before-reset --after-reset --burn-interval 5
```

操作要点（详见 [docs/10](../../docs/10-硬件上手记录.md)）：

- 工具开始等握手后**按一次 KEY1 复位**；传输开始后手离开，别再按复位/拨 S1。
- S1 关机会连 CH340 一起断电，串口会消失；烧录与抓串口不要并行。
- 成功率约 50%，失败重试即可；`--burn-interval 5` 明显提高成功率。

## 5. 接线与按键

- OLED：I2C，SDA/SCL = **IO15/IO16**，从地址 0x3C/0x3D。
- KEY2 实测 **IO3 高电平有效**（IO2/IO3 会同时被拉高）；候选脚内部下拉 + 连续 2 次采样去抖。
- KEY1 = 复位。
- 蜂鸣器 IO10（经 AO3400A 驱动）默认拉低，不启用。

## 6. 复现验收

烧录后 115200 打开串口，应看到：

1. 系统启动日志（`Flash Init Succ` / `cpu 0 entering scheduler` 等）。
2. OLED 时钟正常走动。
3. 短按 KEY2 → OLED 出现 `APPROVED`，串口打印 `KEY SHORT -> APPROVE`。
4. 长按 KEY2 ≥600ms → OLED 出现 `CANCELLED`，串口打印 `KEY LONG -> CANCEL`。

## 7. 下一步（M3：SFC1 上板）

- 串口接收 SFC1 CHALLENGE 帧 → 解析 recipient/action/target_hash → OLED 显示
- 按键决定 → `ws63/protocol.c` 组 DECISION 帧 + HMAC（接 mbedTLS）
- 与 PC 侧 `prototype/src/serial-transport.cjs` 对接，替换虚拟设备
