'use strict';
// 办公套件控制台服务测试（v0.12）
//   覆盖：命令/五道闸/转交/冻结/内网自动确认/WS63 虚拟确认/取消/超时/重放/篡改/
//         攻击样例/风险冻结/双链/报告/重置
const test = require('node:test');
const assert = require('node:assert/strict');
const { ConsoleService } = require('../src/console-service.cjs');
const { FakeMailer } = require('../src/mailer.cjs');

function setup({ start = Date.now(), service = {} } = {}) {
  let nowMs = start;
  const instance = new ConsoleService({ now: () => nowMs, ...service });
  return {
    service: instance,
    advance(ms) { nowMs += ms; },
    now() { return nowMs; },
  };
}

function sample(service, id) {
  const item = service.getDemoSamples().find((s) => s.id === id);
  assert.ok(item, `样例不存在：${id}`);
  return item;
}

async function runSample(service, id, extra = {}) {
  const item = sample(service, id);
  return service.runCommand({ ...item, role: item.role, ...extra });
}

test('初始化：角色/工具/文档/策略/审计链', (t) => {
  const { service } = setup();
  t.after(() => service.close());
  const bootstrap = service.getBootstrap();
  assert.equal(bootstrap.state.version, '0.13.0');
  assert.equal(bootstrap.roles.length, 6);
  assert.equal(bootstrap.samples.length, 10);
  assert.equal(bootstrap.documents.length, 7);
  assert.equal(service.policy.decide('员工', 'sendExternalEmail'), 'confirm');
  assert.equal(service.audit.entries.length, 0);
  assert.equal(service.audit.verify(), true);

  const notRead = service.getDocument('M1');
  assert.equal(notRead.body, null);
  assert.equal(notRead.status, 'not-read');
  const contacts = service.listContacts();
  assert.ok(contacts.length >= 2);
  assert.ok(contacts.every((c) => c.phone === '[手机号已脱敏]' && c.email === '[邮箱已脱敏]'));
});

test('正常内网纪要：冻结 → 策略自动确认 → FakeMailer 发送', async (t) => {
  const { service } = setup();
  t.after(() => service.close());
  const run = await runSample(service, 'normal-minutes');
  assert.equal(run.operations.length, 1);
  const op = run.operations[0];
  assert.equal(op.action, 'sendInternalEmail');
  assert.equal(op.state, 'executed');
  assert.equal(op.outbox.state, 'sent');
  assert.equal(op.confirmationId, 'policy-auto');
  assert.equal(op.deviceId, 'policy-engine');
  assert.equal(service.mailer.calls.length, 1);
  assert.ok(service.runtime.knowledge.draft_M2);
  assert.ok(run.gateSummary.some((g) => g.key === 'gate4' && g.status === 'defer'));
  assert.equal(service.store.verifyEvents(), true);
});

test('外发：冻结待近场；批准后 executed/sent', async (t) => {
  const { service } = setup();
  t.after(() => service.close());
  const run = await runSample(service, 'external-confirm');
  assert.equal(run.operations.length, 1);
  const op = run.operations[0];
  assert.equal(op.state, 'frozen');
  assert.equal(op.requiresNearfield, true);
  assert.equal(service.mailer.calls.length, 0);

  const challenge = service.beginChallenge(op.operationId);
  assert.ok(challenge.summary.includes('外发'));
  assert.equal(challenge.targetHash.length, 64);
  assert.equal(challenge.state, 'pending');

  const decided = await service.decideChallenge(challenge.challengeId, 'approve');
  assert.equal(decided.ok, true);
  assert.equal(decided.outcome, 'approved');
  assert.equal(decided.operation.state, 'executed');
  assert.equal(decided.send.state, 'sent');
  assert.ok(decided.approval.confirmationId.startsWith('ws63-'));
  assert.equal(service.mailer.calls.length, 1);
});

test('取消：decision=0 → rejected，零发送', async (t) => {
  const { service } = setup();
  t.after(() => service.close());
  const run = await runSample(service, 'external-confirm');
  const op = run.operations[0];
  const challenge = service.beginChallenge(op.operationId);
  const decided = await service.decideChallenge(challenge.challengeId, 'cancel');
  assert.equal(decided.ok, false);
  assert.equal(decided.outcome, 'cancelled');
  assert.equal(decided.code, 'DECISION');
  assert.equal(decided.operation.state, 'rejected');
  assert.equal(service.mailer.calls.length, 0);
});

test('超时：nonce 消费、操作仍 frozen、可重新发起并批准', async (t) => {
  const { service, advance } = setup();
  t.after(() => service.close());
  const run = await runSample(service, 'external-confirm');
  const op = run.operations[0];
  const challenge = service.beginChallenge(op.operationId);
  advance(31_000);
  const expired = await service.decideChallenge(challenge.challengeId, 'approve');
  assert.equal(expired.ok, false);
  assert.equal(expired.code, 'EXPIRED');
  assert.equal(expired.operation.state, 'frozen');

  const retry = service.beginChallenge(op.operationId);
  const approved = await service.decideChallenge(retry.challengeId, 'approve');
  assert.equal(approved.ok, true);
  assert.equal(approved.operation.state, 'executed');
  assert.equal(service.mailer.calls.length, 1);
});

test('显式模拟超时：nonce 消费、操作仍 frozen、可重新发起', async (t) => {
  const { service } = setup();
  t.after(() => service.close());
  const run = await runSample(service, 'external-confirm');
  const op = run.operations[0];
  const challenge = service.beginChallenge(op.operationId);
  const expired = service.expireChallenge(challenge.challengeId);
  assert.equal(expired.code, 'EXPIRED');
  assert.equal(expired.operation.state, 'frozen');

  const retry = service.beginChallenge(op.operationId);
  const approved = await service.decideChallenge(retry.challengeId, 'approve');
  assert.equal(approved.ok, true);
  assert.equal(service.mailer.calls.length, 1);
});

test('重放：旧决定 → STATE，不重复发送', async (t) => {
  const { service } = setup();
  t.after(() => service.close());
  const run = await runSample(service, 'external-confirm');
  const op = run.operations[0];
  const challenge = service.beginChallenge(op.operationId);
  const approved = await service.decideChallenge(challenge.challengeId, 'approve');
  assert.equal(approved.ok, true);
  const replay = service.replayLastDecision();
  assert.equal(replay.ok, false);
  assert.equal(replay.code, 'STATE');
  assert.equal(service.mailer.calls.length, 1);
});

test('篡改决定帧：MAC 先失败，pending 保留，随后可正常批准', async (t) => {
  const { service } = setup();
  t.after(() => service.close());
  const run = await runSample(service, 'external-confirm');
  const op = run.operations[0];
  const challenge = service.beginChallenge(op.operationId);
  const tampered = await service.tamperChallenge(challenge.challengeId);
  assert.equal(tampered.ok, false);
  assert.equal(tampered.code, 'MAC');

  const approved = await service.decideChallenge(challenge.challengeId, 'approve');
  assert.equal(approved.ok, true);
  assert.equal(service.mailer.calls.length, 1);
});

test('篡改冻结记录：只读校验 + 确认拒绝', async (t) => {
  const { service } = setup();
  t.after(() => service.close());
  const run = await runSample(service, 'external-confirm');
  const op = run.operations[0];
  const originalCheck = service.verifyTamper(op.operationId);
  assert.equal(originalCheck.original.ok, true);
  assert.equal(originalCheck.tampered.ok, false);

  const challenge = service.beginChallenge(op.operationId);
  service.store.db.prepare('UPDATE operations SET body = ? WHERE operation_id = ?')
    .run('被改的正文', op.operationId);
  const decided = await service.decideChallenge(challenge.challengeId, 'approve');
  assert.equal(decided.ok, false);
  assert.equal(decided.code, 'OPERATION');
  assert.equal(service.mailer.calls.length, 0);
});

test('私人邮箱：闸2 域名白名单拒绝，无冻结操作', async (t) => {
  const { service } = setup();
  t.after(() => service.close());
  const run = await runSample(service, 'private-mailbox');
  assert.equal(run.operations.length, 0);
  assert.ok(run.lines.some((l) => l.includes('闸2拒绝')));
  assert.ok(service.risk.score > 0);
});

test('注入：计划校验移除外部发送；机密正式稿内网发送被闸3拒绝', async (t) => {
  const { service } = setup();
  t.after(() => service.close());
  const run = await runSample(service, 'injection');
  assert.equal(run.operations.length, 0);
  assert.ok(run.lines.some((l) => l.includes('仅出现于外部材料')));
  assert.ok(run.lines.some((l) => l.includes('闸3拒绝')));
  assert.ok(!run.lines.some((l) => l.includes('sendExternalEmail') && l.includes('⇥')));
});

test('风险冻结：高危在转交前被拦，无新操作', async (t) => {
  const { service } = setup();
  t.after(() => service.close());
  service.risk.add(60, '测试：风险冻结');
  const run = await runSample(service, 'external-confirm');
  assert.equal(run.operations.length, 0);
  assert.equal(service.risk.frozen, true);
  assert.ok(run.lines.some((l) => l.includes('风险冻结拦截')));
});

test('设备控制：默认沙箱拒绝；开放物理通道后确认执行', async (t) => {
  const { service } = setup();
  t.after(() => service.close());
  const blocked = await service.runCommand({
    command: '把评审会会议室的门锁打开',
    role: '员工', tools: ['deviceControl'], documentIds: [],
  });
  assert.equal(blocked.operations.length, 0);
  assert.ok(blocked.lines.some((l) => l.includes('沙箱拒绝')));

  const run = await runSample(service, 'device');
  assert.equal(run.operations.length, 1);
  const challenge = service.beginChallenge(run.operations[0].operationId);
  const decided = await service.decideChallenge(challenge.challengeId, 'approve');
  assert.equal(decided.ok, true);
  assert.equal(service.getBusinessState().deviceStates['会议室-门锁'], 'open');
});

test('发送未知：unknown 不自动重试，人工核对为 sent', async (t) => {
  const { service } = setup({ service: { mailer: new FakeMailer({ behavior: 'accepted-then-timeout' }) } });
  t.after(() => service.close());
  const run = await runSample(service, 'normal-minutes');
  assert.equal(run.operations.length, 1);
  const op = run.operations[0];
  assert.equal(op.state, 'executing');
  assert.equal(op.outbox.state, 'unknown');
  assert.equal(service.mailer.calls.length, 1);

  const reconciled = service.reconcileOutbox(op.outbox.outboxId, { state: 'sent', messageId: 'm-1' });
  assert.equal(reconciled.ok, true);
  assert.equal(service.store.getOperation(op.operationId).state, 'executed');
  assert.equal(service.mailer.calls.length, 1);
});

test('双链校验与篡改演示：原链 true，克隆链 false', async (t) => {
  const { service } = setup();
  t.after(() => service.close());
  await runSample(service, 'normal-minutes');
  await runSample(service, 'contacts');
  const verified = service.verifyAudit();
  assert.equal(verified.audit.verified, true);
  assert.equal(verified.events.verified, true);

  const tamper = service.auditTamperDemo();
  assert.equal(tamper.original, true);
  assert.equal(tamper.tampered, false);
  assert.equal(service.audit.verify(), true);
  assert.ok(service.getReport().includes('治理报告'));
});

test('重置：审计/操作/风险清零，基础文档恢复', async (t) => {
  const { service } = setup();
  t.after(() => service.close());
  await runSample(service, 'normal-minutes');
  assert.ok(service.store.listOperations().length > 0);
  service.reset();
  const state = service.getState();
  assert.equal(state.counts.audit, 0);
  assert.equal(state.counts.operations, 0);
  assert.equal(state.risk.score, 0);
  assert.equal(service.store.listOperations().length, 0);
  assert.equal(service.listDocuments().length, 7);
});

test('自动模式：低风险自动只放行白名单内部级外发，设备仍需确认', async (t) => {
  const { service } = setup();
  t.after(() => service.close());
  service.setAutoMode('auto-safe');
  const external = await runSample(service, 'external-confirm');
  assert.equal(external.operations.length, 1);
  assert.equal(external.operations[0].state, 'executed');
  assert.equal(external.operations[0].confirmationId, 'auto-safe');
  assert.equal(service.mailer.calls.length, 1);

  const device = await runSample(service, 'device');
  assert.equal(device.operations.length, 1);
  assert.equal(device.operations[0].state, 'frozen');
  assert.equal(service.getState().autoMode, 'auto-safe');
});

test('自动模式：全自动演示批准所有转交动作（含设备/删除）', async (t) => {
  const { service } = setup();
  t.after(() => service.close());
  service.setAutoMode('auto-full');

  const external = await runSample(service, 'external-confirm');
  assert.equal(external.operations[0].state, 'executed');
  assert.equal(external.operations[0].confirmationId, 'auto-full');
  assert.equal(service.mailer.calls.length, 1);

  const device = await runSample(service, 'device');
  assert.equal(device.operations[0].state, 'executed');
  assert.equal(service.getBusinessState().deviceStates['会议室-门锁'], 'open');

  const deleted = await runSample(service, 'bulk-delete');
  assert.equal(deleted.operations[0].state, 'executed');
  assert.ok(service.getBusinessState().deletedDocIds.includes('M2'));
  assert.equal(service.getState().autoMode, 'auto-full');
});

test('自动模式：非法值拒绝；重置回到人在环', (t) => {
  const { service } = setup();
  t.after(() => service.close());
  assert.throws(() => service.setAutoMode('auto'), (err) => err.code === 'BAD_REQUEST');
  service.setAutoMode('auto-full');
  assert.equal(service.getState().autoMode, 'auto-full');
  service.reset();
  assert.equal(service.getState().autoMode, 'manual');
  assert.equal(service.getState().autoSafe.used, 0);
});

test('角色裁剪：实习生外发工具被令牌拒绝', async (t) => {
  const { service } = setup();
  t.after(() => service.close());
  const run = await service.runCommand({
    command: '把周例会纪要发给外部参会方 partner@partner-example.com',
    role: '实习生', tools: ['readDoc', 'sendExternalEmail'], documentIds: ['M2'],
    domains: ['partner-example.com'],
  });
  assert.equal(run.operations.length, 0);
  assert.ok(run.deniedTools.includes('sendExternalEmail'));
  assert.ok(run.lines.some((l) => l.includes('拒绝')));
});
