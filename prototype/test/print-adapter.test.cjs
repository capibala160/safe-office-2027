'use strict';
// 真实打印适配器：提交打印队列 / 未配置则模拟 / 明确失败分类
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  printText, printDocument, buildPrintHtml, findEdge,
} = require('../src/print-adapter.cjs');
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

// ---------- v0.40 排版打印（HTML → PDF → 可选打印） ----------
function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-office-print-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakePrintExec({ submitFail = false, submitStderr = '' } = {}) {
  const calls = [];
  const fn = (cmd, args, options, cb) => {
    calls.push({ cmd, args, options });
    if (cmd === 'powershell.exe') {
      if (submitFail) cb(new Error('submit failed'), '', submitStderr);
      else cb(null, 'ok', '');
      return;
    }
    // 冒充 Edge：把 --print-to-pdf 指定的文件写出来
    const arg = args.find((a) => a.startsWith('--print-to-pdf='));
    const file = arg.slice('--print-to-pdf='.length);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '%PDF-1.4 fake');
    cb(null, '', '');
  };
  return { fn, calls };
}

test('排版 HTML：标题/密级/操作人转义，正文逐行成段', () => {
  const html = buildPrintHtml({
    title: '<周报&评审>', text: '第一行\n第二行 <script>', level: '内部', operator: 'alice',
    at: '2026-10-31T10:00:00.000Z',
  });
  assert.match(html, /<h1>&lt;周报&amp;评审&gt;<\/h1>/);
  assert.match(html, /第一行<\/p>/);
  assert.match(html, /第二行 &lt;script&gt;<\/p>/);
  assert.match(html, /密级 <span class="level">内部<\/span>/);
  assert.match(html, /操作人 alice/);
  assert.ok(!html.includes('<script>'));
});

test('排版打印：未配置打印机和 PDF 目录 → simulated，不碰 Edge', async () => {
  const exec = fakePrintExec();
  const result = await printDocument({ text: 'x', exec: exec.fn });
  assert.equal(result.mode, 'simulated');
  assert.equal(exec.calls.length, 0);
});

test('排版打印：只配 PDF 目录 → 生成 PDF（pdf 模式）', async (t) => {
  const dir = tmpDir(t);
  const exec = fakePrintExec();
  const result = await printDocument({
    // 显式给假 Edge：本用例只验证 PDF 路径与参数，不应依赖宿主机装了 Edge
    text: '正文', title: '周报', level: '内部', operator: 'alice', pdfDir: dir,
    edgePath: 'msedge-fake', exec: exec.fn,
  });
  assert.equal(result.mode, 'pdf');
  assert.ok(result.file && fs.existsSync(result.file));
  assert.match(path.basename(result.file), /^print-.*-[0-9a-f]{8}\.pdf$/);
  assert.equal(exec.calls.length, 1);
  assert.match(exec.calls[0].args.join(' '), /--headless=new/);
});

test('排版打印：配了打印机 → 先渲染 PDF 再 PrintTo，返回 printed', async (t) => {
  const dir = tmpDir(t);
  const exec = fakePrintExec();
  const result = await printDocument({
    text: '正文', title: '周报', printer: 'P1', pdfDir: dir,
    edgePath: 'msedge-fake', exec: exec.fn,
  });
  assert.equal(result.mode, 'printed');
  assert.equal(exec.calls.length, 2);
  assert.equal(exec.calls[1].cmd, 'powershell.exe');
  assert.equal(exec.calls[1].options.env.SAFE_PRINT_NAME, 'P1');
  assert.ok(fs.existsSync(exec.calls[1].options.env.SAFE_PRINT_PDF));
});

test('排版打印：打印机无效 → failed/rejected，PDF 仍保留', async (t) => {
  const dir = tmpDir(t);
  const exec = fakePrintExec({ submitFail: true, submitStderr: 'printer not found' });
  const result = await printDocument({
    text: 'x', title: 't', printer: 'NOPE', pdfDir: dir,
    edgePath: 'msedge-fake', exec: exec.fn,
  });
  assert.equal(result.mode, 'failed');
  assert.equal(result.rejected, true);
  assert.ok(result.file && fs.existsSync(result.file));
});

test('排版打印：找不到 Edge → 明确失败', async (t) => {
  const dir = tmpDir(t);
  const exec = fakePrintExec();
  const result = await printDocument({
    text: 'x', printer: 'P1', pdfDir: dir, edgePath: null, exec: exec.fn,
  });
  assert.equal(result.mode, 'failed');
  assert.match(result.error, /未找到 Edge/);
  assert.equal(exec.calls.length, 0);
});

test('真实 Edge：渲染一页 PDF 到磁盘', {
  skip: (process.env.SAFE_OFFICE_TEST_EDGE === '1' && findEdge())
    ? false
    : '默认跳过真实 Edge 渲染（SAFE_OFFICE_TEST_EDGE=1 且存在 Edge 时运行）',
}, async (t) => {
  const dir = tmpDir(t);
  const result = await printDocument({
    text: '真实 Edge 渲染测试\n第二行', title: 'PDF 冒烟', level: '公开', operator: 'tester',
    pdfDir: dir,
  });
  assert.equal(result.mode, 'pdf');
  assert.ok(fs.existsSync(result.file));
  const head = fs.readFileSync(result.file).subarray(0, 5).toString('latin1');
  assert.equal(head, '%PDF-');
});
