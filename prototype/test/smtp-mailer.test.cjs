'use strict';
// SMTP 真实发送：白名单、附件内容、错误分类（不联网）
const test = require('node:test');
const assert = require('node:assert');
const { SMTPMailer, createSmtpMailerFromEnv } = require('../src/smtp-mailer.cjs');
const { DemoExecutor } = require('../src/demo-executor.cjs');
const { MailerError } = require('../src/mailer.cjs');

function recordingTransport({ fail = null } = {}) {
  const calls = [];
  return {
    calls,
    async sendMail(mail) {
      calls.push(mail);
      if (fail) throw fail;
      return { messageId: '<test-message@example>' };
    },
  };
}

const OP = {
  operationId: 'op-1',
  recipient: '1364387139@qq.com',
  subject: '测试',
  body: '正文',
  attachments: [],
};

function mailer(transport, extra = {}) {
  return new SMTPMailer({
    host: 'smtp.example.com', port: 465, secure: true,
    user: 'sender@example.com', pass: 'secret',
    allowTo: ['1364387139@qq.com'], transport, ...extra,
  });
}

test('SMTP：白名单内发送，返回 messageId', async () => {
  const transport = recordingTransport();
  const result = await mailer(transport).send({ operation: OP, idempotencyKey: 'idem-1' });
  assert.equal(result.status, 'sent');
  assert.equal(result.messageId, '<test-message@example>');
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0].to, '1364387139@qq.com');
  assert.equal(transport.calls[0].headers['X-Idempotency-Key'], 'idem-1');
});

test('SMTP：别名作为 From；未配置的别名拒绝', async () => {
  const transport = recordingTransport();
  const m = mailer(transport, {
    from: 'sender@example.com', fromName: '张工',
    aliases: [{ address: 'notice@example.com', name: '通知' }],
  });
  await m.send({ operation: { ...OP, mailAlias: 'notice@example.com' }, idempotencyKey: 'idem-alias' });
  assert.deepEqual(transport.calls[0].from, { name: '通知', address: 'notice@example.com' });

  // 主地址也带显示名
  await m.send({ operation: { ...OP, operationId: 'op-2' }, idempotencyKey: 'idem-plain' });
  assert.deepEqual(transport.calls[1].from, { name: '张工', address: 'sender@example.com' });

  await assert.rejects(
    () => m.send({ operation: { ...OP, mailAlias: 'other@example.com' }, idempotencyKey: 'idem-bad' }),
    (err) => err instanceof MailerError && err.kind === 'rejected',
  );
  assert.equal(transport.calls.length, 2);
});

test('SMTP：白名单外地址 / 空白名单一律拒绝', async () => {
  const transport = recordingTransport();
  await assert.rejects(
    () => mailer(transport).send({ operation: { ...OP, recipient: 'evil@example.com' } }),
    (err) => err instanceof MailerError && err.kind === 'rejected',
  );
  await assert.rejects(
    () => mailer(transport, { allowTo: [] }).send({ operation: OP }),
    (err) => err instanceof MailerError && err.kind === 'rejected',
  );
  assert.equal(transport.calls.length, 0);
});

test('SMTP：附件内容进入 MIME；缺失内容拒绝', async () => {
  const transport = recordingTransport();
  const op = {
    ...OP,
    attachments: [{ name: 'a.txt', sha256: 'x', size: 3 }],
    attachmentFiles: [{ name: 'a.txt', mime: 'text/plain', content: Buffer.from('abc') }],
  };
  await mailer(transport).send({ operation: op });
  assert.equal(transport.calls[0].attachments.length, 1);
  assert.equal(transport.calls[0].attachments[0].filename, 'a.txt');
  assert.equal(transport.calls[0].attachments[0].content.toString(), 'abc');

  await assert.rejects(
    () => mailer(transport).send({
      operation: { ...OP, attachments: [{ name: 'a.txt', sha256: 'x', size: 3 }], attachmentFiles: [{ name: 'a.txt', content: 'not-buffer' }] },
    }),
    (err) => err instanceof MailerError && err.kind === 'rejected',
  );
});

test('SMTP：认证失败 = rejected；超时 = unknown（禁自动重试）', async () => {
  const authErr = Object.assign(new Error('Invalid login'), { code: 'EAUTH' });
  await assert.rejects(
    () => mailer(recordingTransport({ fail: authErr })).send({ operation: OP }),
    (err) => err instanceof MailerError && err.kind === 'rejected',
  );
  const timeoutErr = Object.assign(new Error('Connection timeout'), { code: 'ETIMEDOUT' });
  await assert.rejects(
    () => mailer(recordingTransport({ fail: timeoutErr })).send({ operation: OP }),
    (err) => err instanceof MailerError && err.kind === 'timeout',
  );
});

test('配置：未设 host 返回 null；缺授权码/白名单直接报错', () => {
  assert.equal(createSmtpMailerFromEnv({}), null);
  assert.throws(
    () => createSmtpMailerFromEnv({ SAFE_OFFICE_SMTP_HOST: 'smtp.qq.com', SAFE_OFFICE_SMTP_USER: 'a@qq.com' }),
    /缺少 SAFE_OFFICE_SMTP_USER/,
  );
  assert.throws(
    () => createSmtpMailerFromEnv({
      SAFE_OFFICE_SMTP_HOST: 'smtp.qq.com', SAFE_OFFICE_SMTP_USER: 'a@qq.com', SAFE_OFFICE_SMTP_PASS: 'x',
    }),
    /收件人白名单/,
  );
  const ok = createSmtpMailerFromEnv({
    SAFE_OFFICE_SMTP_HOST: 'smtp.qq.com', SAFE_OFFICE_SMTP_USER: 'a@qq.com', SAFE_OFFICE_SMTP_PASS: 'x',
    SAFE_OFFICE_MAIL_ALLOW_TO: '1364387139@qq.com',
  });
  assert.ok(ok instanceof SMTPMailer);
  assert.deepEqual(ok.allowTo, ['1364387139@qq.com']);
});

test('DemoExecutor：按 sha256 取附件内容再交给邮件适配器', async () => {
  const seen = [];
  const smtp = { async send({ operation }) { seen.push(operation); return { status: 'sent', messageId: 'm' }; } };
  const executor = new DemoExecutor({
    mailer: smtp,
    attachmentLoader: (sha) => (sha === 'abc' ? { mime: 'text/plain', content: Buffer.from('hello') } : null),
  });
  await executor.send({
    operation: { ...OP, operationHash: 'h1', protocolAction: 1, attachments: [{ name: 'a.txt', sha256: 'abc', size: 5 }] },
    idempotencyKey: 'k1',
  });
  assert.equal(seen[0].attachmentFiles[0].content.toString(), 'hello');

  await assert.rejects(
    () => executor.send({
      operation: { ...OP, operationHash: 'h2', protocolAction: 1, attachments: [{ name: 'b.txt', sha256: 'missing', size: 1 }] },
      idempotencyKey: 'k2',
    }),
    /附件「b.txt」内容缺失/,
  );
});
