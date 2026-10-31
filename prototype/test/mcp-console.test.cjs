'use strict';
// MCP 控制台接入测试（v0.36）
//   覆盖：发现 → 勾选注册 → 策略矩阵生效 → executor 可调用；
//         默认拒绝、只许回环、重名冲突、reset 后仍在、HTTP 管理员权限
const test = require('node:test');
const assert = require('node:assert/strict');
const { startMcpServer } = require('../mcp-server.cjs');
const { ConsoleService } = require('../src/console-service.cjs');
const { startServer } = require('../server.cjs');
const { AuthService, hashPassword } = require('../src/auth.cjs');

async function boot(t) {
  const mcp = await startMcpServer({ port: 0 });
  t.after(() => mcp.close());
  const service = new ConsoleService({ now: () => Date.now() });
  t.after(() => service.close());
  return { mcp, service };
}

test('MCP 控制台：发现工具 → 勾选注册 → 角色策略生效 → executor 可调用', async (t) => {
  const { mcp, service } = await boot(t);

  const discovered = await service.discoverMcp({ url: mcp.url, by: 'admin' });
  assert.equal(discovered.ok, true);
  assert.ok(discovered.server && discovered.server.name);
  assert.deepEqual(discovered.tools.map((x) => x.name).sort(), ['echo', 'wordCount']);
  assert.equal(service.audit.entries.at(-1).kind, 'MCP 发现');
  assert.equal(service.audit.entries.at(-1).actor, 'admin');

  const registered = await service.registerMcp({
    url: mcp.url,
    tools: ['wordCount'],
    roles: ['员工'],
    level: 'L1',
    by: 'admin',
  });
  assert.deepEqual(registered.registered, ['mcp_wordCount']);

  // 注册表与策略矩阵
  const tools = service.getGovernance().tools;
  const added = tools.find((x) => x.name === 'mcp_wordCount');
  assert.ok(added, '工具注册表里能看到 MCP 工具');
  assert.equal(added.source, 'mcp');
  assert.equal(service.policy.decide('员工', 'mcp_wordCount'), 'allow');
  assert.equal(service.policy.decide('审计员', 'mcp_wordCount'), 'deny', '未声明角色默认拒绝');

  // executor 走真实 HTTP 回调
  const output = await service.toolExecutors.get('mcp_wordCount')({ args: { text: 'hello' } });
  assert.match(output, /字符数=5/);

  const entry = service.audit.entries.find((e) => e.kind === 'MCP 注册');
  assert.ok(entry);
  assert.deepEqual(entry.detail.tools, ['mcp_wordCount']);
  assert.equal(entry.actor, 'admin');
  assert.equal(service.audit.verify(), true);
});

test('MCP 控制台：未选角色/未选工具/重名/非回环地址一律拒绝', async (t) => {
  const { mcp, service } = await boot(t);

  await assert.rejects(
    () => service.registerMcp({ url: mcp.url, tools: ['echo'], roles: [] }),
    /至少选择一个允许角色/,
  );
  await assert.rejects(
    () => service.registerMcp({ url: mcp.url, tools: [], roles: ['员工'] }),
    /至少勾选一个/,
  );
  await assert.rejects(
    () => service.registerMcp({ url: mcp.url, tools: ['echo'], roles: ['不存在角色'] }),
    /未知角色/,
  );
  await assert.rejects(
    () => service.discoverMcp({ url: 'http://evil.example.com/mcp' }),
    /只允许回环地址/,
  );
  await assert.rejects(
    () => service.discoverMcp({ url: 'ftp://127.0.0.1/x' }),
    /只支持 http\/https/,
  );
  await assert.rejects(
    () => service.discoverMcp({ url: 'http://127.0.0.1:1/mcp', timeoutMs: 500 }),
    /连接 MCP 失败/,
  );

  await service.registerMcp({ url: mcp.url, tools: ['echo'], roles: ['管理员'] });
  await assert.rejects(
    () => service.registerMcp({ url: mcp.url, tools: ['echo'], roles: ['管理员'] }),
    /已注册/,
  );
  await assert.rejects(
    () => service.registerMcp({ url: mcp.url, tools: ['missing'], roles: ['管理员'] }),
    /不存在|缺少工具/,
  );
});

test('MCP 控制台：reset 后已注册工具与执行器仍在', async (t) => {
  const { mcp, service } = await boot(t);
  await service.registerMcp({ url: mcp.url, tools: ['wordCount'], roles: ['员工'], level: 'L1' });
  service.reset();
  assert.ok(service.toolRegistry.get('mcp_wordCount'), '注册表保留');
  assert.equal(service.policy.decide('员工', 'mcp_wordCount'), 'allow', '策略重新应用');
  const output = await service.toolExecutors.get('mcp_wordCount')({ args: { text: 'ab' } });
  assert.match(output, /字符数=2/);
});

test('MCP 接口：员工 403，管理员可发现与注册', async (t) => {
  const mcp = await startMcpServer({ port: 0 });
  t.after(() => mcp.close());
  const mk = (username, role) => {
    const { salt, hash } = hashPassword('password123');
    return { username, role, salt, hash };
  };
  const auth = new AuthService({ users: [mk('emp', '员工'), mk('admin', '管理员')] });
  const started = await startServer({ port: 0, auth });
  t.after(() => started.close());
  const cookie = (name) => `sfc_session=${auth.login(name, 'password123').token}`;
  const call = (name, path, body) => fetch(`${started.url}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie(name) },
    body: JSON.stringify(body),
  });

  assert.equal((await call('emp', '/api/mcp/discover', { url: mcp.url })).status, 403);
  assert.equal((await call('emp', '/api/mcp/register', { url: mcp.url, tools: ['echo'], roles: ['员工'] })).status, 403);

  const discovered = await call('admin', '/api/mcp/discover', { url: mcp.url });
  assert.equal(discovered.status, 200);
  assert.equal((await discovered.json()).tools.length, 2);

  const registered = await call('admin', '/api/mcp/register', {
    url: mcp.url, tools: ['echo'], roles: ['员工'], level: 'L1',
  });
  assert.equal(registered.status, 200);
  assert.deepEqual((await registered.json()).registered, ['mcp_echo']);

  const gov = await fetch(`${started.url}/api/governance`, { headers: { Cookie: cookie('admin') } });
  const data = await gov.json();
  assert.ok(data.tools.some((x) => x.name === 'mcp_echo' && x.source === 'mcp'));
});
