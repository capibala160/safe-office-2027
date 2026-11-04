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
| SFC1 帧收发 / HMAC | ✅ **真机通过（M3，2026-11-04 晚）** | `board_confirm_m3.c` + `sfc1_hmac.c/h`；烧录 1,469,032B，批准/取消两条路径走通，见 [docs/57](../../docs/57-M3板端SFC1与串口CLI-2026-11-04.md) §6 |
| Flash 掉电保存（M1） | ✅ **2026-11-04 晚** | `sfc1_nv.c/h`：已消费 nonce 窗口落 NV（key `0x0F01`，160B + HMAC 校验）；断电重上电后重发旧帧 → `REPLAY`，见 [docs/57](../../docs/57-M3板端SFC1与串口CLI-2026-11-04.md) §6.7 |
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

## 3. 编译（v0.48 起用脚本）

```bash
node ws63/firmware/build-m3.cjs            # 只同步源码进 SDK
node ws63/firmware/build-m3.cjs --build    # 同步 + 编译（约 18s 增量）
```

脚本会：同步 `board-confirm/` 与 `ws63/protocol.c/h` → 删除 SDK 里的旧样例源
`base_ssd1306_demo.c` 与旧 `libsamples.a`/目标目录 → 补 PATH（工具链/ninja/gn/ccache）→
调 `src/build.py ws63-liteos-app`。

> `build.py` 需要 `ccache` 与 `ninja` 在 PATH；HiSpark Studio 会自动注入，
> 手跑时脚本已加 `D:/HiSparkToolchain/tools/cfbb/thirdparty/ccache`。

产物：

```
D:\fbb_ws63\src\output\ws63\fwpkg\ws63-liteos-app\ws63-liteos-app_all.fwpkg
```

> 手工路线（不用脚本）见 git 历史；目录名必须保持 `base_03_ssd1306`，
> 且 `base_01_ledblink` 不能同时启用（两者都定义 `task1_ID` / `app_run`）。

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

## 7. M3 联调步骤（硬件恢复后）

1. 烧录本固件（`hsflash` 或 HiSpark Studio），复位后串口应出现：
   `Enter board confirm (M3)!` / `M3 SFC1 ready: uart=0 device=ws63-A`
2. PC 侧：

   ```bash
   cd prototype
   node serial-confirm.cjs --port COM12 --demo-key --to partner@example.com --subject "Quarterly report"
   ```

3. 板端 OLED 应显示 `SEND EXT` + 摘要；短按 KEY2 → PC 输出 `decision=1`；长按 → `decision=0`（退出码 2）。
4. 异常项：拔电（PC 超时）、旧帧重放（REPLAY）、改帧（MAC）、错设备（DEVICE）、过期（EXPIRED）。

### 硬件状态（2026-11-04 晚：已解决）

**M3 已在真板跑通。** 换上的这块 FS-Hi3863DB_V2 一次握手成功、烧录 1,469,032 字节，
复位后打出 `M3 SFC1 ready: uart=0 device=ws63-A`，批准/取消两条确认路径都通过
（见 [docs/57](../../docs/57-M3板端SFC1与串口CLI-2026-11-04.md) §6）。

之前"两块板都 0 字节"的直接原因：**固件只在启动瞬间打印**，被动监听（不复位）永远收不到。
正确做法是先起监听，再按 KEY1 或断电重上电：

```bash
cd prototype
npm run serial:probe -- --port COM11 --baud 115200 --seconds 120 --watch
# 看到 [打开] 后再复位板子
```

第一块板**芯片被锁**（用户说明）——这解释了它 `hsflash` 握手失败、上电无输出的原因；
**锁定方式与是否可逆未核实**，先向厂商确认能否解锁/返修，再决定当备件还是报修
（诊断流程与报修模板见 [docs/58](../../docs/58-WS63不上电诊断清单-2026-11-04.md) §3-A / §8 / §9）。
