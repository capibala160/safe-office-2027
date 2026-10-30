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

module.exports = { printText, PS_SCRIPT };
