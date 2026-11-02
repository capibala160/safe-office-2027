'use strict';
// 多发送账号：解析、默认账号、按 operation.mailAccount 选择
const test = require('node:test');
const assert = require('node:assert');
const { parseAccountsFromEnv, MailerPool } = require('../src/mail-accounts.cjs');

const ENV = {
  SAFE_OFFICE_SMTP_ACCOUNTS: JSON.stringify([
    {
      name: 'work', host: 'smtp.example.com', port: 465, secure: true,
      user: 'work@example.com', pass: 'secret', allowTo: ['partner-example.com'],
    },
    {
      name: 'backup', host: 'smtp2.example.com', port: 587, secure: false,
      user: 'backup@example.com', pass: 'secret2', allowTo: 'partner-example.com,corp.internal',
    },
  ]),
  SAFE_OFFICE_SMTP_DEFAULT_ACCOUNT: 'work',
};

test('多账号：解析配置、默认账号、列表不回传密码', () => {
  const parsed = parseAccountsFromEnv(ENV);
  assert.equal(parsed.accounts.length, 2);
  assert.equal(parsed.defaultName, 'work');
  assert.deepEqual(parsed.accounts[1].allowTo, ['partner-example.com', 'corp.internal']);
  const pool = new MailerPool(parsed);
  const list = pool.list();
  assert.deepEqual(list.map((a) => a.name), ['work', 'backup']);
  assert.equal(list[0].default, true);
  for (const a of list) assert.equal('pass' in a, false, '列表不能带密码');
});

test('多账号：按 operation.mailAccount 选择；未知账号拒绝', async () => {
  const parsed = parseAccountsFromEnv(ENV);
  const sent = [];
  const pool = new MailerPool({
    ...parsed,
    mailerFactory: (cfg) => ({
      async send({ operation }) { sent.push({ user: cfg.user, to: operation.recipient }); return { status: 'sent' }; },
    }),
  });
  await pool.send({ operation: { recipient: 'a@partner-example.com' } });
  await pool.send({ operation: { recipient: 'b@partner-example.com', mailAccount: 'backup' } });
  assert.deepEqual(sent, [
    { user: 'work@example.com', to: 'a@partner-example.com' },
    { user: 'backup@example.com', to: 'b@partner-example.com' },
  ]);
  await assert.rejects(
    () => pool.send({ operation: { recipient: 'x@y.com', mailAccount: 'missing' } }),
    /未知发件账号/,
  );
});
