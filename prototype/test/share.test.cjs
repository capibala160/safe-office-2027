'use strict';
// 文档共享（v0.41）
//   覆盖：授权持久化/撤销/删除清授权、所有者授权、密级不可绕过、越权拒绝、
//         被授权人可见可读、HTTP 接口与角色权限
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DocumentStore, importBuffer, removeFile } = require('../src/ingest.cjs');
const { ConsoleService } = require('../src/console-service.cjs');
const { clearIngestedDocuments } = require('../src/scenario.cjs');
const { AuthService, hashPassword } = require('../src/auth.cjs');
const { startServer } = require('../server.cjs');

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfc-share-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function importDoc(store, { name = '供应商纪要.md', level = '内部', owner = 'alice', body = '价格与交期已确认。' } = {}) {
  return importBuffer(store, {
    filename: name,
    buffer: Buffer.from(`# ${name.replace(/\.[^.]+$/, '')}\n${body}`, 'utf8'),
    level,
    owner,
  });
}

function mkUser(username, role) {
  const { salt, hash } = hashPassword('password123');
  return { username, role, salt, hash };
}

test('DocumentStore：共享授权可持久化、重复授权幂等、删除文档清掉授权', (t) => {
  const dir = tmpdir(t);
  const dbFile = path.join(dir, 'documents.db');
  const store = new DocumentStore(dbFile);
  const doc = importDoc(store);

  assert.equal(store.isSharedWith(doc.id, 'bob'), false);
  store.share(doc.id, 'bob', 'alice');
  store.share(doc.id, 'bob', 'alice');   // 重复授权不产生第二条
  assert.equal(store.isSharedWith(doc.id, 'bob'), true);
  assert.deepEqual(store.sharedDocIds('bob'), [doc.id]);
  assert.equal(store.listShares(doc.id).length, 1);
  assert.equal(store.listShares(doc.id)[0].grantedBy, 'alice');

  // 重开库：授权仍在
  const reopened = new DocumentStore(dbFile);
  assert.equal(reopened.isSharedWith(doc.id, 'bob'), true);
  assert.equal(reopened.revokeShare(doc.id, 'bob'), true);
  assert.equal(reopened.revokeShare(doc.id, 'bob'), false);
  assert.equal(reopened.isSharedWith(doc.id, 'bob'), false);

  // 删除文档同时清授权（CLI 的 removeFile 也必须走同一路径，否则重新导入会复活旧授权）
  reopened.share(doc.id, 'bob', 'alice');
  assert.equal(removeFile(reopened, doc.id), true);
  assert.equal(reopened.listShares(doc.id).length, 0);
  assert.deepEqual(reopened.sharedDocIds('bob'), []);
  const again = importDoc(reopened);
  assert.equal(again.id, doc.id, '同一所有者重新导入同内容应得到同一个 ID');
  assert.equal(reopened.isSharedWith(again.id, 'bob'), false, '旧授权不能复活');

  reopened.share(again.id, 'bob', 'alice');
  reopened.delete(again.id);
  assert.equal(reopened.listShares(again.id).length, 0);
  reopened.close();
  store.close();
});

test('服务层：所有者授权后对方可见可读，撤销后立即失权', async (t) => {
  const store = new DocumentStore(':memory:');
  const doc = importDoc(store);
  class Reader {
    deployment = 'local';
    async plan() { return [{ action: 'readDoc', args: { id: doc.id } }]; }
    async generate() { return '正文'; }
  }
  const service = new ConsoleService({ documentsStore: store, llm: new Reader() });
  t.after(() => {
    service.close();
    store.close();
    clearIngestedDocuments();
  });

  // 共享前：bob 看不到
  assert.ok(service.listDocuments({ actor: 'alice', role: '员工' }).some((d) => d.id === doc.id));
  assert.ok(!service.listDocuments({ actor: 'bob', role: '实习生' }).some((d) => d.id === doc.id));
  assert.throws(
    () => service.getDocument(doc.id, { actor: 'bob', role: '实习生' }),
    (err) => err.status === 404,
  );

  const res = service.shareDocument({
    docId: doc.id, grantee: 'bob', granteeRole: '实习生', actor: 'alice', role: '员工',
  });
  assert.equal(res.shares.length, 1);
  assert.equal(res.shares[0].grantee, 'bob');

  // 共享后：列表可见并标 sharedWithMe；令牌能通过闸2读到正文
  const listed = service.listDocuments({ actor: 'bob', role: '实习生' }).find((d) => d.id === doc.id);
  assert.ok(listed);
  assert.equal(listed.sharedWithMe, true);
  const run = await service.runCommand({
    command: '读一下供应商纪要', role: '实习生', operator: 'bob',
    tools: ['readDoc'], documentIds: [doc.id],
  });
  assert.equal(run.ok, true);
  assert.ok(service.runtime.knowledge[doc.id], '被授权人应能读到共享文档');

  const shared = service.audit.entries.find((e) => e.kind === '文档共享');
  assert.ok(shared);
  assert.equal(shared.actor, 'alice');
  assert.equal(shared.detail.grantee, 'bob');

  // 撤销后：立即看不到也读不了，已读进知识库的副本一并清除
  const revoked = service.revokeDocumentShare({ docId: doc.id, grantee: 'bob', actor: 'alice', role: '员工' });
  assert.equal(revoked.purged, 1);
  assert.equal(service.runtime.knowledge[doc.id], undefined);
  assert.ok(!service.listDocuments({ actor: 'bob', role: '实习生' }).some((d) => d.id === doc.id));
  assert.throws(
    () => service.getDocument(doc.id, { actor: 'bob', role: '实习生' }),
    (err) => err.status === 404,
  );
  assert.ok(service.audit.entries.find((e) => e.kind === '取消共享'));
});

test('服务层：共享不能绕过密级，别人不能替我共享，样例文档无需共享', (t) => {
  const store = new DocumentStore(':memory:');
  const secret = importDoc(store, { name: '并购方案.md', level: '机密' });
  const internal = importDoc(store, { name: '排班表.md', level: '内部' });
  const service = new ConsoleService({ documentsStore: store });
  t.after(() => {
    service.close();
    store.close();
    clearIngestedDocuments();
  });

  // 机密文档不能共享给只能读公开/内部的实习生
  assert.throws(
    () => service.shareDocument({
      docId: secret.id, grantee: 'bob', granteeRole: '实习生', actor: 'alice', role: '员工',
    }),
    (err) => err.status === 403 && /密级/.test(err.message),
  );
  // 非所有者、非管理员不能共享
  assert.throws(
    () => service.shareDocument({
      docId: internal.id, grantee: 'carol', granteeRole: '员工', actor: 'bob', role: '员工',
    }),
    (err) => err.status === 403,
  );
  // 样例文档（无 owner）无需共享
  assert.throws(
    () => service.shareDocument({
      docId: 'M1', grantee: 'bob', granteeRole: '员工', actor: 'alice', role: '员工',
    }),
    (err) => err.status === 409,
  );
  // 不能共享给自己/所有者
  assert.throws(
    () => service.shareDocument({
      docId: internal.id, grantee: 'alice', granteeRole: '员工', actor: 'alice', role: '员工',
    }),
    (err) => err.status === 400,
  );
  // 管理员可以替他共享
  const asAdmin = service.shareDocument({
    docId: internal.id, grantee: 'carol', granteeRole: '员工', actor: 'admin', role: '管理员',
  });
  assert.equal(asAdmin.shares[0].grantee, 'carol');
});

test('HTTP：登录用户之间共享/撤销；非所有者 403；目标不存在 404', async (t) => {
  const store = new DocumentStore(':memory:');
  const doc = importDoc(store);
  const auth = new AuthService({
    users: [mkUser('alice', '员工'), mkUser('bob', '员工'), mkUser('admin', '管理员')],
  });
  const started = await startServer({ port: 0, auth, documentsStore: store });
  t.after(() => {
    started.close();
    store.close();
    clearIngestedDocuments();
  });
  const cookie = (name) => `sfc_session=${auth.login(name, 'password123').token}`;
  const post = (url, body, who) => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie(who) },
    body: JSON.stringify(body || {}),
  });
  const get = (url, who) => fetch(url, { headers: { Cookie: cookie(who) } });

  const targets = await (await get(`${started.url}/api/share-targets`, 'alice')).json();
  assert.ok(targets.items.some((u) => u.username === 'bob'));

  // 目标用户不存在
  const missing = await post(`${started.url}/api/documents/${doc.id}/share`, { grantee: 'nobody' }, 'alice');
  assert.equal(missing.status, 404);

  // 所有者共享
  const shared = await post(`${started.url}/api/documents/${doc.id}/share`, { grantee: 'bob' }, 'alice');
  assert.equal(shared.status, 200);
  assert.equal((await shared.json()).shares[0].grantee, 'bob');

  // bob 现在能看到，且标 sharedWithMe
  const bobDocs = await (await get(`${started.url}/api/documents`, 'bob')).json();
  const row = bobDocs.items.find((d) => d.id === doc.id);
  assert.ok(row);
  assert.equal(row.sharedWithMe, true);

  // bob 不能替 alice 共享
  const denied = await post(`${started.url}/api/documents/${doc.id}/share`, { grantee: 'admin' }, 'bob');
  assert.equal(denied.status, 403);

  // 撤销后 bob 看不到
  const revoked = await post(`${started.url}/api/documents/${doc.id}/share/revoke`, { grantee: 'bob' }, 'alice');
  assert.equal(revoked.status, 200);
  const bobAfter = await (await get(`${started.url}/api/documents`, 'bob')).json();
  assert.ok(!bobAfter.items.some((d) => d.id === doc.id));

  // 未登录用户读共享列表 → 401/403
  const anon = await fetch(`${started.url}/api/documents/${doc.id}/shares`);
  assert.ok([401, 403].includes(anon.status));
});
