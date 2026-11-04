'use strict';
// 串口确认 CLI 的传输层联调测试：真实 SFC1 帧 + 真 HMAC，假的只有"串口设备"
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { OperationStore } = require('../src/store.cjs');
const { FakeMailer } = require('../src/mailer.cjs');
const { FulfillmentService } = require('../src/fulfillment.cjs');
const { VirtualDevice } = require('../src/nearfield-confirm.cjs');
const { runSerialConfirmation, buildOperation } = require('../serial-confirm.cjs');

const KEY = Buffer.alloc(32, 0x42);
const DEVICE = 'ws63-A';

function makePrepared(overrides = {}) {
  const store = new OperationStore(':memory:');
  const service = new FulfillmentService({ store, mailer: new FakeMailer() });
  const operation = service.prepare(buildOperation({
    action: 'sendExternalEmail',
    to: 'partner@example.com',
    subject: 'Quarterly report',
    ttlSec: 30,
    ...overrides,
  }));
  return { store, service, operation };
}

// 假串口：write -> 交给 VirtualDevice -> 把 DECISION 通过 'data' 回给 SerialTransport
class FakePort extends EventEmitter {
  constructor({ device = null, reply = true, tamper = false, silent = false } = {}) {
    super();
    this.isOpen = true;
    this.device = device;
    this.reply = reply;
    this.tamper = tamper;
    this.silent = silent;
    this.writes = [];
  }

  write(frame) {
    this.writes.push(Buffer.from(frame));
    if (this.silent || !this.device) return true;
    setImmediate(async () => {
      try {
        if (!this.reply) return;
        let out = await this.device.receive(frame);
        if (this.tamper) {
          out = Buffer.from(out);
          out[out.length - 1] ^= 0xff;
        }
        this.emit('data', out);
      } catch (err) {
        this.emit('error', err);
      }
    });
    return true;
  }

  close(cb) {
    this.isOpen = false;
    if (cb) setImmediate(cb);
  }
}

test('串口确认：正常批准 → decision=1，挑战帧真的写到了串口', async () => {
  const { store, operation } = makePrepared();
  const device = new VirtualDevice({ key: KEY, deviceId: DEVICE });
  const port = new FakePort({ device });

  const approval = await runSerialConfirmation({
    portPath: 'FAKE',
    key: KEY,
    deviceId: DEVICE,
    operation,
    portFactory: () => port,
    timeoutMs: 2000,
  });

  assert.equal(approval.decision, 1);
  assert.equal(approval.deviceLabel, DEVICE);
  assert.equal(port.writes.length, 1);
  assert.equal(port.writes[0].subarray(0, 4).toString('ascii'), 'SFC1');
  assert.equal(port.isOpen, false, '结束后应关闭串口');
  store.close();
});

test('串口确认：板端取消 → DECISION 错误，不产生批准', async () => {
  const { store, operation } = makePrepared();
  const device = new VirtualDevice({ key: KEY, deviceId: DEVICE, decide: () => 'cancel' });
  const port = new FakePort({ device });

  await assert.rejects(
    runSerialConfirmation({
      portPath: 'FAKE',
      key: KEY,
      deviceId: DEVICE,
      operation,
      portFactory: () => port,
      timeoutMs: 2000,
    }),
    (err) => err.code === 'DECISION' && err.cancelled === true,
  );
  assert.equal(port.isOpen, false);
  store.close();
});

test('串口确认：板端无响应 → TIMEOUT', async () => {
  const { store, operation } = makePrepared();
  const port = new FakePort({ silent: true });

  await assert.rejects(
    runSerialConfirmation({
      portPath: 'FAKE',
      key: KEY,
      deviceId: DEVICE,
      operation,
      portFactory: () => port,
      timeoutMs: 120,
    }),
    (err) => err.code === 'TIMEOUT',
  );
  assert.equal(port.isOpen, false);
  store.close();
});

test('串口确认：应答被篡改 → MAC 拒绝', async () => {
  const { store, operation } = makePrepared();
  const device = new VirtualDevice({ key: KEY, deviceId: DEVICE });
  const port = new FakePort({ device, tamper: true });

  await assert.rejects(
    runSerialConfirmation({
      portPath: 'FAKE',
      key: KEY,
      deviceId: DEVICE,
      operation,
      portFactory: () => port,
      timeoutMs: 2000,
    }),
    (err) => err.code === 'MAC',
  );
  store.close();
});

test('串口确认：设备 ID 不匹配 → DEVICE 拒绝', async () => {
  const { store, operation } = makePrepared();
  const device = new VirtualDevice({ key: KEY, deviceId: 'ws63-B' });
  const port = new FakePort({ device });

  await assert.rejects(
    runSerialConfirmation({
      portPath: 'FAKE',
      key: KEY,
      deviceId: DEVICE,
      operation,
      portFactory: () => port,
      timeoutMs: 2000,
    }),
    (err) => err.code === 'DEVICE',
  );
  store.close();
});

test('buildOperation：动作白名单与必需收件人', () => {
  assert.throws(() => buildOperation({ action: 'nope', to: 'a@b.com', ttlSec: 30 }), /不支持的动作/);
  assert.throws(() => buildOperation({ action: 'sendExternalEmail', ttlSec: 30 }), /缺少 --to/);
  const op = buildOperation({ action: 'sendExternalEmail', to: 'a@b.com', ttlSec: 30 });
  assert.equal(op.state, 'frozen');
  assert.equal(op.protocolAction, 1);
});
