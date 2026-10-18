'use strict';
// WS63 确认适配器测试（v0.11）：SFC1 帧 + 冻结操作闭环
//   覆盖：正常/取消/超时/重放/篡改/错设备/记录变化/忙覆盖/到期边界/窗口
const test = require('node:test');
const assert = require('node:assert/strict');
const { sealOperation, verifyOperation } = require('../src/operation.cjs');
const { OperationStore } = require('../src/store.cjs');
const { FakeMailer } = require('../src/mailer.cjs');
const { FulfillmentService } = require('../src/fulfillment.cjs');
const { decodeFrame, encodeChallenge } = require('../src/ws63-protocol.cjs');
const {
  NearfieldConfirmer, VirtualDevice, createLoopbackTransport,
  confirmWithFulfillment, buildSummary, truncateUtf8, deriveTaskId, deriveDeviceId,
  REPLAY_WINDOW, SUMMARY_MAX_BYTES,
} = require('../src/nearfield-confirm.cjs');

const BASE_SEC = 1_800_000_000;
const BASE_MS = BASE_SEC * 1000;
const KEY = Buffer.alloc(32, 0x42);
const WRONG_KEY = Buffer.alloc(32, 0x43);

let seq = 0;
function makeInput(overrides = {}) {
  seq += 1;
  return {
    taskId: `T-${seq}`,
    action: 'sendExternalEmail',
    protocolAction: 1,
    tool: 'sendExternalEmail',
    recipient: 'partner@example.com',
    subject: '评审纪要',
    body: `最终正文 ${seq}`,
    attachments: [],
    sourceDocIds: ['M2'],
    level: '内部',
    createdAt: new Date(BASE_MS).toISOString(),
    expiresAt: new Date(BASE_MS + 300_000).toISOString(),
    modelId: 'mock',
    planHash: `plan-${seq}`,
    ...overrides,
  };
}

function sealed(overrides = {}) {
  return sealOperation(makeInput(overrides));
}

function makeService(nowSec) {
  const store = new OperationStore(':memory:', { now: () => new Date(nowSec() * 1000).toISOString() });
  const mailer = new FakeMailer();
  const service = new FulfillmentService({ store, mailer, now: () => nowSec() * 1000 });
  return { store, mailer, service };
}

function confirmerFor(nowSec, transport = null) {
  return new NearfieldConfirmer({
    key: KEY, expectedDeviceId: 'ws63-A', deviceLabel: 'ws63-A',
    ttlSec: 30, now: nowSec, transport,
  });
}

function deviceFor(nowSec, options = {}) {
  return new VirtualDevice({ key: KEY, deviceId: 'ws63-A', now: nowSec, ...options });
}

function throwsCode(fn, code) {
  assert.throws(fn, (err) => {
    assert.equal(err.code, code, `期望 ${code}，实际 ${err.code}：${err.message}`);
    return true;
  });
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.code, code, `期望 ${code}，实际 ${err.code}：${err.message}`);
    return true;
  });
}

test('正常闭环：设备确认 → 冻结记录 confirmed → 发送 sent', async (t) => {
  let nowSec = BASE_SEC;
  const clock = () => nowSec;
  const { store, mailer, service } = makeService(clock);
  t.after(() => store.close());

  const operation = service.prepare(makeInput());
  const device = deviceFor(clock);
  const transport = createLoopbackTransport(device);

  // 先单独检查 CHALLENGE 帧内容
  const probe = confirmerFor(clock);
  const { pending, frame } = probe.beginChallenge(operation);
  const challenge = decodeFrame(frame, KEY);
  assert.equal(challenge.type, 'challenge');
  assert.equal(challenge.summary, buildSummary(operation));
  assert.deepEqual(challenge.operationHash, Buffer.from(operation.operationHash, 'hex'));
  assert.deepEqual(challenge.taskId, pending.taskId);
  assert.deepEqual(challenge.nonce, pending.nonce);
  probe.abort();

  const confirmer = confirmerFor(clock, transport);
  const result = await confirmWithFulfillment({ fulfillment: service, confirmer, operation });
  assert.equal(result.approval.decision, 1);
  assert.equal(result.approval.operationHash, operation.operationHash);
  assert.equal(result.outbox.state, 'pending');

  const stored = store.getOperation(operation.operationId);
  assert.equal(stored.state, 'confirmed');
  assert.equal(stored.deviceId, 'ws63-A');
  assert.match(stored.confirmationId, /^ws63-[0-9a-f]{16}-[0-9a-f]{32}$/);

  const sent = await service.send(result.outbox.outboxId);
  assert.equal(sent.state, 'sent');
  assert.equal(store.getOperation(operation.operationId).state, 'executed');
  assert.equal(mailer.calls.length, 1);
  assert.equal(store.verifyEvents(), true);
});

test('取消：decision=0 → DECISION，消费 nonce，操作仍 frozen', async () => {
  let nowSec = BASE_SEC;
  const clock = () => nowSec;
  const operation = sealed();
  const device = deviceFor(clock, { decide: () => 'cancel' });
  const confirmer = confirmerFor(clock, createLoopbackTransport(device));

  const { pending, frame } = confirmer.beginChallenge(operation);
  const reply = await device.receive(frame);
  assert.throws(() => confirmer.acceptDecision(pending, reply, { finalOperation: operation }), (err) => {
    assert.equal(err.code, 'DECISION');
    assert.equal(err.cancelled, true);
    return true;
  });
  assert.equal(confirmer.pending, null);
  assert.equal(confirmer.used.length, 1);
  assert.equal(operation.state, 'frozen');
  // 取消后可以发起新挑战
  const next = confirmer.beginChallenge(operation);
  assert.ok(next.pending);
  assert.notDeepEqual(next.pending.nonce, pending.nonce);
});

test('超时/不在场：无应答 → TIMEOUT，消费 nonce；换正常 transport 可重试', async () => {
  let nowSec = BASE_SEC;
  const clock = () => nowSec;
  const operation = sealed();
  const device = deviceFor(clock);
  const dropped = confirmerFor(clock, createLoopbackTransport(device, { drop: true }));
  await rejectsCode(dropped.requestApproval(operation), 'TIMEOUT');
  assert.equal(dropped.pending, null);
  assert.equal(dropped.used.length, 1);

  const broken = confirmerFor(clock, { send: async () => { throw new Error('link down'); } });
  await rejectsCode(broken.requestApproval(operation), 'TIMEOUT');
  assert.equal(broken.pending, null);

  const normal = confirmerFor(clock, createLoopbackTransport(device));
  const approval = await normal.requestApproval(operation);
  assert.equal(approval.decision, 1);
  assert.equal(normal.pending, null);
});

test('重放：成功后旧 DECISION → STATE；复用 nonce → REPLAY', async () => {
  const nowSec = BASE_SEC;
  const clock = () => nowSec;
  const operation = sealed();
  const device = deviceFor(clock);
  const confirmer = confirmerFor(clock);

  const { pending, frame } = confirmer.beginChallenge(operation);
  const reply = await device.receive(frame);
  const approval = confirmer.acceptDecision(pending, reply, { finalOperation: operation });
  assert.equal(approval.decision, 1);

  throwsCode(() => confirmer.acceptDecision(pending, reply, { finalOperation: operation }), 'STATE');

  let calls = 0;
  const fixedNonce = Buffer.alloc(16, 9);
  const replaying = new NearfieldConfirmer({
    key: KEY, expectedDeviceId: 'ws63-A', now: clock,
    randomBytes: () => { calls += 1; return fixedNonce; },
  });
  const first = replaying.beginChallenge(operation);
  replaying.cancel(first.pending);
  throwsCode(() => replaying.beginChallenge(operation), 'REPLAY');
  assert.equal(calls, 2);
});

test('nonce 已用窗口：FIFO 8 条，最旧被淘汰', () => {
  const nowSec = BASE_SEC;
  const clock = () => nowSec;
  const operation = sealed();
  const nonces = Array.from({ length: 10 }, (_, i) => Buffer.alloc(16, i + 1));
  let index = 0;
  const confirmer = new NearfieldConfirmer({
    key: KEY, expectedDeviceId: 'ws63-A', now: clock,
    randomBytes: () => nonces[index++],
  });

  for (let i = 0; i < REPLAY_WINDOW + 1; i += 1) {
    const { pending } = confirmer.beginChallenge(operation);
    confirmer.cancel(pending);
  }
  assert.equal(confirmer.used.length, REPLAY_WINDOW);
  // 窗口应为 N2..N9（N1 已淘汰）
  assert.deepEqual(confirmer.used[0], nonces[1]);
  assert.deepEqual(confirmer.used[REPLAY_WINDOW - 1], nonces[8]);

  confirmer.randomBytes = () => nonces[7]; // N8 仍在窗口
  throwsCode(() => confirmer.beginChallenge(operation), 'REPLAY');

  confirmer.randomBytes = () => nonces[0]; // N1 已淘汰
  const { pending } = confirmer.beginChallenge(operation);
  assert.ok(pending);
  confirmer.cancel(pending);
});

test('忙覆盖/过期重启：未过期 → STATE；过期 nonce 不可重启 → REPLAY', () => {
  let nowSec = BASE_SEC;
  const clock = () => nowSec;
  const operation = sealed();
  const firstNonce = Buffer.alloc(16, 0x11);
  const confirmer = new NearfieldConfirmer({
    key: KEY, expectedDeviceId: 'ws63-A', now: clock, ttlSec: 30,
    randomBytes: () => firstNonce,
  });

  const first = confirmer.beginChallenge(operation);
  nowSec = BASE_SEC + 10;
  throwsCode(() => confirmer.beginChallenge(operation), 'STATE');

  nowSec = BASE_SEC + 30;
  // 过期 pending 的 nonce 被消费；用同一个 nonce 重启 → REPLAY（镜像 C 测试）
  throwsCode(() => confirmer.beginChallenge(operation), 'REPLAY');
  assert.ok(confirmer.used.some((n) => n.equals(first.pending.nonce)));
  assert.equal(confirmer.pending, null);

  // 换一个新 nonce 可以继续
  nowSec = BASE_SEC + 31;
  confirmer.randomBytes = () => Buffer.alloc(16, 0x22);
  const next = confirmer.beginChallenge(operation);
  assert.ok(next.pending);
});

test('到期边界：now == expiresAt → EXPIRED，消费 nonce', async () => {
  let nowSec = BASE_SEC;
  const clock = () => nowSec;
  const operation = sealed();
  const device = deviceFor(clock);
  const confirmer = confirmerFor(clock);
  const { pending, frame } = confirmer.beginChallenge(operation);
  const reply = await device.receive(frame);

  nowSec = pending.expiresAt;
  throwsCode(() => confirmer.acceptDecision(pending, reply, { finalOperation: operation }), 'EXPIRED');
  assert.equal(confirmer.pending, null);
  assert.equal(confirmer.used.length, 1);
});

test('错设备 ID：DEVICE 不消费 pending，正确设备随后可确认', async () => {
  const nowSec = BASE_SEC;
  const clock = () => nowSec;
  const operation = sealed();
  const deviceB = new VirtualDevice({ key: KEY, deviceId: 'ws63-B', now: clock });
  const deviceA = deviceFor(clock);
  const confirmer = confirmerFor(clock);

  const { pending, frame } = confirmer.beginChallenge(operation);
  const replyB = await deviceB.receive(frame);
  throwsCode(() => confirmer.acceptDecision(pending, replyB, { finalOperation: operation }), 'DEVICE');
  assert.equal(confirmer.pending, pending);
  assert.equal(confirmer.used.length, 0);

  const replyA = await deviceA.receive(frame);
  const approval = confirmer.acceptDecision(pending, replyA, { finalOperation: operation });
  assert.equal(approval.decision, 1);
});

test('篡改决定帧：MAC 不消费 pending，原帧随后通过', async () => {
  const nowSec = BASE_SEC;
  const clock = () => nowSec;
  const operation = sealed();
  const device = deviceFor(clock);
  const confirmer = confirmerFor(clock);
  const { pending, frame } = confirmer.beginChallenge(operation);
  const reply = await device.receive(frame);

  const tampered = Buffer.from(reply);
  tampered[35] ^= 1; // device_id 首字节（header 10 + task 8 + nonce 16 + decision 1）
  throwsCode(() => confirmer.acceptDecision(pending, tampered, { finalOperation: operation }), 'MAC');
  assert.equal(confirmer.pending, pending);
  assert.equal(confirmer.used.length, 0);

  const approval = confirmer.acceptDecision(pending, reply, { finalOperation: operation });
  assert.equal(approval.decision, 1);
});

test('错密钥：错误 replyKey → MAC；设备无法解挑战 → TIMEOUT', async () => {
  const nowSec = BASE_SEC;
  const clock = () => nowSec;
  const operation = sealed();

  const wrongSigner = new VirtualDevice({ key: KEY, deviceId: 'ws63-A', now: clock, replyKey: WRONG_KEY });
  const confirmer = confirmerFor(clock);
  const { pending, frame } = confirmer.beginChallenge(operation);
  const reply = await wrongSigner.receive(frame);
  throwsCode(() => confirmer.acceptDecision(pending, reply, { finalOperation: operation }), 'MAC');

  const wrongDecoder = new VirtualDevice({ key: WRONG_KEY, deviceId: 'ws63-A', now: clock });
  const viaWrong = confirmerFor(clock, createLoopbackTransport(wrongDecoder));
  await rejectsCode(viaWrong.requestApproval(operation), 'TIMEOUT');
});

test('最终记录变化：OPERATION 不消费 pending，原记录随后通过', async () => {
  const nowSec = BASE_SEC;
  const clock = () => nowSec;
  const operation = sealed();
  const device = deviceFor(clock);
  const confirmer = confirmerFor(clock);
  const { pending, frame } = confirmer.beginChallenge(operation);
  const reply = await device.receive(frame);

  const changedBody = { ...operation, body: '被改的正文' };
  assert.equal(verifyOperation(changedBody).ok, false);
  throwsCode(() => confirmer.acceptDecision(pending, reply, { finalOperation: changedBody }), 'OPERATION');

  const changedRecipient = { ...operation, recipient: 'evil@example.com' };
  throwsCode(() => confirmer.acceptDecision(pending, reply, { finalOperation: changedRecipient }), 'OPERATION');
  assert.equal(confirmer.pending, pending);

  const resealed = sealOperation(makeInput({ taskId: 'T-other', body: '另一份正文' }));
  throwsCode(() => confirmer.acceptDecision(pending, reply, { finalOperation: resealed }), 'OPERATION');

  const approval = confirmer.acceptDecision(pending, reply, { finalOperation: operation });
  assert.equal(approval.decision, 1);
});

test('摘要：≤96B、按码点截断、无 NUL，编码器接受', () => {
  assert.equal(SUMMARY_MAX_BYTES, 96);
  assert.equal(Buffer.byteLength(truncateUtf8('中'.repeat(40)), 'utf8'), 96);
  assert.equal(truncateUtf8('中'.repeat(40)), '中'.repeat(32));

  const emoji = truncateUtf8(`${'a'.repeat(93)}😀`, 96);
  assert.equal(Buffer.byteLength(emoji, 'utf8'), 96);
  assert.ok(emoji.endsWith('…'));

  const summary = buildSummary({
    protocolAction: 2, subject: `${'很长的主题'.repeat(20)}\u0000\n`, recipient: 'x@example.com',
  });
  assert.ok(Buffer.byteLength(summary, 'utf8') <= 96);
  assert.ok(!summary.includes('\u0000'));
  assert.ok(summary.startsWith('删除｜'));
  assert.ok(!summary.includes('�'));

  const operationHash = Buffer.alloc(32, 7);
  assert.doesNotThrow(() => encodeChallenge({
    taskId: Buffer.alloc(8, 1), nonce: Buffer.alloc(16, 2), action: 2,
    operationHash, issuedAt: 100, expiresAt: 130, summary,
  }, KEY));
});

test('taskId/deviceId 派生：确定性、恒 8 字节、Buffer 直通', () => {
  assert.equal(deriveTaskId('T-1').length, 8);
  assert.equal(deriveDeviceId('ws63-A').length, 8);
  assert.deepEqual(deriveTaskId('T-1'), deriveTaskId('T-1'));
  assert.notDeepEqual(deriveTaskId('T-1'), deriveTaskId('T-2'));
  assert.notDeepEqual(deriveTaskId('same'), deriveDeviceId('same'));

  const raw = Buffer.alloc(8, 0x5a);
  const copied = deriveTaskId(raw);
  assert.deepEqual(copied, raw);
  assert.notStrictEqual(copied, raw);

  assert.throws(() => deriveTaskId(Buffer.alloc(7)), /8 字节/);
  assert.throws(() => deriveDeviceId(''), /非空字符串/);
});

test('参数/帧错误：克隆 pending、challenge 帧、无 pending、非 frozen', async () => {
  const nowSec = BASE_SEC;
  const clock = () => nowSec;
  const operation = sealed();
  const device = deviceFor(clock);
  const confirmer = confirmerFor(clock);
  const { pending, frame } = confirmer.beginChallenge(operation);
  const reply = await device.receive(frame);

  // 克隆 pending（身份不符）
  const clone = { ...pending };
  throwsCode(() => confirmer.acceptDecision(clone, reply, { finalOperation: operation }), 'ARG');

  // 把 CHALLENGE 帧当 DECISION 交
  const otherChallenge = encodeChallenge({
    taskId: pending.taskId, nonce: pending.nonce, action: 1,
    operationHash: pending.targetHash, issuedAt: pending.issuedAt,
    expiresAt: pending.expiresAt, summary: '另一条挑战',
  }, KEY);
  throwsCode(() => confirmer.acceptDecision(pending, otherChallenge, { finalOperation: operation }), 'TYPE');

  // 非 frozen 记录
  throwsCode(() => confirmer.beginChallenge({ ...operation, state: 'confirmed' }), 'OPERATION');
  throwsCode(() => confirmer.beginChallenge({ ...operation, body: '被改' }), 'OPERATION');

  // 正常确认后再交同一帧 → 无 pending
  confirmer.acceptDecision(pending, reply, { finalOperation: operation });
  throwsCode(() => confirmer.acceptDecision(pending, reply, { finalOperation: operation }), 'STATE');
});
