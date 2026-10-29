'use strict';
// ============================================================
// 附件内容存储（v0.16）
//   按内容 sha256 寻址：同一份文件重复上传只存一份
//   冻结记录里只存 {name, sha256, size}；执行前用这里的内容重算哈希比对
// 边界：明文存本地 SQLite；不做加密与访问控制（本地单用户演示）
// ============================================================
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const MAX_BLOB_BYTES = 5 * 1024 * 1024;

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

class BlobStore {
  constructor(file = ':memory:') {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS blobs (
        sha256 TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        mime TEXT NOT NULL,
        size INTEGER NOT NULL,
        content BLOB NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  put(buffer, { name, mime = 'application/octet-stream', now = () => new Date().toISOString() } = {}) {
    if (!Buffer.isBuffer(buffer)) throw new Error('附件内容必须是 Buffer');
    if (buffer.length === 0) throw new Error('附件是空文件');
    if (buffer.length > MAX_BLOB_BYTES) throw new Error(`附件超过 ${MAX_BLOB_BYTES / 1024 / 1024}MB`);
    const sha256 = sha256Hex(buffer);
    const safeName = String(name || 'attachment').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 120) || 'attachment';
    const safeMime = String(mime || 'application/octet-stream').slice(0, 80);
    this.db.prepare(`
      INSERT INTO blobs (sha256, name, mime, size, content, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(sha256) DO UPDATE SET name = excluded.name, mime = excluded.mime
    `).run(sha256, safeName, safeMime, buffer.length, buffer, now());
    return { name: safeName, sha256, size: buffer.length, mime: safeMime };
  }

  get(sha256) {
    const key = String(sha256 || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(key)) return null;
    const row = this.db.prepare('SELECT name, mime, size, content FROM blobs WHERE sha256 = ?').get(key);
    if (!row) return null;
    return { name: row.name, mime: row.mime, size: row.size, content: Buffer.from(row.content) };
  }

  has(sha256) {
    return this.get(sha256) !== null;
  }

  close() {
    try { this.db.close(); } catch { /* ignore */ }
  }
}

module.exports = { BlobStore, MAX_BLOB_BYTES, sha256Hex };
