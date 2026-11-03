'use strict';
// 多发送账号：解析、默认账号、按 operation.mailAccount 选择、别名/签名
const test = require('node:test');
const assert = require('node:assert');
const { parseAccountsFromEnv, MailerPool, normalizeAccount } = require('../src/mail-accounts.cjs');

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

test('别名：解析字符串/对象混写、去重、按账号解析身份', () => {
  const account = normalizeAccount({
    name: 'work', host: 'smtp.example.com', user: 'work@example.com', pass: 'secret',
    from: 'work@example.com', fromName: '张工',
    aliases: ['Notice@Example.com', { address: 'sales@example.com', name: '销售' }],
    signature: '张工\n内线 8001',
  }, 0);
  assert.deepEqual(account.aliases, [
    { address: 'notice@example.com', name: '' },
    { address: 'sales@example.com', name: '销售' },
  ]);
  assert.equal(account.signature, '张工\n内线 8001');
  const pool = new MailerPool({
    accounts: [account], defaultName: 'work',
    mailerFactory: () => ({ async send() { return { status: 'sent' }; } }),
  });
  assert.deepEqual(pool.resolveIdentity('work', ''), {
    account, address: 'work@example.com', name: '张工', alias: '',
  });
  assert.equal(pool.resolveIdentity('work', 'NOTICE@example.com').address, 'notice@example.com');
  assert.throws(() => pool.resolveIdentity('work', 'other@example.com'), /没有配置别名/);
  // 列表不回传密码和签名正文
  const listed = pool.list()[0];
  assert.equal('pass' in listed, false);
  assert.equal('signature' in listed, false);
  assert.equal(listed.hasSignature, true);
  assert.deepEqual(listed.aliases.map((a) => a.address), ['notice@example.com', 'sales@example.com']);
});

test('别名：重复地址/非法地址/签名控制字符都拒绝', () => {
  const base = { name: 'a', host: 'h', user: 'u@example.com', pass: 'p', from: 'u@example.com' };
  assert.throws(() => normalizeAccount({ ...base, aliases: ['x@example.com', 'X@example.com'] }, 0), /别名重复/);
  assert.throws(() => normalizeAccount({ ...base, aliases: ['not-an-address'] }, 0), /不是合法邮箱地址/);
  assert.throws(() => normalizeAccount({ ...base, aliases: ['bad\r\n@example.com'] }, 0), /不是合法邮箱地址/);
  assert.throws(() => normalizeAccount({ ...base, signature: 'ok\u0007bad' }, 0), /控制字符/);
  assert.throws(() => normalizeAccount({ ...base, signature: 'x'.repeat(1001) }, 0), /超过 1000/);
});

test('别名：发送时传给适配器；未知别名在池层拒绝', async () => {
  const account = normalizeAccount({
    name: 'work', host: 'smtp.example.com', user: 'work@example.com', pass: 'secret',
    from: 'work@example.com', aliases: ['notice@example.com'],
  }, 0);
  const seen = [];
  const pool = new MailerPool({
    accounts: [account], defaultName: 'work',
    mailerFactory: () => ({
      async send({ operation }) { seen.push(operation.mailAlias || ''); return { status: 'sent' }; },
    }),
  });
  await pool.send({ operation: { recipient: 'a@partner-example.com', mailAlias: 'notice@example.com' } });
  assert.deepEqual(seen, ['notice@example.com']);
  await assert.rejects(
    () => pool.send({ operation: { recipient: 'a@partner-example.com', mailAlias: 'other@example.com' } }),
    /没有配置别名/,
  );
});
