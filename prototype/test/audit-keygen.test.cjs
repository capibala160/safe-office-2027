'use strict';
// 审计密钥生成：默认拒绝覆盖、半套文件不落地、--force 才能覆盖
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'audit-keygen.cjs');

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

test('audit-keygen：首次生成成功；重复运行拒绝覆盖且不改文件', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-keygen-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const privateFile = path.join(dir, 'audit-ed25519-private.pem');
  const publicFile = path.join(dir, 'audit-ed25519-public.pem');

  const first = run([`--out=${dir}`]);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /私钥：/);
  assert.match(first.stdout, /keyId：/);
  assert.ok(fs.existsSync(privateFile));
  assert.ok(fs.existsSync(publicFile));
  const privateBefore = fs.readFileSync(privateFile, 'utf8');
  const publicBefore = fs.readFileSync(publicFile, 'utf8');

  const second = run([`--out=${dir}`]);
  assert.equal(second.status, 1);
  assert.match(second.stderr, /拒绝覆盖已存在的审计密钥/);
  assert.match(second.stderr, /轮换流程/);
  assert.equal(fs.readFileSync(privateFile, 'utf8'), privateBefore, '私钥不能被覆盖');
  assert.equal(fs.readFileSync(publicFile, 'utf8'), publicBefore, '公钥不能被覆盖');
});

test('audit-keygen：只缺公钥也拒绝；--force 才覆盖并换新 keyId', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-keygen-force-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const privateFile = path.join(dir, 'audit-ed25519-private.pem');
  const publicFile = path.join(dir, 'audit-ed25519-public.pem');

  const first = run([`--out=${dir}`]);
  assert.equal(first.status, 0, first.stderr);
  const firstKeyId = /keyId：([0-9a-f]+)/.exec(first.stdout)[1];
  fs.rmSync(publicFile);

  const partial = run([`--out=${dir}`]);
  assert.equal(partial.status, 1);
  assert.match(partial.stderr, /拒绝覆盖/);

  const forced = run([`--out=${dir}`, '--force']);
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(forced.stderr, /--force/);
  const secondKeyId = /keyId：([0-9a-f]+)/.exec(forced.stdout)[1];
  assert.notEqual(secondKeyId, firstKeyId);
  assert.ok(fs.existsSync(privateFile));
  assert.ok(fs.existsSync(publicFile));
});
