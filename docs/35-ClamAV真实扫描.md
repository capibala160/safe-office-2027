# ClamAV 真实扫描（v0.34）

> v0.24 已实现 `off/auto/required` 三种模式，但本机一直没有扫描器，实际只做类型/魔数检查。
> 本轮把 ClamAV 1.5.4（Windows x64 zip 版）装到用户目录并跑通真实病毒库扫描。

## 1. 安装方式（不装系统服务）

- 来源：Cisco-Talos/clamav GitHub Releases，`clamav-1.5.4.win.x64.zip`（225,774,978 字节）。
- 解压目录：`C:/Users/Lenovo/tools/clamav/clamav-1.5.4.win.x64/`。
- 病毒库目录：`C:/Users/Lenovo/tools/clamav/db/`（`main.cvd` 85MB、`daily.cvd` 23MB、`bytecode.cvd` 276KB）。
- 更新：`freshclam --config-file=...`；配置里写 `DatabaseDirectory`、`DatabaseMirror database.clamav.net`，需要代理时加 `HTTPProxyServer/HTTPProxyPort`。
- **没有**安装 Windows 服务、没有常驻 `clamd`、没有改系统 PATH；只在本项目配置里显式指向 exe。

## 2. 项目配置

`config.env.example` 新增：

```ini
SAFE_OFFICE_CLAMAV=auto
SAFE_OFFICE_CLAMAV_CMD=C:/Users/you/tools/clamav/clamav-1.5.4.win.x64/clamscan.exe
SAFE_OFFICE_CLAMAV_DB=C:/Users/you/tools/clamav/db
```

本机 `config.env`（gitignore）已填实际路径，`npm start` 会打印：

```
附件扫描：ClamAV auto（C:/Users/Lenovo/tools/clamav/clamav-1.5.4.win.x64/clamscan.exe）
```

模式语义不变：

- `off`：不扫（默认）。
- `auto`：扫描器可用就扫，不可用标注未扫描。
- `required`：扫描器不可用/扫描失败 → 拒绝附件。

## 3. 验证证据

**命令行**

- 干净文本 `clean.txt`：`OK`，exit 0。
- EICAR 测试文件（68 字节标准串）：`Eicar-Test-Signature FOUND`，exit 1。

**项目代码 `scanAttachment`**

- `mode=auto`：干净文本 → `{ok:true, scanned:true, engine:'clamav'}`；EICAR → `{ok:false, reason:'ClamAV 检出恶意内容'}`。
- `mode=required`：干净文本 `scanned:true`；EICAR 拒绝。
- `test/attachment-security.test.cjs` 新增真实扫描用例：只有配置了 `SAFE_OFFICE_CLAMAV_CMD` 且路径存在才运行，否则跳过。

**测试数**

```bash
cd prototype
# 未配置 ClamAV：323 通过 + 1 跳过
npm test
# 配置本机 ClamAV：324 全绿（真实扫描用例执行）
SAFE_OFFICE_CLAMAV_CMD=... SAFE_OFFICE_CLAMAV_DB=... npm test
```

## 4. 边界

- 病毒库有时效；`daily.cvd` 需要定期 `freshclam` 更新，否则新样本可能漏检。
- 每次 `clamscan` 冷启动要加载约 108MB 病毒库，单次扫描是秒级开销；不是常驻 `clamd` 的低延迟方案。
- `auto` 模式下扫描失败只标注未扫描；要强保证请用 `required`（失败即拒绝）。
- 扫描结果依赖 ClamAV 引擎与病毒库，不构成对所有恶意文件的保证；类型/魔数白名单仍是第一道。
- 本机安装路径是用户目录，换机/重装需重新下载病毒库并更新 `config.env`。
