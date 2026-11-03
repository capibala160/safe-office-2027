'use strict';
// ============================================================
// IMAP 收件箱只读同步（v0.43）
//   - 只读最近 N 封元数据 + 纯文本预览；不标记已读、不自动回复、不执行邮件内容
//   - 先读 bodyStructure，只下载选中的 text/plain（或 text/html）段，最多 256KB；
//     不下载整封邮件，也不下载附件
//   - 支持 base64 / quoted-printable / 字符集解码；HTML 去标签
//   - 邮件正文一律视为不可信输入：只做展示，绝不进入 Agent 指令通道
// 边界：不做附件下载、不做全文索引；主题可能仍是 MIME 编码原文。
// ============================================================
const { createImapConfigFromEnv } = require('./imap-poller.cjs');

let ImapFlow = null;
try {
  ({ ImapFlow } = require('imapflow'));
} catch { /* 未安装时在 fetch 处明确报错 */ }

const MAX_PREVIEW_BYTES = 256 * 1024;
const CACHE_MS = 30 * 1000;

// 自动回信安全判断需要的头：只拉这几个，不下载整封
const SAFETY_HEADERS = [
  'message-id', 'auto-submitted', 'x-auto-response-suppress',
  'list-id', 'list-unsubscribe', 'precedence', 'return-path', 'from', 'reply-to',
];

function stripHtml(text) {
  return String(text || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function headerValue(head, name) {
  const re = new RegExp(`^${name}:\\s*(.*)$`, 'im');
  const m = String(head || '').match(re);
  return m ? m[1].trim() : '';
}

// 只解析安全判断要用的头；同名头保留第一个，折叠行拼回去
function parseSafetyHeaders(raw) {
  const text = String(raw || '');
  const out = {};
  if (!text) return out;
  const unfolded = text.replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim().toLowerCase();
    if (!SAFETY_HEADERS.includes(name)) continue;
    const value = line.slice(idx + 1).trim();
    if (!(name in out)) out[name] = value;
  }
  return out;
}

function mimeOf(node) {
  if (!node) return '';
  const type = String(node.type || '').toLowerCase();
  const subtype = String(node.subtype || '').toLowerCase();
  if (type.includes('/')) return type;
  return subtype ? `${type}/${subtype}` : type;
}

function isAttachmentPart(node) {
  if (!node) return false;
  const disposition = String(node.disposition || '').toLowerCase();
  if (disposition === 'attachment') return true;
  const name = node.parameters && (node.parameters.name || node.parameters.filename);
  return !!name && disposition !== 'inline';
}

function findTextPart(node, { html = false } = {}) {
  if (!node) return null;
  // 附件整棵子树都跳过：例如 message/rfc822 附件内部的 text/plain 也不能当正文
  if (isAttachmentPart(node)) return null;
  const mime = mimeOf(node);
  const leaf = node.part || node.childNodes === undefined;
  if (leaf) {
    if (!html && mime === 'text/plain') return node;
    if (html && mime === 'text/html') return node;
  }
  for (const child of node.childNodes || []) {
    const hit = findTextPart(child, { html });
    if (hit) return hit;
  }
  return null;
}

function selectPart(root) {
  return findTextPart(root, { html: false }) || findTextPart(root, { html: true });
}

function decodeQuotedPrintable(text) {
  return String(text)
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

// imapflow.download() 已对文本段做传输编码解码 + 字符集转 UTF-8；
// 这里不能再做 base64/quoted-printable 解码，否则会把明文当编码数据二次解码。
function previewFromDownloaded(buffer, part) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  const text = bytes.toString('utf8');
  const out = mimeOf(part) === 'text/html' ? stripHtml(text) : text;
  return String(out).replace(/\s+/g, ' ').trim().slice(0, 200);
}

// 仅用于“已知未解码的原始段”（例如自建测试/非 imapflow 数据源）；
// 不要对 imapflow.download() 的输出调用。
function decodeRawBody(buffer, part) {
  const encoding = String((part && part.encoding) || '').toLowerCase();
  let bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (encoding === 'base64') {
    bytes = Buffer.from(bytes.toString('ascii').replace(/\s+/g, ''), 'base64');
  } else if (encoding === 'quoted-printable') {
    bytes = Buffer.from(decodeQuotedPrintable(bytes.toString('latin1')), 'latin1');
  }
  const charset = (part && part.parameters && (part.parameters.charset || part.parameters['charset'])) || 'utf-8';
  let text;
  try {
    text = new TextDecoder(charset).decode(bytes);
  } catch {
    text = bytes.toString('utf8');
  }
  if (mimeOf(part) === 'text/html') text = stripHtml(text);
  return String(text).replace(/\s+/g, ' ').trim().slice(0, 200);
}

async function readLimited(content, maxBytes) {
  if (!content) return Buffer.alloc(0);
  if (Buffer.isBuffer(content)) return content.subarray(0, maxBytes);
  if (typeof content[Symbol.asyncIterator] === 'function') {
    const chunks = [];
    let total = 0;
    for await (const chunk of content) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const take = Math.min(buf.length, maxBytes - total);
      chunks.push(take === buf.length ? buf : buf.subarray(0, take));
      total += take;
      if (total >= maxBytes) {
        try { if (typeof content.destroy === 'function') content.destroy(); } catch { /* ignore */ }
        break;
      }
    }
    return Buffer.concat(chunks);
  }
  return Buffer.from(String(content)).subarray(0, maxBytes);
}

async function closeClient(client, timeoutMs = 2000) {
  if (!client) return;
  let finished = false;
  try {
    const logout = typeof client.logout === 'function'
      ? Promise.resolve().then(() => client.logout())
      : Promise.resolve();
    await Promise.race([
      logout.then(() => { finished = true; }, () => { /* 失败也走强制关闭 */ }),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  } catch { /* ignore */ }
  if (!finished) {
    // logout 卡住/失败：强制关闭底层连接，避免重试时出现两个并行连接
    try { if (typeof client.close === 'function') client.close(); } catch { /* ignore */ }
  }
}

function withTimeout(promise, ms, message, onTimeout = null) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(async () => {
      try {
        if (onTimeout) await onTimeout();
      } finally {
        reject(new Error(message));
      }
    }, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function envelopeItem(uid, envelope = null, flags = null) {
  const fromBox = envelope && Array.isArray(envelope.from) ? envelope.from[0] : null;
  const from = fromBox
    ? (fromBox.name ? `${fromBox.name} <${fromBox.address || ''}>` : (fromBox.address || ''))
    : '';
  const dateRaw = envelope && envelope.date;
  return {
    uid: Number(uid),
    from,
    subject: (envelope && envelope.subject) || '(无主题)',
    date: dateRaw instanceof Date ? dateRaw.toISOString() : (dateRaw || null),
    seen: flags && typeof flags.has === 'function' ? flags.has('\\Seen') : false,
    untrusted: true,
    preview: '',
  };
}

// 兼容旧测试/调用：从原始 source 提取预览（不推荐用于大邮件）
function parseMessage(source, { uid, envelope = null, flags = null } = {}) {
  const text = String(source || '');
  const split = text.search(/\r?\n\r?\n/);
  const head = split >= 0 ? text.slice(0, split) : text;
  const body = split >= 0 ? text.slice(split).replace(/^\r?\n\r?\n/, '') : '';
  const item = envelopeItem(uid, envelope, flags);
  if (!item.from) item.from = headerValue(head, 'From');
  if (item.subject === '(无主题)') item.subject = headerValue(head, 'Subject') || '(无主题)';
  item.size = Buffer.byteLength(text, 'utf8');
  item.preview = stripHtml(body).slice(0, 200);
  return item;
}

class ImapInboxReader {
  constructor({
    config, factory = null, now = () => Date.now(), readTimeoutMs = 0, closeTimeoutMs = 0,
  } = {}) {
    if (!config || typeof config.host !== 'string') throw new TypeError('ImapInboxReader 需要 config');
    this.config = config;
    this.now = now;
    this.readTimeoutMs = Number(readTimeoutMs) > 0
      ? Number(readTimeoutMs)
      : Math.max(5000, (Number(config.timeoutMs) || 20000) * 2);
    this.closeTimeoutMs = Number(closeTimeoutMs) > 0 ? Number(closeTimeoutMs) : 2000;
    this.factory = factory || ((cfg) => {
      if (!ImapFlow) throw new Error('imapflow 未安装：npm install imapflow 后再启用 IMAP');
      return new ImapFlow({
        host: cfg.host, port: cfg.port, secure: cfg.secure,
        auth: { user: cfg.user, pass: cfg.pass },
        logger: false,
        connectionTimeout: cfg.timeoutMs,
        greetingTimeout: cfg.timeoutMs,
        socketTimeout: cfg.timeoutMs,
      });
    });
    this._cache = null;
    this._inflight = new Map();   // limit → Promise；不同条数的并发请求不能共用
  }

  async fetch({ limit = 10, refresh = false, includeHeaders = false } = {}) {
    const max = Math.min(50, Math.max(1, Number(limit) || 10));
    const withHeaders = !!includeHeaders;
    if (!refresh && this._cache && this.now() - this._cache.at < CACHE_MS
        && this._cache.limit === max && this._cache.includeHeaders === withHeaders) {
      return { ...this._cache.result, cached: true };
    }
    const key = `${max}|${withHeaders ? 'h' : ''}`;
    if (this._inflight.has(key)) return this._inflight.get(key);
    const client = this.factory(this.config);
    const task = withTimeout(
      this._fetchUncached(client, max, withHeaders),
      this.readTimeoutMs,
      '收件箱读取超时',
      () => closeClient(client, this.closeTimeoutMs),
    ).then((result) => {
      this._cache = { at: this.now(), limit: max, includeHeaders: withHeaders, result };
      return result;
    }).finally(() => { this._inflight.delete(key); });
    this._inflight.set(key, task);
    return task;
  }

  async _fetchUncached(client, max, includeHeaders = false) {
    try {
      await client.connect();
      await client.mailboxOpen(this.config.mailbox);
      let uids;
      try {
        uids = await client.search({ since: new Date(this.now() - 7 * 24 * 60 * 60 * 1000) }, { uid: true });
      } catch {
        uids = await client.search({ all: true }, { uid: true });
      }
      const list = (Array.isArray(uids) ? uids : []).map(Number)
        .filter((uid) => Number.isInteger(uid) && uid > 0)
        .sort((a, b) => a - b)
        .slice(-max);
      const items = [];
      for (const uid of list) {
        const query = { envelope: true, bodyStructure: true, flags: true };
        if (includeHeaders) query.headers = SAFETY_HEADERS;
        const msg = await client.fetchOne(uid, query, { uid: true });
        if (!msg) continue;
        const item = envelopeItem(uid, msg.envelope, msg.flags);
        item.size = Number(msg.size) || 0;
        if (includeHeaders) {
          const headers = parseSafetyHeaders(msg.headers);
          item.headers = headers;
          item.messageId = headers['message-id'] || '';
        }
        const part = selectPart(msg.bodyStructure);
        if (!part) {
          item.previewError = '没有可读文本段';
        } else if (typeof client.download !== 'function') {
          item.previewError = '服务器不支持按段下载';
        } else {
          try {
            const downloaded = await client.download(uid, String(part.part || '1'), { uid: true });
            const bytes = await readLimited(downloaded && downloaded.content, MAX_PREVIEW_BYTES);
            item.preview = previewFromDownloaded(bytes, part);
          } catch (err) {
            item.previewError = String((err && err.message) || err);
          }
        }
        items.push(item);
      }
      return {
        configured: true,
        mailbox: this.config.mailbox,
        items,
        untrusted: true,
        note: '只读：未标记已读，未执行邮件内容；只下载文本段（≤256KB）',
      };
    } finally {
      await closeClient(client, this.closeTimeoutMs);
    }
  }
}

function createInboxReaderFromEnv({ env = process.env, factory = null, now = () => Date.now() } = {}) {
  const config = createImapConfigFromEnv(env);
  if (!config) return null;
  return new ImapInboxReader({ config, factory, now });
}

module.exports = {
  ImapInboxReader, createInboxReaderFromEnv,
  parseMessage, stripHtml, selectPart, previewFromDownloaded, decodeRawBody, decodeQuotedPrintable,
  parseSafetyHeaders, SAFETY_HEADERS,
};
