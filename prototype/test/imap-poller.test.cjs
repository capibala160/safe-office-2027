'use strict';
// IMAP 退信轮询测试（v0.39）
//   覆盖：只处理 DSN/标已读、普通邮件不动、失败重试、并发保护、配置解析、控制台集成
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ImapBouncePoller, createImapConfigFromEnv,
} = require('../src/imap-poller.cjs');
const { ConsoleService } = require('../src/console-service.cjs');

function dsn({ messageId = '<x@example.com>' } = {}) {
  const B = 'B';
  return [
    'From: Mail Delivery Subsystem <mailer-daemon@example.com>',
    'Subject: Delivery Status Notification',
    'Content-Type: multipart/report; report-type=delivery-status; boundary="B"',
    '',
    `--${B}`,
    'Content-Type: message/delivery-status',
    '',
    'Reporting-MTA: dns; mx.example.com',
    '',
    'Final-Recipient: rfc822; nobody@example.com',
    'Action: failed',
    'Status: 5.1.1',
    'Diagnostic-Code: smtp; 550 5.1.1 unknown user',
    '',
    `--${B}`,
    'Content-Type: message/rfc822',
    '',
    `Message-ID: ${messageId}`,
    '',
    `--${B}--`,
    '',
  ].join('\r\n');
}

const normalMail = [
  'From: alice@example.com',
  'To: me@example.com',
  'Subject: 周报',
  'Content-Type: text/plain',
  '',
  '本周完成…',
].join('\r\n');

const CONFIG = {
  host: 'imap.test', port: 993, secure: true, user: 'u', pass: 'p',
  mailbox: 'INBOX', pollMs: 60000, maxPerPoll: 20, timeoutMs: 1000,
};

function makeClient(messages, { failFetch = new Set() } = {}) {
  const seen = new Set();
  return {
    seen,
    fetchCount: 0,
    async connect() {},
    async mailboxOpen() {},
    async search(query = {}) {
      return messages.filter((m) => {
        if (query.seen === false && !seen.has(m.uid)) return true;
        if (query.since) return true;   // 假客户端：最近窗口内全返回
        const src = String(m.source);
        if (query.subject && src.includes(query.subject)) return true;
        if (query.from && src.toLowerCase().includes(String(query.from).toLowerCase())) return true;
        return false;
      }).map((m) => m.uid);
    },
    async fetchOne(uid) {
      this.fetchCount += 1;
      if (failFetch.has(uid)) throw new Error('fetch boom');
      const msg = messages.find((m) => m.uid === uid);
      return { source: Buffer.from(msg.source, 'utf8') };
    },
    async messageFlagsAdd(uid) { seen.add(uid); },
    async logout() {},
  };
}

test('轮询：DSN 才处理并标已读，普通邮件不标已读', async () => {
  const messages = [
    { uid: 1, source: dsn() },
    { uid: 2, source: normalMail },
  ];
  const client = makeClient(messages);
  const ingested = [];
  const poller = new ImapBouncePoller({
    config: CONFIG,
    factory: () => client,
    ingest: (eml) => {
      ingested.push(eml);
      return { ok: true, summary: { bounced: 1, duplicate: 0, unmatched: 0, ignored: 0 } };
    },
  });

  const result = await poller.poll();
  assert.equal(result.scanned, 2);
  assert.equal(result.dsn, 1);
  assert.equal(result.bounced, 1);
  assert.equal(result.ignored, 1);
  assert.equal(result.markedSeen, 1);
  assert.equal(ingested.length, 1, '只把退信交给回填');
  assert.deepEqual([...client.seen], [1], '普通邮件不标已读');
  assert.ok(poller.state.lastAt);
  assert.equal(poller.state.totalBounced, 1);
});

test('轮询：回填抛错不标已读，下一轮还会重试', async () => {
  const client = makeClient([{ uid: 7, source: dsn() }]);
  const poller = new ImapBouncePoller({
    config: CONFIG,
    factory: () => client,
    ingest: () => { throw new Error('回填炸了'); },
  });
  const result = await poller.poll();
  assert.equal(result.errors, 1);
  assert.equal(result.markedSeen, 0);
  assert.deepEqual([...client.seen], []);
  assert.match(poller.state.lastError, /回填炸了/);
});

test('轮询：取信失败只计数，不阻塞其余邮件', async () => {
  const client = makeClient([
    { uid: 1, source: dsn() },
    { uid: 2, source: dsn() },
  ], { failFetch: new Set([1]) });
  const poller = new ImapBouncePoller({
    config: CONFIG,
    factory: () => client,
    ingest: () => ({ ok: true, summary: { bounced: 1, duplicate: 0, unmatched: 0, ignored: 0 } }),
  });
  const result = await poller.poll();
  assert.equal(result.errors, 1);
  assert.equal(result.bounced, 1);
  assert.deepEqual([...client.seen], [2]);
});

test('并发保护：同一时刻只跑一轮', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const client = makeClient([{ uid: 1, source: normalMail }]);
  client.connect = () => gate;
  const poller = new ImapBouncePoller({
    config: CONFIG,
    factory: () => client,
    ingest: () => ({ ok: true, summary: { bounced: 0 } }),
  });
  const first = poller.poll();
  const second = await poller.poll();
  assert.deepEqual(second, { skipped: 'running' });
  release();
  const result = await first;
  assert.equal(result.scanned, 1);
});

test('配置解析：未配 host 返回 null；缺凭据/默认值按口径', () => {
  assert.equal(createImapConfigFromEnv({}), null);
  assert.throws(
    () => createImapConfigFromEnv({ SAFE_OFFICE_IMAP_HOST: 'imap.qq.com' }),
    /缺少 SAFE_OFFICE_IMAP_USER/,
  );
  const cfg = createImapConfigFromEnv({
    SAFE_OFFICE_IMAP_HOST: 'imap.qq.com',
    SAFE_OFFICE_IMAP_USER: 'u@qq.com',
    SAFE_OFFICE_IMAP_PASS: 'p',
    SAFE_OFFICE_IMAP_POLL_MS: '100',
  });
  assert.equal(cfg.port, 993);
  assert.equal(cfg.secure, true);
  assert.equal(cfg.mailbox, 'INBOX');
  assert.equal(cfg.pollMs, 10000, '轮询间隔下限 10s');
});

test('控制台：手动轮询写入审计；未配置 IMAP 明确拒绝', async (t) => {
  let service;
  const client = makeClient([{ uid: 3, source: dsn({ messageId: '<never-sent@example.com>' }) }]);
  const poller = new ImapBouncePoller({
    config: CONFIG,
    factory: () => client,
    ingest: (eml) => service.ingestBounce({ eml, by: 'imap' }),
  });
  service = new ConsoleService({ bouncePoller: poller, now: () => Date.now() });
  t.after(() => service.close());

  const res = await service.pollBounceNow({ by: 'auditor' });
  assert.equal(res.ok, true);
  assert.equal(res.result.dsn, 1);
  assert.equal(res.result.unmatched, 1, '找不到发件记录也不猜');
  assert.ok(service.audit.entries.some((e) => e.kind === 'IMAP 手动轮询'));
  assert.ok(service.audit.entries.some((e) => e.kind === '退信未回填'));
  const gov = service.getGovernance();
  assert.equal(gov.bouncePoll.configured, true);
  assert.equal(gov.bouncePoll.mailbox, 'INBOX');

  const bare = new ConsoleService({ now: () => Date.now(), bouncePoller: null });
  t.after(() => bare.close());
  // 本机没有 IMAP 环境变量时，未配置应 409 拒绝
  if (!process.env.SAFE_OFFICE_IMAP_HOST) {
    await assert.rejects(() => bare.pollBounceNow(), /IMAP 未配置/);
    assert.equal(bare.getGovernance().bouncePoll.configured, false);
  }
});

// ---------- v0.40.1 回归：普通邮件积压不能把退信饿死 ----------
test('回归：25 封未读普通邮件 + 1 封退信，前 20 封占满窗口也不漏退信', async (t) => {
  const messages = [];
  for (let uid = 1; uid <= 25; uid += 1) messages.push({ uid, source: normalMail });
  messages.push({ uid: 26, source: dsn({ messageId: '<late@example.com>' }) });
  const client = makeClient(messages);
  const poller = new ImapBouncePoller({
    config: { ...CONFIG, maxPerPoll: 20 },
    factory: () => client,
    ingest: () => ({ ok: true, summary: { bounced: 1, duplicate: 0, unmatched: 0, ignored: 0 } }),
  });

  const first = await poller.poll();
  assert.equal(first.scanned, 20);
  assert.equal(first.dsn, 0, '第一轮全是普通邮件');
  assert.equal(first.ignored, 20);
  assert.deepEqual([...client.seen], [], '普通邮件不标已读');

  const second = await poller.poll();
  assert.equal(second.dsn, 1, '第二轮必须轮到后面的退信');
  assert.equal(second.markedSeen, 1);
  assert.deepEqual([...client.seen], [26]);

  const before = client.fetchCount;
  const third = await poller.poll();
  assert.equal(third.scanned, 0, '普通邮件已记住，不再重复抓取');
  assert.equal(client.fetchCount, before);
});

test('轮转：退信多于单轮上限时分批处理', async () => {
  const messages = [
    { uid: 1, source: dsn({ messageId: '<a@example.com>' }) },
    { uid: 2, source: dsn({ messageId: '<b@example.com>' }) },
    { uid: 3, source: dsn({ messageId: '<c@example.com>' }) },
  ];
  const client = makeClient(messages);
  const poller = new ImapBouncePoller({
    config: { ...CONFIG, maxPerPoll: 2 },
    factory: () => client,
    ingest: () => ({ ok: true, summary: { bounced: 1, duplicate: 0, unmatched: 0, ignored: 0 } }),
  });
  const first = await poller.poll();
  assert.equal(first.dsn, 2);
  const second = await poller.poll();
  assert.equal(second.dsn, 1);
  assert.deepEqual([...client.seen].sort(), [1, 2, 3]);
});

test('回归：用户先点开过退信（已读）也要能处理', async () => {
  const client = makeClient([{ uid: 1, source: dsn() }]);
  client.seen.add(1);   // 已读：用户先在邮箱里点开过
  const poller = new ImapBouncePoller({
    config: CONFIG,
    factory: () => client,
    ingest: () => ({ ok: true, summary: { bounced: 1, duplicate: 0, unmatched: 0, ignored: 0 } }),
  });
  const result = await poller.poll();
  assert.equal(result.dsn, 1, '已读退信不能漏');
  assert.equal(result.markedSeen, 1);
  const second = await poller.poll();
  assert.equal(second.scanned, 0, '处理过的退信不重复抓取');
});
