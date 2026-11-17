'use strict';
// ============================================================
// 附件来源闭包（2026-11-17，docs/75 续）
//   用户上传的附件是裸字节，不带密级；这里按内容把它和已知文档对上：
//     1) 整文件哈希等于某文档正文 → 强匹配；
//     2) 规范化文本里出现某文档正文的前 48 个字符 → 文本匹配；
//   命中后继承该文档的密级/污点。对不上任何文档 = 「未分类」（放行但记录）。
//
// 边界：
//   - 只做文本/整文件匹配，不做语义理解；二进制文件（含 NUL）不分析内容；
//   - 部分摘录（少于 48 字符的片段）可能漏检，材料里不要宣称"能识别任意片段"；
//   - 附件无法像正文那样脱敏，所以内部级附件在外部发送时直接拒绝。
// ============================================================
const crypto = require('node:crypto');

const PREFIX_CHARS = 48;
/* 短文档（例如只有 29 字）按整段包含匹配；低于 12 字不做文本匹配，避免误报 */
const MIN_TEXT_MATCH = 12;

/** @param {Buffer} buffer @returns {string} */
function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * 尝试把附件按 UTF-8 文本解码；明显是二进制（含 NUL / 非法序列 / 不可打印比例高）返回 null。
 * @param {Buffer} buffer
 * @returns {string | null}
 */
function decodeText(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  if (sample.includes(0)) return null;
  const text = sample.toString('utf8');
  if (text.includes('�')) return null;
  let printable = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) || 0;
    if (code === 9 || code === 10 || code === 13 || code >= 32) printable += 1;
  }
  return printable / text.length >= 0.98 ? buffer.toString('utf8') : null;
}

/** @param {unknown} body @returns {string} */
function normalizeBody(body) {
  return String(body === undefined || body === null ? '' : body).replace(/\s+/g, ' ').trim();
}

/** @param {string} level @returns {number} */
function levelRank(level) {
  return level === '机密' ? 2 : level === '内部' ? 1 : level === '公开' ? 0 : -1;
}

/**
 * @typedef {{ id: string, title?: string, level?: string, body?: string, tainted?: boolean }} KnownDoc
 * @typedef {{ name: string, level: string, tainted: boolean, analyzed: boolean,
 *             matched: { id: string, title: string, level: string, tainted: boolean }[] }} AttachmentProvenance
 */

/**
 * 分析一个附件；未知密级的普通文件返回 level='未分类'。
 * @param {{ name: string, buffer: Buffer }} attachment
 * @param {KnownDoc[]} docs
 * @returns {AttachmentProvenance}
 */
function analyzeAttachment({ name, buffer }, docs) {
  const text = decodeText(buffer);
  const digest = sha256Hex(buffer);
  const normText = text === null ? '' : normalizeBody(text);
  /** @type {AttachmentProvenance['matched']} */
  const matched = [];

  for (const doc of Array.isArray(docs) ? docs : []) {
    const body = normalizeBody(doc && doc.body);
    if (body.length === 0) continue;
    const exact = text !== null && sha256Hex(Buffer.from(String(doc.body), 'utf8')) === digest;
    const needle = body.length <= PREFIX_CHARS ? body : body.slice(0, PREFIX_CHARS);
    const prefix = normText !== '' && needle.length >= MIN_TEXT_MATCH && normText.includes(needle);
    if (exact || prefix) {
      matched.push({
        id: String(doc.id || ''),
        title: String(doc.title || doc.id || ''),
        level: String(doc.level || ''),
        tainted: Boolean(doc.tainted),
      });
    }
  }

  let level = '未分类';
  let tainted = false;
  for (const m of matched) {
    if (levelRank(m.level) > levelRank(level)) level = m.level;
    if (m.tainted) tainted = true;
  }
  return { name, level, tainted, analyzed: text !== null, matched };
}

/**
 * 附件策略：污点/机密一律拒绝；内部级只在外部发送时拒绝（附件无法脱敏）。
 * @param {AttachmentProvenance[]} entries
 * @param {string} action
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function checkAttachmentPolicy(entries, action) {
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry.tainted) {
      return { ok: false, reason: `附件「${entry.name}」来源受污染（派生自被隔离的输入），拒绝发送` };
    }
    if (entry.level === '机密') {
      const titles = entry.matched.map((m) => m.title).join('、');
      return { ok: false, reason: `附件「${entry.name}」包含机密级材料${titles ? `（${titles}）` : ''}，禁止发送` };
    }
    if (entry.level === '内部' && action === 'sendExternalEmail') {
      const titles = entry.matched.map((m) => m.title).join('、');
      return { ok: false, reason: `附件「${entry.name}」包含内部级材料${titles ? `（${titles}）` : ''}，禁止外部发送（附件无法脱敏）` };
    }
  }
  return { ok: true };
}

module.exports = {
  PREFIX_CHARS,
  MIN_TEXT_MATCH,
  decodeText,
  analyzeAttachment,
  checkAttachmentPolicy,
  levelRank,
};
