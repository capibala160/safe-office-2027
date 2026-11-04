'use strict';
// 设备执行帧（v0.52）：协议往返 + 串口执行器
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { createSerialActuator, mapDeviceOp } = require('../src/device-actuator.cjs');
const { encodeActuator, decodeFrame } = require('../src/ws63-protocol.cjs');

function ackFrame({ status = 0, pin = 13, level = 1 } = {}, key) {
  const header = Buffer.from([0x53, 0x46, 0x43, 0x31, 1, 0x22, 0, 0, 0, 0]);
  header.writeUInt16LE(3 + 32, 8);
  const data = Buffer.concat([header, Buffer.from([status, pin, level])]);
  return Buffer.concat([data, crypto.createHmac('sha256', key).update(data).digest()]);
}

function fakePort({ ack, key, onWrite = null, reply = true }) {
  const port = new EventEmitter();
  port.write = (buf) => {
    if (onWrite) onWrite(buf);
    if (reply) setImmediate(() => port.emit('data', ackFrame(ack, key)));
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

test('执行器：unlock → IO13 高电平，ACK 解析', async () => {
  const key = Buffer.alloc(32, 9);
  let wrote = null;
  const actuator = createSerialActuator({
    portPath: 'COM-TEST',
    key,
    openSerial: () => fakePort({ ack: { status: 0, pin: 13, level: 1 }, key, onWrite: (b) => { wrote = b; } }),
  });
  const ack = await actuator.actuate({ device: '门锁', op: 'unlock' });
  assert.equal(ack.status, 0);
  assert.equal(ack.pin, 13);
  assert.equal(ack.level, 1);
  assert.ok(wrote && wrote.subarray(0, 4).toString('ascii') === 'SFC1');
  assert.equal(wrote[5], 0x21);
});

test('执行器：beep → IO10；未映射的 op 直接拒绝', async () => {
  const key = Buffer.alloc(32, 9);
  const actuator = createSerialActuator({
    portPath: 'COM-TEST',
    key,
    openSerial: () => fakePort({ ack: { status: 0, pin: 10, level: 1 }, key }),
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
    openSerial: () => fakePort({ ack: {}, key, reply: false }),
  });
  await assert.rejects(actuator.actuate({ device: '门锁', op: 'unlock' }), /等待设备 ACK 超时/);
});

test('映射表：unlock/lock/beep/silence 只落在 IO13/IO10', () => {
  assert.deepEqual(mapDeviceOp('门锁', 'unlock'), { pin: 13, level: 1 });
  assert.deepEqual(mapDeviceOp('门锁', 'lock'), { pin: 13, level: 0 });
  assert.deepEqual(mapDeviceOp('蜂鸣器', 'beep'), { pin: 10, level: 1 });
  assert.deepEqual(mapDeviceOp('蜂鸣器', 'silence'), { pin: 10, level: 0 });
  assert.equal(mapDeviceOp('门锁', 'unknown'), null);
});
