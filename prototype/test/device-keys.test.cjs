'use strict';
// 设备钥匙解析：优先级、生产模式、设备表读取与损坏处理（docs/60）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  DEMO_KEY, readDeviceTable, findDevice, chooseDeviceKey, resolveDeviceKey,
} = require('../src/device-keys.cjs');

function tmpTable(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devkeys-'));
  const file = path.join(dir, 'devices.json');
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}

function record(deviceId, label, fill = 3) {
  return { deviceId, label, key: Buffer.alloc(32, fill).toString('base64'), provisionedAt: 'x' };
}

test('设备表：缺失返回空表；合法表只保留有 deviceId/key 的记录', () => {
  assert.deepEqual(readDeviceTable(path.join(os.tmpdir(), 'nope-devices.json')), []);
  const file = tmpTable({ version: 2, devices: [record('aa', 'ws63-A'), { label: 'broken' }] });
  const table = readDeviceTable(file);
  assert.equal(table.length, 1);
  assert.equal(table[0].deviceId, 'aa');
});

test('设备表：损坏/根数组/devices 非数组 一律抛错', () => {
  assert.throws(() => readDeviceTable(tmpTable('{bad')), /设备表损坏/);
  assert.throws(() => readDeviceTable(tmpTable('[]')), /根节点必须是对象/);
  assert.throws(() => readDeviceTable(tmpTable({ devices: 'x' })), /devices 必须是数组/);
});

test('findDevice：优先 device_id，其次标签', () => {
  const table = [record('aa', 'ws63-A', 1), record('bb', 'ws63-B', 2)];
  assert.equal(findDevice(table, { deviceId: 'bb' }).label, 'ws63-B');
  assert.equal(findDevice(table, { label: 'ws63-A' }).deviceId, 'aa');
  assert.equal(findDevice(table, { deviceId: 'zz', label: 'ws63-A' }), null, '显式 device_id 找不到不能退回标签');
});

test('chooseDeviceKey：demo > key > env > 设备表', () => {
  const rec = record('aa', 'ws63-A', 7);
  assert.equal(chooseDeviceKey({ demoKey: true }).source, 'demo');
  assert.equal(chooseDeviceKey({ keyHex: '11'.repeat(32) }).source, 'arg');
  assert.equal(chooseDeviceKey({ envKey: '22'.repeat(32) }).source, 'env');
  const fromTable = chooseDeviceKey({ record: rec });
  assert.equal(fromTable.source, 'table');
  assert.ok(fromTable.key.equals(Buffer.alloc(32, 7)));
});

test('生产模式：禁止演示密钥，其它来源照常', () => {
  assert.throws(() => chooseDeviceKey({ demoKey: true, production: true }), /生产模式/);
  assert.equal(chooseDeviceKey({ keyHex: '11'.repeat(32), production: true }).source, 'arg');
});

test('chooseDeviceKey：非法长度/格式与缺钥匙的报错', () => {
  assert.throws(() => chooseDeviceKey({ keyHex: 'abc' }), /64 位十六进制/);
  assert.throws(() => chooseDeviceKey({ envKey: 'zz' }), /64 位十六进制/);
  assert.throws(() => chooseDeviceKey({}), /缺少密钥/);
  assert.throws(() => chooseDeviceKey({ record: { deviceId: 'aa', key: Buffer.alloc(16).toString('base64') } }), /长度不对/);
});

test('resolveDeviceKey：从设备表按标签取钥；显式 --key 覆盖；环境变量覆盖', () => {
  const file = tmpTable({ version: 2, devices: [record('aa', 'ws63-A', 4)] });
  const fromTable = resolveDeviceKey({ label: 'ws63-A', file, envKey: '' });
  assert.equal(fromTable.source, 'table');
  assert.ok(fromTable.key.equals(Buffer.alloc(32, 4)));

  const byKey = resolveDeviceKey({ label: 'ws63-A', file, keyHex: '33'.repeat(32), envKey: '' });
  assert.equal(byKey.source, 'arg');

  const byEnv = resolveDeviceKey({ label: 'ws63-A', file, envKey: '44'.repeat(32) });
  assert.equal(byEnv.source, 'env');
});

test('resolveDeviceKey：设备表损坏但显式给了钥匙时仍可用', () => {
  const file = tmpTable('[]');
  const chosen = resolveDeviceKey({ file, keyHex: '55'.repeat(32), envKey: '' });
  assert.equal(chosen.source, 'arg');
  assert.throws(() => resolveDeviceKey({ file, envKey: '' }), /根节点必须是对象/);
});

test('DEMO_KEY 是 0x42×32', () => {
  assert.ok(DEMO_KEY.equals(Buffer.alloc(32, 0x42)));
});
