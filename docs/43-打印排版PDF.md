# 排版打印 PDF（v0.40）

> 之前「真实打印」只是把纯文本经 `Out-Printer` 丢给打印机：没有页眉、没有密级、
> 没有操作人，正文换行也靠打印机驱动。本轮改成 **HTML → A4 PDF → 可选提交打印**。

## 1. 流水线

```
已批准正文（冻结记录）
   → buildPrintHtml：A4 版式、页眉（时间/操作人/密级）、标题、逐段正文、页脚
   → Edge headless --print-to-pdf
   → 有打印机：PowerShell Start-Process -Verb PrintTo
```

**模式**

| mode | 含义 |
|---|---|
| `printed` | PDF 已生成并提交打印队列 |
| `pdf` | 只生成 PDF（配置了 `SAFE_OFFICE_PRINT_PDF_DIR`，未配打印机） |
| `simulated` | 打印机和 PDF 目录都没配；只记录，不碰 Edge |
| `failed` | 渲染或提交失败（`rejected` 区分打印机名无效等明确失败） |

## 2. 配置

```ini
# 打印机（沿用）
SAFE_OFFICE_PRINTER=HP LaserJet MFP M232-M237
# PDF 落盘目录（v0.40 新增）；不配则 PDF 只落在临时目录（pdf 模式下会返回路径）
SAFE_OFFICE_PRINT_PDF_DIR=C:/Users/you/safe-office-print
# Edge 路径（默认查 Program Files 下的 msedge.exe）
SAFE_OFFICE_EDGE=C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe
```

打印任务记录新增 `file` 字段（PDF 路径）；`mode` 如实反映是否真的提交了打印。

## 3. 版式内容

- A4，20/18/24mm 页边距；正文 12pt、1.75 行高；
- 页眉：`安全智慧办公 · 已批准操作导出 · 时间 · 操作人 · 密级徽标`；
- 页脚固定在每页底部：`本文由安全智慧办公控制台生成；冻结哈希与审批记录见审计链。`；
- 标题与正文全部 HTML 转义（正文里的 `<script>` 不会执行）。

## 4. 验证

```bash
npm test        # 367 项：365 通过 + 2 跳过（ClamAV / 真实 Edge 默认跳过）
SAFE_OFFICE_TEST_EDGE=1 npm test   # 额外跑真实 Edge 渲染
```

`test/print-adapter.test.cjs` 新增 7 项：

- HTML 转义/页眉字段/逐行成段；
- 未配置 → `simulated`，不调用 Edge；
- 只配目录 → `pdf`，文件名 `print-<时间>-<hash8>.pdf`；
- 配打印机 → 先渲染再 `PrintTo`，`printed`；
- 打印机无效 → `failed/rejected`，PDF 仍保留；
- 找不到 Edge → 明确失败；
- **真实 Edge 渲染**（默认跳过）：设 `SAFE_OFFICE_TEST_EDGE=1` 后生成一页 PDF 并校验 `%PDF-` 头
  （本机已通过，约 1.4s）。受限沙箱里 Edge 无法启动，默认跳过避免环境性失败。

## 5. 边界

- 没在测试里真的出纸（避免浪费纸张）；`PrintTo` 依赖 Windows 的 PDF 关联程序，
  不同机器行为可能不同，失败会明确报错而不是假装成功。
- 页眉密级是文字徽标，不是斜向水印；没有骑缝章/二维码。
- 不支持附件合并打印、批量打印、双面/纸盒选择。
- PDF 目录是本机路径；`data/print-pdf` 之类目录需自行创建/清理（适配器会自动建目录）。
- Edge 版本差异可能影响 `--headless=new --print-to-pdf`；找不到时用 `SAFE_OFFICE_EDGE` 指定。
- 真实 Edge 测试默认不跑（`SAFE_OFFICE_TEST_EDGE=1` 开启）；其余打印测试用假 exec，不依赖浏览器。
