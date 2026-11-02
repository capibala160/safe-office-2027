'use strict';
// 收件箱只读同步：解析、限流、绝不标记已读
const test = require('node:test');
const assert = require('node:assert');
const {
  ImapInboxReader, parseMessage, stripHtml, previewFromDownloaded, decodeRawBody,
  decodeQuotedPrintable, selectPart,
} = require('../src/imap-inbox.cjs');

test('收件箱解析：envelope 优先、HTML 去标签、正文截断、untrusted 标记', () => {
  const source = 'From: raw@example.com\r\nSubject: raw\r\n\r\n<html><body><p>Hello&nbsp;World</p><script>x()</script></body></html>';
  const item = parseMessage(source, {
    uid: 7,
    envelope: { from: [{ name: 'Alice', address: 'alice@example.com' }], subject: '周报', date: new Date('2026-11-02T00:00:00Z') },
    flags: new Set(),
  });
  assert.equal(item.uid, 7);
  assert.equal(item.from, 'Alice <alice@example.com>');
  assert.equal(item.subject, '周报');
  assert.equal(item.date, '2026-11-02T00:00:00.000Z');
  assert.equal(item.untrusted, true);
  assert.ok(item.preview.includes('Hello World'));
  assert.ok(!item.preview.includes('<'));
  assert.equal(stripHtml('<b>x</b>'), 'x');
});

test('MIME 解码：download 已解码，不得二次解码；原始段按需解码', () => {
  const base64 = Buffer.from('中文正文', 'utf8').toString('base64');
  assert.equal(decodeRawBody(Buffer.from(base64), {
    type: 'text/plain', encoding: 'base64', parameters: { charset: 'utf-8' },
  }), '中文正文');
  assert.equal(decodeQuotedPrintable('Hello=20World=0A'), 'Hello World\n');
  // 回归：imapflow.download() 返回的已是 UTF-8 明文，即使 part.encoding 仍写 base64
  assert.equal(previewFromDownloaded(Buffer.from('Hello office'), {
    type: 'text/plain', encoding: 'base64', parameters: { charset: 'utf-8' },
  }), 'Hello office', '不能把已解码明文再当 base64 解');
  assert.equal(previewFromDownloaded(Buffer.from('<b>Hello</b>'), { type: 'text/html' }), 'Hello');
  const tree = {
    type: 'multipart/alternative',
    childNodes: [
      { type: 'text/html', part: '1.1', encoding: '7bit' },
      { type: 'text/plain', part: '1.2', encoding: '7bit' },
    ],
  };
  assert.equal(selectPart(tree).part, '1.2', '优先 text/plain');
});

test('正文选择：跳过 disposition: attachment 的文本附件', () => {
  const tree = {
    type: 'multipart/mixed',
    childNodes: [
      { type: 'text/html', part: '1', disposition: 'inline', encoding: '7bit' },
      {
        type: 'text/plain', part: '2', disposition: 'attachment',
        parameters: { name: 'notes.txt' }, encoding: 'base64',
      },
    ],
  };
  assert.equal(selectPart(tree).part, '1', '应选 HTML 正文而不是 TXT 附件');
});

test('正文选择：附件子树（message/rfc822）内部文本也不能当正文', () => {
  const tree = {
    type: 'multipart/mixed',
    childNodes: [
      { type: 'text/html', part: '1', disposition: 'inline', encoding: '7bit' },
      {
        type: 'message/rfc822', part: '2', disposition: 'attachment',
        parameters: { name: 'forwarded.eml' },
        childNodes: [{ type: 'text/plain', part: '2.1', encoding: '7bit' }],
      },
    ],
  };
  assert.equal(selectPart(tree).part, '1', '不能选附件内部的 text/plain');
});

test('收件箱读取：只下载文本段、展示已解码内容、不标已读、退出时 logout', async () => {
  const calls = [];
  // imapflow.download() 返回的是已解码 UTF-8（不是 base64）
  const decoded = Buffer.from('Hello 世界', 'utf8');
  const client = {
    async connect() { calls.push('connect'); },
    async mailboxOpen(mailbox) { calls.push(`open:${mailbox}`); },
    async search() { return [1, 2, 3, 4]; },
    async fetchOne(uid, options) {
      assert.equal(options.source, undefined, '不能下载整封原始邮件');
      assert.equal(options.bodyStructure, true);
      return {
        size: 1234,
        envelope: { from: [{ address: 'a@b' }], subject: `s${uid}`, date: new Date('2026-11-02T00:00:00Z') },
        bodyStructure: {
          type: 'text', subtype: 'plain', part: '1', encoding: 'base64', parameters: { charset: 'utf-8' },
        },
        flags: new Set(),
      };
    },
    async download(uid, part) { calls.push(`download:${uid}:${part}`); return { content: Buffer.from(decoded) }; },
    async logout() { calls.push('logout'); },
    async messageFlagsAdd() { calls.push('MARK_SEEN'); },
  };
  const reader = new ImapInboxReader({
    config: { host: 'imap.example.com', port: 993, secure: true, user: 'u', pass: 'p', mailbox: 'INBOX', timeoutMs: 1000 },
    factory: () => client,
  });
  const res = await reader.fetch({ limit: 2 });
  assert.equal(res.configured, true);
  assert.equal(res.items.length, 2);
  assert.deepEqual(res.items.map((i) => i.uid), [3, 4]);
  assert.equal(res.items[0].preview, 'Hello 世界');
  assert.ok(calls.includes('download:3:1'));
  assert.ok(!calls.includes('MARK_SEEN'), '收件箱同步不能标记已读');
  assert.ok(calls.includes('logout'));
});

test('读取超时：logout 卡住时强制 close，重试建立新连接', async () => {
  let clients = 0;
  let logouts = 0;
  let forcedClose = 0;
  const factory = () => {
    clients += 1;
    return {
      async connect() {},
      async mailboxOpen() {},
      search() { return new Promise(() => {}); },   // 永不返回
      async fetchOne() { return {}; },
      async download() { return { content: Buffer.alloc(0) }; },
      logout() { logouts += 1; return new Promise(() => {}); },  // 卡住
      close() { forcedClose += 1; },
    };
  };
  const reader = new ImapInboxReader({
    config: { host: 'x', port: 993, secure: true, user: 'u', pass: 'p', mailbox: 'INBOX', timeoutMs: 1000 },
    factory,
    readTimeoutMs: 40,
    closeTimeoutMs: 20,
  });
  await assert.rejects(() => reader.fetch({ limit: 1 }), /收件箱读取超时/);
  assert.ok(logouts >= 1, '超时必须尝试 logout');
  assert.ok(forcedClose >= 1, 'logout 卡住时必须强制 close');
  const before = clients;
  await assert.rejects(() => reader.fetch({ limit: 1 }), /收件箱读取超时/);
  assert.equal(clients, before + 1, '重试应建立新连接');
});

test('并发不同条数：不能共用同一个 _inflight 结果', async () => {
  let clients = 0;
  const makeClient = () => {
    clients += 1;
    return {
      async connect() {},
      async mailboxOpen() {},
      async search() { return Array.from({ length: 12 }, (_, i) => i + 1); },
      async fetchOne(uid) {
        return {
          envelope: { from: [{ address: 'a@b' }], subject: `s${uid}`, date: new Date('2026-11-02T00:00:00Z') },
          bodyStructure: { type: 'text', subtype: 'plain', part: '1', encoding: '7bit' },
          flags: new Set(),
        };
      },
      async download() { return { content: Buffer.from('hello') }; },
      async logout() {},
    };
  };
  const reader = new ImapInboxReader({
    config: { host: 'x', port: 993, secure: true, user: 'u', pass: 'p', mailbox: 'INBOX', timeoutMs: 1000 },
    factory: makeClient,
    readTimeoutMs: 2000,
  });
  const [one, ten] = await Promise.all([reader.fetch({ limit: 1 }), reader.fetch({ limit: 10 })]);
  assert.equal(one.items.length, 1);
  assert.equal(ten.items.length, 10);
  assert.equal(clients, 2, '不同条数应各建一个连接，不能共用 inflight');
});
