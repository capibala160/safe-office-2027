'use strict';
// 配网"钥匙不丢"（docs/60 复核问题 1/3）：pending 按设备多记录、只清本次、目录自动创建。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  saveDevice, writePending, readPendingAll, listPending, readPendingFor, clearPending,
  pendingFileFor, chooseKey,
} = require('../scripts/provision-device.cjs');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'prov-test-'));
}

function record(deviceId, label = 'ws63-A', fill = 1) {
  return { deviceId, label, key: Buffer.alloc(32, fill).toString('base64'), createdAt: '2026-11-04T00:00:00Z' };
}

test('pending：多设备共存，读各自的记录', () => {
  const dir = tmpDir();
  const file = pendingFileFor(path.join(dir, 'devices.json'));
  writePending(file, record('aa'));
  writePending(file, record('bb', 'ws63-B', 2));
  assert.equal(listPending(file).length, 2);
  assert.equal(readPendingFor(file, 'aa').label, 'ws63-A');
  assert.equal(readPendingFor(file, 'bb').label, 'ws63-B');
  assert.equal(readPendingFor(file, 'cc'), null);
});

test('pending：清除只清本次设备，不影响其它设备的未恢复记录（评审问题 1）', () => {
  const dir = tmpDir();
  const file = pendingFileFor(path.join(dir, 'devices.json'));
  writePending(file, record('aa'));
  writePending(file, record('bb', 'ws63-B', 2));
  clearPending(file, 'bb');
  assert.ok(readPendingFor(file, 'aa'), 'A 的 pending 必须还在');
  assert.equal(readPendingFor(file, 'bb'), null);
  assert.ok(fs.existsSync(file), '还有其它设备记录时不能删文件');
  clearPending(file, 'aa');
  assert.equal(fs.existsSync(file), false, '最后一条清掉后才删文件');
});

test('pending：父目录不存在时自动创建（评审问题 3）', () => {
  const dir = tmpDir();
  const file = pendingFileFor(path.join(dir, 'nested', 'deeper', 'devices.json'));
  assert.equal(fs.existsSync(path.dirname(file)), false);
  writePending(file, record('aa'));
  assert.ok(fs.existsSync(file));
  assert.equal(readPendingFor(file, 'aa').deviceId, 'aa');
});

test('pending：损坏/缺文件返回空表，不抛错', () => {
  const dir = tmpDir();
  const file = pendingFileFor(path.join(dir, 'devices.json'));
  assert.deepEqual(readPendingAll(file), {});
  fs.writeFileSync(file, '{bad json');
  assert.deepEqual(readPendingAll(file), {});
});

test('chooseKey：--key 优先于 pending；同设备 pending 复用；否则随机', () => {
  const pending = record('aa', 'ws63-A', 9);
  assert.equal(chooseKey({ keyHex: '11'.repeat(32), pending, deviceIdHex: 'aa' }).source, 'arg');

  const reused = chooseKey({ pending, deviceIdHex: 'aa' });
  assert.equal(reused.source, 'pending');
  assert.ok(reused.key.equals(Buffer.alloc(32, 9)));

  const other = chooseKey({ pending, deviceIdHex: 'zz' });
  assert.equal(other.source, 'random');
  assert.equal(other.key.length, 32);
});

test('chooseKey：pending 钥匙长度不对要报错', () => {
  assert.throws(
    () => chooseKey({ pending: { deviceId: 'aa', key: Buffer.alloc(16, 1).toString('base64') }, deviceIdHex: 'aa' }),
    /长度/,
  );
});

test('设备表：按 deviceId upsert，钥匙 base64 原样保留', () => {
  const dir = tmpDir();
  const out = path.join(dir, 'devices.json');
  const key = Buffer.alloc(32, 7);
  saveDevice(out, { deviceId: Buffer.from('11111111', 'hex'), label: 'ws63-A', key });
  saveDevice(out, { deviceId: Buffer.from('11111111', 'hex'), label: 'ws63-A2', key });
  const table = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(table.devices.length, 1);
  assert.equal(table.devices[0].label, 'ws63-A2');
  assert.ok(Buffer.from(table.devices[0].key, 'base64').equals(key));
});
