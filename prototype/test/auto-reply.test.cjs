'use strict';
// 自动回信：配置 fail-closed、白名单/批量邮件判断、去重与限速、端到端冻结发送
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  parseAutoReplyConfig, evaluateAutoReply, senderAddress, normalizeMessageKey,
} = require('../src/auto-reply.cjs');
const { ConsoleService } = require('../src/console-service.cjs');

function config(overrides = {}) {
  return parseAutoReplyConfig({
    SAFE_OFFICE_AUTOREPLY: '1',
    SAFE_OFFICE_AUTOREPLY_ALLOW_TO: 'alice@partner-example.com,@corp.example',
    ...overrides,
  });
}

function ctx(overrides = {}) {
  return {
    selfAddresses: new Set(['me@corp.example']),
    now: Date.parse('2026-11-03T10:00:00Z'),
    hasReplied: () => false,
    lastReplyTo: () => null,
    countLastHour: () => 0,
    ...overrides,
  };
}

function mail(overrides = {}) {
  return {
    uid: 7,
    from: 'Alice <alice@partner-example.com>',
    subject: '项目对接',
    date: '2026-11-03T09:00:00Z',
    headers: { 'message-id': '<m-1@partner-example.com>' },
    ...overrides,
  };
}

test('配置：默认关闭；开启但白名单为空直接报错', () => {
  assert.equal(parseAutoReplyConfig({}).enabled, false);
  assert.throws(() => parseAutoReplyConfig({ SAFE_OFFICE_AUTOREPLY: '1' }), /白名单/);
  assert.throws(
    () => parseAutoReplyConfig({ SAFE_OFFICE_AUTOREPLY: '1', SAFE_OFFICE_AUTOREPLY_ALLOW_TO: 'bad' }),
    /白名单地址非法/,
  );
  const cfg = config();
  assert.deepEqual(cfg.allow, [
    { address: 'alice@partner-example.com' },
    { domain: 'corp.example' },
  ]);
  assert.equal(cfg.maxPerHour, 5);
  assert.equal(cfg.maxAgeHours, 24);
});

test('判断：白名单内个人来信才回；地址解析容忍显示名', () => {
  const cfg = config();
  assert.equal(senderAddress('Alice <ALICE@partner-example.com>'), 'alice@partner-example.com');
  assert.equal(senderAddress('bob@corp.example'), 'bob@corp.example');
  assert.equal(senderAddress('not an address'), '');
  assert.equal(evaluateAutoReply(mail(), cfg, ctx()).decision, 'reply');
  assert.equal(evaluateAutoReply(mail({ from: 'eve@evil.example' }), cfg, ctx()).reason, 'sender-not-allowed');
  assert.equal(evaluateAutoReply(mail({ from: 'me@corp.example' }), cfg, ctx()).reason, 'self');
});

test('判断：自动回复/邮件列表/批量/机器地址一律跳过', () => {
  const cfg = config();
  const cases = [
    [{ headers: { 'auto-submitted': 'auto-replied', 'message-id': '<a@x>' } }, 'auto-submitted'],
    [{ headers: { 'x-auto-response-suppress': 'all', 'message-id': '<a@x>' } }, 'auto-response-suppressed'],
    [{ headers: { 'list-id': '<list.example>', 'message-id': '<a@x>' } }, 'mailing-list'],
    [{ headers: { 'list-unsubscribe': '<mailto:u@x>', 'message-id': '<a@x>' } }, 'mailing-list'],
    [{ headers: { precedence: 'bulk', 'message-id': '<a@x>' } }, 'bulk'],
    [{ from: 'no-reply@corp.example', headers: { 'message-id': '<a@x>' } }, 'machine-sender'],
    [{ from: 'mailer-daemon@corp.example', headers: { 'message-id': '<a@x>' } }, 'machine-sender'],
  ];
  // auto-submitted: no 是正常邮件，放行
  assert.equal(evaluateAutoReply(mail({ headers: { 'auto-submitted': 'no', 'message-id': '<ok@x>' } }), cfg, ctx()).decision, 'reply');
  for (const [overrides, reason] of cases) {
    assert.equal(evaluateAutoReply(mail(overrides), cfg, ctx()).reason, reason, `${reason} 应跳过`);
  }
});

test('判断：去重、限速、时间窗口', () => {
  const cfg = config();
  const item = mail();
  const key = normalizeMessageKey(item);
  assert.match(key, /^mid:m-1@partner-example\.com$/);
  assert.equal(evaluateAutoReply(item, cfg, ctx({ hasReplied: (k) => k === key })).reason, 'duplicate');
  assert.equal(
    evaluateAutoReply(item, cfg, ctx({ lastReplyTo: () => '2026-11-03T09:30:00Z' })).reason,
    'sender-rate-limit',
  );
  assert.equal(evaluateAutoReply(item, cfg, ctx({ countLastHour: () => 5 })).reason, 'global-rate-limit');
  assert.equal(
    evaluateAutoReply(mail({ date: '2026-11-01T09:00:00Z' }), cfg, ctx()).reason,
    'too-old',
  );
  assert.equal(
    evaluateAutoReply(mail({ date: '2026-11-03T12:00:00Z' }), cfg, ctx()).reason,
    'date-in-future',
  );
  assert.equal(evaluateAutoReply(mail({ headers: {} }), cfg, ctx()).reason, 'no-message-id');
});

function fakeMailer(sent) {
  return {
    defaultName: 'work',
    list: () => [{
      name: 'work', from: 'me@corp.example', fromName: '我', host: 'smtp.example.com',
      aliases: [], hasSignature: true, default: true,
    }],
    getAccount: () => ({ name: 'work', from: 'me@corp.example', signature: '安全智慧办公' }),
    async send({ operation }) {
      sent.push(operation);
      return { status: 'sent', messageId: `<sent-${sent.length}@corp.example>` };
    },
  };
}

test('端到端：扫描 → 冻结 → 自动确认 → 发送；第二次扫描不重复', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-reply-'));
  const storeFile = path.join(dir, 'ops.db');
  const sent = [];
  const fresh = { date: new Date(Date.now() - 60 * 60 * 1000).toISOString() };
  const inboxReader = {
    async fetch({ includeHeaders }) {
      assert.equal(includeHeaders, true, '自动回信必须取安全头');
      return { items: [mail(fresh)] };
    },
  };
  const make = () => new ConsoleService({
    storeFile, inboxReader, autoReplyPolicy: config(), mailer: fakeMailer(sent),
  });
  let service = make();
  const first = await service.scanAutoReplies({ by: 'admin' });
  assert.equal(first.replied, 1);
  assert.equal(first.errors, 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].recipient, 'alice@partner-example.com');
  assert.equal(sent[0].mailAccount, 'work');
  assert.ok(sent[0].body.includes('安全智慧办公'), '签名进入正文');
  assert.equal(service.store.listOperations().length, 1);
  const op = service.store.listOperations()[0];
  assert.equal(op.createdBy, 'auto-reply');
  assert.equal(op.confirmationId, 'policy-auto-reply');

  // 同一服务再扫：duplicate
  const second = await service.scanAutoReplies({ by: 'admin' });
  assert.equal(second.replied, 0);
  assert.equal(second.reasons.duplicate, 1);
  assert.equal(sent.length, 1);
  service.close();

  // 重启后同一 Message-ID 仍不重复（占位落库）
  service = make();
  const third = await service.scanAutoReplies({ by: 'admin' });
  assert.equal(third.replied, 0);
  assert.equal(third.reasons.duplicate, 1);
  assert.equal(sent.length, 1);
  service.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('端到端：非白名单/批量邮件不发信，扫描结果如实统计', async (t) => {
  const sent = [];
  const items = [
    mail({ uid: 1, from: 'eve@evil.example', headers: { 'message-id': '<e1@evil>' } }),
    mail({ uid: 2, from: 'list@corp.example', headers: { 'list-id': '<l@x>', 'message-id': '<l1@x>' } }),
    mail({ uid: 3, from: 'me@corp.example', headers: { 'message-id': '<s1@x>' } }),
  ];
  const service = new ConsoleService({
    inboxReader: { async fetch() { return { items }; } },
    autoReplyPolicy: config(),
    mailer: fakeMailer(sent),
  });
  t.after(() => service.close());
  const res = await service.scanAutoReplies();
  assert.equal(res.replied, 0);
  assert.equal(res.skipped, 3);
  assert.equal(res.reasons['sender-not-allowed'], 1);
  assert.equal(res.reasons['mailing-list'], 1);
  assert.equal(res.reasons.self, 1);
  assert.equal(sent.length, 0);
  assert.equal(service.getAutoReplyStatus().enabled, true);
});

test('未启用时扫描直接拒绝（不静默）', async (t) => {
  const service = new ConsoleService({ inboxReader: { async fetch() { return { items: [] }; } } });
  t.after(() => service.close());
  await assert.rejects(() => service.scanAutoReplies(), /自动回信未启用/);
});
