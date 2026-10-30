'use strict';
// MCP 真实联调：仓库内最小 server ↔ McpClient ↔ ToolRegistry
const test = require('node:test');
const assert = require('node:assert');
const { startMcpServer } = require('../mcp-server.cjs');
const { McpClient, createHttpTransport, registerMcpTools } = require('../src/mcp-adapter.cjs');
const { ToolRegistry } = require('../src/tool-registry.cjs');
const { PolicyEngine } = require('../src/governance.cjs');

test('MCP：initialize / tools/list / tools/call 真实 HTTP 链路', async (t) => {
  const started = await startMcpServer({ port: 0 });
  t.after(() => started.close());
  const transport = createHttpTransport({ url: started.url });
  const client = new McpClient({ transport });

  const init = await client.initialize();
  assert.equal(init.serverInfo.name, 'safe-office-minimal-mcp');
  const tools = await client.listTools();
  assert.ok(tools.some((x) => x.name === 'wordCount'));
  const result = await client.callTool('wordCount', { text: 'ab\nc' });
  assert.match(result.content[0].text, /字符数=4/);
});

test('MCP：注册到 ToolRegistry，策略+沙箱显式声明后 executor 可调用', async (t) => {
  const started = await startMcpServer({ port: 0 });
  t.after(() => started.close());
  const transport = createHttpTransport({ url: started.url });
  const client = new McpClient({ transport });
  const registry = new ToolRegistry();
  const policy = new PolicyEngine();

  const result = await registerMcpTools({
    registry, client, policy,
    defaults: {
      namePrefix: 'mcp_', capability: 'MCP 演示', level: 'L1',
      sandbox: { local: true }, policies: [{ role: '员工', decision: 'allow' }],
    },
  });
  assert.deepEqual(result.registered.sort(), ['mcp_echo', 'mcp_wordCount']);
  const output = await registry.get('mcp_wordCount').executor({ args: { text: 'hello' } });
  assert.match(output, /字符数=5/);
  assert.equal(policy.decide('员工', 'mcp_wordCount'), 'allow');
});

test('MCP：token 不匹配 → 401，客户端不会拿到工具', async (t) => {
  const started = await startMcpServer({ port: 0, token: 'secret-token' });
  t.after(() => started.close());
  const bad = createHttpTransport({ url: started.url });
  await assert.rejects(() => new McpClient({ transport: bad }).initialize(), /401/);

  const good = createHttpTransport({ url: started.url, headers: { 'x-mcp-token': 'secret-token' } });
  const tools = await new McpClient({ transport: good }).listTools();
  assert.ok(Array.isArray(tools));
});
