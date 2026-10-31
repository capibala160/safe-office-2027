'use strict';
// ============================================================
// 附件安全检查（v0.24）
//   1) 扩展名/魔数白名单：可执行文件与脚本一律拒绝
//   2) 可选 ClamAV：SAFE_OFFICE_CLAMAV=required|auto|off（默认 off）
//      required：扫描器不可用 → 拒绝；auto：可用则扫，不可用标注未扫描
//      命中病毒 → rejected
// 边界：不是杀毒引擎；魔数可伪造；ClamAV 结果依赖病毒库。
// ============================================================
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const BLOCKED_EXT = new Set([
  '.exe', '.dll', '.sys', '.scr', '.com', '.bat', '.cmd', '.ps1', '.vbs', '.js', '.jse',
  '.wsf', '.msi', '.jar', '.sh', '.py', '.rb', '.php', '.lnk', '.reg',
]);

const ALLOWED_EXT = new Set([
  '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.txt', '.md', '.csv',
  '.docx', '.xlsx', '.pptx', '.zip',
]);

function detectKind(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return 'empty';
  const head = buffer.subarray(0, 8);
  if (head.subarray(0, 4).toString('latin1') === '%PDF') return 'pdf';
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (head.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'jpeg';
  if (head.subarray(0, 4).toString('latin1') === 'GIF8') return 'gif';
  if (head.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (head.subarray(0, 2).toString('latin1') === 'PK') return 'zip';
  if (head.subarray(0, 2).toString('latin1') === 'MZ') return 'pe';
  if (head.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return 'elf';
  // 文本：无 NUL 且能按 UTF-8 解码
  if (!buffer.includes(0)) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(buffer);
      return 'text';
    } catch { /* fallthrough */ }
  }
  return 'binary';
}

function extOf(filename) {
  return path.extname(String(filename || '')).toLowerCase();
}

function findClamav() {
  // 允许显式指定可执行文件（Windows zip 解压目录通常不在 PATH）
  const configured = process.env.SAFE_OFFICE_CLAMAV_CMD;
  if (configured) {
    try {
      execFileSync(configured, ['--version'], { stdio: 'ignore', timeout: 5000 });
      return configured;
    } catch {
      return null;
    }
  }
  for (const cmd of ['clamdscan', 'clamscan']) {
    try {
      execFileSync(cmd, ['--version'], { stdio: 'ignore', timeout: 3000 });
      return cmd;
    } catch { /* try next */ }
  }
  return null;
}

function scanWithClamav(buffer, filename, { cmd = null, db = null, timeoutMs = 15000 } = {}) {
  const scanner = cmd || findClamav();
  if (!scanner) return { available: false, infected: false };
  const database = db || process.env.SAFE_OFFICE_CLAMAV_DB || null;
  const file = path.join(os.tmpdir(), `safe-office-scan-${crypto.randomUUID()}`);
  fs.writeFileSync(file, buffer, { mode: 0o600 });
  try {
    const args = ['--no-summary'];
    if (database) args.push(`--database=${database}`);
    args.push(file);
    execFileSync(scanner, args, { stdio: 'pipe', timeout: timeoutMs });
    return { available: true, infected: false };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { available: false, infected: false };
    // clamscan 命中病毒时 exit=1；2=扫描错误
    if (err && err.status === 1) return { available: true, infected: true };
    return { available: true, error: String((err && err.message) || err), infected: false };
  } finally {
    try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
  }
}

function scanAttachment(buffer, {
  filename = '', clamavMode = process.env.SAFE_OFFICE_CLAMAV || 'off', clamavCmd = null, clamavDb = null,
} = {}) {
  const ext = extOf(filename);
  if (BLOCKED_EXT.has(ext)) {
    return { ok: false, rejected: true, reason: `不允许的附件类型：${ext}` };
  }
  if (ALLOWED_EXT.size > 0 && ext && !ALLOWED_EXT.has(ext)) {
    return { ok: false, rejected: true, reason: `附件类型不在白名单：${ext}` };
  }
  const kind = detectKind(buffer);
  if (kind === 'pe' || kind === 'elf') {
    return { ok: false, rejected: true, reason: '附件内容是可执行文件，拒绝' };
  }
  if (kind === 'empty') return { ok: false, rejected: true, reason: '附件是空文件' };

  const mode = String(clamavMode || 'off').toLowerCase();
  if (mode === 'off') return { ok: true, kind, scanned: false, engine: null };
  const result = scanWithClamav(buffer, filename, { cmd: clamavCmd, db: clamavDb });
  if (!result.available) {
    if (mode === 'required') return { ok: false, rejected: true, reason: 'ClamAV 不可用（required 模式拒绝）' };
    return { ok: true, kind, scanned: false, engine: null, note: 'ClamAV 不可用，未扫描' };
  }
  if (result.infected) return { ok: false, rejected: true, reason: 'ClamAV 检出恶意内容' };
  if (result.error) {
    if (mode === 'required') return { ok: false, rejected: true, reason: `ClamAV 扫描失败：${result.error}` };
    return { ok: true, kind, scanned: false, engine: result.engine || 'clamav', note: '扫描失败，未判定' };
  }
  return { ok: true, kind, scanned: true, engine: 'clamav' };
}

module.exports = {
  scanAttachment, detectKind, extOf, BLOCKED_EXT, ALLOWED_EXT, findClamav, scanWithClamav,
};
