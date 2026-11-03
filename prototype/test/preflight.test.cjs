'use strict';
// 演示前自检：静态检查 + 运行态检查 + HTTP 管理员权限
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { staticChecks, runPreflight, formatPreflight, STATUS } = require('../src/preflight.cjs');
const { startServer } = require('../server.cjs');
const { AuthService, hashPassword } = require('../src/auth.cjs');
const { FakeMailer } = require('../src/mailer.cjs');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-office-preflight-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function find(checks, id) {
  return checks.find((c) => c.id === id);
}

test('静态检查：用户/审计/检查点齐全时判为 ok', (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify([{ username: 'a', role: '管理员' }]), 'utf8');
  fs.writeFileSync(path.join(dir, 'audit.jsonl'), '', 'utf8');
  fs.writeFileSync(path.join(dir, 'audit.jsonl.head'), '{}', 'utf8');
  const checks = staticChecks({ env: {}, dataDir: dir });
  assert.equal(find(checks, 'users').status, STATUS.OK);
  assert.equal(find(checks, 'audit').status, STATUS.OK);
  assert.equal(find(checks, 'data-dir').status, STATUS.OK);
  // 未配置 Ed25519 只提醒，不阻塞演示
  assert.equal(find(checks, 'audit-signing').status, STATUS.WARN);
});

test('静态检查：AUTH=required 但没有用户表 → fail', (t) => {
  const dir = tempDir(t);
  const checks = staticChecks({ env: { SAFE_OFFICE_AUTH: 'required' }, dataDir: dir });
  assert.equal(find(checks, 'users').status, STATUS.FAIL);
  const result = { checks, ok: false };
  assert.match(formatPreflight({ ...result, counts: { ok: 1, warn: 1, fail: 1 } }), /有阻塞项/);
});

test('运行态检查：审计链失败 → fail；FakeMailer/虚拟设备只提醒', () => {
  const service = {
    auditFile: 'C:/tmp/audit.jsonl',
    audit: { verify: () => false, entries: [1] },
    auditSigner: { algorithm: 'HMAC' },
    getAuditExternalStatus: () => ({ configured: false }),
    getState: () => ({ model: { mode: 'MockLLM（演示）', location: 'local' }, risk: { frozen: false } }),
    mailer: new FakeMailer(),
    pairingCode: null,
    getAutoReplyStatus: () => ({ enabled: false }),
    storeFile: ':memory:',
  };
  return runPreflight({ env: {}, dataDir: tempDirForTest(), service }).then((result) => {
    assert.equal(result.ok, false);
    assert.equal(find(result.checks, 'audit-live').status, STATUS.FAIL);
    assert.equal(find(result.checks, 'mailer-live').status, STATUS.WARN);
    assert.equal(find(result.checks, 'confirm-live').status, STATUS.WARN);
    assert.equal(find(result.checks, 'signing-live').status, STATUS.WARN);
  });
});

// runPreflight 需要一个真实存在的 dataDir；用系统临时目录下已存在的目录即可
function tempDirForTest() {
  return os.tmpdir();
}

test('HTTP：管理员可读自检，员工 403', async (t) => {
  const mk = (username, role) => {
    const { salt, hash } = hashPassword('password123');
    return { username, role, salt, hash };
  };
  const auth = new AuthService({ users: [mk('admin', '管理员'), mk('emp', '员工')] });
  const started = await startServer({ port: 0, auth });
  t.after(() => started.close());
  const cookie = (name) => `sfc_session=${auth.login(name, 'password123').token}`;

  const admin = await fetch(`${started.url}/api/preflight`, { headers: { Cookie: cookie('admin') } });
  assert.equal(admin.status, 200);
  const body = await admin.json();
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.preflight.checks));
  assert.ok(body.preflight.checks.length > 0);

  const emp = await fetch(`${started.url}/api/preflight`, { headers: { Cookie: cookie('emp') } });
  assert.equal(emp.status, 403);
});
