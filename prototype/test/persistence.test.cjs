'use strict';
// v0.15 持久化 / 模型注入 / 工作区版本号
//   覆盖：文件库重启恢复、在途 sending→unknown、审计链恢复与篡改拒绝、重置清盘、在途结果作废
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ConsoleService } = require('../src/console-service.cjs');
const { AuditLog } = require('../src/governance.cjs');
const { createLlmFromEnv, MockLLM, HttpLLM } = require('../src/llm.cjs');

const EXTERNAL = {
  command: '把周例会纪要发给外部参会方 partner@partner-example.com',
  role: '员工',
  tools: ['readDoc', 'sendExternalEmail'],
  documentIds: ['M2'],
  domains: ['partner-example.com'],
};

// 临时工作区：清理前先关掉本用例开过的服务，否则 Windows 上 SQLite 文件占用会让 rm 报 EPERM
function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-office-'));
  const opened = [];
  t.after(() => {
    for (const service of opened) {
      try { service.close(); } catch { /* 已关闭 */ }
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* Windows 偶发占用：留给系统临时目录清理 */ }
  });
  const files = { store: path.join(dir, 'ops.db'), audit: path.join(dir, 'audit.json') };
  return {
    dir,
    files,
    open(options = {}) {
      const service = new ConsoleService({ storeFile: files.store, auditFile: files.audit, ...options });
      opened.push(service);
      return service;
    },
  };
}

test('文件库：重启后冻结操作与审计链都还在', async (t) => {
  const ws = workspace(t);

  const first = ws.open();
  const run = await first.runCommand(EXTERNAL);
  assert.equal(run.ok, true);
  assert.ok(run.operations.length > 0, '应冻结一条外发操作');
  const operationId = run.operations[0].operationId;
  const auditCount = first.audit.entries.length;
  first.close();

  const second = ws.open();
  const restored = second.store.getOperation(operationId);
  assert.ok(restored, '重启后操作记录应还在');
  assert.equal(restored.state, 'frozen');
  assert.equal(second.audit.entries.length, auditCount, '审计条目数应一致');
  assert.equal(second.audit.verify(), true, '恢复后的审计链必须自校验通过');
});

test('审计篡改：检查点不匹配 → 拒绝恢复，从新链开始并留痕', async (t) => {
  const ws = workspace(t);

  const first = ws.open();
  await first.runCommand(EXTERNAL);
  first.close();

  // 新格式为 JSONL：一行一条；篡改第一条后检查点必然对不上
  const lines = fs.readFileSync(ws.files.audit, 'utf8').trim().split('\n');
  const entries = lines.map((line) => JSON.parse(line));
  entries[0].detail = { ...entries[0].detail, tampered: true };
  fs.writeFileSync(ws.files.audit, `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf8');

  const second = ws.open();
  assert.equal(second.audit.entries.length, 1);
  assert.equal(second.audit.entries[0].kind, '审计恢复失败');
  assert.equal(second.audit.verify(), true, '新链自身应可校验');
});

test('重启恢复：上次发送中的记录转 unknown，禁止自动重试', async (t) => {
  const ws = workspace(t);

  const first = ws.open();
  const run = await first.runCommand(EXTERNAL);
  const operation = first.store.getOperation(run.operations[0].operationId);
  const confirmed = first.fulfillment.confirm(operation.operationId, {
    confirmedHash: operation.operationHash,
    confirmationId: 'test-confirm',
    deviceId: 'test-device',
  });
  first.store.setOutboxState(confirmed.outbox.outboxId, 'sending');
  first.close();

  const second = ws.open();
  const recovered = second.store.getOutbox(confirmed.outbox.outboxId);
  assert.equal(recovered.state, 'unknown');
  assert.match(recovered.lastError || '', /待核实/);
  assert.equal(second.recoveredInFlight, 1);
  assert.ok(second.audit.entries.some((e) => e.kind === '恢复'), '恢复动作要留审计');

  // unknown 不能被自动重试，只能人工核对
  const again = await second.fulfillment.send(confirmed.outbox.outboxId);
  assert.equal(again.state, 'unknown');
  assert.equal(again.note, '结果待核实，禁止自动重试');
});

test('文件模式重置：库与审计一并清空，旧操作不会复活', async (t) => {
  const ws = workspace(t);

  const service = ws.open();
  const run = await service.runCommand(EXTERNAL);
  const operationId = run.operations[0].operationId;
  service.reset();

  assert.equal(service.store.listOperations().length, 0);
  service.close();

  const reopened = ws.open();
  assert.equal(reopened.store.getOperation(operationId), null);
  assert.equal(reopened.audit.entries.length, 0);
});

test('工作区版本号：重置发生在运行途中 → 这一轮结果整轮作废', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  class SlowLLM {
    deployment = 'local';
    async plan() {
      await gate;
      return [{ action: 'readDoc', args: { id: 'M1' } }];
    }
    async generate() { return '正文'; }
  }

  const service = new ConsoleService({ llm: new SlowLLM() });
  t.after(() => { try { service.close(); } catch { /* ignore */ } });
  const pending = service.runCommand({
    command: '把周例会纪要发给我自己看看', role: '员工', tools: ['readDoc'], documentIds: ['M1'],
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  service.reset();
  release();

  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.stale, true);
  assert.equal(result.reason, 'RESET_DURING_RUN');
  assert.equal(service.store.listOperations().length, 0, '作废的运行不能写入新工作区');
  assert.equal(service.runs.length, 0, '作废的运行不能进运行列表');
});

test('模型注入：控制台如实报告注入的实现，不冒充 MockLLM', async () => {
  class FakeLLM {
    deployment = 'local';
    async plan() { return [{ action: 'readDoc', args: { id: 'M1' } }]; }
    async generate() { return '正文'; }
  }
  const service = new ConsoleService({ llm: new FakeLLM() });
  try {
    const state = service.getState();
    assert.equal(state.model.name, 'FakeLLM');
    assert.equal(state.model.location, 'local');
    assert.equal(state.model.mode, 'FakeLLM（演示）');
  } finally {
    service.close();
  }
});

test('模型选择：没配端点密钥退回 MockLLM，配了就走 HttpLLM', () => {
  const offline = createLlmFromEnv({});
  assert.ok(offline instanceof MockLLM);
  assert.equal(offline.deployment, 'local');

  const online = createLlmFromEnv({
    SAFE_OFFICE_LLM_ENDPOINT: 'https://llm.example.com/v1',
    SAFE_OFFICE_LLM_KEY: 'test-key',
    SAFE_OFFICE_LLM_MODEL: 'test-model',
  });
  assert.ok(online instanceof HttpLLM);
  assert.equal(online.deployment, 'cloud');
  assert.equal(online.model, 'test-model');
  assert.equal(online.timeoutMs, 60000, '带推理的模型默认给 60s');

  const timed = createLlmFromEnv({
    SAFE_OFFICE_LLM_ENDPOINT: 'https://llm.example.com/v1',
    SAFE_OFFICE_LLM_KEY: 'test-key',
    SAFE_OFFICE_LLM_TIMEOUT_MS: '9000',
  });
  assert.equal(timed.timeoutMs, 9000, '超时可用环境变量覆盖');
});

test('审计增量落盘：新事件只追加，不改写已有内容', async (t) => {
  const ws = workspace(t);
  const service = ws.open();
  await service.runCommand({
    command: '查一下张伟的联系方式', role: '员工', tools: ['readContact'], documentIds: [],
  });
  const before = fs.readFileSync(ws.files.audit, 'utf8');
  await service.runCommand({
    command: '查一下李娜的联系方式', role: '员工', tools: ['readContact'], documentIds: [],
  });
  const after = fs.readFileSync(ws.files.audit, 'utf8');
  assert.ok(after.startsWith(before), '已有审计内容不能被重写');
  const lines = after.trim().split('\n').length;
  assert.equal(lines, service.audit.entries.length, '一行一条，与内存条目一致');
});

test('旧版整体 JSON 审计：首次写入迁移为 JSONL 且不丢历史', async (t) => {
  const ws = workspace(t);
  const legacy = new AuditLog();
  legacy.append('历史事件', { note: 'legacy' });
  const checkpoint = legacy.save(ws.files.audit);
  fs.writeFileSync(`${ws.files.audit}.head`, JSON.stringify(checkpoint), 'utf8');

  const service = ws.open();
  await service.runCommand({
    command: '查一下张伟的联系方式', role: '员工', tools: ['readContact'], documentIds: [],
  });
  service.close();

  const raw = fs.readFileSync(ws.files.audit, 'utf8');
  assert.ok(!raw.trim().startsWith('{"entries"'), '应已迁移为 JSONL');
  const entries = AuditLog.readFile(ws.files.audit);
  assert.equal(entries[0].kind, '历史事件');
  assert.ok(entries.length > 1, '新事件应追加在后面');
  const reopened = ws.open();
  assert.ok(reopened.audit.entries.some((e) => e.kind === '历史事件'), '重启后历史仍在');
});
