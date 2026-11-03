'use strict';
// 串口 transport 测试（v0.14 草案）
//   覆盖：分片/噪声重同步、正常闭环、超时、帧类型过滤、串行化
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { sealOperation } = require('../src/operation.cjs');
const { encodeChallenge, encodeDecision, decodeFrame } = require('../src/ws63-protocol.cjs');
const { NearfieldConfirmer, VirtualDevice } = require('../src/nearfield-confirm.cjs');
const {
  SerialFrameParser,
  createSerialTransport,
  openSerialPort,
  TYPE_CHALLENGE,
} = require('../src/serial-transport.cjs');

const BASE_SEC = 1_800_000_000;
const KEY = Buffer.alloc(32, 0x42);

function challengeFrame(overrides = {}) {
  return encodeChallenge({
    taskId: Buffer.alloc(8, 1),
    nonce: Buffer.alloc(16, 2),
    action: 1,
    operationHash: Buffer.alloc(32, 4),
    issuedAt: BASE_SEC,
    expiresAt: BASE_SEC + 30,
    summary: '测试摘要',
    ...overrides,
  }, KEY);
}

function decisionFrame(overrides = {}) {
  return encodeDecision({
    taskId: Buffer.alloc(8, 1),
    nonce: Buffer.alloc(16, 2),
    decision: 1,
    deviceId: Buffer.alloc(8, 3),
    decidedAt: BASE_SEC,
    ...overrides,
  }, KEY);
}

class FakePort extends EventEmitter {
  constructor(handler = () => null) {
    super();
    this.handler = handler;
    this.writes = [];
  }

  write(chunk) {
    this.writes.push(Buffer.from(chunk));
    Promise.resolve()
      .then(() => this.handler(chunk))
      .then((reply) => {
        if (reply) setImmediate(() => this.emit('data', reply));
      })
      .catch((err) => setImmediate(() => this.emit('error', err)));
    return true;
  }
}

function makeOperation(overrides = {}) {
  return sealOperation({
    taskId: 'T-serial-1',
    action: 'sendExternalEmail',
    protocolAction: 1,
    tool: 'sendExternalEmail',
    recipient: 'partner@example.com',
    subject: '评审纪要',
    body: '最终正文',
    attachments: [],
    sourceDocIds: ['M2'],
    level: '内部',
    createdAt: new Date(BASE_SEC * 1000).toISOString(),
    expiresAt: new Date((BASE_SEC + 300) * 1000).toISOString(),
    modelId: 'mock',
    planHash: 'plan-serial-1',
    ...overrides,
  });
}

test('解析器：分片 + 前置噪声 + 连续两帧', () => {
  const parser = new SerialFrameParser();
  const first = decisionFrame();
  const second = decisionFrame({ nonce: Buffer.alloc(16, 9) });
  const stream = Buffer.concat([Buffer.from([0x00, 0xff, 0x7e]), first, second]);

  const frames = [];
  for (let i = 0; i < stream.length; i += 5) {
    frames.push(...parser.push(stream.subarray(i, i + 5)));
  }
  assert.equal(frames.length, 2);
  assert.deepEqual(frames[0], first);
  assert.deepEqual(frames[1], second);
});

test('解析器：坏长度后重新同步', () => {
  const parser = new SerialFrameParser();
  const bogus = Buffer.from('SFC1\x01\x02\x00\x00\x00\x00', 'latin1'); // length=0，非法
  const real = decisionFrame();
  const frames = parser.push(Buffer.concat([bogus, real]));
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0], real);
});

test('串口 transport：正常闭环（NearfieldConfirmer + VirtualDevice）', async () => {
  const operation = makeOperation();
  const device = new VirtualDevice({
    key: KEY,
    deviceId: 'ws63-A',
    now: () => BASE_SEC,
  });
  const port = new FakePort((frame) => device.receive(frame));
  const transport = createSerialTransport({ port, timeoutMs: 500 });
  const confirmer = new NearfieldConfirmer({
    key: KEY,
    expectedDeviceId: 'ws63-A',
    ttlSec: 30,
    now: () => BASE_SEC,
    transport,
  });

  const approval = await confirmer.requestApproval(operation);
  assert.equal(approval.decision, 1);
  assert.equal(approval.deviceLabel, 'ws63-A');
  assert.equal(port.writes.length, 1);

  const sent = decodeFrame(port.writes[0], KEY);
  assert.equal(sent.type, 'challenge');
  assert.match(sent.summary, /评审纪要/);
  transport.close();
});

test('串口 transport：无应答 → null → TIMEOUT', async () => {
  const operation = makeOperation();
  const port = new FakePort(() => null);
  const transport = createSerialTransport({ port, timeoutMs: 40 });
  const confirmer = new NearfieldConfirmer({
    key: KEY,
    expectedDeviceId: 'ws63-A',
    ttlSec: 30,
    now: () => BASE_SEC,
    transport,
  });

  await assert.rejects(
    confirmer.requestApproval(operation),
    (err) => {
      assert.equal(err.code, 'TIMEOUT');
      return true;
    },
  );
  transport.close();
});

test('串口 transport：忽略 CHALLENGE 回显，只收 DECISION', async () => {
  const echo = challengeFrame();
  const decision = decisionFrame();
  const port = new FakePort(() => Buffer.concat([echo, decision]));
  const transport = createSerialTransport({ port, timeoutMs: 200 });

  const reply = await transport.send(challengeFrame());
  assert.deepEqual(reply, decision);
  transport.close();
});

test('串口 transport：并发 send 串行化', async () => {
  let releaseFirst;
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  let calls = 0;
  const port = new FakePort(async () => {
    calls += 1;
    if (calls === 1) await gate;
    return decisionFrame({ nonce: Buffer.alloc(16, calls) });
  });
  const transport = createSerialTransport({ port, timeoutMs: 500 });

  const first = transport.send(challengeFrame());
  const second = transport.send(challengeFrame());
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(port.writes.length, 1, '第二次 send 不应在第一次应答前落盘');

  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(port.writes.length, 2);
  transport.close();
});

test('串口 transport：参数校验', async () => {
  const port = new FakePort();
  const transport = createSerialTransport({ port, timeoutMs: 100 });
  await assert.rejects(transport.send('not-a-frame'), /Buffer/);
  assert.throws(() => createSerialTransport({ port, timeoutMs: 0 }), /timeoutMs/);
  assert.throws(() => createSerialTransport({ port, replyType: 3 }), /replyType/);
  transport.close();
});

test('真串口打开：factory 注入、参数校验、失败/超时如实拒绝', async () => {
  const opened = [];
  class OpenPort extends FakePort {
    constructor(opts) { super(); this.opts = opts; this.isOpen = false; }
    open() {
      opened.push(this.opts);
      setImmediate(() => { this.isOpen = true; this.emit('open'); });
    }
  }
  const port = await openSerialPort({
    path: 'COM11', baudRate: 921600,
    factory: (opts) => new OpenPort(opts),
  });
  assert.equal(port.isOpen, true);
  assert.deepEqual(opened, [{ path: 'COM11', baudRate: 921600 }]);

  await assert.rejects(() => openSerialPort({ path: '' }), /串口名/);
  await assert.rejects(() => openSerialPort({ path: 'COM11', baudRate: 0 }), /baudRate/);

  // 打开失败
  class FailPort extends FakePort {
    open() { setImmediate(() => this.emit('error', new Error('拒绝访问'))); }
  }
  await assert.rejects(
    () => openSerialPort({ path: 'COM9', factory: () => new FailPort() }),
    /拒绝访问/,
  );

  // 一直不回调 open → 超时
  const silent = new FakePort();
  silent.open = () => {};
  await assert.rejects(
    () => openSerialPort({ path: 'COM1', factory: () => silent, openTimeoutMs: 20 }),
    /超时/,
  );
});

test('常量与帧类型对齐 protocol.h', () => {
  assert.equal(TYPE_CHALLENGE, 1);
  assert.equal(challengeFrame()[5], 1);
  assert.equal(decisionFrame()[5], 2);
});
