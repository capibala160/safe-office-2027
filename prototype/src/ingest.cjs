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

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// ---------- ZIP（只够读 docx） ----------
const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

function findEocd(buffer) {
  const min = Math.max(0, buffer.length - 65557);
  for (let i = buffer.length - 22; i >= min; i -= 1) {
    if (buffer.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

// 返回 Map<name, Buffer>：只解压未加密的 stored/deflate 条目
function readZipEntries(buffer) {
  const eocd = findEocd(buffer);
  if (eocd < 0) throw new Error('不是合法的 ZIP/docx 文件');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== SIG_CENTRAL) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLen);
    offset += 46 + nameLen + extraLen + commentLen;

    if (buffer.readUInt32LE(localOffset) !== SIG_LOCAL) continue;
    const localNameLen = buffer.readUInt16LE(localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLen + localExtraLen;
    const data = buffer.subarray(start, start + compressedSize);
    try {
      entries.set(name, method === 0 ? Buffer.from(data) : zlib.inflateRawSync(data));
    } catch { /* 损坏条目跳过，别让整份文件失败 */ }
  }
  return entries;
}

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
function xmlToText(xml) {
  return decodeXmlEntities(
    xml
      .replace(/<w:tab\b[^>]*\/>/g, '\t')
      .replace(/<w:br\b[^>]*\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]+>/g, ''),
  );
}

function docxToText(buffer) {
  const entries = readZipEntries(buffer);
  const main = entries.get('word/document.xml');
  if (!main) throw new Error('docx 里找不到 word/document.xml');
  return xmlToText(main.toString('utf8')).replace(/\n{3,}/g, '\n\n').trim();
}

// ---------- 文件解析 ----------
function parseFile(filePath) {
  const buffer = fs.readFileSync(filePath);
  if (buffer.length > MAX_BYTES) throw new Error(`文件超过 ${MAX_BYTES / 1024 / 1024}MB，拒绝导入`);
  const ext = path.extname(filePath).toLowerCase();
  let body;
  if (ext === '.docx') body = docxToText(buffer);
  else if (ext === '.txt' || ext === '.md' || ext === '.markdown' || ext === '') {
    body = buffer.toString('utf8').replace(/^﻿/, '').trim();
  } else {
    throw new Error(`暂不支持 ${ext}；请另存为 .txt / .md / .docx`);
  }
  if (!body) throw new Error('文件没有可用正文');
  const firstLine = body.split('\n').map((line) => line.trim()).find(Boolean) || '';
  const title = (firstLine.replace(/^#+\s*/, '').slice(0, 40)) || path.basename(filePath, ext);
  return { title, body, ext };
}

function normalizeLevel(level) {
  return LEVELS.includes(level) ? level : null;
}

// ---------- 存储 ----------
class DocumentStore {
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
        imported_at TEXT NOT NULL
      );
    `);
  }

  upsert(doc) {
    this.db.prepare(`
      INSERT INTO documents (doc_id, title, level, body, source_path, sha256, imported_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(doc_id) DO UPDATE SET
        title = excluded.title, level = excluded.level, body = excluded.body,
        source_path = excluded.source_path, sha256 = excluded.sha256, imported_at = excluded.imported_at
    `).run(doc.id, doc.title, doc.level, doc.body, doc.sourcePath, doc.sha256, doc.importedAt);
    return doc;
  }

  list() {
    return this.db.prepare(`
      SELECT doc_id, title, level, body, source_path, sha256, imported_at FROM documents ORDER BY imported_at
    `).all().map((row) => ({
      id: row.doc_id,
      title: row.title,
      level: row.level,
      body: row.body,
      sourcePath: row.source_path,
      sha256: row.sha256,
      importedAt: row.imported_at,
    }));
  }

  get(docId) {
    const row = this.db.prepare('SELECT * FROM documents WHERE doc_id = ?').get(docId);
    if (!row) return null;
    return {
      id: row.doc_id, title: row.title, level: row.level, body: row.body,
      sourcePath: row.source_path, sha256: row.sha256, importedAt: row.imported_at,
    };
  }

  close() {
    try { this.db.close(); } catch { /* ignore */ }
  }
}

// 导入一个文件：id 由内容哈希派生，同一份文件重复导入不会产生副本
// 密级必须由导入的人显式指定——默认成"内部"会把机密文档静默降级
function importFile(store, filePath, { level, now = () => new Date().toISOString() } = {}) {
  const safeLevel = normalizeLevel(level);
  if (!safeLevel) throw new Error(`密级必须是 ${LEVELS.join(' / ')}`);
  const buffer = fs.readFileSync(filePath);
  const { title, body } = parseFile(filePath);
  const hash = sha256Hex(buffer);
  const doc = {
    id: `IMP-${hash.slice(0, 8)}`,
    title,
    level: safeLevel,
    body,
    sourcePath: path.resolve(filePath),
    sha256: hash,
    importedAt: now(),
  };
  return store.upsert(doc);
}

function removeFile(store, docId) {
  const info = store.db.prepare('DELETE FROM documents WHERE doc_id = ?').run(docId);
  return info.changes > 0;
}

module.exports = {
  LEVELS, DocumentStore, parseFile, importFile, removeFile,
  docxToText, readZipEntries, xmlToText,
};
