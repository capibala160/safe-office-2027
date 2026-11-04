'use strict';
// 闸4 真板确认实现（docs/59 第 2 批）：用假 transport 覆盖批准/取消/错设备/超时/篡改/过期。
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { createBoardHumanConfirm, toAscii } = require('../src/board-human-confirm.cjs');
const { decodeFrame, encodeDecision } = require('../src/ws63-protocol.cjs');
const { deriveDeviceId } = require('../src/nearfield-confirm.cjs');

const KEY = Buffer.alloc(32, 0x42);
const DEVICE = 'ws63-A';
const CONTENT_HASH = randomBytes(32).toString('hex');

function operation(overrides = {}) {
  return {
    action: 'sendExternalEmail',
    args: { to: 'partner@example.com' },
    contentHash: CONTENT_HASH,
    ...overrides,
  };
}

function decisionFor(frame, { decision = 1, deviceId = deriveDeviceId(DEVICE) } = {}) {
  const challenge = decodeFrame(frame, KEY);
  return encodeDecision({
    taskId: challenge.taskId,
    nonce: challenge.nonce,
    decision,
    deviceId,
    decidedAt: 1_800_000_000,
  }, KEY);
}

function factoryReturning(send) {
  return createBoardHumanConfirm({ transportFactory: async () => ({ send }), key: KEY, deviceId: DEVICE });
}

test('批准：帧绑定 contentHash、摘要是 ASCII，回帧验过后放行并带 proof', async () => {
  let seen = null;
  const humanConfirm = factoryReturning(async (frame) => {
    seen = decodeFrame(frame, KEY);
    return decisionFor(frame);
  });
  const result = await humanConfirm({ operation: operation() });
  assert.equal(result.approved, true);
  assert.equal(result.method, 'WS63 真板（SFC1）');
  assert.ok(result.proof.confirmationId.startsWith('ws63-'));
  assert.equal(result.proof.deviceLabel, DEVICE);
  assert.ok(seen.operationHash.equals(Buffer.from(CONTENT_HASH, 'hex')), 'operationHash 必须绑定 contentHash');
  assert.equal(seen.action, 1);
  assert.match(seen.summary, /^SEND EXT partner@example\.com$/);
});

test('取消：decision=0 → 拒绝且不出 proof', async () => {
  const humanConfirm = factoryReturning(async (frame) => decisionFor(frame, { decision: 0 }));
  const result = await humanConfirm({ operation: operation() });
  assert.equal(result.approved, false);
  assert.match(result.method, /取消/);
  assert.equal(result.proof, undefined);
});

test('错设备：别的设备签名 → 拒绝', async () => {
  const humanConfirm = factoryReturning(async (frame) => decisionFor(frame, { deviceId: deriveDeviceId('ws63-B') }));
  const result = await humanConfirm({ operation: operation() });
  assert.equal(result.approved, false);
  assert.match(result.method, /设备不符/);
});

test('超时：transport 返回 null → 拒绝', async () => {
  const humanConfirm = factoryReturning(async () => null);
  const result = await humanConfirm({ operation: operation() });
  assert.equal(result.approved, false);
  assert.match(result.method, /无响应/);
});

test('传输异常 / 打开失败 → 拒绝（不回退模拟）', async () => {
  const throwing = factoryReturning(async () => { throw new Error('COM11 Access denied'); });
  assert.match((await throwing({ operation: operation() })).method, /确认端异常/);

  const failingFactory = createBoardHumanConfirm({
    transportFactory: async () => { throw new Error('EBUSY'); },
    key: KEY,
    deviceId: DEVICE,
  });
  const result = await failingFactory({ operation: operation() });
  assert.equal(result.approved, false);
  assert.match(result.method, /确认端不可用/);
});

test('篡改决定帧 → MAC 校验失败被拒', async () => {
  const humanConfirm = factoryReturning(async (frame) => {
    const bad = Buffer.from(decisionFor(frame));
    bad[bad.length - 1] ^= 0x01;
    return bad;
  });
  const result = await humanConfirm({ operation: operation() });
  assert.equal(result.approved, false);
  assert.match(result.method, /决定帧非法/);
});

test('挑战过期（回帧晚于 TTL）→ 拒绝', async () => {
  let clock = 1000;
  const humanConfirm = createBoardHumanConfirm({
    transportFactory: async () => ({
      send: async (frame) => {
        clock += 31;
        return decisionFor(frame);
      },
    }),
    key: KEY,
    deviceId: DEVICE,
    ttlSec: 30,
    now: () => clock,
  });
  const result = await humanConfirm({ operation: operation() });
  assert.equal(result.approved, false);
  assert.match(result.method, /过期/);
});

test('参数缺失 → 直接拒绝，不打开传输', async () => {
  let opened = 0;
  const humanConfirm = createBoardHumanConfirm({
    transportFactory: async () => { opened += 1; return { send: async () => null }; },
    key: KEY,
    deviceId: DEVICE,
  });
  const result = await humanConfirm({ operation: { action: 'sendExternalEmail' } });
  assert.equal(result.approved, false);
  assert.match(result.method, /contentHash/);
  assert.equal(opened, 0);
});

test('摘要：中文替换成 ?，超长按 96 字节截断', async () => {
  let seen = null;
  const humanConfirm = factoryReturning(async (frame) => {
    seen = decodeFrame(frame, KEY);
    return decisionFor(frame);
  });
  await humanConfirm({ operation: operation({ args: { to: '张三@example.com' } }) });
  assert.ok(!/[^\x20-\x7E]/.test(seen.summary), '摘要必须全是 ASCII');
  assert.equal(toAscii('x'.repeat(200)).length, 96);
});
