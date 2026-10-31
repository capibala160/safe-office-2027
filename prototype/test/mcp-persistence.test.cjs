'use strict';
// MCP 配置持久化测试（v0.39）
//   覆盖：注册落盘（含 token）、重启重连、服务不可用只记录不崩、坏文件不崩
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startMcpServer } = require('../mcp-server.cjs');
const { ConsoleService } = require('../src/console-service.cjs');

function tmpFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-office-mcp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'mcp-servers.json');
}

function normalize(url) {
  return new URL(url).toString();
}

test('注册落盘：URL / 工具 / 角色 / 级别 / token 写进配置文件', async (t) => {
  const file = tmpFile(t);
  const mcp = await startMcpServer({ port: 0, token: 'secret-token' });
  t.after(() => mcp.close());
  const service = new ConsoleService({ mcpConfigFile: file, now: () => Date.now() });
  t.after(() => service.close());

  const result = await service.registerMcp({
    url: mcp.url, token: 'secret-token', tools: ['wordCount'], roles: ['员工'], level: 'L1',
  });
  assert.equal(result.persisted, true);

  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.version, 1);
  assert.equal(saved.servers.length, 1);
  const entry = saved.servers[0];
  assert.equal(entry.url, normalize(mcp.url));
  assert.deepEqual(entry.tools, ['wordCount']);
  assert.deepEqual(entry.roles, ['员工']);
  assert.equal(entry.level, 'L1');
  assert.equal(entry.token, 'secret-token');
});

test('重启恢复：自动重连、注册表/策略/执行器都回来了（token 也用持久化的）', async (t) => {
  const file = tmpFile(t);
  const mcp = await startMcpServer({ port: 0, token: 'secret-token' });
  t.after(() => mcp.close());

  const first = new ConsoleService({ mcpConfigFile: file, now: () => Date.now() });
  t.after(() => first.close());
  await first.registerMcp({
    url: mcp.url, token: 'secret-token', tools: ['wordCount'], roles: ['员工'], level: 'L1',
  });
  first.close();

  const second = new ConsoleService({ mcpConfigFile: file, now: () => Date.now() });
  t.after(() => second.close());
  const report = await second.mcpRestorePromise;
  assert.equal(report.attempted, 1);
  assert.equal(report.restored, 1);
  assert.equal(report.failed.length, 0);
  assert.ok(second.toolRegistry.get('mcp_wordCount'));
  assert.equal(second.policy.decide('员工', 'mcp_wordCount'), 'allow');
  const output = await second.toolExecutors.get('mcp_wordCount')({ args: { text: 'hi' } });
  assert.match(output, /字符数=2/);
  assert.ok(second.audit.entries.some((e) => e.kind === 'MCP 恢复'));
});

test('服务不可用：启动不崩，记录恢复失败并留审计', async (t) => {
  const file = tmpFile(t);
  const mcp = await startMcpServer({ port: 0 });
  const first = new ConsoleService({ mcpConfigFile: file, now: () => Date.now() });
  await first.registerMcp({ url: mcp.url, tools: ['echo'], roles: ['员工'] });
  first.close();
  await mcp.close();

  const second = new ConsoleService({ mcpConfigFile: file, now: () => Date.now() });
  t.after(() => second.close());
  const report = await second.mcpRestorePromise;
  assert.equal(report.attempted, 1);
  assert.equal(report.restored, 0);
  assert.equal(report.failed.length, 1);
  assert.match(report.failed[0].error, /ECONNREFUSED|fetch failed|MCP|连接/i);
  assert.equal(second.toolRegistry.get('mcp_echo'), null);
  assert.equal(second.audit.entries.filter((e) => e.kind === 'MCP 恢复失败').length, 1);
  // 服务本身仍然可用
  assert.ok(second.getBootstrap().state);
  assert.equal(second.getGovernance().mcpRestore.failed.length, 1);
});

test('坏配置文件：解析失败不崩，记录错误并继续启动', async (t) => {
  const file = tmpFile(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ this is not json', 'utf8');
  const service = new ConsoleService({ mcpConfigFile: file, now: () => Date.now() });
  t.after(() => service.close());
  const report = await service.mcpRestorePromise;
  assert.equal(report.attempted, 0);
  assert.ok(service.mcpConfigError);
  const entry = service.audit.entries.find((e) => e.kind === 'MCP 配置加载');
  assert.ok(entry);
  assert.match(entry.detail.error, /JSON|Unexpected|property/i);
  assert.deepEqual(service.getGovernance().mcpServers, []);
});

test('不配配置文件：注册照常工作，只是不落盘', async (t) => {
  const mcp = await startMcpServer({ port: 0 });
  t.after(() => mcp.close());
  const service = new ConsoleService({ now: () => Date.now() });
  t.after(() => service.close());
  const result = await service.registerMcp({ url: mcp.url, tools: ['echo'], roles: ['员工'] });
  assert.equal(result.persisted, false);
  assert.equal(result.persistEnabled, false, '没配文件属于"未启用"，不是"落盘失败"');
  assert.equal(service.mcpConfigFile, null);
  assert.ok(service.toolRegistry.get('mcp_echo'));
});

test('保存失败：persisted:false、不留假条目、工具仍在内存、审计留痕', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-office-mcp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, 'x');
  const badFile = path.join(blocker, 'mcp.json');   // 父路径是文件 → 落盘必失败

  const mcp = await startMcpServer({ port: 0 });
  t.after(() => mcp.close());
  const service = new ConsoleService({ mcpConfigFile: badFile, now: () => Date.now() });
  t.after(() => service.close());

  const res = await service.registerMcp({ url: mcp.url, tools: ['echo'], roles: ['员工'] });
  assert.equal(res.persisted, false, '保存失败必须如实返回 false');
  assert.equal(res.persistEnabled, true);
  assert.ok(res.persistError);
  assert.ok(service.toolRegistry.get('mcp_echo'), '内存里仍然注册成功');
  assert.deepEqual(service.mcpConfig, [], '失败不留假持久化条目');
  assert.ok(service.audit.entries.some((e) => e.kind === 'MCP 配置保存失败'));
  assert.deepEqual(service.getGovernance().mcpServers, []);
});
