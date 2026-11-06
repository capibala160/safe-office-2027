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

test('执行器：命令已写出后报 busy → 不重开串口、不重发（防重复执行）', async () => {
  const key = Buffer.alloc(32, 21);
  let opens = 0;
  let writes = 0;
  const actuator = createSerialActuator({
    portPath: 'COM-TEST',
    key,
    openSerial: () => {
      opens += 1;
      const port = new EventEmitter();
      port.write = () => {
        writes += 1;
        setImmediate(() => port.emit('error', new Error('Error: Device busy')));
      };
      port.close = (cb) => { if (cb) cb(); };
      setImmediate(() => port.emit('open'));
      return port;
    },
  });
  await assert.rejects(actuator.actuate({ device: '门锁', op: 'unlock' }), /busy/);
  assert.equal(opens, 1, '命令写出后失败不得重新打开串口重试');
  assert.equal(writes, 1, '同一次操作只允许写出 1 条执行帧');
});

test('执行器：异常长度帧头不阻塞后续有效 ACK', async () => {
  const key = Buffer.alloc(32, 22);
  const actuator = createSerialActuator({
    portPath: 'COM-TEST',
    key,
    timeoutMs: 500,
    openSerial: () => {
      const port = new EventEmitter();
      port.write = (buf) => {
        const { nonce } = decodeFrame(buf, key);
        const ack = ackFrame({ nonce, status: 0, pin: 13, level: 1 }, key);
        // 长度字段异常（0x7fff / 0）的假帧头 + 紧跟有效 ACK
        const badLarge = Buffer.from([0x53, 0x46, 0x43, 0x31, 1, 0x22, 0, 0, 0xff, 0x7f]);
        const badSmall = Buffer.from([0x53, 0x46, 0x43, 0x31, 1, 0x22, 0, 0, 0x00, 0x00]);
        setImmediate(() => port.emit('data', Buffer.concat([badLarge, badSmall, ack])));
      };
      port.close = (cb) => { if (cb) cb(); };
      setImmediate(() => port.emit('open'));
      return port;
    },
  });
  const ack = await actuator.actuate({ device: '门锁', op: 'unlock' });
  assert.equal(ack.status, 0);
  assert.equal(ack.level, 1);
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

test('映射：继电器只响应门锁类设备的开/关语义，开灯不会开锁', () => {
  // 门锁类设备 + 显式锁语义 → 继电器
  assert.deepEqual(mapDeviceOp('会议室-门锁', 'unlock', 12), { pin: 12, level: 1 });
  assert.deepEqual(mapDeviceOp('front-door', 'open', 12), { pin: 12, level: 1 });
  assert.deepEqual(mapDeviceOp('会议室-门锁', 'lock', 12), { pin: 12, level: 0 });
  // 非门锁设备的锁语义 → fail-closed，不落到继电器
  assert.equal(mapDeviceOp('会议室灯', 'unlock', 12), null);
  assert.equal(mapDeviceOp('空调', 'open', 12), null);
  // 通用的 on/off 仍只驱动 IO13 LED，绝不碰继电器
  assert.deepEqual(mapDeviceOp('会议室灯', 'on', 12), { pin: 13, level: 1 });
  assert.deepEqual(mapDeviceOp('门锁', 'on', 12), { pin: 13, level: 1 });
  assert.deepEqual(mapDeviceOp('门锁', 'off', 12), { pin: 13, level: 0 });
  // 未配置继电器 / 显式配置 IO13 时保持旧行为（IO13 不是继电器）
  assert.deepEqual(mapDeviceOp('会议室灯', 'unlock'), { pin: 13, level: 1 });
  assert.deepEqual(mapDeviceOp('会议室灯', 'unlock', 13), { pin: 13, level: 1 });
});

test('执行器：relayPin 只接受固件支持的 IO12/IO13，其余配置直接拒绝', () => {
  const key = Buffer.alloc(32, 12);
  for (const bad of [10, 14, 0, 1.5, Number.NaN]) {
    assert.throws(
      () => createSerialActuator({ portPath: 'COM-TEST', key, relayPin: bad }),
      /relayPin/,
      `relayPin=${bad} 应被拒绝`,
    );
  }
});

test('执行器：继电器模式下非门锁设备 unlock 直接拒绝，且不写串口', async () => {
  const key = Buffer.alloc(32, 13);
  let writes = 0;
  const actuator = createSerialActuator({
    portPath: 'COM-TEST',
    key,
    relayPin: 12,
    openSerial: () => fakePort({ key, pin: 12, level: 1, onWrite: () => { writes += 1; } }),
  });
  await assert.rejects(
    actuator.actuate({ device: '会议室灯', op: 'unlock' }),
    /没有映射到物理动作/,
  );
  assert.equal(writes, 0, '被拒绝时不应向板子发任何执行帧');
});
