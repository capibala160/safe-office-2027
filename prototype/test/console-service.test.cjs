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
  assert.equal(bootstrap.state.version, '0.41.0');
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

test('四眼原则：发起人不能批准自己的操作，换人后可批准', async (t) => {
  const { service } = setup();
  t.after(() => service.close());
  const run = await service.runCommand({ ...sample(service, 'external-confirm'), operator: 'alice' });
  const op = run.operations[0];
  assert.equal(op.createdBy, 'alice');

  const challenge = service.beginChallenge(op.operationId);
  await assert.rejects(
    () => service.decideChallenge(challenge.challengeId, 'approve', { actor: 'alice', role: '员工' }),
    /四眼原则/,
  );
  assert.equal(service.store.getOperation(op.operationId).state, 'frozen', '被拒后操作仍冻结');
  assert.equal(service.mailer.calls.length, 0);

  const approved = await service.decideChallenge(challenge.challengeId, 'approve', {
    actor: 'bob', role: '设备助手',
  });
  assert.equal(approved.outcome, 'approved');
  assert.equal(approved.operation.state, 'executed');
  assert.ok(service.audit.entries.some((e) => e.kind === '四眼原则拒绝'));
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
  // v0.19 起计划层预检会先移除未授权工具；运行时闸2 仍兜底其他路径
  assert.ok(run.lines.some((l) => l.includes('不在本次授权工具内') || l.includes('拒绝')));
});

test('导出正文：冻结时拒绝，批准后返回与冻结记录一致的正文', async (t) => {
  const { service } = setup();
  t.after(() => service.close());
  const run = await runSample(service, 'external-confirm');
  const op = run.operations.find((o) => o.state === 'frozen');
  assert.ok(op, '外发样例应产生冻结操作');

  assert.throws(() => service.getOperationBody(op.operationId), /尚未批准/);

  const frozen = service.store.getOperation(op.operationId);
  service.fulfillment.confirm(op.operationId, {
    confirmedHash: frozen.operationHash, confirmationId: 'test', deviceId: 'test-device',
  });
  const out = service.getOperationBody(op.operationId);
  assert.equal(out.body, frozen.body, '导出的必须是被批准的那一份');
  assert.equal(out.bodyHash, frozen.bodyHash);
  assert.equal(out.recipient, frozen.recipient);
  assert.ok(service.audit.entries.some((e) => e.kind === '导出正文'));
});

test('草稿编辑：正文改动 → 重新哈希 → 旧挑战作废 → 保留版本历史', async (t) => {
  const { service } = setup();
  t.after(() => service.close());
  const run = await runSample(service, 'external-confirm');
  const op = run.operations[0];
  assert.equal(op.state, 'frozen');
  const challenge = service.beginChallenge(op.operationId);

  const edited = service.editOperationBody(op.operationId, { body: '改过的正文：只发这一段。', editor: '测试' });
  assert.equal(edited.changed, true);
  assert.equal(edited.voidedChallenges, 1, '旧挑战必须作废');
  assert.notEqual(edited.operation.operationHash, op.operationHash);
  assert.notEqual(edited.operation.bodyHash, op.bodyHash);
  assert.equal(service.challenges.get(challenge.challengeId).state, 'expired');

  // 重新发起挑战，目标哈希必须是新记录的
  const next = service.beginChallenge(op.operationId);
  assert.equal(next.targetHash, edited.operation.operationHash);

  const history = service.listOperationRevisions(op.operationId);
  assert.equal(history.revisions.length, 1);
  assert.equal(history.revisions[0].bodyHash, op.bodyHash, '旧版本正文哈希要留档');
  assert.equal(history.current.body, '改过的正文：只发这一段。');
});

test('草稿编辑：已确认/已执行的操作不能再改', async (t) => {
  const { service } = setup();
  t.after(() => service.close());
  const run = await runSample(service, 'external-confirm');
  const op = run.operations[0];
  const challenge = service.beginChallenge(op.operationId);
  const decided = await service.decideChallenge(challenge.challengeId, 'approve');
  assert.equal(decided.outcome, 'approved');
  assert.throws(
    () => service.editOperationBody(op.operationId, { body: '偷偷改一下' }),
    /不能再编辑/,
  );
});

test('授权语义：未传=角色默认，显式空=不授权（不能扩大权限）', async (t) => {
  const { service } = setup();
  t.after(() => service.close());
  await assert.rejects(
    () => service.runCommand({ command: '查一下张伟的联系方式', role: '员工', tools: [], documentIds: [] }),
    /空选择等于不授权/,
  );
  // 显式空文档 = 不授权任何文档，但不报错
  const run = await service.runCommand({ command: '查一下张伟的联系方式', role: '员工', tools: ['readContact'], documentIds: [] });
  assert.deepEqual(run.documentIds, []);
});

test('异步任务：起跑即返回 runId，阶段可轮询，完成有结果', async (t) => {
  const { service } = setup();
  t.after(() => service.close());
  const started = service.startCommand({
    command: '把周例会纪要整理一下，发到部门内网邮箱 team@corp.internal',
    role: '员工', tools: ['readDoc', 'summarize', 'sendInternalEmail'], documentIds: ['M2'],
  });
  assert.match(started.runId, /^RUN-\d+$/);
  const live = service.liveRuns.get(started.runId);
  await live.done;
  const snap = service.getRun(started.runId);
  assert.equal(snap.status, 'done');
  assert.ok(snap.stageLog.some((s) => s.stage === '规划'), '应有规划阶段');
  assert.ok(snap.stageLog.some((s) => s.stage === '执行'), '应有执行阶段');
  assert.ok(snap.result, '完成后的任务要能取回结果');
});

test('取消：规划期间请求取消 → 后续步骤全部不执行，已发生的保留', async (t) => {
  const gate = new Promise((resolve) => setTimeout(resolve, 40));
  const llm = {
    deployment: 'local',
    async plan() {
      await gate;
      return [
        { action: 'readDoc', args: { id: 'M2' } },
        { action: 'summarize', args: { of: 'M2' } },
        { action: 'sendInternalEmail', args: { to: 'team@corp.internal', docId: 'draft_M2' } },
      ];
    },
    async generate() { return '正文'; },
  };
  const { service } = setup({ service: { llm } });
  t.after(() => service.close());
  const started = service.startCommand({
    command: '整理纪要并发内网', role: '员工',
    tools: ['readDoc', 'summarize', 'sendInternalEmail'], documentIds: ['M2'],
  });
  service.cancelRun(started.runId);
  const run = await service.liveRuns.get(started.runId).done;
  assert.ok(run.lines.some((l) => l.includes('任务取消')), '结果里要写明已取消');
  assert.equal(service.getRun(started.runId).status, 'done');
  assert.ok(service.audit.entries.some((e) => e.kind === '任务取消'), '取消要进审计');
});

test('取消：任务结束后再取消 → 409', async (t) => {
  const { service } = setup();
  t.after(() => service.close());
  const started = service.startCommand({
    command: '查一下张伟的联系方式', role: '员工', tools: ['readContact'], documentIds: [],
  });
  await service.liveRuns.get(started.runId).done;
  assert.throws(() => service.cancelRun(started.runId), /已结束/);
});

test('重启恢复：操作来源、运行历史、风险计量、业务状态跨进程恢复', async (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-office-restore-'));
  const storeFile = path.join(dir, 'ops.db');
  const auditFile = path.join(dir, 'audit.json');

  const a = setup({ service: { storeFile, auditFile } }).service;
  const run = await a.runCommand({
    command: '把周例会纪要发给外部参会方 partner@partner-example.com',
    role: '员工', tools: ['readDoc', 'sendExternalEmail'], documentIds: ['M2'],
    domains: ['partner-example.com'], nearfieldOnline: true,
  });
  const opId = run.operations[0].operationId;
  a.risk.add(70, '测试用风险累积');
  a._persistConsoleState();
  a.close();

  const b = setup({ service: { storeFile, auditFile } }).service;
  t.after(() => { b.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const detail = b.getOperation(opId);
  assert.equal(detail.meta.runId, run.runId, '操作来源（runId）要能恢复');
  assert.equal(detail.meta.docTitle, run.operations[0].docTitle);
  assert.ok(b.runs.some((r) => r.runId === run.runId), '运行历史要能恢复');
  assert.equal(b.risk.frozen, true, '风险冻结状态要能恢复');
  assert.ok(b.getState().counts.operations >= 1);
  assert.equal(b.getOperation(opId).operation.state, 'frozen');

  // 任务编号必须接着历史最大号：否则重启后的 RUN-1 会与已落库的 RUN-1 撞车
  const seqOf = (id) => Number(String(id).replace(/^RUN-/, ''));
  const next = await b.runCommand({
    command: '查一下张伟的联系方式', role: '员工', tools: ['readContact'], documentIds: [],
  });
  assert.ok(seqOf(next.runId) > seqOf(run.runId), `新任务编号应大于 ${run.runId}，实际 ${next.runId}`);
  assert.ok(b.seq >= seqOf(next.runId));
});

test('手机确认端：详情带收件人/正文预览/附件，目标哈希与操作一致', async (t) => {
  const { service } = setup();
  t.after(() => service.close());
  const run = await runSample(service, 'external-confirm');
  const op = run.operations[0];
  service.beginChallenge(op.operationId);
  const state = service.getPhoneState();
  const details = state.pending.details;
  assert.ok(details, '待确认时必须带展示详情');
  assert.equal(details.targetHash, op.operationHash, '端上据此与挑战目标哈希比对');
  assert.equal(details.recipient, op.recipient);
  assert.equal(details.level, op.level);
  assert.ok(details.bodyPreview.length > 0, '应有正文预览');
  assert.ok(Array.isArray(details.attachments));
  assert.equal(details.verify.ok, true);
});

test('设备批准但发送失败/未知：不按成功回报', async (t) => {
  const failed = setup({ service: { mailer: new FakeMailer({ behavior: 'rejected' }) } });
  t.after(() => failed.service.close());
  const run = await runSample(failed.service, 'external-confirm');
  const op = run.operations[0];
  const ch = failed.service.beginChallenge(op.operationId);
  const decided = await failed.service.decideChallenge(ch.challengeId, 'approve');
  assert.equal(decided.ok, false, '发送失败不能报 ok:true');
  assert.equal(decided.outcome, 'approved-but-failed');
  assert.equal(decided.code, 'SEND_FAILED');
  assert.equal(decided.send.state, 'failed');
  assert.match(decided.message, /发送失败/);
  assert.equal(decided.operation.state, 'failed');
  assert.equal(decided.operation.outbox.state, 'failed');

  const unknown = setup({ service: { mailer: new FakeMailer({ behavior: 'timeout' }) } });
  t.after(() => unknown.service.close());
  const run2 = await runSample(unknown.service, 'external-confirm');
  const op2 = run2.operations[0];
  const ch2 = unknown.service.beginChallenge(op2.operationId);
  const decided2 = await unknown.service.decideChallenge(ch2.challengeId, 'approve');
  assert.equal(decided2.ok, false);
  assert.equal(decided2.outcome, 'approved-but-unknown');
  assert.equal(decided2.code, 'SEND_UNKNOWN');
  assert.equal(decided2.send.state, 'unknown');
  assert.match(decided2.message, /待核实/);
});

test('发件核对：不能核对他人记录（服务层 404）', async (t) => {
  const { service } = setup({ service: { mailer: new FakeMailer({ behavior: 'accepted-then-timeout' }) } });
  t.after(() => service.close());
  const run = await service.runCommand({ ...sample(service, 'external-confirm'), operator: 'alice' });
  const op = run.operations[0];
  const ch = service.beginChallenge(op.operationId);
  await service.decideChallenge(ch.challengeId, 'approve');
  const outbox = service.store.getOutboxByOperation(op.operationId);
  assert.equal(outbox.state, 'unknown');

  assert.throws(
    () => service.reconcileOutbox(outbox.outboxId, { state: 'sent', actor: 'bob', role: '员工' }),
    /发件记录不存在/,
  );
  assert.equal(service.store.getOutbox(outbox.outboxId).state, 'unknown');

  const ok = service.reconcileOutbox(outbox.outboxId, { state: 'sent', actor: 'alice', role: '员工' });
  assert.equal(ok.ok, true);
  assert.equal(ok.outbox.state, 'sent');

  // 管理员跨租户核对仍然允许
  const run2 = await service.runCommand({ ...sample(service, 'external-confirm'), operator: 'alice' });
  const op2 = run2.operations[0];
  const ch2 = service.beginChallenge(op2.operationId);
  await service.decideChallenge(ch2.challengeId, 'approve');
  const outbox2 = service.store.getOutboxByOperation(op2.operationId);
  const admin = service.reconcileOutbox(outbox2.outboxId, { state: 'sent', actor: 'root', role: '管理员' });
  assert.equal(admin.ok, true);
});
