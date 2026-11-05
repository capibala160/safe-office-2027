'use strict';
// ============================================================
// 真实资料导入（v0.16）
//   .txt / .md 直接读；.docx 用最小 ZIP 解析 + word/document.xml 抽文本（零依赖）
//   落 SQLite（documents 表），再注册进 scenario 的文档注册表
// 边界：
//   - 只抽正文，不处理批注/修订/图片/表格样式；复杂排版会丢格式
//   - 密级由导入的人手动标，不允许模型自定
//   - 正文明文存本地 SQLite；不要导入真实企业机密
// ============================================================
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');

const LEVELS = ['公开', '内部', '机密'];
const MAX_BYTES = 5 * 1024 * 1024;

/**
 * @typedef {{
 *   id: string,
 *   title: string,
 *   level: string,
 *   body: string,
 *   sourcePath: string,
 *   sha256: string,
 *   importedAt: string,
 *   owner?: string,
 * }} ImportedDocument
 * @typedef {{
 *   filename?: string,
 *   buffer?: Buffer,
 *   level?: string,
 *   owner?: string,
 *   now?: () => string,
 * }} ImportOptions
 */

/** @param {Buffer | string} buffer @returns {string} */
function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// ---------- ZIP（只够读 docx） ----------
const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

/** @param {Buffer} buffer @returns {number} */
function findEocd(buffer) {
  const min = Math.max(0, buffer.length - 65557);
  for (let i = buffer.length - 22; i >= min; i -= 1) {
    if (buffer.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

// 压缩炸弹防线：小文件可以解出几百 MB，必须在解压前按"声明大小"卡住
const ZIP_LIMITS = {
  entries: 200,
  entryBytes: 10 * 1024 * 1024,
  totalBytes: 20 * 1024 * 1024,
};

// 返回 Map<name, Buffer>：只解压未加密的 stored/deflate 条目
// only 给定时只解压该条目（docx 只关心 word/document.xml），其余只做限额检查
/**
 * @param {Buffer} buffer
 * @param {{ only?: string | null }} [options]
 * @returns {Map<string, Buffer>}
 */
function readZipEntries(buffer, { only = null } = {}) {
  const eocd = findEocd(buffer);
  if (eocd < 0) throw new Error('不是合法的 ZIP/docx 文件');
  const count = buffer.readUInt16LE(eocd + 10);
  if (count > ZIP_LIMITS.entries) {
    throw new Error(`ZIP 条目过多（${count}），拒绝解析`);
  }
  let offset = buffer.readUInt32LE(eocd + 16);
  let declaredTotal = 0;
  const entries = new Map();
  for (let i = 0; i < count; i += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== SIG_CENTRAL) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const declaredSize = buffer.readUInt32LE(offset + 24);   // 中央目录里声明的解压后大小
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLen);
    offset += 46 + nameLen + extraLen + commentLen;

    if (declaredSize > ZIP_LIMITS.entryBytes) {
      throw new Error(`ZIP 条目「${name}」声明解压后 ${declaredSize} 字节，超出上限，疑似压缩炸弹`);
    }
    declaredTotal += declaredSize;
    if (declaredTotal > ZIP_LIMITS.totalBytes) {
      throw new Error('ZIP 声明解压总量超出上限，疑似压缩炸弹');
    }
    if (only && name !== only) continue;

    if (buffer.readUInt32LE(localOffset) !== SIG_LOCAL) continue;
    const localNameLen = buffer.readUInt16LE(localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLen + localExtraLen;
    const data = buffer.subarray(start, start + compressedSize);
    try {
      // 双保险：即使中央目录谎报大小，解压时也会被硬性截断
      entries.set(name, method === 0
        ? Buffer.from(data)
        : zlib.inflateRawSync(data, { maxOutputLength: ZIP_LIMITS.entryBytes }));
    } catch (err) {
      if (err && (/** @type {{ code?: string }} */ (err).code === 'ERR_BUFFER_TOO_LARGE' || err instanceof RangeError)) {
        throw new Error(`ZIP 条目「${name}」解压后超出上限，疑似压缩炸弹`);
      }
      /* 损坏条目跳过，别让整份文件失败 */
    }
  }
  return entries;
}

/** @param {string} text @returns {string} */
function decodeXmlEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, '&');
}

// 段落 → 换行，制表/换行元素保留；其余标签剥掉
/** @param {string} xml @returns {string} */
function xmlToText(xml) {
  return decodeXmlEntities(
    xml
      .replace(/<w:tab\b[^>]*\/>/g, '\t')
      .replace(/<w:br\b[^>]*\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]+>/g, ''),
  );
}

/** @param {Buffer} buffer @returns {string} */
function docxToText(buffer) {
  // 只解压正文条目；其余条目仍经过限额检查，但不会占用内存
  const entries = readZipEntries(buffer, { only: 'word/document.xml' });
  const main = entries.get('word/document.xml');
  if (!main) throw new Error('docx 里找不到 word/document.xml');
  return xmlToText(main.toString('utf8')).replace(/\n{3,}/g, '\n\n').trim();
}

// ---------- 文件解析 ----------
const ALLOWED_EXT = new Set(['.txt', '.md', '.markdown', '.docx']);
const DOCX_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04"

// 上传通道要防"改了后缀的别的文件"：docx 必须真是 ZIP，文本必须是 UTF-8 且无 NUL
/** @param {Buffer} buffer @param {string} ext */
function assertBufferSafe(buffer, ext) {
  if (buffer.length === 0) throw new Error('文件是空的');
  if (buffer.length > MAX_BYTES) throw new Error(`文件超过 ${MAX_BYTES / 1024 / 1024}MB，拒绝导入`);
  if (ext === '.docx') {
    if (!buffer.subarray(0, 4).equals(DOCX_MAGIC)) {
      throw new Error('扩展名是 .docx，但内容不是 ZIP——可能是改了后缀的其它文件');
    }
    return;
  }
  if (buffer.includes(0)) throw new Error('文本文件里含 NUL 字节，疑似二进制文件');
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new Error('不是合法的 UTF-8 文本；请另存为 UTF-8 后再导入');
  }
}

/**
 * @param {Buffer} buffer
 * @param {string | undefined} fileName
 * @returns {{ title: string, body: string, ext: string }}
 */
function parseBuffer(buffer, fileName) {
  const ext = path.extname(String(fileName || '')).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    throw new Error(`暂不支持 ${ext || '(无扩展名)'}；请用 .txt / .md / .docx`);
  }
  assertBufferSafe(buffer, ext);
  const body = ext === '.docx'
    ? docxToText(buffer)
    : buffer.toString('utf8').replace(/^\uFEFF/, '').trim();
  if (!body) throw new Error('文件没有可用正文');
  const firstLine = body.split('\n').map((line) => line.trim()).find(Boolean) || '';
  const fallback = path.basename(String(fileName || ''), ext);
  const title = (firstLine.replace(/^#+\s*/, '').slice(0, 40)) || fallback || '未命名资料';
  return { title, body, ext };
}

/** @param {string} filePath @returns {{ title: string, body: string, ext: string }} */
function parseFile(filePath) {
  return parseBuffer(fs.readFileSync(filePath), filePath);
}

/** @param {any} level @returns {string | null} */
function normalizeLevel(level) {
  return LEVELS.includes(level) ? level : null;
}

// ---------- 存储 ----------
class DocumentStore {
  /** @param {string} [file] */
  constructor(file = ':memory:') {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        doc_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        level TEXT NOT NULL,
        body TEXT NOT NULL,
        source_path TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        imported_at TEXT NOT NULL,
        owner TEXT NOT NULL DEFAULT ''
      );
    `);
    // v0.33 之前导入的资料没有 owner：保留为 ''（旧资料视为共享，避免升级后突然消失）
    const columns = this.db.prepare('PRAGMA table_info(documents)').all().map((c) => c.name);
    if (!columns.includes('owner')) {
      this.db.exec("ALTER TABLE documents ADD COLUMN owner TEXT NOT NULL DEFAULT ''");
    }
    // v0.41：文档共享授权（所有者按人授权；共享不降密级，撤销即失权）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS document_shares (
        doc_id TEXT NOT NULL,
        grantee TEXT NOT NULL,
        granted_by TEXT NOT NULL,
        granted_at TEXT NOT NULL,
        PRIMARY KEY (doc_id, grantee)
      );
    `);
  }

  /** @param {ImportedDocument} doc @returns {ImportedDocument} */
  upsert(doc) {
    this.db.prepare(`
      INSERT INTO documents (doc_id, title, level, body, source_path, sha256, imported_at, owner)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(doc_id) DO UPDATE SET
        title = excluded.title, level = excluded.level, body = excluded.body,
        source_path = excluded.source_path, sha256 = excluded.sha256,
        imported_at = excluded.imported_at, owner = excluded.owner
    `).run(doc.id, doc.title, doc.level, doc.body, doc.sourcePath, doc.sha256, doc.importedAt, doc.owner || '');
    return doc;
  }

  /** @returns {ImportedDocument[]} */
  list() {
    return /** @type {any[]} */ (this.db.prepare(`
      SELECT doc_id, title, level, body, source_path, sha256, imported_at, owner
        FROM documents ORDER BY imported_at
    `).all()).map((row) => ({
      id: row.doc_id,
      title: row.title,
      level: row.level,
      body: row.body,
      sourcePath: row.source_path,
      sha256: row.sha256,
      importedAt: row.imported_at,
      owner: row.owner || '',
    }));
  }

  /** @param {string} docId @returns {ImportedDocument | null} */
  get(docId) {
    const row = /** @type {any} */ (this.db.prepare('SELECT * FROM documents WHERE doc_id = ?').get(docId));
    if (!row) return null;
    return {
      id: row.doc_id, title: row.title, level: row.level, body: row.body,
      sourcePath: row.source_path, sha256: row.sha256, importedAt: row.imported_at,
      owner: row.owner || '',
    };
  }

  /** @param {string} docId @returns {boolean} */
  delete(docId) {
    const id = String(docId);
    this.db.prepare('DELETE FROM document_shares WHERE doc_id = ?').run(id);
    const info = this.db.prepare('DELETE FROM documents WHERE doc_id = ?').run(id);
    return info.changes > 0;
  }

  // ---------- 文档共享（v0.41） ----------
  // 授权只是"额外允许某个账号读"，不改变文档所有者与密级
  /**
   * @param {string} docId
   * @param {string} grantee
   * @param {string} [grantedBy]
   * @param {() => string} [now]
   * @returns {{ docId: string, grantee: string, grantedBy: string }}
   */
  share(docId, grantee, grantedBy = '', now = () => new Date().toISOString()) {
    const id = String(docId);
    const who = String(grantee);
    if (!id || !who) throw new Error('共享需要文档 ID 与目标账号');
    this.db.prepare(`
      INSERT INTO document_shares (doc_id, grantee, granted_by, granted_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(doc_id, grantee) DO UPDATE SET
        granted_by = excluded.granted_by, granted_at = excluded.granted_at
    `).run(id, who, String(grantedBy || ''), now());
    return { docId: id, grantee: who, grantedBy: String(grantedBy || '') };
  }

  /** @param {string} docId @param {string} grantee @returns {boolean} */
  revokeShare(docId, grantee) {
    const info = this.db.prepare(
      'DELETE FROM document_shares WHERE doc_id = ? AND grantee = ?',
    ).run(String(docId), String(grantee));
    return info.changes > 0;
  }

  /**
   * @param {string} docId
   * @returns {{ docId: string, grantee: string, grantedBy: string, grantedAt: string }[]}
   */
  listShares(docId) {
    return /** @type {any[]} */ (this.db.prepare(`
      SELECT doc_id, grantee, granted_by, granted_at
        FROM document_shares WHERE doc_id = ? ORDER BY granted_at, grantee
    `).all(String(docId))).map((row) => ({
      docId: row.doc_id,
      grantee: row.grantee,
      grantedBy: row.granted_by || '',
      grantedAt: row.granted_at,
    }));
  }

  /** @param {string} docId @param {string | null} [grantee] @returns {boolean} */
  isSharedWith(docId, grantee) {
    if (!grantee) return false;
    const row = this.db.prepare(
      'SELECT 1 AS hit FROM document_shares WHERE doc_id = ? AND grantee = ?',
    ).get(String(docId), String(grantee));
    return !!row;
  }

  /** @param {string | null} [grantee] @returns {string[]} */
  sharedDocIds(grantee) {
    if (!grantee) return [];
    return /** @type {any[]} */ (this.db.prepare(
      'SELECT doc_id FROM document_shares WHERE grantee = ?',
    ).all(String(grantee))).map((row) => row.doc_id);
  }

  close() {
    try { this.db.close(); } catch { /* ignore */ }
  }
}

// 导入一个文件：id 由内容哈希派生，同一份文件重复导入不会产生副本
// 密级必须由导入的人显式指定——默认成"内部"会把机密文档静默降级
/**
 * @param {{ upsert: (doc: ImportedDocument) => ImportedDocument }} store
 * @param {ImportOptions} [options]
 * @returns {ImportedDocument}
 */
function importBuffer(store, {
  filename, buffer, level, owner = '', now = () => new Date().toISOString(),
} = {}) {
  const safeLevel = normalizeLevel(level);
  if (!safeLevel) throw new Error(`密级必须是 ${LEVELS.join(' / ')}`);
  if (!Buffer.isBuffer(buffer)) throw new Error('缺少文件内容');
  const { title, body } = parseBuffer(buffer, filename);
  const hash = sha256Hex(buffer);
  const tenant = String(owner || '').trim();
  // 租户隔离：同一份文件被不同用户导入 → 不同 ID，互不覆盖
  const idHash = tenant ? sha256Hex(`${tenant}\n${hash}`) : hash;
  const doc = {
    id: `IMP-${idHash.slice(0, 8)}`,
    title,
    level: safeLevel,
    body,
    sourcePath: String(filename || ''),
    sha256: hash,
    importedAt: now(),
    owner: tenant,
  };
  return store.upsert(doc);
}

/**
 * @param {{ upsert: (doc: ImportedDocument) => ImportedDocument }} store
 * @param {string} filePath
 * @param {ImportOptions} [options]
 * @returns {ImportedDocument}
 */
function importFile(store, filePath, options = {}) {
  const buffer = fs.readFileSync(filePath);
  return importBuffer(store, { ...options, filename: path.resolve(filePath), buffer });
}

/** @param {DocumentStore} store @param {string} docId @returns {boolean} */
function removeFile(store, docId) {
  // 走 DocumentStore.delete 以同时清掉共享授权（v0.41），否则删除后重新导入同内容
  // 会得到同一个 ID，旧授权会被重新激活。
  if (typeof store.delete === 'function') return store.delete(docId);
  const info = store.db.prepare('DELETE FROM documents WHERE doc_id = ?').run(docId);
  return info.changes > 0;
}

module.exports = {
  LEVELS, MAX_BYTES, DocumentStore, parseFile, parseBuffer, importFile, importBuffer, removeFile,
  docxToText, readZipEntries, xmlToText, assertBufferSafe,
};
