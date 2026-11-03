'use strict';
// ============================================================
// 附件内容存储（v0.16）
//   按内容 sha256 寻址：同一份文件重复上传只存一份
//   冻结记录里只存 {name, sha256, size}；执行前用这里的内容重算哈希比对
// 边界：默认明文存本地 SQLite；配置 SAFE_OFFICE_BLOB_KEY 后新内容 AES-256-GCM 加密；
//       仍不做按用户/租户的访问控制（本地单用户演示）
// ============================================================
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const MAX_BLOB_BYTES = 5 * 1024 * 1024;
const ENC_MAGIC = Buffer.from('SFE1');
const NONCE_LEN = 12;
const TAG_LEN = 16;

function parseKey(key) {
  if (!key) return null;
  if (Buffer.isBuffer(key)) {
    if (key.length !== 32) throw new Error('附件加密密钥必须是 32 字节');
    return key;
  }
  const text = String(key).trim();
  if (/^[0-9a-fA-F]{64}$/.test(text)) return Buffer.from(text, 'hex');
  const buf = Buffer.from(text, 'base64');
  if (buf.length !== 32) throw new Error('附件加密密钥必须是 32 字节（base64 或 hex）');
  return buf;
}

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

class BlobStore {
  constructor(file = ':memory:', { key = null } = {}) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.key = parseKey(key);
    this.db = new DatabaseSync(file);
    try {
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS blobs (
        sha256 TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        mime TEXT NOT NULL,
        size INTEGER NOT NULL,
        content BLOB NOT NULL,
        encrypted INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
    `);
    // 旧库补列：已有密文按 SFE1 魔数回填 encrypted=1（一次性迁移）。
    // 新上传不再靠魔数判断，避免普通文件以 SFE1 开头被误判为加密。
    const columns = this.db.prepare('PRAGMA table_info(blobs)').all().map((c) => c.name);
    if (!columns.includes('encrypted')) {
      // 补列和数据迁移必须同一事务：中途失败要回滚，否则下次启动看到列已存在
      // 会跳过迁移，把旧密文当明文返回。
      this.db.exec('BEGIN');
      try {
        this.db.exec("ALTER TABLE blobs ADD COLUMN encrypted INTEGER NOT NULL DEFAULT 0");
        // 旧库迁移：sha256 列存的是明文哈希。若内容哈希 == 明文哈希，说明这是
        // 以 SFE1 开头的普通文件，不能标成密文；只有哈希对不上且带 SFE1 才判密文。
        const rows = this.db.prepare(
          "SELECT sha256, content FROM blobs WHERE substr(content, 1, 4) = X'53464531'",
        ).all();
        const update = this.db.prepare('UPDATE blobs SET encrypted = ? WHERE sha256 = ?');
        for (const row of rows) {
          const contentHash = sha256Hex(Buffer.from(row.content));
          const isPlain = contentHash === String(row.sha256).toLowerCase();
          update.run(isPlain ? 0 : 1, row.sha256);
        }
        this.db.exec('COMMIT');
      } catch (err) {
        try { this.db.exec('ROLLBACK'); } catch { /* ignore */ }
        throw err;
      }
    }
    } catch (err) {
      // 迁移失败不要让半开连接留在后台；下次启动会从旧结构重试
      try { this.db.close(); } catch { /* ignore */ }
      throw err;
    }
  }

  put(buffer, { name, mime = 'application/octet-stream', now = () => new Date().toISOString() } = {}) {
    if (!Buffer.isBuffer(buffer)) throw new Error('附件内容必须是 Buffer');
    if (buffer.length === 0) throw new Error('附件是空文件');
    if (buffer.length > MAX_BLOB_BYTES) throw new Error(`附件超过 ${MAX_BLOB_BYTES / 1024 / 1024}MB`);
    const sha256 = sha256Hex(buffer);
    // 附件名要剔除控制字符，属于有意使用
    // eslint-disable-next-line no-control-regex
    const safeName = String(name || 'attachment').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 120) || 'attachment';
    const safeMime = String(mime || 'application/octet-stream').slice(0, 80);
    let stored = buffer;
    if (this.key) {
      const nonce = crypto.randomBytes(NONCE_LEN);
      const cipher = crypto.createCipheriv('aes-256-gcm', this.key, nonce);
      const ciphertext = Buffer.concat([cipher.update(buffer), cipher.final()]);
      stored = Buffer.concat([ENC_MAGIC, nonce, cipher.getAuthTag(), ciphertext]);
    }
    this.db.prepare(`
      INSERT INTO blobs (sha256, name, mime, size, content, encrypted, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(sha256) DO UPDATE SET name = excluded.name, mime = excluded.mime
    `).run(sha256, safeName, safeMime, buffer.length, stored, this.key ? 1 : 0, now());
    return { name: safeName, sha256, size: buffer.length, mime: safeMime };
  }

  get(sha256) {
    const key = String(sha256 || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(key)) return null;
    const row = this.db.prepare('SELECT name, mime, size, content, encrypted FROM blobs WHERE sha256 = ?').get(key);
    if (!row) return null;
    let content = Buffer.from(row.content);
    if (Number(row.encrypted) === 1) {
      if (!this.key) throw new Error('附件已加密，但未提供 SAFE_OFFICE_BLOB_KEY');
      if (!content.subarray(0, 4).equals(ENC_MAGIC)) throw new Error('附件加密格式损坏（缺少 SFE1 头）');
      const nonce = content.subarray(4, 4 + NONCE_LEN);
      const tag = content.subarray(4 + NONCE_LEN, 4 + NONCE_LEN + TAG_LEN);
      const ciphertext = content.subarray(4 + NONCE_LEN + TAG_LEN);
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, nonce);
      decipher.setAuthTag(tag);
      content = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    }
    return { name: row.name, mime: row.mime, size: row.size, content };
  }

  has(sha256) {
    return this.get(sha256) !== null;
  }

  // 保留策略：列出早于 cutoff（ISO 时间）的附件元数据；调用方决定是否被引用
  listOlderThan(cutoffIso) {
    const cutoff = String(cutoffIso || '');
    return this.db.prepare(`
      SELECT sha256, name, size, created_at FROM blobs
      WHERE created_at < ? ORDER BY created_at ASC
    `).all(cutoff);
  }

  // 只删指定内容（按内容寻址）。调用方必须自己确认没有操作还引用它。
  delete(sha256) {
    const key = String(sha256 || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(key)) return false;
    const info = this.db.prepare('DELETE FROM blobs WHERE sha256 = ?').run(key);
    return info.changes > 0;
  }

  close() {
    try { this.db.close(); } catch { /* ignore */ }
  }
}

module.exports = { BlobStore, MAX_BLOB_BYTES, sha256Hex, parseKey };
