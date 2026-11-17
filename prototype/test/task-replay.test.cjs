'use strict';
// 任务证据回放（2026-11-17）：要求/计划/批准/调用/回执 + 完整性校验
const test = require('node:test');
const assert = require('node:assert/strict');
const { ConsoleService } = require('../src/console-service.cjs');
const { buildTaskReplay, renderTaskReplay } = require('../src/task-replay.cjs');
const { verifyOperation } = require('../src/operation.cjs');

function synthetic() {
  const run = {
    runId: 'RUN-1',
    at: '2026-11-17T10:00:00.000Z',
    command: '把周例会纪要发给 partner@example.com',
    role: '员工',
    operator: 'alice',
    tools: ['readDoc', 'summarize', 'sendExternalEmail'],
    documentIds: ['M2'],
    risk: { score: 5, threshold: 60, frozen: false },
    audit: { from: 2, to: 8, count: 6, verified: true },
  };
  const entries = [
    { seq: 1, ts: 1000, kind: '计划校验', detail: { level: 'info' } },
    { seq: 2, ts: 1001, kind: '执行', detail: { n: 1, action: 'readDoc', outcome: '读入 M2' } },
    { seq: 3, ts: 1002, kind: '执行', detail: { n: 2, action: 'summarize', outcome: '生成 draft_M2' } },
    { seq: 4, ts: 1003, kind: '待确认', detail: { operationId: 'op-1' } },
  ];
  const operation = {
    operationId: 'op-1',
    taskId: 'RUN-1',
    action: 'sendExternalEmail',
    recipient: 'partner@example.com',
    level: '内部',
    state: 'confirmed',
    operationHash: 'a'.repeat(64),
    confirmationId: 'ws63-x',
    deviceId: 'ws63-B',
    planHash: 'plan-1',
    modelId: 'mock',
    createdAt: '2026-11-17T10:00:00.000Z',
    expiresAt: '2026-11-17T10:10:00.000Z',
  };
  return { run, entries, operation };
}

test('回放：要求/闸事件/批准/调用/回执串联，完整性为真', () => {
  const { run, entries, operation } = synthetic();
  const replay = buildTaskReplay({
    run,
    auditEntries: entries,
    operations: [operation],
    outboxByOperation: () => ({ state: 'sent', messageId: '<msg-1@example.com>' }),
    verifyOperation: () => ({ ok: true }),
  });
  assert.equal(replay.runId, 'RUN-1');
  assert.match(replay.command, /partner@example\.com/);
  assert.equal(replay.approvals.length, 1);
  assert.equal(replay.approvals[0].state, 'confirmed');
  assert.equal(replay.approvals[0].receipt.state, 'sent');
  assert.equal(replay.calls.length, 2);
  assert.ok(replay.gates.some((g) => g.kind === '待确认'));
  assert.equal(replay.integrity.auditVerified, true);
  assert.deepEqual(replay.warnings, []);

  const lines = renderTaskReplay(replay);
  assert.ok(lines.some((l) => l.includes('任务回放 RUN-1')));
  assert.ok(lines.some((l) => l.includes('回执：state=sent')));
});

test('回放：发送结果未知与操作校验失败会给出警告', () => {
  const { run, entries, operation } = synthetic();
  const replay = buildTaskReplay({
    run,
    auditEntries: entries,
    operations: [operation],
    outboxByOperation: () => ({ state: 'unknown', messageId: null, lastError: 'timeout' }),
    verifyOperation: () => ({ ok: false, reason: '正文哈希不符' }),
  });
  assert.ok(replay.warnings.some((w) => w.includes('发送结果未知')));
  assert.ok(replay.warnings.some((w) => w.includes('冻结记录校验失败')));
  assert.equal(replay.integrity.operations[0].ok, false);
});

test('回放：审计链未通过时明确警告', () => {
  const { run, entries, operation } = synthetic();
  const replay = buildTaskReplay({
    run: { ...run, audit: { ...run.audit, verified: false } },
    auditEntries: entries,
    operations: [operation],
    outboxByOperation: () => null,
    verifyOperation: () => ({ ok: true }),
  });
  assert.equal(replay.integrity.auditVerified, false);
  assert.ok(replay.warnings.some((w) => w.includes('审计链校验未通过')));
});

test('控制台集成：运行后可按 runId 取回放；未知 runId 404', async (t) => {
  const service = new ConsoleService();
  t.after(() => service.close());
  const item = service.getDemoSamples().find((s) => s.id === 'external-confirm');
  assert.ok(item, '样例存在');
  const run = await service.runCommand({ ...item, role: item.role });
  assert.ok(run.runId);

  const replay = service.getTaskReplay(run.runId);
  assert.equal(replay.runId, run.runId);
  assert.equal(replay.command, run.command);
  assert.ok(replay.approvals.length >= 1, '外发样例应冻结一条操作');
  assert.ok(replay.gates.length >= 1, '应包含闸/待确认事件');
  assert.equal(typeof replay.integrity.auditVerified, 'boolean');

  assert.throws(() => service.getTaskReplay('RUN-不存在'), /不存在/);
});
