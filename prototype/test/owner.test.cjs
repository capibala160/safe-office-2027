'use strict';
// 操作发起人（v0.31）：写进冻结记录哈希、SQLite 往返、旧记录兼容
const test = require('node:test');
const assert = require('node:assert');
const { sealOperation, verifyOperation } = require('../src/operation.cjs');
const { OperationStore } = require('../src/store.cjs');

function make(createdBy) {
  return sealOperation({
    operationId: `op-${createdBy || 'none'}`,
    taskId: 'RUN-1',
    action: 'sendExternalEmail',
    protocolAction: 1,
    recipient: 'partner@partner-example.com',
    subject: '测试',
    body: '正文',
    createdAt: '2026-10-31T00:00:00.000Z',
    expiresAt: '2026-10-31T01:00:00.000Z',
    createdBy,
  });
}

test('发起人进入 operationHash：改 createdBy 校验失败', () => {
  const sealed = make('alice');
  assert.equal(sealed.createdBy, 'alice');
  assert.equal(verifyOperation(sealed).ok, true);
  const tampered = { ...sealed, createdBy: 'bob' };
  const check = verifyOperation(tampered);
  assert.equal(check.ok, false);
  assert.match(check.reason, /已变化/);
});

test('旧记录没有 createdBy 仍能通过校验（哈希兼容）', () => {
  const sealed = make('');
  const legacy = JSON.parse(JSON.stringify(sealed));
  delete legacy.createdBy;
  assert.equal(verifyOperation(legacy).ok, true, '升级前冻结的记录不应因新增字段失效');
});

test('SQLite：createdBy 写入并读回；旧库自动补列', () => {
  const store = new OperationStore(':memory:');
  try {
    const sealed = make('alice');
    const saved = store.insertOperation(sealed);
    assert.equal(saved.createdBy, 'alice');
    assert.equal(store.getOperation(sealed.operationId).createdBy, 'alice');
    assert.equal(store.listOperations()[0].createdBy, 'alice');
  } finally {
    store.close();
  }
});

test('SQLite：升级前的 operations 表自动补 created_by 列', () => {
  const { DatabaseSync } = require('node:sqlite');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'safe-office-db-')), 'old.db');
  const db = new DatabaseSync(file);
  try {
    db.exec(`CREATE TABLE operations (
      operation_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, action TEXT NOT NULL,
      protocol_action INTEGER NOT NULL, tool TEXT NOT NULL, recipient TEXT NOT NULL,
      subject TEXT NOT NULL DEFAULT '', body TEXT NOT NULL, body_hash TEXT NOT NULL,
      attachments TEXT NOT NULL DEFAULT '[]', source_doc_ids TEXT NOT NULL DEFAULT '[]',
      level TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
      model_id TEXT NOT NULL DEFAULT '', plan_hash TEXT NOT NULL DEFAULT '',
      operation_hash TEXT NOT NULL UNIQUE, state TEXT NOT NULL, confirmation_id TEXT,
      device_id TEXT, updated_at TEXT NOT NULL, result TEXT
    )`);
  } finally {
    db.close();
  }
  const store = new OperationStore(file);
  try {
    const columns = store.db.prepare('PRAGMA table_info(operations)').all().map((c) => c.name);
    assert.ok(columns.includes('created_by'));
  } finally {
    store.close();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});
