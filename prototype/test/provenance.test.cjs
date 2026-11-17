'use strict';
// 跨步骤来源追踪（2026-11-17）：
//   - 派生内容继承来源闭包（密级取最高、污点取并集、变换链追加）
//   - 出站/打印时按闭包校验：来源未授权、来源受污染、密级被转换降低 都拒绝
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { AgentRuntime } = require('../src/runtime.cjs');
const { GuardedPlanner } = require('../src/planner.cjs');
const { MockLLM } = require('../src/llm.cjs');
const { PolicyEngine, AuditLog, RiskMeter } = require('../src/governance.cjs');
const { CapabilityToken } = require('../src/guard.cjs');
const { DOCS } = require('../src/scenario.cjs');

function fixture(llm = new MockLLM()) {
  const audit = new AuditLog();
  const risk = new RiskMeter(1000);
  const policy = new PolicyEngine();
  const planner = new GuardedPlanner({ llm, audit, risk });
  return { audit, risk, rt: new AgentRuntime({ policy, audit, risk, planner }) };
}

function tokenFor(tools, documentIds) {
  return new CapabilityToken({
    tools,
    documentIds,
    allowedExternalDomains: ['partner-example.com'],
  });
}

test('污点闭包：转写稿→摘要→外发被拒绝', async () => {
  const { rt, audit } = fixture();
  const ctx = {
    role: '员工',
    token: tokenFor(['transcribeAudio', 'summarize', 'sendExternalEmail'], ['A2']),
    nearfieldOnline: true,
    command: '把录音整理后发给 partner@partner-example.com',
  };

  await rt.execStep({ action: 'transcribeAudio', args: { id: 'A2' } }, 1, ctx);
  assert.ok(rt.knowledge.tr_A2 && rt.knowledge.tr_A2.tainted, '录音转写应标记受污染');

  await rt.execStep({ action: 'summarize', args: { of: 'tr_A2' } }, 2, ctx);
  assert.ok(rt.knowledge.draft_tr_A2, '应生成派生稿');
  assert.equal(rt.knowledge.draft_tr_A2.tainted, true, '派生稿必须继承污点');
  assert.deepEqual(rt.knowledge.draft_tr_A2.sourceIds, ['A2'], '来源闭包应指向根源');

  const out = await rt.execStep(
    { action: 'sendExternalEmail', args: { to: 'partner@partner-example.com', docId: 'draft_tr_A2' } },
    3,
    ctx,
  );
  assert.match(out, /来源受污染/, '污点来源禁止外发');
  assert.equal(rt.outbox.length, 0, '不应产生发送记录');
  assert.ok(
    audit.entries.some((e) => e.kind === '闸3拒绝' && String(e.detail.reason || '').includes('污染')),
    '审计应记录污点拒绝',
  );
});

test('等级单调：转换把密级降下来 → 拒绝', async () => {
  const { rt } = fixture();
  rt.knowledge.M2 = { ...DOCS.M2 }; // 内部
  rt.knowledge.draft_low = {
    id: 'draft_low', title: '被降级的派生稿', level: '公开',
    body: '内容', sourceIds: ['M2'], generated: true,
  };
  const ctx = {
    role: '员工',
    token: tokenFor(['sendExternalEmail'], ['M2']),
    nearfieldOnline: true,
    command: '发给 partner@partner-example.com',
  };
  const out = await rt.execStep(
    { action: 'sendExternalEmail', args: { to: 'partner@partner-example.com', docId: 'draft_low' } },
    1,
    ctx,
  );
  assert.match(out, /不得降级/, '来源密级高于内容密级应拒绝');
  assert.equal(rt.outbox.length, 0);
});

test('来源闭包：根源未被令牌授权 → 拒绝', async () => {
  const { rt } = fixture();
  rt.knowledge.M2 = { ...DOCS.M2 };
  rt.knowledge.draft_orphan = {
    id: 'draft_orphan', title: '来源未授权', level: '内部',
    body: '内容', sourceIds: ['M2'], generated: true,
  };
  const ctx = {
    role: '员工',
    token: tokenFor(['sendExternalEmail'], ['draft_orphan']), // 只授权了派生稿，没有根源 M2
    nearfieldOnline: true,
    command: '发给 partner@partner-example.com',
  };
  const out = await rt.execStep(
    { action: 'sendExternalEmail', args: { to: 'partner@partner-example.com', docId: 'draft_orphan' } },
    1,
    ctx,
  );
  assert.match(out, /来源未授权/, '闭包里的根源必须被令牌覆盖');
  assert.equal(rt.outbox.length, 0);
});

test('正常链路不回归：内部纪要→摘要→外部合作方仍可发送（脱敏后）', async () => {
  const llm = new MockLLM();
  llm.generate = async () => '正式稿：周四十点开会，周五提交值班表。';
  const { rt } = fixture(llm);
  const ctx = {
    role: '员工',
    token: tokenFor(['readDoc', 'summarize', 'sendExternalEmail'], ['M2']),
    nearfieldOnline: true,
    command: '整理周例会纪要发给 partner@partner-example.com',
  };

  await rt.execStep({ action: 'readDoc', args: { id: 'M2' } }, 1, ctx);
  await rt.execStep({ action: 'summarize', args: { of: 'M2' } }, 2, ctx);
  assert.equal(rt.knowledge.draft_M2.level, '内部', '正常派生稿保持内部级');
  assert.equal(rt.knowledge.draft_M2.tainted, false, '干净来源不应被标记污点');

  const out = await rt.execStep(
    { action: 'sendExternalEmail', args: { to: 'partner@partner-example.com', docId: 'draft_M2' } },
    3,
    ctx,
  );
  assert.match(out, /已发送/, '正常流程不应被新增闸门误拦');
  assert.equal(rt.outbox.length, 1);
  assert.equal(rt.outbox[0].docId, 'draft_M2');
});
