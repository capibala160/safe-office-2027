'use strict';
// 手机确认端端到端测试（v0.14）
//   走真实 HTTP：控制台发起挑战 → 手机取帧、验 MAC、端上签 DECISION → 回传 → 执行
//   关键断言：错密钥/篡改/重放/超时都必须被状态机拒绝，操作保持冻结。
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('../server.cjs');
const { ConsoleService } = require('../src/console-service.cjs');
const SFC1 = require('../public/sfc1-browser.js');

const CODE = 'AB12-CD34';
const DEVICE = 'phone-A';

const externalCommand = {
  command: '把周例会纪要发给外部参会方 partner@partner-example.com',
  role: '员工',
  tools: ['readDoc', 'sendExternalEmail'],
  documentIds: ['M2'],
  domains: ['partner-example.com'],
};

async function json(url, options) {
  const res = await fetch(url, options);
  const data = await res.json();
  return { res, data };
}

function post(url, body) {
  return json(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body === undefined ? {} : body),
  });
}

async function boot(t, options = {}) {
  const started = await startServer({ port: 0, pairingCode: CODE, ...options });
  t.after(() => started.close());
  return started;
}

async function makeFrozen(url) {
  const cmd = await post(`${url}/api/commands`, externalCommand);
  assert.equal(cmd.data.ok, true);
  return cmd.data.operations[0];
}

async function openChallenge(url, operationId) {
  const challenge = await post(`${url}/api/operations/${operationId}/challenge`, {});
  assert.equal(challenge.data.ok, true);
  return challenge.data.challenge;
}

// 模拟手机：用正确密钥解 CHALLENGE，用指定密钥签 DECISION
async function buildDecision(url, { signCode = CODE, decision = 1, device = DEVICE, tamperAt = null } = {}) {
  const state = await json(`${url}/api/phone/state`);
  const pending = state.data.pending;
  assert.ok(pending, '应有待确认挑战');
  const rightKey = await SFC1.deriveKey(CODE);
  const parsed = await SFC1.decodeFrame(SFC1.base64ToBytes(pending.frame), rightKey);
  const signKey = await SFC1.deriveKey(signCode);
  const bytes = await SFC1.encodeDecision({
    taskId: parsed.taskId,
    nonce: parsed.nonce,
    decision,
    deviceId: await SFC1.deriveDeviceId(device),
    decidedAt: Math.floor(Date.now() / 1000),
  }, signKey);
  if (tamperAt !== null) bytes[tamperAt] ^= 0x01;
  return { challengeId: pending.challengeId, frame: SFC1.bytesToBase64(bytes) };
}

test('手机确认端：端上签帧 → 批准 → 执行并发送', async (t) => {
  const { url } = await boot(t);
  const op = await makeFrozen(url);
  await openChallenge(url, op.operationId);

  const state = await json(`${url}/api/phone/state`);
  assert.equal(state.data.device.id, DEVICE);
  assert.ok(state.data.pending);
  assert.ok(state.data.pending.summary.includes('外发'));

  const body = await buildDecision(url);
  const decided = await post(`${url}/api/phone/decision`, body);
  assert.equal(decided.data.ok, true);
  assert.equal(decided.data.outcome, 'approved');
  assert.equal(decided.data.operation.state, 'executed');
  assert.equal(decided.data.send.state, 'sent');

  const emails = await json(`${url}/api/emails`);
  assert.ok(emails.data.items.some((e) => e.operationId === op.operationId && e.outbox && e.outbox.state === 'sent'));

  const after = await json(`${url}/api/phone/state`);
  assert.equal(after.data.pending, null);
  assert.equal(after.data.lastResult.outcome, 'approved');
});

test('手机确认端：取消（decision=0）→ 操作转入 rejected', async (t) => {
  const { url } = await boot(t);
  const op = await makeFrozen(url);
  await openChallenge(url, op.operationId);

  const body = await buildDecision(url, { decision: 0 });
  const decided = await post(`${url}/api/phone/decision`, body);
  assert.equal(decided.data.ok, false);
  assert.equal(decided.data.outcome, 'cancelled');
  assert.equal(decided.data.operation.state, 'rejected');
});

test('手机确认端：错配对码 → MAC 拒绝，操作仍冻结', async (t) => {
  const { url } = await boot(t);
  const op = await makeFrozen(url);
  await openChallenge(url, op.operationId);

  const body = await buildDecision(url, { signCode: 'ZZ99-ZZ99' });
  const decided = await post(`${url}/api/phone/decision`, body);
  assert.equal(decided.data.ok, false);
  assert.equal(decided.data.code, 'MAC');
  assert.equal(decided.data.operation.state, 'frozen');
});

test('手机确认端：篡改帧 → MAC 拒绝，pending 仍可正常批准', async (t) => {
  const { url } = await boot(t);
  const op = await makeFrozen(url);
  await openChallenge(url, op.operationId);

  const tampered = await buildDecision(url, { tamperAt: 30 });
  const rejected = await post(`${url}/api/phone/decision`, tampered);
  assert.equal(rejected.data.ok, false);
  assert.equal(rejected.data.code, 'MAC');

  const good = await buildDecision(url);
  const approved = await post(`${url}/api/phone/decision`, good);
  assert.equal(approved.data.ok, true);
  assert.equal(approved.data.outcome, 'approved');
});

test('手机确认端：重复提交同一决定 → stale', async (t) => {
  const { url } = await boot(t);
  const op = await makeFrozen(url);
  await openChallenge(url, op.operationId);

  const body = await buildDecision(url);
  const first = await post(`${url}/api/phone/decision`, body);
  assert.equal(first.data.ok, true);
  const second = await post(`${url}/api/phone/decision`, body);
  assert.equal(second.data.ok, false);
  assert.equal(second.data.outcome, 'stale');
});

test('手机确认端：超过 TTL 提交 → expired，操作保持冻结', async (t) => {
  const key = Buffer.from(await SFC1.deriveKey(CODE));
  const service = new ConsoleService({
    nearfieldKey: key, deviceId: DEVICE, deviceLabel: '手机确认端（测试）', pairingCode: CODE, ttlSec: 1,
  });
  const { url } = await boot(t, { service });
  const op = await makeFrozen(url);
  await openChallenge(url, op.operationId);
  const body = await buildDecision(url);

  await new Promise((resolve) => setTimeout(resolve, 1100));
  const decided = await post(`${url}/api/phone/decision`, body);
  assert.equal(decided.data.ok, false);
  assert.equal(decided.data.code, 'EXPIRED');
  assert.equal(decided.data.operation.state, 'frozen');
});

test('手机接口：无挑战时 pending 为 null；坏帧直接 400', async (t) => {
  const { url } = await boot(t);

  const idle = await json(`${url}/api/phone/state`);
  assert.equal(idle.data.pending, null);

  const missing = await post(`${url}/api/phone/decision`, {});
  assert.equal(missing.res.status, 400);

  const op = await makeFrozen(url);
  const challenge = await openChallenge(url, op.operationId);

  const badBase64 = await post(`${url}/api/phone/decision`, {
    challengeId: challenge.challengeId, frame: '!!!!',
  });
  assert.equal(badBase64.res.status, 400);
});

test('手机确认端：拿 CHALLENGE 帧冒充 DECISION → TYPE 拒绝', async (t) => {
  const { url } = await boot(t);
  const op = await makeFrozen(url);
  await openChallenge(url, op.operationId);

  const state = await json(`${url}/api/phone/state`);
  const decided = await post(`${url}/api/phone/decision`, {
    challengeId: state.data.pending.challengeId,
    frame: state.data.pending.frame,
  });
  assert.equal(decided.data.ok, false);
  assert.equal(decided.data.code, 'TYPE');
  assert.equal(decided.data.operation.state, 'frozen');
});
