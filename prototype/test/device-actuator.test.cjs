'use strict';
// 设备执行帧（v0.52 / v0.52.1）：协议往返 + 串口执行器
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { createSerialActuator, mapDeviceOp } = require('../src/device-actuator.cjs');
const { encodeActuator, decodeFrame } = require('../src/ws63-protocol.cjs');

function ackFrame({ nonce = crypto.randomBytes(16), status = 0, pin = 13, level = 1 } = {}, key) {
  const header = Buffer.from([0x53, 0x46, 0x43, 0x31, 1, 0x22, 0, 0, 0, 0]);
  header.writeUInt16LE(19 + 32, 8);
  const data = Buffer.concat([header, nonce, Buffer.from([status, pin, level])]);
  return Buffer.concat([data, crypto.createHmac('sha256', key).update(data).digest()]);
}

// 默认把请求帧里的 nonce 原样回带；overrideNonce 用于构造「旧回执」
function fakePort({ key, status = 0, pin = 13, level = 1, reply = true, overrideNonce = null, onWrite = null }) {
  const port = new EventEmitter();
  port.write = (buf) => {
    if (onWrite) onWrite(buf);
    if (!reply) return;
    let nonce = overrideNonce;
    if (!nonce) {
      try { nonce = decodeFrame(buf, key).nonce; } catch { nonce = crypto.randomBytes(16); }
    }
    setImmediate(() => port.emit('data', ackFrame({ nonce, status, pin, level }, key)));
  };
  port.close = (cb) => { if (cb) cb(); };
  setImmediate(() => port.emit('open'));
  return port;
}

test('执行帧：encode → decode 往返，MAC 错误被拒', () => {
  const key = Buffer.alloc(32, 7);
  const nonce = crypto.randomBytes(16);
  const frame = encodeActuator({ nonce, pin: 13, level: 1 }, key);
  const decoded = decodeFrame(frame, key);
  assert.equal(decoded.type, 'actuator');
  assert.deepEqual(decoded.nonce, nonce);
  assert.equal(decoded.pin, 13);
  assert.equal(decoded.level, 1);
  assert.throws(() => decodeFrame(frame, Buffer.alloc(32, 8)), /invalid MAC/);
});

test('ACK 解码：回带 nonce/status/pin/level', () => {
  const key = Buffer.alloc(32, 7);
  const nonce = crypto.randomBytes(16);
  const ack = decodeFrame(ackFrame({ nonce, status: 0, pin: 10, level: 1 }, key), key);
  assert.equal(ack.type, 'actuator-ack');
  assert.deepEqual(ack.nonce, nonce);
  assert.equal(ack.pin, 10);
  assert.equal(ack.level, 1);
});

test('执行器：unlock → IO13 高电平，ACK 绑定本次 nonce', async () => {
  const key = Buffer.alloc(32, 9);
  let wrote = null;
  const actuator = createSerialActuator({
    portPath: 'COM-TEST',
    key,
    openSerial: () => fakePort({ key, status: 0, pin: 13, level: 1, onWrite: (b) => { wrote = b; } }),
  });
  const ack = await actuator.actuate({ device: '门锁', op: 'unlock' });
  assert.equal(ack.status, 0);
  assert.equal(ack.pin, 13);
  assert.equal(ack.level, 1);
  assert.ok(wrote && wrote.subarray(0, 4).toString('ascii') === 'SFC1');
  assert.equal(wrote[5], 0x21);
});

test('执行器：旧回执（nonce 不符）不被采信 → 超时', async () => {
  const key = Buffer.alloc(32, 9);
  const actuator = createSerialActuator({
    portPath: 'COM-TEST',
    key,
    timeoutMs: 40,
    openSerial: () => fakePort({ key, pin: 13, level: 1, overrideNonce: crypto.randomBytes(16) }),
  });
  await assert.rejects(actuator.actuate({ device: '门锁', op: 'unlock' }), /等待设备 ACK 超时/);
});

test('执行器：nonce 对上但 pin 不符 → 明确失败', async () => {
  const key = Buffer.alloc(32, 9);
  const actuator = createSerialActuator({
    portPath: 'COM-TEST',
    key,
    timeoutMs: 200,
    openSerial: () => fakePort({ key, pin: 10, level: 1 }), // 请求 13，回执 10
  });
  await assert.rejects(actuator.actuate({ device: '门锁', op: 'unlock' }), /ACK 与本次命令不符/);
});

test('执行器：beep → IO10；未映射的 op 直接拒绝', async () => {
  const key = Buffer.alloc(32, 9);
  const actuator = createSerialActuator({
    portPath: 'COM-TEST',
    key,
    openSerial: () => fakePort({ key, pin: 10, level: 1 }),
  });
  const ack = await actuator.actuate({ device: '蜂鸣器', op: 'beep' });
  assert.equal(ack.pin, 10);
  await assert.rejects(actuator.actuate({ device: '门锁', op: 'explode' }), /没有映射到物理动作/);
});

test('执行器：板端无响应 → 超时', async () => {
  const key = Buffer.alloc(32, 9);
  const actuator = createSerialActuator({
    portPath: 'COM-TEST',
    key,
    timeoutMs: 30,
    openSerial: () => fakePort({ key, reply: false }),
  });
  await assert.rejects(actuator.actuate({ device: '门锁', op: 'unlock' }), /等待设备 ACK 超时/);
});

test('执行器：serialport 未安装 → 明确错误（不是 new null 的 TypeError）', async () => {
  const actuator = createSerialActuator({
    portPath: 'COM-TEST',
    key: Buffer.alloc(32, 9),
    serialPortModule: null,
  });
  await assert.rejects(actuator.actuate({ device: '门锁', op: 'unlock' }), /serialport 未安装/);
});

test('映射表：unlock/lock/beep/silence 只落在 IO13/IO10', () => {
  assert.deepEqual(mapDeviceOp('门锁', 'unlock'), { pin: 13, level: 1 });
  assert.deepEqual(mapDeviceOp('门锁', 'lock'), { pin: 13, level: 0 });
  assert.deepEqual(mapDeviceOp('蜂鸣器', 'beep'), { pin: 10, level: 1 });
  assert.deepEqual(mapDeviceOp('蜂鸣器', 'silence'), { pin: 10, level: 0 });
  assert.equal(mapDeviceOp('门锁', 'unknown'), null);
});

test('执行器：首次打开被占用 → 短暂重试后成功', async () => {
  const key = Buffer.alloc(32, 9);
  let calls = 0;
  const actuator = createSerialActuator({
    portPath: 'COM-TEST',
    key,
    openSerial: () => {
      calls += 1;
      if (calls === 1) {
        const port = new EventEmitter();
        port.write = () => {};
        port.close = (cb) => { if (cb) cb(); };
        setImmediate(() => port.emit('error', new Error('Opening COM11: Access denied')));
        return port;
      }
      return fakePort({ key });
    },
  });
  const ack = await actuator.actuate({ device: '门锁', op: 'unlock' });
  assert.equal(ack.status, 0);
  assert.equal(calls, 2, '占用后应重试一次');
});

test('映射：relayPin=12 时 unlock/lock 走继电器，未配置仍走 IO13 LED', () => {
  assert.deepEqual(mapDeviceOp('门锁', 'unlock', 12), { pin: 12, level: 1 });
  assert.deepEqual(mapDeviceOp('门锁', 'lock', 12), { pin: 12, level: 0 });
  assert.deepEqual(mapDeviceOp('门锁', 'unlock'), { pin: 13, level: 1 });
  assert.deepEqual(mapDeviceOp('门锁', 'beep', 12), { pin: 10, level: 1 });
});

test('执行器：relayPin=12 时执行帧 pin=12，ACK 绑定同一 nonce', async () => {
  const key = Buffer.alloc(32, 11);
  let decoded = null;
  const actuator = createSerialActuator({
    portPath: 'COM-TEST',
    key,
    relayPin: 12,
    openSerial: () => fakePort({
      key, status: 0, pin: 12, level: 1,
      onWrite: (buf) => { decoded = decodeFrame(buf, key); },
    }),
  });
  const ack = await actuator.actuate({ device: '门锁', op: 'unlock' });
  assert.equal(decoded.pin, 12);
  assert.equal(decoded.level, 1);
  assert.equal(ack.pin, 12);
  assert.equal(ack.level, 1);
});
