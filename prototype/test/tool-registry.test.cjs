'use strict';
// 工具注册表 + MCP 适配器（v0.13）
//   只使用独立 ToolRegistry / 假 transport，不污染静态表、不联网。
const test = require('node:test');
const assert = require('node:assert/strict');
const { ToolRegistry, BUILTIN_DEFERRED_ACTIONS } = require('../src/tool-registry.cjs');
const { TOOL_META } = require('../src/capabilities.cjs');
const { DEFAULT_SANDBOX, checkSandbox } = require('../src/sandbox.cjs');
const { HIGH_RISK_ACTIONS, OUTBOUND_ACTIONS, CapabilityToken } = require('../src/guard.cjs');
const { PolicyEngine, AuditLog, RiskMeter } = require('../src/governance.cjs');
const { validatePlan, GuardedPlanner } = require('../src/planner.cjs');
const { ROLE_DEFS, ROLE_TOOLS, defineAgent, verifyAgentManifest, issueToken } = require('../src/agents.cjs');
const { AgentRuntime } = require('../src/runtime.cjs');
const { McpClient, createHttpTransport, mcpToolToDefinition, registerMcpTools } = require('../src/mcp-adapter.cjs');
const { ConsoleService } = require('../src/console-service.cjs');

function customDef(overrides = {}) {
  return {
    name: 'lookupRoom',
    capability: '会议预约',
    level: 'L1',
    requiredArgs: ['room'],
    sandbox: { local: true },
    outbound: false,
    outboundArg: null,
    irreversible: false,
    highRisk: false,
    deferred: false,
    protocolAction: null,
    policies: [{ role: '员工', decision: 'allow' }],
    description: '查询会议室',
    executor: async ({ args }) => `会议室 ${args.room} 空闲`,
    ...overrides,
  };
}

function setupPolicy(registry, def) {
  const policy = new PolicyEngine();
  registry.register(def, { policy });
  return policy;
}

function fakeLLM(plan) {
  return {
    deployment: 'local',
    plan: async () => plan,
    generate: async () => 'ok',
  };
}

test('内置种子与静态表一致', () => {
  const registry = new ToolRegistry();
  assert.deepEqual(registry.names(), Object.keys(TOOL_META));
  assert.deepEqual([...registry.highRiskNames()].sort(), [...HIGH_RISK_ACTIONS].sort());
  assert.deepEqual([...registry.outboundNames()].sort(), [...OUTBOUND_ACTIONS].sort());
  for (const [name, action] of BUILTIN_DEFERRED_ACTIONS) {
    assert.ok(registry.deferredNames().has(name));
    assert.equal(registry.protocolAction(name), action);
  }
  for (const name of registry.names()) {
    assert.ok(registry.sandboxProfile(name), `${name} 缺少沙箱档案`);
    assert.equal(registry.get(name).source, 'builtin');
  }
});

test('重名与 reset', () => {
  const registry = new ToolRegistry();
  assert.throws(() => registry.register(customDef({ name: 'readDoc' })), /已注册/);
  const def = customDef();
  registry.register(def);
  assert.ok(registry.has('lookupRoom'));
  assert.throws(() => registry.register(def), /已注册/);
  registry.reset();
  assert.ok(!registry.has('lookupRoom'));
  assert.equal(registry.names().length, Object.keys(TOOL_META).length);
});

test('非法定义 fail-closed', () => {
  const registry = new ToolRegistry();
  const cases = [
    [{ name: 'bad-level', level: 'L5' }, /level/],
    [{ name: 'no-sandbox', sandbox: undefined }, /sandbox/],
    [{ name: 'bad-fs', sandbox: { fsRead: { scope: '/docs' } } }, /fsRead/],
    [{ name: 'bad-args', requiredArgs: [1] }, /requiredArgs/],
    [{ name: 'bad-deferred', deferred: true }, /protocolAction/],
    [{ name: 'bad-policy', policies: [{ role: '员工', decision: 'maybe' }] }, /decision/],
    [{ name: 'bad-outbound', outbound: true }, /outboundArg/],
  ];
  for (const [patch, expected] of cases) {
    assert.throws(() => registry.register(customDef(patch)), expected);
  }
});

test('自定义工具默认拒绝', () => {
  const registry = new ToolRegistry();
  const policy = new PolicyEngine();
  registry.register(customDef({ policies: [] }));
  assert.equal(policy.decide('员工', 'lookupRoom'), 'deny');
  assert.ok(!registry.toolsForRole('员工', policy).includes('lookupRoom'));
});

test('策略声明生效、可应用到新 PolicyEngine', () => {
  const registry = new ToolRegistry();
  const def = customDef();
  const policy = new PolicyEngine();
  registry.register(def, { policy });
  assert.equal(policy.decide('员工', 'lookupRoom'), 'allow');
  assert.ok(registry.toolsForRole('员工', policy).includes('lookupRoom'));

  const policy2 = new PolicyEngine();
  registry.applyPolicies(policy2);
  assert.equal(policy2.decide('员工', 'lookupRoom'), 'allow');

  registry.reset();
  assert.ok(!registry.has('lookupRoom'));
});

test('动态角色工具顺序与静态 ROLE_TOOLS 一致', () => {
  const registry = new ToolRegistry();
  const policy = new PolicyEngine();
  for (const role of Object.keys(ROLE_DEFS)) {
    assert.deepEqual(registry.toolsForRole(role, policy), ROLE_TOOLS[role], role);
  }
});

test('planner 动态目录：自定义工具可校验，2 参调用仍拒绝', () => {
  const registry = new ToolRegistry();
  setupPolicy(registry, customDef());
  const withRegistry = validatePlan(
    [{ action: 'lookupRoom', args: { room: 'A' } }],
    { command: '查会议室 A', registry },
  );
  assert.equal(withRegistry.steps.length, 1);

  const withoutRegistry = validatePlan(
    [{ action: 'lookupRoom', args: { room: 'A' } }],
    { command: '查会议室 A' },
  );
  assert.equal(withoutRegistry.steps.length, 0);
  assert.ok(withoutRegistry.findings[0].reason.includes('不在工具目录内'));

  const missing = validatePlan(
    [{ action: 'lookupRoom', args: {} }],
    { command: '查会议室', registry },
  );
  assert.equal(missing.steps.length, 0);
  assert.ok(missing.findings[0].reason.includes('room'));
  assert.ok(!Object.keys(TOOL_META).includes('lookupRoom'));
});

test('GuardedPlanner 注入 registry 后保留自定义动作', async () => {
  const registry = new ToolRegistry();
  setupPolicy(registry, customDef());
  const audit = new AuditLog();
  const risk = new RiskMeter(60);
  const llm = fakeLLM([{ action: 'lookupRoom', args: { room: 'A' } }]);

  const planner = new GuardedPlanner({ llm, audit, risk, registry });
  const plan = await planner.makePlan('查会议室 A');
  assert.equal(plan.steps.length, 1);

  const audit2 = new AuditLog();
  const risk2 = new RiskMeter(60);
  const defaultPlanner = new GuardedPlanner({ llm, audit: audit2, risk: risk2 });
  const plan2 = await defaultPlanner.makePlan('查会议室 A');
  assert.equal(plan2.steps.length, 0);
});

test('沙箱第 4 参数：自定义档案放行，显式 null fail-closed', () => {
  const registry = new ToolRegistry();
  registry.register(customDef({ name: 'localTool', sandbox: { local: true } }));
  assert.equal(checkSandbox('localTool', {}, DEFAULT_SANDBOX, registry.sandboxProfile('localTool')).allow, true);
  assert.equal(checkSandbox('localTool', {}, DEFAULT_SANDBOX, null).allow, false);
  assert.equal(checkSandbox('readDoc', { id: 'M2' }, DEFAULT_SANDBOX).allow, true);

  registry.register(customDef({ name: 'netTool', sandbox: { net: 'https-upload' } }));
  assert.equal(checkSandbox('netTool', {}, DEFAULT_SANDBOX, registry.sandboxProfile('netTool')).allow, true);
  const tightened = { ...DEFAULT_SANDBOX, net: ['smtp-internal'] };
  assert.equal(checkSandbox('netTool', {}, tightened, registry.sandboxProfile('netTool')).allow, false);
});

test('运行时自定义执行器端到端', async () => {
  const registry = new ToolRegistry();
  const policy = setupPolicy(registry, customDef());
  const audit = new AuditLog();
  const risk = new RiskMeter(60);
  const planner = new GuardedPlanner({
    llm: fakeLLM([{ action: 'lookupRoom', args: { room: 'A' } }]),
    audit, risk, registry,
  });
  const runtime = new AgentRuntime({ policy, audit, risk, planner, toolRegistry: registry });
  const token = new CapabilityToken({ tools: ['lookupRoom'], documentIds: [], issuedFor: '查会议室 A' });
  const lines = await runtime.runCommand('查会议室 A', { role: '员工', token });
  assert.ok(lines.join('\n').includes('会议室 A 空闲'));
  assert.ok(audit.entries.some((e) => e.kind === '执行' && e.detail.action === 'lookupRoom'));
  assert.equal(token.used, 1);
});

test('无执行器 / 未注册工具 fail-closed', async () => {
  const registry = new ToolRegistry();
  const policy = setupPolicy(registry, customDef({ executor: null }));
  const audit = new AuditLog();
  const risk = new RiskMeter(60);
  const planner = new GuardedPlanner({
    llm: fakeLLM([{ action: 'lookupRoom', args: { room: 'A' } }]),
    audit, risk, registry,
  });
  const runtime = new AgentRuntime({ policy, audit, risk, planner, toolRegistry: registry });
  const token = new CapabilityToken({ tools: ['lookupRoom'], documentIds: [], issuedFor: 'x' });
  const lines = await runtime.runCommand('查会议室 A', { role: '员工', token });
  assert.ok(lines.join('\n').includes('未注册执行器'));
  assert.ok(!audit.entries.some((e) => e.kind === '执行' && e.detail.action === 'lookupRoom'));

  const unregistered = await runtime.execStep(
    { action: 'notRegistered', args: {} }, 1,
    { role: '员工', token, command: 'x', nearfieldOnline: true },
  );
  assert.ok(unregistered.includes('工具拒绝'));
});

test('自定义出站工具：目标未在指令中 → 拒绝且不执行', async () => {
  const registry = new ToolRegistry();
  let called = 0;
  const policy = setupPolicy(registry, customDef({
    name: 'mcpSend',
    level: 'L2',
    requiredArgs: ['to'],
    sandbox: { net: 'smtp-external' },
    outbound: true,
    outboundArg: 'to',
    executor: async () => { called += 1; return 'sent'; },
  }));
  const audit = new AuditLog();
  const risk = new RiskMeter(60);
  const planner = new GuardedPlanner({
    llm: fakeLLM([{ action: 'mcpSend', args: { to: 'evil@example.com', docId: 'M2' } }]),
    audit, risk, registry,
  });
  const runtime = new AgentRuntime({ policy, audit, risk, planner, toolRegistry: registry });
  const token = new CapabilityToken({
    tools: ['mcpSend'], documentIds: ['M2'], allowedExternalDomains: ['evil.example.com'], issuedFor: 'x',
  });
  const lines = await runtime.runCommand('把纪要发出去', { role: '员工', token });
  assert.ok(lines.join('\n').includes('出站目标未获用户明确授权'));
  assert.equal(called, 0);
});

test('Agent 动态校验：传 registry+policy 接受自定义工具，静态口径拒绝', () => {
  const registry = new ToolRegistry();
  const policy = setupPolicy(registry, customDef());
  const agent = defineAgent({
    agentId: 'a1', role: '员工', allowedTools: ['lookupRoom'], documentScopes: [], modelLocation: 'local',
  }, { registry, policy });
  assert.ok(agent.allowedTools.includes('lookupRoom'));
  assert.equal(verifyAgentManifest(agent, { registry, policy }).ok, true);
  const issued = issueToken(agent, { tools: ['lookupRoom'] }, { registry, policy });
  assert.deepEqual(issued.token.tools, ['lookupRoom']);

  assert.throws(() => defineAgent({
    agentId: 'a2', role: '员工', allowedTools: ['lookupRoom'], documentScopes: [], modelLocation: 'local',
  }), /不具备的工具/);
  assert.ok(!ROLE_TOOLS['员工'].includes('lookupRoom'));
});

test('MCP 映射与 fake client；缺沙箱/批内重名 fail-closed', async () => {
  const registry = new ToolRegistry();
  const policy = new PolicyEngine();
  const client = {
    calls: [],
    async listTools() {
      return [{
        name: 'mcp_echo',
        description: 'echo',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      }];
    },
    async callTool(name, args) {
      this.calls.push({ name, args });
      return { content: [{ type: 'text', text: `echo:${args.text}` }] };
    },
  };
  const result = await registerMcpTools({
    registry, client, policy,
    defaults: {
      capability: 'MCP 测试', level: 'L1', sandbox: { local: true },
      policies: [{ role: '员工', decision: 'allow' }],
    },
  });
  assert.deepEqual(result.registered, ['mcp_echo']);
  assert.ok(registry.has('mcp_echo'));
  assert.equal(registry.get('mcp_echo').source, 'mcp');
  assert.deepEqual(registry.requiredArgs('mcp_echo'), ['text']);
  assert.equal(policy.decide('员工', 'mcp_echo'), 'allow');
  const output = await registry.get('mcp_echo').executor({ args: { text: 'hi' } });
  assert.equal(output, 'echo:hi');
  assert.deepEqual(client.calls[0], { name: 'mcp_echo', args: { text: 'hi' } });

  assert.throws(() => mcpToolToDefinition({ name: 'x', inputSchema: {} }, {}), /sandbox/);

  const dupRegistry = new ToolRegistry();
  const dupClient = {
    async listTools() {
      return [
        { name: 'dup', inputSchema: {} },
        { name: 'dup', inputSchema: {} },
      ];
    },
    async callTool() { return {}; },
  };
  await assert.rejects(
    registerMcpTools({ registry: dupRegistry, client: dupClient, defaults: { sandbox: { local: true } } }),
    /重复/,
  );
  assert.ok(!dupRegistry.has('dup'));
});

test('HTTP JSON-RPC 骨架：initialize → initialized → tools/list', async () => {
  const requests = [];
  const transport = createHttpTransport({
    url: 'http://mcp.test/rpc',
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push({ url, body, headers: options.headers });
      return {
        ok: true,
        headers: { get: () => null },
        json: async () => ({ jsonrpc: '2.0', id: body.id, result: body.method === 'tools/list' ? { tools: [] } : {} }),
      };
    },
  });
  const client = new McpClient({ transport });
  const tools = await client.listTools();
  assert.deepEqual(tools, []);
  assert.equal(requests[0].body.method, 'initialize');
  assert.equal(requests[1].body.method, 'notifications/initialized');
  assert.equal(requests[2].body.method, 'tools/list');
  assert.equal(requests[2].body.jsonrpc, '2.0');
  assert.equal(requests[2].body.params && typeof requests[2].body.params, 'object');
});

test('Console 集成：自定义工具进入 bootstrap/策略矩阵，reset 不丢', (t) => {
  const registry = new ToolRegistry();
  registry.register(customDef());
  const service = new ConsoleService({ toolRegistry: registry });
  t.after(() => service.close());

  const bootstrap = service.getBootstrap();
  assert.ok(bootstrap.tools.some((tool) => tool.name === 'lookupRoom'));
  assert.ok(bootstrap.roleTools['员工'].includes('lookupRoom'));
  const governance = service.getGovernance();
  assert.equal(governance.policy['员工'].lookupRoom, 'allow');
  assert.ok(governance.tools.some((tool) => tool.name === 'lookupRoom'));

  service.reset();
  assert.ok(service.getBootstrap().tools.some((tool) => tool.name === 'lookupRoom'));
  assert.equal(service.policy.decide('员工', 'lookupRoom'), 'allow');

  const plain = new ConsoleService();
  try {
    assert.equal(plain.getBootstrap().tools.length, 13);
    assert.equal(plain.getBootstrap().roles.length, 6);
    assert.equal(plain.getBootstrap().samples.length, 10);
  } finally {
    plain.close();
  }
});
