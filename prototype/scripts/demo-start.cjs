#!/usr/bin/env node
'use strict';
// ============================================================
// 一键演示包（v0.44）
//   npm run demo:start  → 建演示数据 + 演示账号 + 启动控制台
//   npm run demo:reset  → 清空演示工作区后重新启动
//   npm run demo:check  → 只建演示数据并退出（CI/自检用）
// 演示数据全部落在 prototype/data/demo/（已 gitignore），不碰正式 data/。
// ============================================================
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { hashPassword, loadUsers, saveUsers } = require('../src/auth.cjs');

const ROOT = path.join(__dirname, '..');
const DEMO_DIR = process.env.SAFE_OFFICE_DEMO_DIR
  ? path.resolve(process.env.SAFE_OFFICE_DEMO_DIR)
  : path.join(ROOT, 'data', 'demo');

function arg(name, fallback) {
  const argv = process.argv.slice(2);
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  if (index !== -1 && index + 1 < argv.length && !argv[index + 1].startsWith('--')) {
    return argv[index + 1];
  }
  return fallback;
}

const DEMO_USERS = [
  { username: 'demo-admin', role: '管理员', password: 'DemoAdmin2026!' },
  { username: 'demo-auditor', role: '审计员', password: 'DemoAuditor2026!' },
];

function ensureDemoUsers(file) {
  const existing = fs.existsSync(file) ? loadUsers(file) : [];
  const names = new Set(existing.map((u) => u.username));
  const users = [...existing];
  for (const u of DEMO_USERS) {
    if (names.has(u.username)) continue;
    const { salt, hash } = hashPassword(u.password);
    users.push({ username: u.username, role: u.role, salt, hash });
  }
  saveUsers(file, users);
  return users;
}

function buildDemoEnv(dir = DEMO_DIR, extra = {}) {
  const env = {
    ...process.env,
    // 隔离到演示目录，绝不碰正式数据
    SAFE_OFFICE_USERS_FILE: path.join(dir, 'users.json'),
    SAFE_OFFICE_SESSIONS_FILE: path.join(dir, 'sessions.json'),
    SAFE_OFFICE_STORE_FILE: path.join(dir, 'operations.db'),
    SAFE_OFFICE_AUDIT_FILE: path.join(dir, 'audit.jsonl'),
    SAFE_OFFICE_AUDIT_CHECKPOINT: path.join(dir, 'audit.jsonl.head'),
    SAFE_OFFICE_AUDIT_TENANT_CHECKPOINT: path.join(dir, 'audit.tenants.json'),
    SAFE_OFFICE_DOCS_DB: path.join(dir, 'documents.db'),
    SAFE_OFFICE_ATTACHMENTS_DB: path.join(dir, 'attachments.db'),
    SAFE_OFFICE_MCP_FILE: path.join(dir, 'mcp-servers.json'),
    SAFE_OFFICE_CALENDAR_DIR: path.join(dir, 'calendar'),
    SAFE_OFFICE_PRINT_PDF_DIR: path.join(dir, 'print'),
    // 演示：强制登录 + 允许虚拟设备确认；关闭真实邮件/打印机/真实模型，避免误发
    SAFE_OFFICE_AUTH: 'required',
    SAFE_OFFICE_ALLOW_VIRTUAL_CONFIRM: '1',
    SAFE_OFFICE_SMTP_HOST: '',
    SAFE_OFFICE_SMTP_ACCOUNTS: '',
    SAFE_OFFICE_SMTP_USER: '',
    SAFE_OFFICE_SMTP_PASS: '',
    SAFE_OFFICE_MAIL_ALLOW_TO: '',
    SAFE_OFFICE_IMAP_HOST: '',
    SAFE_OFFICE_IMAP_USER: '',
    SAFE_OFFICE_IMAP_PASS: '',
    // 自动回信默认关闭，演示包也必须关（避免误回任何真实来信）
    SAFE_OFFICE_AUTOREPLY: '',
    SAFE_OFFICE_AUTOREPLY_ALLOW_TO: '',
    SAFE_OFFICE_PRINTER: '',
    SAFE_OFFICE_LLM_ENDPOINT: '',
    SAFE_OFFICE_LLM_KEY: '',
    SAFE_OFFICE_LLM_MODEL: '',
    SAFE_OFFICE_HOST: '127.0.0.1',
    ...extra,
  };
  return env;
}

function seedDemo({ dir = DEMO_DIR, reset = false } = {}) {
  if (reset && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  ensureDemoUsers(path.join(dir, 'users.json'));
  const readme = [
    '安全智慧办公 · 一键演示包',
    '',
    '启动：npm run demo:start',
    '重置：先 Ctrl+C 停止，再 npm run demo:reset',
    '',
    '演示账号（仅本机演示，勿用于生产）：',
    '  管理员：demo-admin / DemoAdmin2026!',
    '  审计员：demo-auditor / DemoAuditor2026!',
    '',
    '地址：http://127.0.0.1:7812',
    '说明：演示模式关闭真实 SMTP/IMAP/打印/真实模型，只走内置样例与 MockLLM。',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'README.txt'), readme, { encoding: 'utf8', mode: 0o600 });
  return { dir, users: DEMO_USERS.map(({ username, role }) => ({ username, role })) };
}

function main() {
  const reset = process.argv.includes('--reset');
  const check = process.argv.includes('--check') || process.argv.includes('--no-start');
  // 真板模式：--nearfield-port COM11 [--nearfield-device ws63-A] [--gate4]
  const nearfieldPort = String(arg('nearfield-port', process.env.SAFE_OFFICE_NEARFIELD_PORT || '')).trim();
  const nearfieldDevice = String(arg('nearfield-device', process.env.SAFE_OFFICE_DEVICE || 'ws63-A')).trim() || 'ws63-A';
  const demoGate4 = process.argv.includes('--gate4');
  const nearfieldEnv = nearfieldPort
    ? {
        SAFE_OFFICE_NEARFIELD_PORT: nearfieldPort,
        SAFE_OFFICE_DEVICE: nearfieldDevice,
        SAFE_OFFICE_GATE4_NEARFIELD: process.env.SAFE_OFFICE_GATE4_NEARFIELD
          || (demoGate4 ? '1' : '0'),
      }
    : {};

  const seeded = seedDemo({ reset });
  console.log(`演示数据：${seeded.dir}`);
  console.log('演示账号：');
  for (const u of DEMO_USERS) console.log(`  ${u.role}：${u.username} / ${u.password}`);
  if (check) return;

  const env = buildDemoEnv(seeded.dir, nearfieldEnv);
  const port = Number(env.PORT) || 7812;
  console.log(`启动控制台：http://127.0.0.1:${port}`);
  console.log(nearfieldPort
    ? `（真板确认：${nearfieldPort} · 设备 ${nearfieldDevice}${env.SAFE_OFFICE_GATE4_NEARFIELD === '1' ? ' · 闸4 走真板' : ''}；MockLLM；Ctrl+C 停止）`
    : '（仅本机、虚拟确认、MockLLM；Ctrl+C 停止）');
  const child = spawn(process.execPath, [path.join(ROOT, 'server.cjs')], {
    cwd: ROOT, env, stdio: 'inherit',
  });
  const stop = () => { try { child.kill('SIGINT'); } catch { /* ignore */ } };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  child.on('exit', (code) => { process.exitCode = code === null ? 1 : code; });
}

if (require.main === module) main();

module.exports = { DEMO_DIR, DEMO_USERS, seedDemo, buildDemoEnv };
