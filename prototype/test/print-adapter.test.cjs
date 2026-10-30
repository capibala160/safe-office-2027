'use strict';
// 真实打印适配器：提交打印队列 / 未配置则模拟 / 明确失败分类
const test = require('node:test');
const assert = require('node:assert');
const { printText } = require('../src/print-adapter.cjs');
const { ConsoleService } = require('../src/console-service.cjs');
const { MailerError } = require('../src/mailer.cjs');

function fakeExec({ fail = false, stderr = '' } = {}) {
  const calls = [];
  const fn = (cmd, args, options, cb) => {
    calls.push({ cmd, args, options });
    if (fail) cb(new Error('spawn failed'), '', stderr);
    else cb(null, 'ok', '');
  };
  return { fn, calls };
}

test('打印：配置打印机时用 PowerShell Out-Printer，返回 printed', async () => {
  const exec = fakeExec();
  const result = await printText({
    text: '周例会纪要', title: '周例会纪要', printer: 'HP LaserJet MFP M232-M237', exec: exec.fn,
  });
  assert.equal(result.mode, 'printed');
  assert.equal(exec.calls.length, 1);
  assert.equal(exec.calls[0].options.env.SAFE_PRINT_NAME, 'HP LaserJet MFP M232-M237');
  assert.ok(exec.calls[0].options.env.SAFE_PRINT_FILE);
});

test('打印：未配置打印机 → simulated，不执行 PowerShell', async () => {
  const exec = fakeExec();
  const result = await printText({ text: 'x', printer: null, exec: exec.fn });
  assert.equal(result.mode, 'simulated');
  assert.equal(exec.calls.length, 0);
});

test('打印：打印机无效 → rejected；队列异常 → 不确定', async () => {
  const notFound = await printText({ text: 'x', printer: 'NOPE', exec: fakeExec({ fail: true, stderr: 'printer not found' }).fn });
  assert.equal(notFound.mode, 'failed');
  assert.equal(notFound.rejected, true);

  const other = await printText({ text: 'x', printer: 'P', exec: fakeExec({ fail: true, stderr: 'spooler timeout' }).fn });
  assert.equal(other.mode, 'failed');
  assert.equal(other.rejected, false);
});

test('控制台：打印动作调用真实适配器并记录模式', async (t) => {
  const calls = [];
  const adapter = async ({ text, title, printer }) => {
    calls.push({ text, title, printer });
    return { mode: 'printed', printer };
  };
  const service = new ConsoleService({ printer: 'P1', printAdapter: adapter });
  t.after(() => service.close());
  service.runtime.knowledge.M2 = { id: 'M2', title: '周例会纪要', cleaned: '正文' };

  await service._applyBusinessAction({
    protocolAction: 3, operationId: 'op', recipient: 'M2', subject: '发送：周例会纪要',
    body: '冻住的正文',
  });
  assert.deepEqual(calls[0], { text: '冻住的正文', title: '周例会纪要', printer: 'P1' });
  assert.equal(service.business.printJobs[0].mode, 'printed');
});

test('控制台：打印机明确失败 → MailerError rejected', async (t) => {
  const service = new ConsoleService({
    printer: 'P1',
    printAdapter: async () => ({ mode: 'failed', printer: 'P1', error: 'printer not found', rejected: true }),
  });
  t.after(() => service.close());
  await assert.rejects(
    () => service._applyBusinessAction({ protocolAction: 3, operationId: 'op', recipient: 'M2', body: 'x' }),
    (err) => err instanceof MailerError && err.kind === 'rejected',
  );
});

test('删除：导入资料真正从 DocumentStore 删除，不会重启复活', async (t) => {
  const { DocumentStore } = require('../src/ingest.cjs');
  const store = new DocumentStore(':memory:');
  const doc = {
    id: 'IMP-TEST', title: '待删资料', level: '内部', body: 'x',
    sourcePath: 'test.txt', sha256: 'a'.repeat(64), importedAt: new Date().toISOString(),
  };
  store.upsert(doc);
  const service = new ConsoleService({ documentsStore: store });
  t.after(() => { service.close(); store.close(); });
  assert.ok(store.get('IMP-TEST'));
  await service._applyBusinessAction({ protocolAction: 2, operationId: 'op', recipient: 'IMP-TEST' });
  assert.equal(store.get('IMP-TEST'), null, '库里必须真删');
});
