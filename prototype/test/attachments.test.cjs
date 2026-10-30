'use strict';
// v0.16 附件链路：冻结记录带附件 → 执行前重算内容哈希 → 批准后可下载
const test = require('node:test');
const assert = require('node:assert/strict');
const { ConsoleService } = require('../src/console-service.cjs');
const { BlobStore } = require('../src/blob-store.cjs');
const { verifyOperation } = require('../src/operation.cjs');

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

async function freezeExternal(service, attachments) {
  const item = sample(service, 'external-confirm');
  const run = await service.runCommand({ ...item, role: item.role, attachments });
  const operation = run.operations.find((o) => o.state === 'frozen');
  assert.ok(operation, '外发样例应冻结一条操作');
  return { run, operation };
}

const ATTACHMENT = {
  filename: '会议纪要.pdf', mime: 'application/pdf', contentBase64: b64('PDF-CONTENT-123'),
};

test('冻结：邮件操作带上附件元数据，且哈希进入冻结记录', async (t) => {
  const { service } = setup(t);
  const { operation } = await freezeExternal(service, [ATTACHMENT]);

  assert.equal(operation.attachments.length, 1);
  assert.equal(operation.attachments[0].name, '会议纪要.pdf');
  assert.equal(operation.attachments[0].size, Buffer.byteLength('PDF-CONTENT-123'));
  assert.match(operation.attachments[0].sha256, /^[0-9a-f]{64}$/);

  const stored = service.store.getOperation(operation.operationId);
  assert.deepEqual(stored.attachmentHashes, stored.attachments);
  assert.equal(verifyOperation(stored).ok, true);

  // 改附件元数据 → 冻结记录校验失败
  const tampered = { ...stored, attachments: [{ ...stored.attachments[0], name: '换了个名字.pdf' }] };
  assert.equal(verifyOperation(tampered).ok, false);
});

test('冻结：非邮件操作不带附件，也不留下孤儿内容', async (t) => {
  const { service, blobStore } = setup(t);
  const item = sample(service, 'bulk-delete');
  const run = await service.runCommand({ ...item, role: item.role, attachments: [ATTACHMENT] });
  assert.ok(run.operations.length > 0);
  for (const operation of run.operations) {
    assert.deepEqual(operation.attachments, [], `${operation.action} 不该带附件`);
  }
  const blobs = blobStore.db.prepare('SELECT COUNT(*) AS n FROM blobs').get().n;
  assert.equal(blobs, 0, '没有邮件动作时附件不应落库');
  assert.ok(run.lines.some((line) => line.includes('未落库')), '应明确告知附件未使用');
  assert.ok(service.audit.entries.some((e) => e.kind === '附件未使用'));
});

test('附件校验失败：不写库、不留孤儿', async (t) => {
  const { service, blobStore } = setup(t);
  const item = sample(service, 'external-confirm');
  await assert.rejects(
    () => service.runCommand({
      ...item, role: item.role,
      attachments: [{ filename: '坏文件.pdf', mime: 'application/pdf', contentBase64: '!!!' }],
    }),
    /contentBase64 非法/,
  );
  const blobs = blobStore.db.prepare('SELECT COUNT(*) AS n FROM blobs').get().n;
  assert.equal(blobs, 0);
});

test('执行：附件内容被篡改 → 拒绝发送', async (t) => {
  const { service, blobStore } = setup(t);
  const { operation } = await freezeExternal(service, [ATTACHMENT]);
  const stored = service.store.getOperation(operation.operationId);
  service.fulfillment.confirm(operation.operationId, {
    confirmedHash: stored.operationHash, confirmationId: 'test', deviceId: 'test-device',
  });

  blobStore.db.prepare('UPDATE blobs SET content = ? WHERE sha256 = ?')
    .run(Buffer.from('EVIL CONTENT', 'utf8'), stored.attachments[0].sha256);

  await assert.rejects(() => service.sendOperation(operation.operationId), /内容与冻结记录不符/);
});

test('执行：附件内容缺失 → 拒绝发送', async (t) => {
  const { service, blobStore } = setup(t);
  const { operation } = await freezeExternal(service, [ATTACHMENT]);
  const stored = service.store.getOperation(operation.operationId);
  service.fulfillment.confirm(operation.operationId, {
    confirmedHash: stored.operationHash, confirmationId: 'test', deviceId: 'test-device',
  });
  blobStore.db.prepare('DELETE FROM blobs WHERE sha256 = ?').run(stored.attachments[0].sha256);

  await assert.rejects(() => service.sendOperation(operation.operationId), /内容缺失/);
});

test('下载：批准前拒绝，批准后返回原内容', async (t) => {
  const { service } = setup(t);
  const { operation } = await freezeExternal(service, [ATTACHMENT]);
  const stored = service.store.getOperation(operation.operationId);
  const sha = stored.attachments[0].sha256;

  assert.throws(() => service.getAttachment(operation.operationId, sha), /尚未批准/);

  service.fulfillment.confirm(operation.operationId, {
    confirmedHash: stored.operationHash, confirmationId: 'test', deviceId: 'test-device',
  });
  const file = service.getAttachment(operation.operationId, sha);
  assert.equal(file.name, '会议纪要.pdf');
  assert.equal(file.content.toString('utf8'), 'PDF-CONTENT-123');
  assert.ok(service.audit.entries.some((e) => e.kind === '下载附件'));

  assert.throws(() => service.getAttachment(operation.operationId, 'f'.repeat(64)), /没有这个附件/);
});

test('入参：附件数量与文件名/编码校验', async (t) => {
  const { service } = setup(t);
  const item = sample(service, 'external-confirm');
  const base = { ...item, role: item.role };

  await assert.rejects(
    () => service.runCommand({ ...base, attachments: Array.from({ length: 6 }, (_, i) => ({ ...ATTACHMENT, filename: `${i}.pdf` })) }),
    /最多 5 个/,
  );
  await assert.rejects(
    () => service.runCommand({ ...base, attachments: [{ ...ATTACHMENT, filename: '' }] }),
    /缺少文件名/,
  );
  await assert.rejects(
    () => service.runCommand({ ...base, attachments: [{ ...ATTACHMENT, contentBase64: '!!!!' }] }),
    /contentBase64 非法/,
  );
});
