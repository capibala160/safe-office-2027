'use strict';
// ============================================================
// 退信报告（DSN, RFC 3464）解析（v0.35）
//   - 纯解析：输入一封 .eml 文本，输出每收件人的投递结果；不改任何状态
//   - 识别依据：multipart/report; report-type=delivery-status，或正文里成组的
//     Final-Recipient / Action / Status（兼容无 MIME 的简版退信）
//   - 原信 Message-ID：内嵌 message/rfc822 的原信头 > Original-Message-ID
//   - 边界：不做 IMAP/POP3 收信；.eml 由人工或外部流程导入
// ============================================================

// 头字段解析：支持折行（续行以空白开头）与重复字段合并
function parseHeaders(text) {
  const headers = {};
  let last = null;
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    if (rawLine === '') { last = null; continue; }
    if (/^[ \t]/.test(rawLine) && last) {
      headers[last] += ` ${rawLine.trim()}`;
      continue;
    }
    const idx = rawLine.indexOf(':');
    if (idx <= 0) { last = null; continue; }
    const name = rawLine.slice(0, idx).trim().toLowerCase();
    const value = rawLine.slice(idx + 1).trim();
    headers[name] = headers[name] === undefined ? value : `${headers[name]}, ${value}`;
    last = name;
  }
  return headers;
}

function splitMessage(text) {
  const src = String(text || '');
  const m = /\r?\n\r?\n/.exec(src);
  if (!m) return { headers: parseHeaders(src), body: '' };
  return {
    headers: parseHeaders(src.slice(0, m.index)),
    body: src.slice(m.index + m[0].length),
  };
}

function parseContentType(value) {
  const out = { type: '', params: {} };
  const src = String(value || '').trim();
  if (!src) return out;
  const parts = src.split(';');
  out.type = parts[0].trim().toLowerCase();
  for (const part of parts.slice(1)) {
    const m = /^\s*([^=]+)=\s*(?:"([^"]*)"|([^;]*))\s*$/.exec(part);
    if (m) out.params[m[1].trim().toLowerCase()] = (m[2] !== undefined ? m[2] : m[3]).trim();
  }
  return out;
}

function splitMultipart(body, boundary) {
  const parts = [];
  if (!boundary) return parts;
  const segments = String(body || '').split(`--${boundary}`);
  for (let i = 1; i < segments.length; i += 1) {
    let seg = segments[i];
    if (/^--/.test(seg)) break;                    // 结束标记 --boundary--
    seg = seg.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
    parts.push(splitMessage(seg));
  }
  return parts;
}

// delivery-status 正文按空行分块：第一块是报文级（Reporting-MTA 等），
// 之后每个收件人一块。没有 Final-Recipient 的块不要。
function parseStatusBlocks(body) {
  const blocks = [];
  for (const chunk of String(body || '').split(/\r?\n\r?\n+/)) {
    if (!chunk.trim()) continue;
    const h = parseHeaders(chunk);
    if (h['final-recipient'] || h['original-recipient'] || h['action'] || h['status']) blocks.push(h);
  }
  return blocks;
}

function normalizeMessageId(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const angle = /<([^<>]+)>/.exec(raw);
  const id = (angle ? angle[1] : raw).trim();
  return id ? id.toLowerCase() : '';
}

function extractMessageIds(value) {
  const src = String(value || '').trim();
  if (!src) return [];
  const ids = [];
  const re = /<([^<>]+)>/g;
  let m;
  while ((m = re.exec(src))) {
    const id = normalizeMessageId(m[1]);
    if (id && !ids.includes(id)) ids.push(id);
  }
  if (ids.length === 0) {
    const id = normalizeMessageId(src);
    if (id) ids.push(id);
  }
  return ids;
}

function stripAddress(value) {
  const raw = String(value || '').trim();
  // Final-Recipient: rfc822; user@example.com
  const m = /^\s*[a-z0-9-]+\s*;\s*(.+)$/i.exec(raw);
  return (m ? m[1] : raw).trim().replace(/^<|>$/g, '').trim();
}

function stripDiagnostic(value) {
  const raw = String(value || '').trim();
  const m = /^\s*[a-z0-9-]+\s*;\s*([\s\S]+)$/i.exec(raw);
  return (m ? m[1] : raw).trim();
}

// 传输编码解码：目前只处理 base64（QQ 把原信放在 application/octet-stream）
function decodeTransferBody(part) {
  const enc = String(part.headers['content-transfer-encoding'] || '').toLowerCase();
  if (enc === 'base64') {
    try { return Buffer.from(String(part.body).replace(/\s+/g, ''), 'base64').toString('utf8'); } catch { return part.body; }
  }
  return part.body;
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|tr|div|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .trim();
}

// QQ 退信没有 message/delivery-status：关键信息在 HTML 正文里。
// 例：无法发送到 x@y ... 退信原因 ... host mx[...] said: 550-5.1.1 ...
function extractHtmlBounceFact(html) {
  const text = htmlToText(html);
  const recipientMatch = /无法发送到\s*([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+)/.exec(text)
    || /收件人邮件地址[（(]([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+)[）)]/.exec(text);
  if (!recipientMatch) return null;
  const statusMatch = /\b([45]\.\d{1,3}\.\d{1,3})\b/.exec(text);
  let diagnostic = '';
  const said = /host\s+[^\s]+(?:\s*\[[^\]]*\])?\s*said:\s*([\s\S]+?)(?:\s+解决方案|$)/i.exec(text);
  if (said) diagnostic = said[1];
  else {
    const reason = /退信原因\s*([\s\S]+?)(?:\s+host\s|\s+解决方案|$)/.exec(text);
    if (reason) diagnostic = reason[1];
  }
  return {
    recipient: recipientMatch[1].toLowerCase(),
    action: 'failed',
    status: statusMatch ? statusMatch[1] : '',
    diagnostic: diagnostic.replace(/\s+/g, ' ').trim().slice(0, 500),
  };
}

// 递归收集：退信状态块 + 内嵌原信头 + HTML 退信信息
function collectParts(part, acc) {
  const ct = parseContentType(part.headers['content-type']);
  if (ct.type.startsWith('multipart/')) {
    for (const child of splitMultipart(part.body, ct.params.boundary)) collectParts(child, acc);
    return acc;
  }
  if (ct.type === 'message/delivery-status') {
    acc.statusBlocks.push(...parseStatusBlocks(decodeTransferBody(part)));
    return acc;
  }
  if (ct.type === 'message/rfc822' || ct.type === 'text/rfc822-headers') {
    const embedded = splitMessage(decodeTransferBody(part));
    acc.embeddedHeaders.push(embedded.headers);
    return acc;
  }
  // QQ/部分 MTA：原信以 base64 附件形式内嵌
  if (ct.type === 'application/octet-stream' || ct.type === 'application/rfc822') {
    const embedded = splitMessage(decodeTransferBody(part));
    if (Object.keys(embedded.headers).some((k) => k === 'message-id' || k === 'x-idempotency-key')) {
      acc.embeddedHeaders.push(embedded.headers);
    }
    return acc;
  }
  if (ct.type === 'text/html') {
    const fact = extractHtmlBounceFact(part.body);
    if (fact) acc.htmlFacts.push(fact);
    return acc;
  }
  // 没有 MIME 结构的简版退信：正文里直接给状态块
  if (!ct.type || ct.type === 'text/plain') {
    const blocks = parseStatusBlocks(part.body).filter((b) => b['final-recipient']);
    acc.statusBlocks.push(...blocks);
  }
  return acc;
}

function parseDsn(text) {
  const src = String(text || '');
  const top = splitMessage(src);
  const topType = parseContentType(top.headers['content-type']);
  const acc = { statusBlocks: [], embeddedHeaders: [], htmlFacts: [] };

  if (topType.type.startsWith('multipart/')) {
    for (const part of splitMultipart(top.body, topType.params.boundary)) collectParts(part, acc);
  } else if (topType.type === 'message/delivery-status' || topType.type === '') {
    acc.statusBlocks.push(...parseStatusBlocks(top.body));
  } else {
    collectParts(top, acc);
  }

  // 报文级 Message-ID：内嵌原信头优先，其次 Original-Message-ID
  const messageIds = [];
  const pushIds = (value) => {
    for (const id of extractMessageIds(value)) if (!messageIds.includes(id)) messageIds.push(id);
  };
  for (const headers of acc.embeddedHeaders) pushIds(headers['message-id']);
  pushIds(top.headers['original-message-id']);
  pushIds(top.headers['x-original-message-id']);
  for (const block of acc.statusBlocks) pushIds(block['original-message-id']);

  // 幂等键：我们发信时写入的 X-Idempotency-Key（= operationHash）。
  // 部分 MTA（QQ）会改写 Message-ID，但会保留这个自定义头，作为可靠回退匹配键。
  const idempotencyKeys = [];
  for (const headers of acc.embeddedHeaders) {
    const raw = String(headers['x-idempotency-key'] || '').trim().toLowerCase();
    if (/^[0-9a-f]{64}$/.test(raw) && !idempotencyKeys.includes(raw)) idempotencyKeys.push(raw);
  }

  const reports = [];
  for (const block of acc.statusBlocks) {
    const recipient = stripAddress(block['final-recipient'] || block['original-recipient'] || '');
    if (!recipient && !block['status']) continue;
    const action = String(block.action || '').trim().toLowerCase();
    const status = String(block.status || '').trim();
    reports.push({
      recipient,
      action,
      status,
      hardFail: /^5\./.test(status),
      diagnostic: stripDiagnostic(block['diagnostic-code'] || ''),
      remoteMta: stripAddress(block['remote-mta'] || ''),
      // v0.35 的匹配只认报文级 Message-ID；逐条报告不再单独取
      messageIds: [],
    });
  }

  // 没有标准 delivery-status 块（如 QQ 退信）：用 HTML 里的事实补报告
  if (reports.length === 0) {
    for (const fact of acc.htmlFacts) {
      if (reports.some((r) => r.recipient === fact.recipient && r.action === fact.action)) continue;
      reports.push({
        recipient: fact.recipient,
        action: fact.action,
        status: fact.status,
        hardFail: /^5\./.test(fact.status),
        diagnostic: fact.diagnostic,
        remoteMta: '',
        messageIds: [],
      });
    }
  }

  for (const report of reports) {
    report.messageIds = [...messageIds];
    report.idempotencyKeys = [...idempotencyKeys];
  }

  const isDsn = reports.length > 0 ||
    topType.params['report-type'] === 'delivery-status' ||
    /message\/delivery-status/i.test(src);

  const failed = reports.filter((r) => r.action === 'failed');
  const delayed = reports.filter((r) => r.action === 'delayed');
  let reportType = 'other';
  if (failed.length > 0) reportType = 'failure';
  else if (delayed.length > 0) reportType = 'delay';
  else if (reports.length > 0) reportType = 'delivery';

  return {
    isDsn,
    reportType,
    messageIds,
    idempotencyKeys,
    reports,
    failedRecipients: failed.map((r) => r.recipient).filter(Boolean),
    delayedRecipients: delayed.map((r) => r.recipient).filter(Boolean),
  };
}

module.exports = { parseDsn, parseHeaders, splitMessage, parseContentType, normalizeMessageId };
