'use strict';
// v0.16 真实资料导入：解析 / 存储 / 并入控制台文档视图
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { DocumentStore, parseFile, importFile, removeFile, docxToText } = require('../src/ingest.cjs');
const { ConsoleService } = require('../src/console-service.cjs');
const { clearIngestedDocuments } = require('../src/scenario.cjs');

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-office-doc-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 偶发占用 */ } });
  return dir;
}

// 造一个最小 docx（zip + deflate），只够被测解析器读取
function buildZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = zlib.deflateRawSync(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);          // deflate
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const count = Object.keys(files).length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(count, 8);
  eocd.writeUInt16LE(count, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

function writeDocx(file, paragraphs) {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('');
  const xml = `<?xml version="1.0" encoding="UTF-8"?><w:document><w:body>${body}</w:body></w:document>`;
  fs.writeFileSync(file, buildZip({ 'word/document.xml': Buffer.from(xml, 'utf8') }));
}

test('解析：.md 取首行当标题，正文完整', (t) => {
  const dir = tmpdir(t);
  const file = path.join(dir, '周会.md');
  fs.writeFileSync(file, '# 周四品牌改稿评审\n\n1. 补一页包装延展\n2. 周五前给最终报价\n', 'utf8');
  const parsed = parseFile(file);
  assert.equal(parsed.title, '周四品牌改稿评审');
  assert.match(parsed.body, /包装延展/);
});

test('解析：.docx 走最小 ZIP 解析抽出正文', (t) => {
  const dir = tmpdir(t);
  const file = path.join(dir, '纪要.docx');
  writeDocx(file, ['周例会纪要', '决议：下周一开工', '对接人 张工']);
  const parsed = parseFile(file);
  assert.equal(parsed.title, '周例会纪要');
  assert.match(parsed.body, /下周一开工/);
  assert.match(parsed.body, /张工/);
});

test('解析：不支持的格式明确拒绝', (t) => {
  const dir = tmpdir(t);
  const file = path.join(dir, '表格.xlsx');
  fs.writeFileSync(file, 'not really excel');
  assert.throws(() => parseFile(file), /暂不支持/);
});

test('docx：缺少 document.xml → 明确报错', () => {
  const zip = buildZip({ 'word/styles.xml': Buffer.from('<x/>') });
  assert.throws(() => docxToText(zip), /找不到 word\/document\.xml/);
});

test('存储：同一文件重复导入不会产生副本；密级必须白名单', (t) => {
  const dir = tmpdir(t);
  const file = path.join(dir, 'note.txt');
  fs.writeFileSync(file, '会议纪要正文：下周交付', 'utf8');
  const store = new DocumentStore(':memory:');
  t.after(() => store.close());

  const first = importFile(store, file, { level: '内部' });
  const again = importFile(store, file, { level: '机密' });
  assert.equal(again.id, first.id, 'id 由内容哈希派生，同一文件是同一个 id');
  assert.equal(again.level, '机密', '再次导入可改密级');
  assert.equal(store.list().length, 1);

  assert.throws(() => importFile(store, file, { level: '绝密' }), /密级/);
  assert.throws(() => importFile(store, file, { level: undefined }), /密级/);
});

test('存储：落盘后重开仍在；删除生效', (t) => {
  const dir = tmpdir(t);
  const dbFile = path.join(dir, 'docs.db');
  const file = path.join(dir, 'note.md');
  fs.writeFileSync(file, '# 归档说明\n需要保留三个月', 'utf8');

  const store = new DocumentStore(dbFile);
  const doc = importFile(store, file, { level: '公开' });
  store.close();

  const reopened = new DocumentStore(dbFile);
  t.after(() => reopened.close());
  assert.equal(reopened.list().length, 1);
  assert.match(reopened.get(doc.id).body, /三个月/);
  assert.equal(removeFile(reopened, doc.id), true);
  assert.equal(reopened.get(doc.id), null);
});

test('控制台：导入的资料出现在文档面板，且能被角色授权读取', async (t) => {
  const dir = tmpdir(t);
  const file = path.join(dir, '导入纪要.md');
  fs.writeFileSync(file, '# 供应商沟通纪要\n价格与交期已确认，下周签约。', 'utf8');

  const store = new DocumentStore(':memory:');
  const doc = importFile(store, file, { level: '内部' });
  let planned = false;
  class ReadImported {
    deployment = 'local';
    async plan() {
      planned = true;
      return [{ action: 'readDoc', args: { id: doc.id } }];
    }
    async generate() { return '正文'; }
  }
  const service = new ConsoleService({ documentsStore: store, llm: new ReadImported() });
  t.after(() => {
    service.close();
    store.close();
    clearIngestedDocuments();
  });

  const listed = service.listDocuments().find((item) => item.id === doc.id);
  assert.ok(listed, '文档面板应包含导入的资料');
  assert.equal(listed.title, '供应商沟通纪要');

  const run = await service.runCommand({
    command: '读一下导入的供应商纪要', role: '员工', tools: ['readDoc'], documentIds: [doc.id],
  });
  assert.equal(run.ok, true);
  assert.equal(planned, true);
  assert.ok(service.runtime.knowledge[doc.id], '导入资料应能被授权读取并进入知识库');
  assert.equal(service.runtime.knowledge[doc.id].level, '内部');
});

test('控制台：没导入时文档数保持样例数量（默认不受影响）', () => {
  const service = new ConsoleService();
  try {
    assert.equal(service.listDocuments().filter((d) => d.id.startsWith('IMP-')).length, 0);
  } finally {
    service.close();
  }
});

// ---------- 浏览器上传接口 ----------
async function bootServer(t, store) {
  const { startServer } = require('../server.cjs');
  const started = await startServer({ port: 0, documentsStore: store });
  t.after(() => started.close());
  return started;
}

function upload(server, payload) {
  return fetch(`${server.url}/api/documents/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

test('上传：合法 md 导入后立刻出现在文档面板', async (t) => {
  const store = new DocumentStore(':memory:');
  const server = await bootServer(t, store);
  t.after(() => clearIngestedDocuments());

  const content = Buffer.from('# 供应商沟通纪要\n价格 12 万，下周签约。', 'utf8');
  const res = await upload(server, {
    filename: '供应商沟通纪要.md', level: '内部', contentBase64: content.toString('base64'),
  });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.match(body.document.id, /^IMP-/);

  const docs = await (await fetch(`${server.url}/api/documents`)).json();
  assert.ok(docs.items.some((item) => item.id === body.document.id), '导入后应立刻可见，不用重启');
  assert.equal(docs.items.find((item) => item.id === body.document.id).level, '内部');
});

test('上传：不合规的文件一律 400，且不落库', async (t) => {
  const store = new DocumentStore(':memory:');
  const server = await bootServer(t, store);
  t.after(() => clearIngestedDocuments());

  const cases = [
    [{ filename: '工具.exe', level: '内部', contentBase64: Buffer.from('MZ').toString('base64') }, /暂不支持/],
    [{ filename: '假docx.docx', level: '内部', contentBase64: Buffer.from('hello').toString('base64') }, /不是 ZIP/],
    [{ filename: '二进制.txt', level: '内部', contentBase64: Buffer.from([0x61, 0x00, 0x62]).toString('base64') }, /NUL/],
    [{ filename: '纪要.md', contentBase64: Buffer.from('# x').toString('base64') }, /密级/],
    [{ filename: '纪要.md', level: '内部', contentBase64: '!!!!' }, /base64/],
  ];
  for (const [payload, pattern] of cases) {
    const res = await upload(server, payload);
    const body = await res.json();
    assert.equal(res.status, 400, `${payload.filename} 应被拒：${JSON.stringify(body)}`);
    assert.match(body.error.message, pattern, JSON.stringify(body));
  }
  assert.equal(store.list().length, 0, '被拒绝的文件不能落库');
});

// ---------- 压缩炸弹防线 ----------
test('压缩炸弹：声明解压后超限 → 拒绝解析', () => {
  const big = Buffer.alloc(11 * 1024 * 1024, 0x61);
  const zip = buildZip({ 'word/document.xml': big });
  assert.throws(() => docxToText(zip), /压缩炸弹/);
});

test('压缩炸弹：谎报声明大小 → 解压时被硬性截断', () => {
  const big = Buffer.alloc(11 * 1024 * 1024, 0x61);
  const zip = buildZip({ 'word/document.xml': big });
  // 把声明大小改成 100 字节，看解压阶段能不能兜住
  zip.writeUInt32LE(100, 22);
  const central = zip.readUInt32LE(zip.length - 22 + 16);
  zip.writeUInt32LE(100, central + 24);

  assert.throws(() => docxToText(zip), /压缩炸弹|超出上限/);
});

test('ZIP 条目过多 → 拒绝解析', () => {
  const files = {};
  for (let i = 0; i < 201; i += 1) files[`part${i}.xml`] = Buffer.from('<x/>');
  const zip = buildZip(files);
  assert.throws(() => docxToText(zip), /条目过多/);
});
