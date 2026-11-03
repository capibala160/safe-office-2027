'use strict';
// 全量备份/恢复：清单、校验、覆盖保护
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBackup, verifyBackup, restoreBackup } = require('../src/backup.cjs');

function tempDir(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `safe-office-${name}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function seedData(dir) {
  fs.mkdirSync(path.join(dir, 'audit-archive'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'keys'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'demo'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'operations.db'), 'ops', 'utf8');
  fs.writeFileSync(path.join(dir, 'documents.db'), 'docs', 'utf8');
  fs.writeFileSync(path.join(dir, 'users.json'), '{"users":[]}', 'utf8');
  fs.writeFileSync(path.join(dir, 'audit.jsonl'), '{"seq":1}\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'audit.jsonl.head'), '{}', 'utf8');
  fs.writeFileSync(path.join(dir, 'audit-archive', 'audit-1.jsonl'), 'old', 'utf8');
  fs.writeFileSync(path.join(dir, 'keys', 'audit-public.pem'), 'pub', 'utf8');
  fs.writeFileSync(path.join(dir, 'demo', 'users.json'), 'demo', 'utf8');
  fs.writeFileSync(path.join(dir, 'initial-users.txt'), 'alice:password', 'utf8');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not in scope', 'utf8');
}

test('备份：收录数据文件，排除明文初始密码与 demo（默认）', (t) => {
  const data = tempDir(t, 'data');
  seedData(data);
  const out = path.join(tempDir(t, 'out'), 'backup');
  const result = createBackup({ dataDir: data, outDir: out, now: () => new Date('2026-11-03T12:00:00Z') });
  assert.equal(result.ok, true);
  const names = result.files.map((f) => f.path).sort();
  assert.ok(names.includes('operations.db'));
  assert.ok(names.includes('documents.db'));
  assert.ok(names.includes('audit.jsonl'));
  assert.ok(names.includes('audit.jsonl.head'));
  assert.ok(names.includes('audit-archive/audit-1.jsonl'));
  assert.ok(names.includes('keys/audit-public.pem'));
  assert.ok(!names.includes('initial-users.txt'));
  assert.ok(!names.includes('demo/users.json'));
  assert.ok(!names.includes('notes.txt'));
  assert.ok(result.excluded.some((x) => x.path === 'initial-users.txt'));
  assert.ok(result.excluded.some((x) => x.path === 'demo'));

  const check = verifyBackup(out);
  assert.equal(check.ok, true);
  assert.equal(check.checked, result.files.length);
});

test('备份校验：改内容/删文件/路径越界都能发现', (t) => {
  const data = tempDir(t, 'data');
  seedData(data);
  const out = path.join(tempDir(t, 'out'), 'backup');
  createBackup({ dataDir: data, outDir: out });

  fs.writeFileSync(path.join(out, 'operations.db'), 'tampered', 'utf8');
  fs.rmSync(path.join(out, 'documents.db'));
  const result = verifyBackup(out);
  assert.equal(result.ok, false);
  assert.ok(result.mismatches.some((m) => m.path === 'operations.db'));
  assert.ok(result.missing.includes('documents.db'));

  const evil = path.join(tempDir(t, 'evil'), 'backup');
  fs.mkdirSync(evil, { recursive: true });
  fs.writeFileSync(path.join(evil, 'manifest.json'), JSON.stringify({
    files: [{ path: '../../escape.txt', bytes: 1, sha256: 'x' }],
  }), 'utf8');
  const evilCheck = verifyBackup(evil);
  assert.equal(evilCheck.ok, false);
  assert.ok(evilCheck.mismatches.some((m) => m.reason === '路径越界'));
});

test('恢复：默认拒绝覆盖，--force 先留档再恢复', (t) => {
  const data = tempDir(t, 'data');
  seedData(data);
  const out = path.join(tempDir(t, 'out'), 'backup');
  createBackup({ dataDir: data, outDir: out });

  fs.writeFileSync(path.join(data, 'operations.db'), 'newer', 'utf8');
  assert.throws(() => restoreBackup({ backupDir: out, dataDir: data }), /已存在|同名文件/);

  const restored = restoreBackup({
    backupDir: out, dataDir: data, force: true,
    now: () => new Date('2026-11-03T13:00:00Z'),
  });
  assert.equal(restored.ok, true);
  assert.equal(fs.readFileSync(path.join(data, 'operations.db'), 'utf8'), 'ops');
  assert.ok(restored.movedAside.length >= 1);
  assert.ok(fs.existsSync(`${path.join(data, 'operations.db')}.pre-restore-2026-11-03T13-00-00-000Z`));
});
