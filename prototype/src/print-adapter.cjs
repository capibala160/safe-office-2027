'use strict';
// ============================================================
// 真实打印适配器（v0.22）
//   - 通过 Windows PowerShell Out-Printer 把纯文本送到指定打印机
//   - 打印机名从环境变量 SAFE_OFFICE_PRINTER 读；未配置则返回 simulated（不冒充真打印）
//   - 只用环境变量传文件路径/打印机名，避免命令注入
// 边界：只证明"已提交到打印队列"，不证明纸张真的出来；驱动/编码由系统打印机决定。
// ============================================================
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const PS_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  'Get-Content -LiteralPath $env:SAFE_PRINT_FILE -Raw -Encoding UTF8 | Out-Printer -Name $env:SAFE_PRINT_NAME',
].join('; ');

function printText({
  text, printer = null, title = '', timeoutMs = 30000,
  exec = execFile,
} = {}) {
  if (!printer) return Promise.resolve({ mode: 'simulated', printer: null });
  const file = path.join(os.tmpdir(), `safe-office-print-${crypto.randomUUID()}.txt`);
  fs.writeFileSync(file, `${title ? `${title}\n\n` : ''}${text || ''}`, { encoding: 'utf8', mode: 0o600 });
  return new Promise((resolve) => {
    exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_SCRIPT], {
      timeout: timeoutMs,
      windowsHide: true,
      env: { ...process.env, SAFE_PRINT_FILE: file, SAFE_PRINT_NAME: printer },
    }, (err, stdout, stderr) => {
      try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
      if (!err) {
        resolve({ mode: 'printed', printer, stdout: String(stdout || '').trim() });
        return;
      }
      const message = String(stderr || err.message || err);
      // 打印机名无效/驱动拒绝 = 明确失败；其他（超时/队列异常）= 结果不确定
      const rejected = /printer|not found|invalid|无法|不存在|无效/i.test(message);
      resolve({ mode: 'failed', printer, error: message.slice(0, 300), rejected });
    });
  });
}

// ---------- v0.40 排版打印：HTML → PDF（Edge headless）→ 可选提交打印机 ----------
const EDGE_CANDIDATES = [
  process.env.SAFE_OFFICE_EDGE,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);

const PS_PRINT_PDF = [
  "$ErrorActionPreference='Stop'",
  'Start-Process -FilePath $env:SAFE_PRINT_PDF -Verb PrintTo -ArgumentList $env:SAFE_PRINT_NAME',
].join('; ');

function findEdge() {
  for (const candidate of EDGE_CANDIDATES) {
    try { if (fs.existsSync(candidate)) return candidate; } catch { /* ignore */ }
  }
  return null;
}

function escapeHtml(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildPrintHtml({ title = '', text = '', level = '', operator = '', at = new Date().toISOString() } = {}) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const body = lines.map((line) => `<p>${line ? escapeHtml(line) : '&nbsp;'}</p>`).join('\n');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(title || '安全智慧办公')}</title>
<style>
  @page { size: A4; margin: 20mm 18mm 24mm; }
  body { font-family: "Microsoft YaHei", "PingFang SC", sans-serif; color: #111; font-size: 12pt; line-height: 1.75; }
  h1 { font-size: 18pt; margin: 0 0 6mm; }
  .meta { color: #555; font-size: 9pt; border-bottom: 1px solid #bbb; padding-bottom: 3mm; margin-bottom: 8mm; }
  .level { display: inline-block; border: 1px solid #b33; color: #b33; padding: 0 4px; font-size: 9pt; }
  p { margin: 0 0 2.2mm; white-space: pre-wrap; }
  footer { position: fixed; bottom: -12mm; left: 0; right: 0; color: #888; font-size: 8.5pt; border-top: 1px solid #ddd; padding-top: 2mm; }
</style></head>
<body>
  <div class="meta">安全智慧办公 · 已批准操作导出 · ${escapeHtml(at)} · 操作人 ${escapeHtml(operator || '—')}${level ? ` · 密级 <span class="level">${escapeHtml(level)}</span>` : ''}</div>
  <h1>${escapeHtml(title || '（无标题）')}</h1>
  ${body}
  <footer>本文由安全智慧办公控制台生成；冻结哈希与审批记录见审计链。</footer>
</body></html>`;
}

function renderPdf({
  html, outFile, edgePath = findEdge(), timeoutMs = 30000, exec = execFile, tmpDir = os.tmpdir(),
} = {}) {
  if (!edgePath) {
    return Promise.resolve({ mode: 'failed', error: '未找到 Edge（可用 SAFE_OFFICE_EDGE 指定）', rejected: false });
  }
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const htmlFile = path.join(tmpDir, `safe-office-print-${crypto.randomUUID()}.html`);
  fs.writeFileSync(htmlFile, html, { encoding: 'utf8', mode: 0o600 });
  return new Promise((resolve) => {
    exec(edgePath, [
      '--headless=new', '--disable-gpu', '--no-first-run',
      `--print-to-pdf=${outFile}`,
      pathToFileURL(htmlFile).href,
    ], { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      try { fs.rmSync(htmlFile, { force: true }); } catch { /* ignore */ }
      if (err || !fs.existsSync(outFile)) {
        const message = String(stderr || (err && err.message) || 'PDF 渲染失败');
        resolve({ mode: 'failed', error: message.slice(0, 300), rejected: false });
        return;
      }
      resolve({ mode: 'pdf', file: outFile });
    });
  });
}

function submitPdf({ file, printer, timeoutMs = 30000, exec = execFile } = {}) {
  return new Promise((resolve) => {
    exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_PRINT_PDF], {
      timeout: timeoutMs,
      windowsHide: true,
      env: { ...process.env, SAFE_PRINT_PDF: file, SAFE_PRINT_NAME: printer },
    }, (err, stdout, stderr) => {
      if (!err) {
        resolve({ ok: true });
        return;
      }
      const message = String(stderr || err.message || err);
      resolve({
        ok: false,
        error: message.slice(0, 300),
        rejected: /printer|not found|invalid|无法|不存在|无效/i.test(message),
      });
    });
  });
}

// 排版打印：未配置打印机/PDF 目录 → simulated（与旧行为一致，不碰 Edge）
async function printDocument({
  text = '', title = '', level = '', operator = '',
  printer = null, pdfDir = null, now = new Date(),
  edgePath, exec = execFile, timeoutMs = 30000,
} = {}) {
  if (!printer && !pdfDir) return { mode: 'simulated', printer: null, file: null };
  const html = buildPrintHtml({ title, text, level, operator, at: now.toISOString() });
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
  const hash = crypto.createHash('sha256').update(`${title}|${text}`).digest('hex').slice(0, 8);
  const dir = pdfDir || os.tmpdir();
  const outFile = path.join(dir, `print-${stamp}-${hash}.pdf`);
  const rendered = await renderPdf({ html, outFile, edgePath, exec, timeoutMs });
  if (rendered.mode === 'failed') {
    return { mode: 'failed', printer, file: null, error: rendered.error, rejected: false };
  }
  if (!printer) return { mode: 'pdf', printer: null, file: rendered.file };
  const submitted = await submitPdf({ file: rendered.file, printer, exec, timeoutMs });
  if (!submitted.ok) {
    return {
      mode: 'failed', printer, file: rendered.file,
      error: submitted.error, rejected: submitted.rejected,
    };
  }
  return { mode: 'printed', printer, file: rendered.file };
}

module.exports = {
  printText, PS_SCRIPT,
  buildPrintHtml, renderPdf, printDocument, findEdge, escapeHtml,
  PS_PRINT_PDF,
};
