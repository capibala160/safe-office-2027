'use strict';
// 退信报告（DSN）解析与回填测试（v0.35）
//   覆盖：标准 multipart/report、多收件人、延迟通知、无 MIME 简版、
//         按 Message-ID 回填、重复导入幂等、unknown/failed 行为
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDsn, normalizeMessageId } = require('../src/dsn.cjs');
const { OperationStore } = require('../src/store.cjs');
const { FulfillmentService } = require('../src/fulfillment.cjs');
const { FakeMailer } = require('../src/mailer.cjs');
const { ConsoleService } = require('../src/console-service.cjs');

function makeInput(overrides = {}) {
  const now = Date.now();
  return {
    taskId: 'T-DSN',
    action: 'sendExternalEmail',
    protocolAction: 1,
    tool: 'sendExternalEmail',
    recipient: 'partner@example.com',
    subject: '退信测试',
    body: '正文',
    sourceDocIds: ['M2'],
    level: '内部',
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    ...overrides,
  };
}

// Gmail 风格退信：X-Failed-Recipients + message/delivery-status + 内嵌原信
function gmailDsn({
  messageId = '<abc123@qq.com>',
  recipient = 'partner@example.com',
  status = '5.1.1',
  action = 'failed',
  diagnostic = 'smtp; 550-5.1.1 The email account that you tried to reach does not exist',
} = {}) {
  const B = 'BOUNDARY-123';
  return [
    'From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>',
    'To: sender@example.com',
    'Subject: Delivery Status Notification',
    'MIME-Version: 1.0',
    `X-Failed-Recipients: ${recipient}`,
    'Auto-Submitted: auto-replied',
    `Content-Type: multipart/report; report-type=delivery-status; boundary="${B}"`,
    '',
    `--${B}`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    '** Address not found **',
    '',
    `--${B}`,
    'Content-Type: message/delivery-status',
    '',
    'Reporting-MTA: dns; googlemail.com',
    '',
    `Final-Recipient: rfc822; ${recipient}`,
    `Action: ${action}`,
    `Status: ${status}`,
    `Diagnostic-Code: ${diagnostic}`,
    'Remote-MTA: dns; mx.example.com',
    '',
    `--${B}`,
    'Content-Type: message/rfc822',
    '',
    'From: sender@example.com',
    `To: ${recipient}`,
    'Subject: Report',
    `Message-ID: ${messageId}`,
    '',
    '原始正文',
    `--${B}--`,
    '',
  ].join('\r\n');
}

function multiRecipientDsn() {
  const B = 'BOUNDARY-MULTI';
  return [
    'From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>',
    'Subject: Delivery Status Notification',
    `Content-Type: multipart/report; report-type=delivery-status; boundary="${B}"`,
    '',
    `--${B}`,
    'Content-Type: message/delivery-status',
    '',
    'Reporting-MTA: dns; mx.example.com',
    '',
    'Final-Recipient: rfc822; a@example.com',
    'Action: failed',
    'Status: 5.2.1',
    'Diagnostic-Code: smtp; 550 5.2.1 mailbox full',
    '',
    'Final-Recipient: rfc822; b@example.com',
    'Action: delayed',
    'Status: 4.2.2',
    '',
    `--${B}`,
    'Content-Type: message/rfc822',
    '',
    'Message-ID: <multi-1@example.com>',
    '',
    `--${B}--`,
    '',
  ].join('\r\n');
}

test('解析 Gmail 风格退信：收件人 / 状态 / Diagnostic / 原信 Message-ID', () => {
  const parsed = parseDsn(gmailDsn());
  assert.equal(parsed.isDsn, true);
  assert.equal(parsed.reportType, 'failure');
  assert.deepEqual(parsed.messageIds, ['abc123@qq.com']);
  assert.deepEqual(parsed.failedRecipients, ['partner@example.com']);
  assert.equal(parsed.reports.length, 1);
  const [report] = parsed.reports;
  assert.equal(report.recipient, 'partner@example.com');
  assert.equal(report.action, 'failed');
  assert.equal(report.status, '5.1.1');
  assert.equal(report.hardFail, true);
  assert.match(report.diagnostic, /550-5\.1\.1/);
  assert.equal(report.remoteMta, 'mx.example.com');
});

test('多收件人退信：逐条报告共享同一 Message-ID，延迟通知不算失败', () => {
  const parsed = parseDsn(multiRecipientDsn());
  assert.equal(parsed.reports.length, 2);
  assert.deepEqual(parsed.failedRecipients, ['a@example.com']);
  assert.deepEqual(parsed.delayedRecipients, ['b@example.com']);
  assert.equal(parsed.reportType, 'failure');
  const delayed = parsed.reports.find((r) => r.recipient === 'b@example.com');
  assert.equal(delayed.action, 'delayed');
  assert.equal(delayed.hardFail, false);
  for (const report of parsed.reports) assert.deepEqual(report.messageIds, ['multi-1@example.com']);
});

test('无 MIME 的简版退信也能解析（Original-Message-ID 回退）', () => {
  const eml = [
    'From: MAILER-DAEMON@example.com',
    'Subject: Undelivered Mail Returned to Sender',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    '这是自动生成的退信。',
    '',
    'Final-Recipient: rfc822; nobody@example.com',
    'Action: failed',
    'Status: 5.1.1',
    'Diagnostic-Code: smtp; 550 5.1.1 unknown user',
    'Original-Message-ID: <Simple-1@Example.COM>',
    '',
  ].join('\r\n');
  const parsed = parseDsn(eml);
  assert.equal(parsed.isDsn, true);
  assert.equal(parsed.reports.length, 1);
  assert.equal(parsed.reports[0].recipient, 'nobody@example.com');
  assert.deepEqual(parsed.messageIds, ['simple-1@example.com'], 'Message-ID 统一小写');
});

test('普通邮件不是退信', () => {
  const parsed = parseDsn([
    'From: alice@example.com',
    'To: bob@example.com',
    'Subject: 周报',
    'Content-Type: text/plain',
    '',
    '本周完成事项…',
  ].join('\r\n'));
  assert.equal(parsed.isDsn, false);
  assert.equal(parsed.reports.length, 0);
});

test('Message-ID 归一化：尖括号与大小写不影响匹配', () => {
  assert.equal(normalizeMessageId('<ABC@QQ.COM>'), 'abc@qq.com');
  assert.equal(normalizeMessageId('abc@qq.com'), 'abc@qq.com');
  assert.equal(normalizeMessageId('  <abc@qq.com>  '), 'abc@qq.com');
  const store = new OperationStore(':memory:');
  try {
    const service = new FulfillmentService({ store, mailer: new FakeMailer() });
    const operation = service.prepare(makeInput());
    const confirmed = service.confirm(operation.operationId, { confirmedHash: operation.operationHash });
    store.setOutboxState(confirmed.outbox.outboxId, 'sending');
    store.setOutboxState(confirmed.outbox.outboxId, 'sent', { messageId: '<ABC@QQ.COM>' });
    assert.equal(store.listOutboxByMessageId('abc@qq.com').length, 1);
    assert.equal(store.listOutboxByMessageId('<abc@qq.com>').length, 1);
    assert.equal(store.listOutboxByMessageId('other@qq.com').length, 0);
  } finally {
    store.close();
  }
});

test('发送成功后收到退信：sent → bounced，操作保持 executed，重复导入幂等', async (t) => {
  const store = new OperationStore(':memory:');
  t.after(() => store.close());
  const service = new FulfillmentService({ store, mailer: new FakeMailer() });
  const operation = service.prepare(makeInput());
  const confirmed = service.confirm(operation.operationId, { confirmedHash: operation.operationHash });
  const sent = await service.send(confirmed.outbox.outboxId);
  assert.equal(sent.state, 'sent');
  const outbox = store.getOutbox(confirmed.outbox.outboxId);
  assert.equal(outbox.messageId, 'fake-message-1-1');

  const bounced = service.recordBounce({
    messageId: outbox.messageId,
    recipient: 'partner@example.com',
    status: '5.1.1',
    diagnostic: '550 user unknown',
  });
  assert.equal(bounced.matched, true);
  assert.equal(bounced.previousState, 'sent');
  assert.equal(bounced.outbox.state, 'bounced');
  assert.match(bounced.outbox.lastError, /5\.1\.1/);
  assert.equal(store.getOperation(operation.operationId).state, 'executed', '执行事实不变');

  const again = service.recordBounce({ messageId: outbox.messageId, status: '5.1.1' });
  assert.equal(again.duplicate, true);
  assert.equal(again.outbox.state, 'bounced');
  assert.throws(() => store.setOutboxState(confirmed.outbox.outboxId, 'sent'), /非法发送状态迁移/,
    '退信后不能回到 sent');
});

test('unknown 不接受退信：先人工核对成 sent，再登记退信', async (t) => {
  const store = new OperationStore(':memory:');
  t.after(() => store.close());
  const service = new FulfillmentService({ store, mailer: new FakeMailer({ behavior: 'accepted-then-timeout' }) });
  const operation = service.prepare(makeInput());
  const confirmed = service.confirm(operation.operationId, { confirmedHash: operation.operationHash });
  const result = await service.send(confirmed.outbox.outboxId);
  assert.equal(result.state, 'unknown');
  assert.equal(store.getOperation(operation.operationId).state, 'executing');

  // unknown 没有服务端 Message-ID，退信一律不回填
  const skipped = service.recordBounce({ messageId: 'server-1@example.com', status: '5.1.1' });
  assert.equal(skipped.matched, false, '没有可匹配的发件记录');

  // 人工核对为已发送后，退信才能落到 sent → bounced
  service.reconcile(confirmed.outbox.outboxId, { state: 'sent', messageId: '<server-1@example.com>' });
  const bounced = service.recordBounce({ messageId: '<server-1@example.com>', status: '5.1.1' });
  assert.equal(bounced.outbox.state, 'bounced');
  assert.equal(store.getOperation(operation.operationId).state, 'executed');
});

test('明确失败（rejected）的发件记录不接受退信', async (t) => {
  const store = new OperationStore(':memory:');
  t.after(() => store.close());
  const service = new FulfillmentService({ store, mailer: new FakeMailer({ behavior: 'rejected' }) });
  const operation = service.prepare(makeInput());
  const confirmed = service.confirm(operation.operationId, { confirmedHash: operation.operationHash });
  const result = await service.send(confirmed.outbox.outboxId);
  assert.equal(result.state, 'failed');
  const outbox = store.getOutbox(confirmed.outbox.outboxId);
  const bounced = service.recordBounce({ messageId: outbox.messageId || 'x', status: '5.1.1' });
  assert.equal(bounced.matched, false, '没有 messageId 时匹配不到');
});

// ---------- 控制台服务集成 ----------
function setupConsole() {
  return new ConsoleService({ now: () => Date.now() });
}

async function runExternal(service) {
  const sample = service.getDemoSamples().find((s) => s.id === 'external-confirm');
  const run = await service.runCommand({ ...sample });
  const op = run.operations[0];
  const challenge = service.beginChallenge(op.operationId);
  const decided = await service.decideChallenge(challenge.challengeId, 'approve');
  assert.equal(decided.send.state, 'sent');
  return service.getOperation(op.operationId).operation;
}

test('控制台：导入退信 → 发件记录退信 + 审计留痕 + 计数', async (t) => {
  const service = setupConsole();
  t.after(() => service.close());
  const op = await runExternal(service);
  const messageId = op.outbox.messageId;
  assert.ok(messageId);

  const res = service.ingestBounce({ eml: gmailDsn({ messageId: `<${messageId}>` }), by: 'auditor' });
  assert.equal(res.ok, true);
  assert.equal(res.reportType, 'failure');
  assert.equal(res.summary.bounced, 1);
  assert.equal(res.results[0].outcome, 'bounced');
  assert.equal(res.results[0].previousState, 'sent');

  const after = service.getOperation(op.operationId).operation;
  assert.equal(after.outbox.state, 'bounced');
  assert.equal(after.state, 'executed');
  assert.equal(service.listEmails().counts.bounced, 1);

  const entry = service.audit.entries.find((e) => e.kind === '退信');
  assert.ok(entry, '审计里有退信记录');
  assert.equal(entry.actor, 'auditor');
  assert.equal(entry.detail.status, '5.1.1');
  assert.equal(service.audit.verify(), true, '审计链仍有效');
});

test('控制台：重复导入同一退信幂等，未匹配不猜', async (t) => {
  const service = setupConsole();
  t.after(() => service.close());
  const op = await runExternal(service);

  const first = service.ingestBounce({ eml: gmailDsn({ messageId: `<${op.outbox.messageId}>` }) });
  assert.equal(first.summary.bounced, 1);
  const second = service.ingestBounce({ eml: gmailDsn({ messageId: `<${op.outbox.messageId}>` }) });
  assert.equal(second.summary.bounced, 0);
  assert.equal(second.summary.duplicate, 1);

  const unmatched = service.ingestBounce({ eml: gmailDsn({ messageId: '<never-sent@example.com>' }) });
  assert.equal(unmatched.summary.unmatched, 1);
  assert.equal(service.getOperation(op.operationId).operation.outbox.state, 'bounced');
});

test('控制台：延迟通知只记录不改状态；非退信原文拒绝', async (t) => {
  const service = setupConsole();
  t.after(() => service.close());
  const op = await runExternal(service);

  const delayEml = gmailDsn({ messageId: `<${op.outbox.messageId}>`, action: 'delayed', status: '4.2.2', diagnostic: 'smtp; 450 try later' });
  const delayed = service.ingestBounce({ eml: delayEml });
  assert.equal(delayed.summary.ignored, 1);
  assert.equal(service.getOperation(op.operationId).operation.outbox.state, 'sent', '延迟通知不改状态');

  assert.throws(
    () => service.ingestBounce({ eml: 'From: a@b.c\r\nSubject: hi\r\n\r\nhello' }),
    /不是退信报告/,
  );
  assert.throws(() => service.ingestBounce({ eml: '' }), /缺少退信原文/);
});
