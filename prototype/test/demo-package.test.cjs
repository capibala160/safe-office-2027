'use strict';
// 一键演示包：独立演示目录、演示账号、隔离真实动作
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { seedDemo, buildDemoEnv } = require('../scripts/demo-start.cjs');
const { loadUsers } = require('../src/auth.cjs');

test('一键演示包：种子账号在独立目录，环境变量不碰正式数据/真实动作', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-office-demo-'));
  try {
    const seeded = seedDemo({ dir, reset: true });
    assert.equal(seeded.dir, dir);
    const users = loadUsers(path.join(dir, 'users.json'));
    assert.deepEqual(users.map((u) => `${u.username}:${u.role}`).sort(), [
      'demo-admin:管理员',
      'demo-auditor:审计员',
    ]);
    assert.ok(fs.existsSync(path.join(dir, 'README.txt')));

    const env = buildDemoEnv(dir);
    assert.equal(env.SAFE_OFFICE_AUTH, 'required');
    assert.equal(env.SAFE_OFFICE_SMTP_HOST, '', '演示模式必须关闭真实 SMTP');
    assert.equal(env.SAFE_OFFICE_SMTP_ACCOUNTS, '');
    assert.equal(env.SAFE_OFFICE_IMAP_HOST, '');
    assert.equal(env.SAFE_OFFICE_PRINTER, '');
    assert.equal(env.SAFE_OFFICE_LLM_ENDPOINT, '');
    assert.equal(env.SAFE_OFFICE_USERS_FILE, path.join(dir, 'users.json'));
    assert.equal(env.SAFE_OFFICE_STORE_FILE, path.join(dir, 'operations.db'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
