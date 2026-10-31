'use strict';
// ============================================================
// SQLite 持久化（v0.10，Node 24 内置 node:sqlite，零依赖）
//   operations：冻结的最终操作记录（不可覆盖）
//   outbox：发送状态机（pending/sending/sent/failed/unknown）
//   events：本地审计事件哈希链（独立于外部服务）
// 边界：SQLite 只保证本地状态；不保证 SMTP/HTTP 外部服务只执行一次。
// ============================================================
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const { verifyOperation, TRANSITIONS } = require('./operation.cjs');

const OUTBOX_TRANSITIONS = {
  pending: new Set(['sending', 'failed']),
  sending: new Set(['sent', 'failed', 'unknown']),
  // v0.35：unknown 不直接接受退信——客户端超时拿不到服务端 Message-ID，
  //        无法可靠匹配；先人工核对成 sent，再走 sent → bounced。
  unknown: new Set(['sent', 'failed']),
  failed: new Set(), /* 明确失败后必须新建操作记录，不能复用旧记录重试 */
  // v0.35：sent 只代表 SMTP 接了；退信 = 投递失败。两种情况都必须新建操作才能重发
  sent: new Set(['bounced']),
  bounced: new Set(),
};

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function parseJson(text, fallback) {
  try { return JSON.parse(text); } catch { return fallback; }
}

class OperationStore {
  constructor(file = ':memory:', { now = () => new Date().toISOString() } = {}) {
    this.now = now;
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA foreign_keys = ON;');
    if (file !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL;');
    }
    this._migrate();
  }

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS operations (
        operation_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        action TEXT NOT NULL,
        protocol_action INTEGER NOT NULL,
        tool TEXT NOT NULL,
        recipient TEXT NOT NULL,
        subject TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL,
        body_hash TEXT NOT NULL,
        attachments TEXT NOT NULL DEFAULT '[]',
        source_doc_ids TEXT NOT NULL DEFAULT '[]',
        level TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        model_id TEXT NOT NULL DEFAULT '',
        plan_hash TEXT NOT NULL DEFAULT '',
        created_by TEXT NOT NULL DEFAULT '',
        operation_hash TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL,
        confirmation_id TEXT,
        device_id TEXT,
        updated_at TEXT NOT NULL,
        result TEXT
      );
      CREATE TABLE IF NOT EXISTS outbox (
        outbox_id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL REFERENCES operations(operation_id),
        idempotency_key TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL,
        message_id TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_outbox_operation ON outbox(operation_id);
      CREATE TABLE IF NOT EXISTS operation_revisions (
        operation_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        body TEXT NOT NULL,
        body_hash TEXT NOT NULL,
        operation_hash TEXT NOT NULL,
        editor TEXT NOT NULL,
        note TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (operation_id, revision)
      );
      CREATE TABLE IF NOT EXISTS operation_meta (
        operation_id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS console_state (
        key TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        operation_id TEXT,
        kind TEXT NOT NULL,
        detail TEXT NOT NULL,
        created_at TEXT NOT NULL,
        prev_hash TEXT NOT NULL,
        hash TEXT NOT NULL
      );
    `);
    // 旧库补列：v0.31 之前的 operations 表没有 created_by
    const columns = this.db.prepare('PRAGMA table_info(operations)').all().map((c) => c.name);
    if (!columns.includes('created_by')) {
      this.db.exec("ALTER TABLE operations ADD COLUMN created_by TEXT NOT NULL DEFAULT ''");
    }
  }

  _transaction(fn) {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    }
  }

  close() {
    this.db.close();
  }

  // ---------- operations ----------
  insertOperation(operation) {
    if (!operation || operation.state !== 'frozen') {
      throw new Error('新操作记录必须是 frozen 状态');
    }
    const check = verifyOperation(operation);
    if (!check.ok) throw new Error(`拒绝写入未通过校验的操作记录：${check.reason}`);
    return this._transaction(() => {
      this.db.prepare(`
        INSERT INTO operations (
          operation_id, task_id, action, protocol_action, tool, recipient, subject,
          body, body_hash, attachments, source_doc_ids, level, created_at, expires_at,
          model_id, plan_hash, created_by, operation_hash, state, confirmation_id, device_id,
          updated_at, result
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        operation.operationId, operation.taskId, operation.action, operation.protocolAction,
        operation.tool, operation.recipient, operation.subject, operation.body,
        operation.bodyHash, JSON.stringify(operation.attachments),
        JSON.stringify(operation.sourceDocIds), operation.level, operation.createdAt,
        operation.expiresAt, operation.modelId, operation.planHash, operation.createdBy || '',
        operation.operationHash, operation.state, null, null, this.now(), null,
      );
      this.appendEvent('操作冻结', {
        operationId: operation.operationId,
        operationHash: operation.operationHash,
        recipient: operation.recipient,
        action: operation.action,
      }, { operationId: operation.operationId });
      return this.getOperation(operation.operationId);
    });
  }

  _rowToOperation(row) {
    if (!row) return null;
    return {
      operationId: row.operation_id,
      taskId: row.task_id,
      action: row.action,
      protocolAction: row.protocol_action,
      tool: row.tool,
      recipient: row.recipient,
      subject: row.subject,
      body: row.body,
      bodyHash: row.body_hash,
      attachments: parseJson(row.attachments, []),
      attachmentHashes: parseJson(row.attachments, []),
      sourceDocIds: parseJson(row.source_doc_ids, []),
      level: row.level,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      modelId: row.model_id,
      planHash: row.plan_hash,
      createdBy: row.created_by || '',
      operationHash: row.operation_hash,
      state: row.state,
      confirmationId: row.confirmation_id,
      deviceId: row.device_id,
      updatedAt: row.updated_at,
      result: row.result === null ? null : parseJson(row.result, row.result),
    };
  }

  getOperation(operationId) {
    return this._rowToOperation(this.db.prepare('SELECT * FROM operations WHERE operation_id = ?').get(operationId));
  }

  listOperations() {
    return this.db.prepare('SELECT * FROM operations ORDER BY created_at ASC, operation_id ASC')
      .all().map((row) => this._rowToOperation(row));
  }

  setOperationState(operationId, next, { confirmationId = null, deviceId = null, result = null } = {}) {
    return this._transaction(() => {
      const current = this.getOperation(operationId);
      if (!current) throw new Error(`操作不存在：${operationId}`);
      if (!TRANSITIONS[current.state] || !TRANSITIONS[current.state].has(next)) {
        throw new RangeError(`非法操作状态迁移：${current.state} → ${next}`);
      }
      this.db.prepare(`
        UPDATE operations
           SET state = ?, confirmation_id = COALESCE(?, confirmation_id),
               device_id = COALESCE(?, device_id), result = COALESCE(?, result),
               updated_at = ?
         WHERE operation_id = ?
      `).run(next, confirmationId, deviceId, result === null ? null : JSON.stringify(result), this.now(), operationId);
      this.appendEvent('操作状态', { operationId, from: current.state, to: next }, { operationId });
      return this.getOperation(operationId);
    });
  }

  // 草稿编辑：只有 frozen（尚未确认）的记录可以改；改完必须重新过校验并重新确认
  updateFrozenOperation(operation) {
    if (!operation || operation.state !== 'frozen') {
      throw new Error('只有 frozen 状态的操作记录可以编辑');
    }
    const check = verifyOperation(operation);
    if (!check.ok) throw new Error(`拒绝写入未通过校验的操作记录：${check.reason}`);
    return this._transaction(() => {
      const current = this.getOperation(operation.operationId);
      if (!current) throw new Error(`操作不存在：${operation.operationId}`);
      if (current.state !== 'frozen') throw new Error(`操作状态 ${current.state} 不能编辑`);
      this.db.prepare(`
        UPDATE operations
           SET body = ?, body_hash = ?, operation_hash = ?, subject = ?, updated_at = ?
         WHERE operation_id = ? AND state = 'frozen'
      `).run(operation.body, operation.bodyHash, operation.operationHash, operation.subject,
        this.now(), operation.operationId);
      this.appendEvent('草稿修改', {
        operationId: operation.operationId,
        fromHash: current.operationHash,
        toHash: operation.operationHash,
      }, { operationId: operation.operationId });
      return this.getOperation(operation.operationId);
    });
  }

  insertRevision(revision) {
    return this._transaction(() => {
      this.db.prepare(`
        INSERT INTO operation_revisions (
          operation_id, revision, body, body_hash, operation_hash, editor, note, created_at
        ) VALUES (?,?,?,?,?,?,?,?)
      `).run(
        revision.operationId, revision.revision, revision.body, revision.bodyHash,
        revision.operationHash, revision.editor, revision.note || '', revision.createdAt,
      );
      return this.listRevisions(revision.operationId);
    });
  }

  listRevisions(operationId) {
    return this.db.prepare('SELECT * FROM operation_revisions WHERE operation_id = ? ORDER BY revision ASC')
      .all(operationId)
      .map((row) => ({
        operationId: row.operation_id,
        revision: row.revision,
        body: row.body,
        bodyHash: row.body_hash,
        operationHash: row.operation_hash,
        editor: row.editor,
        note: row.note || '',
        createdAt: row.created_at,
      }));
  }

  // ---------- 控制台元数据（重启恢复用） ----------
  saveOperationMeta(operationId, data) {
    this.db.prepare(`
      INSERT INTO operation_meta (operation_id, data, updated_at) VALUES (?,?,?)
      ON CONFLICT(operation_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
    `).run(operationId, JSON.stringify(data || {}), this.now());
  }

  listOperationMeta() {
    return this.db.prepare('SELECT * FROM operation_meta').all().map((row) => ({
      operationId: row.operation_id,
      data: parseJson(row.data, {}),
    }));
  }

  saveState(key, value) {
    this.db.prepare(`
      INSERT INTO console_state (key, data, updated_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
    `).run(String(key), JSON.stringify(value === undefined ? null : value), this.now());
  }

  loadState(key) {
    const row = this.db.prepare('SELECT data FROM console_state WHERE key = ?').get(String(key));
    return row ? parseJson(row.data, null) : null;
  }

  // ---------- outbox ----------
  _rowToOutbox(row) {
    if (!row) return null;
    return {
      outboxId: row.outbox_id,
      operationId: row.operation_id,
      idempotencyKey: row.idempotency_key,
      state: row.state,
      messageId: row.message_id,
      attempts: row.attempts,
      lastError: row.last_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  enqueueOutbox(operation) {
    if (!operation || operation.state !== 'confirmed') {
      throw new Error('只有 confirmed 状态的操作才能入队发送');
    }
    return this._transaction(() => {
      this.db.prepare(`
        INSERT OR IGNORE INTO outbox (
          outbox_id, operation_id, idempotency_key, state, message_id,
          attempts, last_error, created_at, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?)
      `).run(
        crypto.randomUUID(), operation.operationId, operation.operationHash,
        'pending', null, 0, null, this.now(), this.now(),
      );
      const row = this.db.prepare('SELECT * FROM outbox WHERE idempotency_key = ?').get(operation.operationHash);
      this.appendEvent('发送入队', { operationId: operation.operationId, outboxId: row.outbox_id }, { operationId: operation.operationId });
      return this._rowToOutbox(row);
    });
  }

  getOutbox(outboxId) {
    return this._rowToOutbox(this.db.prepare('SELECT * FROM outbox WHERE outbox_id = ?').get(outboxId));
  }

  getOutboxByOperation(operationId) {
    return this._rowToOutbox(this.db.prepare('SELECT * FROM outbox WHERE operation_id = ?').get(operationId));
  }

  // v0.40.2 退信回退匹配：部分 MTA 改写 Message-ID，但保留 X-Idempotency-Key（= operationHash）
  listOutboxByIdempotencyKey(idempotencyKey) {
    const target = String(idempotencyKey || '').trim().toLowerCase();
    if (!target) return [];
    return this.listOutbox().filter((row) => String(row.idempotencyKey || '').toLowerCase() === target);
  }

  // v0.35 退信匹配：Message-ID 大小写与尖括号不敏感；同 ID 多条时返回全部交由上层判断
  listOutboxByMessageId(messageId) {
    const target = String(messageId || '').trim().replace(/^<|>$/g, '').toLowerCase();
    if (!target) return [];
    return this.listOutbox().filter((row) => {
      const id = String(row.messageId || '').trim().replace(/^<|>$/g, '').toLowerCase();
      return id === target;
    });
  }

  listOutbox() {
    return this.db.prepare('SELECT * FROM outbox ORDER BY created_at ASC').all().map((r) => this._rowToOutbox(r));
  }

  setOutboxState(outboxId, next, { messageId = null, error = null, incrementAttempts = false } = {}) {
    return this._transaction(() => {
      const current = this.getOutbox(outboxId);
      if (!current) throw new Error(`发件记录不存在：${outboxId}`);
      if (!OUTBOX_TRANSITIONS[current.state] || !OUTBOX_TRANSITIONS[current.state].has(next)) {
        throw new RangeError(`非法发送状态迁移：${current.state} → ${next}`);
      }
      this.db.prepare(`
        UPDATE outbox
           SET state = ?, message_id = COALESCE(?, message_id),
               last_error = ?, attempts = attempts + ?, updated_at = ?
         WHERE outbox_id = ?
      `).run(next, messageId, error, incrementAttempts ? 1 : 0, this.now(), outboxId);
      this.appendEvent('发送状态', {
        outboxId, operationId: current.operationId, from: current.state, to: next, messageId, error,
      }, { operationId: current.operationId });
      return this.getOutbox(outboxId);
    });
  }

  // ---------- events（本地哈希链） ----------
  appendEvent(kind, detail, { operationId = null } = {}) {
    const last = this.db.prepare('SELECT hash FROM events ORDER BY seq DESC LIMIT 1').get();
    const prevHash = last ? last.hash : 'GENESIS';
    const createdAt = this.now();
    const payload = `${prevHash}\n${kind}\n${JSON.stringify(detail)}\n${createdAt}`;
    const hash = sha256Hex(payload);
    this.db.prepare(`
      INSERT INTO events (operation_id, kind, detail, created_at, prev_hash, hash)
      VALUES (?,?,?,?,?,?)
    `).run(operationId, kind, JSON.stringify(detail), createdAt, prevHash, hash);
    return { kind, detail, createdAt, prevHash, hash };
  }

  listEvents() {
    return this.db.prepare('SELECT * FROM events ORDER BY seq ASC').all().map((r) => ({
      seq: r.seq,
      operationId: r.operation_id,
      kind: r.kind,
      detail: parseJson(r.detail, r.detail),
      createdAt: r.created_at,
      prevHash: r.prev_hash,
      hash: r.hash,
    }));
  }

  verifyEvents() {
    let prev = 'GENESIS';
    const rows = this.db.prepare('SELECT * FROM events ORDER BY seq ASC').all();
    for (const row of rows) {
      if (row.prev_hash !== prev) return false;
      const payload = `${row.prev_hash}\n${row.kind}\n${row.detail}\n${row.created_at}`;
      if (sha256Hex(payload) !== row.hash) return false;
      prev = row.hash;
    }
    return true;
  }

  eventCheckpoint() {
    const row = this.db.prepare('SELECT seq, hash FROM events ORDER BY seq DESC LIMIT 1').get();
    return { count: this.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, head: row ? row.hash : 'GENESIS' };
  }
}

module.exports = { OperationStore, OUTBOX_TRANSITIONS };
