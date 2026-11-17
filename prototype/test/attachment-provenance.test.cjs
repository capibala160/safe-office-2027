'use strict';
// 附件来源闭包（2026-11-17）：上传的裸字节按内容对上已知文档，继承密级/污点；
// 机密、污点、内部级外部发送 → 冻结/发送阶段拒绝。
const test = require('node:test');
const assert = require('node:assert/strict');
const { ConsoleService } = require('../src/console-service.cjs');
const { BlobStore } = require('../src/blob-store.cjs');
const { DOCS } = require('../src/scenario.cjs');
const {
  analyzeAttachment, checkAttachmentPolicy, decodeText,
} = require('../src/attachment-provenance.cjs');

const docView = () => [
  { id: 'M1', title: '预算评审会纪要（终稿）', level: '机密', body: DOCS.M1.body },
  { id: 'M2', title: '周例会纪要（草稿）', level: '内部', body: DOCS.M2.body },
  { id: 'M3', title: '外部参会方补充材料', level: '内部', body: DOCS.M3.body },
];

function b64(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

function setup(t) {
  const blobStore = new BlobStore(':memory:');
  const service = new ConsoleService({ blobStore });
  t.after(() => { service.close(); blobStore.close(); });
  return { service, blobStore };
}

function sample(service, id) {
  const item = service.getDemoSamples().find((s) => s.id === id);
  assert.ok(item, `样例不存在：${id}`);
  return item;
}

test('整文件匹配：附件正文等于内部文档 → 继承内部级', () => {
  const entry = analyzeAttachment(
    { name: '纪要.txt', buffer: Buffer.from(DOCS.M2.body, 'utf8') },
    docView(),
  );
  assert.equal(entry.level, '内部');
  assert.equal(entry.tainted, false);
  assert.ok(entry.matched.some((m) => m.id === 'M2'), '应命中 M2');
});

test('文本匹配：附件里夹带文档前缀 → 仍能识别', () => {
  const prefix = DOCS.M2.body.replace(/\s+/g, ' ').slice(0, 80);
  const entry = analyzeAttachment(
    { name: '汇报.txt', buffer: Buffer.from(`【说明】\n${prefix}\n【附件结束】`, 'utf8') },
    docView(),
  );
  assert.equal(entry.level, '内部');
  assert.ok(entry.matched.some((m) => m.id === 'M2'));
});

test('二进制不误报：含 NUL 的附件按未分类处理', () => {
  const binary = Buffer.concat([Buffer.from('PDF'), Buffer.from([0, 1, 2, 3])]);
  assert.equal(decodeText(binary), null);
  const entry = analyzeAttachment({ name: 'scan.pdf', buffer: binary }, docView());
  assert.equal(entry.analyzed, false);
  assert.equal(entry.level, '未分类');
  assert.deepEqual(entry.matched, []);
});

test('策略：机密/污点一律拒绝；内部级仅外部发送拒绝', () => {
  const conf = analyzeAttachment({ name: 'm1.txt', buffer: Buffer.from(DOCS.M1.body, 'utf8') }, docView());
  assert.equal(checkAttachmentPolicy([conf], 'sendInternalEmail').ok, false, '机密连内网也拒绝');

  const internal = analyzeAttachment({ name: 'm2.txt', buffer: Buffer.from(DOCS.M2.body, 'utf8') }, docView());
  assert.equal(checkAttachmentPolicy([internal], 'sendExternalEmail').ok, false, '内部级禁止外部发送');
  assert.equal(checkAttachmentPolicy([internal], 'sendInternalEmail').ok, true, '内部级内网允许');

  const tainted = { name: 'tr.txt', level: '公开', tainted: true, analyzed: true, matched: [] };
  assert.equal(checkAttachmentPolicy([tainted], 'sendInternalEmail').ok, false, '污点一律拒绝');

  const unknown = analyzeAttachment({ name: 'note.txt', buffer: Buffer.from('普通会议安排，无敏感内容', 'utf8') }, docView());
  assert.equal(checkAttachmentPolicy([unknown], 'sendExternalEmail').ok, true, '未分类可发送');
});

test('集成：机密/内部附件冻结被拒，普通附件照常冻结', async (t) => {
  const { service } = setup(t);
  const item = sample(service, 'external-confirm');

  await assert.rejects(
    service.runCommand({
      ...item, role: item.role,
      attachments: [{ filename: 'leak.txt', mime: 'text/plain', contentBase64: b64(DOCS.M1.body) }],
    }),
    /机密级材料/,
    '机密附件必须拒绝冻结',
  );

  await assert.rejects(
    service.runCommand({
      ...item, role: item.role,
      attachments: [{ filename: 'leak2.txt', mime: 'text/plain', contentBase64: b64(DOCS.M2.body) }],
    }),
    /内部级材料/,
    '内部级附件外部发送必须拒绝',
  );

  const ok = await service.runCommand({
    ...item, role: item.role,
    attachments: [{ filename: 'agenda.txt', mime: 'text/plain', contentBase64: b64('议程：周一上午项目对齐') }],
  });
  const frozen = ok.operations.find((o) => o.state === 'frozen');
  assert.ok(frozen, '普通附件应正常冻结');
  assert.ok(
    service.audit.entries.some((e) => e.kind === '附件来源检查'),
    '审计应记录附件来源检查',
  );
});

test('发送前复核：冻结后才读入同内容文档 → 拒绝执行', async (t) => {
  const { service } = setup(t);
  const item = sample(service, 'external-confirm');
  const content = '议程：周一上午项目对齐';
  const run = await service.runCommand({
    ...item, role: item.role,
    attachments: [{ filename: 'agenda.txt', mime: 'text/plain', contentBase64: b64(content) }],
  });
  const frozen = run.operations.find((o) => o.state === 'frozen');
  assert.ok(frozen, '冻结时应为未分类附件');

  // 模拟冻结之后运行期才读入一份同内容内部文档
  service.runtime.knowledge.mimic = {
    id: 'mimic', title: '后来读入的内部议程', level: '内部', body: content, tainted: false,
  };
  assert.throws(
    () => service._assertAttachmentsIntact(frozen),
    /内部级材料/,
    '发送前按当前知识库复核应拒绝',
  );
});
