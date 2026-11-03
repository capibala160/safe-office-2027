'use strict';
// ============================================================
// 全量数据备份/恢复（v0.47）
//   范围：prototype/data 下的操作库、文档库、附件库、审计链/归档、用户/会话、
//         MCP 配置、keys/、calendar/、print/；可选 demo/。
//   不做：
//   - 不备份 initial-users.txt（明文初始密码）与 config.env（含密钥）
//   - 不在服务运行时保证 SQLite 一致性：备份前先停服务（恢复 CLI 会探测端口）
//   - 不加密备份本身：备份目录权限由操作系统保证，敏感环境请自行加密存放
// ============================================================
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const TOP_FILE = /\.(?:db|db-wal|db-shm|json|jsonl|head|tenants)$/i;
const EXCLUDED_NAMES = new Set(['initial-users.txt', 'config.env']);
const INCLUDED_DIRS = ['audit-archive', 'keys', 'calendar', 'print'];

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function toPosix(rel) {
  return rel.split(path.sep).join('/');
}

function isInside(parent, child) {
  const p = path.resolve(parent);
  const c = path.resolve(child);
  return c === p || c.startsWith(`${p}${path.sep}`);
}

function walkFiles(root, base = root, excluded = []) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isSymbolicLink()) {
      excluded.push({ path: toPosix(path.relative(base, full)), reason: '符号链接' });
      continue;
    }
    if (entry.isDirectory()) out.push(...walkFiles(full, base, excluded));
    else if (entry.isFile()) out.push(toPosix(path.relative(base, full)));
  }
  return out.sort();
}

function collectEntries({ dataDir = DATA_DIR, includeDemo = false } = {}) {
  const root = path.resolve(dataDir);
  const files = [];
  const excluded = [];
  for (const name of fs.readdirSync(root)) {
    const full = path.join(root, name);
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) {
      excluded.push({ path: name, reason: '符号链接' });
      continue;
    }
    if (stat.isDirectory()) continue;
    if (EXCLUDED_NAMES.has(name)) {
      excluded.push({ path: name, reason: name === 'config.env' ? '含密钥' : '含明文初始密码' });
      continue;
    }
    if (!TOP_FILE.test(name)) {
      excluded.push({ path: name, reason: '不在备份范围' });
      continue;
    }
    files.push(name);
  }
  for (const dir of INCLUDED_DIRS) {
    const full = path.join(root, dir);
    if (fs.existsSync(full) && fs.statSync(full).isDirectory()) {
      files.push(...walkFiles(full, root, excluded));
    }
  }
  if (includeDemo) {
    const demo = path.join(root, 'demo');
    if (fs.existsSync(demo)) files.push(...walkFiles(demo, root, excluded));
  } else if (fs.existsSync(path.join(root, 'demo'))) {
    excluded.push({ path: 'demo', reason: '演示数据（--include-demo 才备份）' });
  }
  const unique = [...new Set(files)].sort();
  const entries = unique.map((rel) => {
    const full = path.join(root, rel);
    return { path: toPosix(rel), bytes: fs.statSync(full).size, sha256: sha256File(full) };
  });
  return { root, entries, excluded };
}

function stampOf(date) {
  return date.toISOString().replace(/[:.]/g, '-');
}

// 创建备份目录并复制；manifest 最后写，中途失败不会留下“看起来完整”的清单
function createBackup({
  dataDir = DATA_DIR, outDir = null, includeDemo = false, now = () => new Date(),
} = {}) {
  const root = path.resolve(dataDir);
  if (!fs.existsSync(root)) throw new Error(`数据目录不存在：${root}`);
  const at = now();
  const target = path.resolve(outDir || path.join(path.dirname(root), 'backups', `backup-${stampOf(at)}`));
  if (isInside(root, target) || isInside(target, root)) {
    throw new Error('备份目录不能与数据目录互相包含');
  }
  if (fs.existsSync(target) && fs.readdirSync(target).length > 0) {
    throw new Error(`备份目录已存在且非空：${target}`);
  }
  fs.mkdirSync(target, { recursive: true });
  const { entries, excluded } = collectEntries({ dataDir: root, includeDemo });
  const copied = [];
  for (const entry of entries) {
    const from = path.join(root, entry.path.split('/').join(path.sep));
    const to = path.join(target, entry.path.split('/').join(path.sep));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    copied.push(entry);
  }
  const manifest = {
    version: 1,
    at: at.toISOString(),
    source: root,
    files: copied,
    excluded,
    note: '备份前请停止服务以保证 SQLite 一致；备份本身不加密，请自行保护',
  };
  const manifestPath = path.join(target, 'manifest.json');
  const tmp = `${manifestPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, manifestPath);
  return {
    ok: true, dir: target, at: manifest.at, files: copied,
    bytes: copied.reduce((sum, f) => sum + f.bytes, 0), excluded,
  };
}

function verifyBackup(dir) {
  const root = path.resolve(dir);
  const manifestPath = path.join(root, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return { ok: false, reason: '缺少 manifest.json', dir: root };
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    return { ok: false, reason: `manifest 解析失败：${err.message}`, dir: root };
  }
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  const missing = [];
  const mismatches = [];
  let checked = 0;
  const listed = new Set();
  for (const entry of files) {
    const rel = String((entry && entry.path) || '');
    const full = path.resolve(root, rel);
    if (!rel || path.isAbsolute(rel) || (full !== root && !full.startsWith(`${root}${path.sep}`))) {
      mismatches.push({ path: rel, reason: '路径越界' });
      continue;
    }
    listed.add(toPosix(path.relative(root, full)));
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
      missing.push(rel);
      continue;
    }
    if (Number(entry.bytes) !== fs.statSync(full).size) {
      mismatches.push({ path: rel, reason: '大小不一致' });
      continue;
    }
    if (String(entry.sha256) !== sha256File(full)) {
      mismatches.push({ path: rel, reason: '哈希不一致' });
      continue;
    }
    checked += 1;
  }
  const extra = walkFiles(root).filter((rel) => rel !== 'manifest.json' && !listed.has(rel));
  return {
    ok: missing.length === 0 && mismatches.length === 0,
    dir: root, checked, files: files.length, missing, mismatches, extra,
    manifest: { at: manifest.at || null, source: manifest.source || null },
  };
}

// 恢复到数据目录；默认拒绝覆盖。--force 时先把现有文件改名留档，再复制。
function restoreBackup({ backupDir, dataDir = DATA_DIR, force = false, now = () => new Date() } = {}) {
  const source = path.resolve(backupDir);
  const target = path.resolve(dataDir);
  if (isInside(source, target) || isInside(target, source)) {
    throw new Error('备份目录不能与数据目录互相包含');
  }
  const report = verifyBackup(source);
  if (!report.ok) {
    const detail = [...report.missing.map((p) => `缺失 ${p}`), ...report.mismatches.map((m) => `${m.path} ${m.reason}`)];
    throw new Error(`备份校验失败：${detail.join('；') || report.reason || '未知原因'}`);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8'));
  const stamp = stampOf(now());
  const conflicts = manifest.files
    .map((f) => path.join(target, f.path.split('/').join(path.sep)))
    .filter((full) => fs.existsSync(full));
  if (conflicts.length > 0 && !force) {
    throw new Error(`目标已有 ${conflicts.length} 个同名文件；确认覆盖请加 --force`);
  }
  const movedAside = [];
  for (const full of conflicts) {
    const aside = `${full}.pre-restore-${stamp}`;
    fs.renameSync(full, aside);
    movedAside.push(aside);
  }
  const restored = [];
  for (const entry of manifest.files) {
    const from = path.join(source, entry.path.split('/').join(path.sep));
    const to = path.join(target, entry.path.split('/').join(path.sep));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    restored.push(entry.path);
  }
  fs.writeFileSync(path.join(target, `restore-${stamp}.json`), JSON.stringify({
    at: now().toISOString(), from: source, files: restored, movedAside,
  }, null, 2), { encoding: 'utf8', mode: 0o600 });
  return { ok: true, dir: target, from: source, restored: restored.length, movedAside };
}

module.exports = {
  DATA_DIR, createBackup, verifyBackup, restoreBackup, collectEntries, sha256File, walkFiles,
};
