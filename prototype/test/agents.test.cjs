'use strict';
// Agent 身份与权限分级（v0.9）：角色矩阵 / 清单 / 令牌交集 / 委托令牌 / 审计绑定
const test = require('node:test');
const assert = require('node:assert');
const { PolicyEngine, AuditLog, RiskMeter } = require('../src/governance.cjs');
const { AgentRuntime } = require('../src/runtime.cjs');
const { GuardedPlanner, validatePlan } = require('../src/planner.cjs');
const { MockLLM } = require('../src/llm.cjs');
const {
  defineAgent, issueToken, verifyAgentManifest, DelegationService,
  ROLE_TOOLS, ROLE_DOC_IDS,
} = require('../src/agents.cjs');

function mkRt() {
  const audit = new AuditLog();
  const risk = new RiskMeter(1000, { onEvent: (k, d) => audit.append(k, d) }); // 测试内不触发冻结
  const planner = new GuardedPlanner({ llm: new MockLLM(), audit, risk });
  const rt = new AgentRuntime({ policy: new PolicyEngine(), audit, risk, planner });
  return { rt, audit, risk };
}

const ALL_DOCS = ['M1', 'M2', 'M3', 'I1', 'I2', 'A1', 'A2'];
const intern = defineAgent({
  agentId: 'intern-1', role: '实习生',
  allowedTools: ['readDoc', 'readContact', 'summarize', 'recognizeImage', 'transcribeAudio'],
  documentScopes: ['M2', 'M3', 'I1', 'A1', 'A2'],
});
const employee = defineAgent({
  agentId: 'emp-1', role: '员工',
  allowedTools: ['readDoc', 'readContact', 'summarize', 'sendInternalEmail', 'sendExternalEmail'],
  documentScopes: ALL_DOCS,
});
const auditor = defineAgent({
  agentId: 'audit-1', role: '审计员',
  allowedTools: ['readDoc', 'summarize'], documentScopes: ALL_DOCS,
});
const device = defineAgent({
  agentId: 'dev-1', role: '设备助手',
  allowedTools: ['deviceControl'], documentScopes: [],
});

test('角色矩阵：工具与密级范围符合最小权限', () => {
  assert.ok(ROLE_TOOLS['实习生'].includes('readDoc'));
  assert.ok(!ROLE_TOOLS['实习生'].includes('sendExternalEmail'), '实习生不得外发');
  assert.ok(!ROLE_TOOLS['实习生'].includes('sendInternalEmail'), '实习生不得发送');
  assert.deepEqual(ROLE_TOOLS['设备助手'], ['deviceControl']);
  assert.deepEqual(ROLE_TOOLS['管理员'], []);
  assert.deepEqual(ROLE_TOOLS['访客'], []);
  assert.ok(!ROLE_DOC_IDS['实习生'].includes('M1'), '实习生不得读取机密纪要');
  assert.ok(!ROLE_DOC_IDS['实习生'].includes('I2'), '实习生不得读取机密截图');
  assert.ok(ROLE_DOC_IDS['员工'].includes('M1'));
  assert.deepEqual(ROLE_DOC_IDS['设备助手'], []);

  const p = new PolicyEngine();
  assert.equal(p.decide('实习生', 'readDoc'), 'allow');
  assert.equal(p.decide('实习生', 'sendExternalEmail'), 'deny');
  assert.equal(p.decide('审计员', 'sendInternalEmail'), 'deny');
  assert.equal(p.decide('设备助手', 'deviceControl'), 'confirm');
  assert.equal(p.decide('设备助手', 'readDoc'), 'deny');
  assert.equal(p.decide('管理员', 'readDoc'), 'deny');
});

test('Agent 清单：越角色申请工具/文档直接拒绝', () => {
  assert.throws(() => defineAgent({
    agentId: 'bad-1', role: '实习生', allowedTools: ['sendExternalEmail'],
  }), /不具备的工具/);
  assert.throws(() => defineAgent({
    agentId: 'bad-2', role: '实习生', documentScopes: ['M1'],
  }), /不可读的资源/);
  assert.throws(() => defineAgent({ agentId: 'bad-3', role: '不存在的角色' }), /未知角色/);
  assert.throws(() => defineAgent({
    agentId: 'bad-4', role: '员工', modelLocation: 'edge',
  }), /modelLocation/);
});

test('令牌 = 角色 ∩ 清单 ∩ 任务：越权请求被裁剪并记录', () => {
  const { token, deniedTools, deniedDocs } = issueToken(intern, {
    tools: ['readDoc', 'sendExternalEmail'],
    documentIds: ['M2', 'M1'],
    maxCalls: 100,
    issuedFor: '测试',
  });
  assert.deepEqual(token.tools, ['readDoc']);
  assert.deepEqual(token.documentIds, ['M2']);
  assert.deepEqual(deniedTools, ['sendExternalEmail']);
  assert.deepEqual(deniedDocs, ['M1']);
  assert.equal(token.maxCalls, 8, '不得超过角色调用上限');
  assert.equal(token.agentId, 'intern-1');
  assert.equal(token.role, '实习生');
});

test('令牌 TTL：ttlMs=0 不能绕过角色上限变成永不过期', () => {
  const { token } = issueToken(intern, { tools: ['readDoc'], documentIds: ['M2'], ttlMs: 0 });
  const ttl = token.expiresAt - token.issuedAt;
  assert.ok(ttl > 0, '必须仍有有效期');
  assert.ok(ttl <= 5 * 60 * 1000, '不得超过角色 TTL 上限');
});

test('清单摘要：篡改角色/工具后校验失败', () => {
  assert.equal(verifyAgentManifest(intern).ok, true);
  const tampered = { ...intern, role: '员工' };
  assert.equal(verifyAgentManifest(tampered).ok, false);
  const extra = { ...intern, allowedTools: [...intern.allowedTools, 'sendExternalEmail'] };
  assert.equal(verifyAgentManifest(extra).ok, false);
});

test('运行绑定：Agent + 令牌一致才执行，且审计记录 Agent 身份', async () => {
  const { rt, audit } = mkRt();
  const { token } = issueToken(intern, { tools: ['readContact'], documentIds: [] });
  const out = (await rt.runCommand('查一下张伟的联系方式', { agent: intern, token })).join('\n');
  assert.match(out, /联系人「张伟」/);
  const identity = audit.entries.find((e) => e.kind === 'Agent身份');
  assert.equal(identity.detail.agentId, 'intern-1');
  assert.equal(identity.detail.role, '实习生');
  assert.ok(identity.detail.manifestHash);
  const command = audit.entries.find((e) => e.kind === '用户指令');
  assert.equal(command.detail.agentId, 'intern-1');
});

test('运行绑定：角色声明不一致 / 令牌换 Agent / 清单篡改 一律拒绝', async () => {
  const { token: internToken } = issueToken(intern, { tools: ['readContact'], documentIds: [] });

  let { rt } = mkRt();
  let out = (await rt.runCommand('查一下张伟的联系方式', {
    agent: intern, role: '员工', token: internToken,
  })).join('\n');
  assert.match(out, /角色声明不一致/);

  ({ rt } = mkRt());
  const { token: empToken } = issueToken(employee, { tools: ['readContact'], documentIds: [] });
  out = (await rt.runCommand('查一下张伟的联系方式', { agent: intern, token: empToken })).join('\n');
  assert.match(out, /令牌未绑定/);

  ({ rt } = mkRt());
  out = (await rt.runCommand('查一下张伟的联系方式', {
    agent: { ...intern, role: '员工' }, token: internToken,
  })).join('\n');
  assert.match(out, /清单摘要不匹配|不具备工具|不可读资源/);

  ({ rt } = mkRt());
  out = (await rt.runCommand('查一下张伟的联系方式', {
    agent: intern, token: internToken, modelLocation: 'local',
  })).join('\n');
  assert.match(out, /模型位置声明不一致/, '模型位置以清单为准，调用方不能擅自改写');
});

test('委托令牌：无令牌/过期/主体不符/动作不符/已撤销 均拒绝，合法令牌放行', () => {
  const ds = new DelegationService();
  const command = '以张总名义给全部门发通知：下周例会改期，发到 team@corp.internal';
  const raw = [{ action: 'sendInternalEmail', args: { to: 'team@corp.internal', docId: 'M2' } }];
  const verify = (t) => ds.verify(t, { to: 'team@corp.internal', action: 'sendInternalEmail' });

  const none = validatePlan(raw, { command, docs: [] });
  assert.equal(none.steps.length, 0);
  assert.match(none.findings[0].reason, /未持委托令牌/);

  const valid = ds.issue({ from: '张总', to: 'team@corp.internal', actions: ['sendInternalEmail'] });
  const ok = validatePlan(raw, {
    command, docs: [], delegation: valid,
    delegationVerifier: (t, ctx) => ds.verify(t, ctx),
  });
  assert.equal(ok.steps.length, 1);
  assert.equal(ok.notes.length, 1);
  assert.match(ok.notes[0].reason, /委托令牌放行/);

  // 纵深防御：委托令牌不能替代"目标必须在用户指令中可溯源"
  const missingTarget = validatePlan(raw, {
    command: '以张总名义给全部门发通知：下周例会改期', docs: [], delegation: valid,
    delegationVerifier: (t, ctx) => ds.verify(t, ctx),
  });
  assert.equal(missingTarget.steps.length, 0);
  assert.match(missingTarget.findings[0].reason, /来源未授权/);
  assert.equal(missingTarget.notes.length, 0, '步骤被移除时不得写"委托放行"假审计');

  const expired = ds.issue({ from: '张总', to: 'team@corp.internal', actions: ['sendInternalEmail'], ttlMs: -1 });
  assert.equal(verify(expired).allow, false);
  assert.match(verify(expired).reason, /过期/);

  const wrongTarget = ds.issue({ from: '张总', to: 'other@corp.internal', actions: ['sendInternalEmail'] });
  assert.match(verify(wrongTarget).reason, /主体不匹配/);

  const wrongAction = ds.issue({ from: '张总', to: 'team@corp.internal', actions: ['sendExternalEmail'] });
  assert.match(verify(wrongAction).reason, /不覆盖动作/);

  const revoked = ds.issue({ from: '张总', to: 'team@corp.internal', actions: ['sendInternalEmail'] });
  ds.revoke(revoked.id);
  assert.match(verify(revoked).reason, /已撤销/);
});

test('委托令牌接入运行时：无令牌拦截、有令牌放行且实际发送', async () => {
  const command = '以张总名义给全部门发通知：下周例会改期，发到 team@corp.internal';

  let { rt, audit } = mkRt();
  let { token } = issueToken(employee, {
    tools: ['readDoc', 'sendInternalEmail'], documentIds: ['M2'],
  });
  let out = (await rt.runCommand(command, { agent: employee, token })).join('\n');
  assert.match(out, /未持委托令牌/);
  assert.equal(rt.outbox.length, 0, '无委托令牌不得发送');

  ({ rt, audit } = mkRt());
  const ds = new DelegationService();
  ({ token } = issueToken(employee, { tools: ['readDoc', 'sendInternalEmail'], documentIds: ['M2'] }));
  const delegation = ds.issue({ from: '张总', to: 'team@corp.internal', actions: ['sendInternalEmail'] });
  out = (await rt.runCommand(command, {
    agent: employee, token, delegation,
    delegationVerifier: (t, ctx) => ds.verify(t, ctx),
  })).join('\n');
  assert.match(out, /委托令牌放行/);
  assert.match(out, /邮件 → team@corp.internal 已发送/);
  assert.equal(rt.outbox.length, 1);
  assert.ok(audit.entries.some((e) => e.kind === '委托放行'), '委托放行必须入审计');
});

test('令牌签发入审计：Agent、角色、裁剪结果可追溯', () => {
  const audit = new AuditLog();
  issueToken(intern, {
    tools: ['readDoc', 'sendExternalEmail'], documentIds: ['M2', 'M1'], issuedFor: '审计测试',
  }, { audit });
  const rec = audit.entries.find((e) => e.kind === '令牌签发');
  assert.ok(rec, '应记录令牌签发');
  assert.equal(rec.detail.agentId, 'intern-1');
  assert.equal(rec.detail.role, '实习生');
  assert.deepEqual(rec.detail.deniedTools, ['sendExternalEmail']);
  assert.deepEqual(rec.detail.deniedDocs, ['M1']);
  assert.ok(audit.verify(), '审计链应完整');
});
