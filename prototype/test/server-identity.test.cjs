'use strict';
// 控制台设备身份（docs/60 复核第六轮）：SAFE_OFFICE_DEVICE 必须同时决定 deviceId 与显示名，
// 否则 B 板的决定帧会因 device_id 不符被拒。
const test = require('node:test');
const assert = require('node:assert/strict');
const { consoleIdentityFromEnv } = require('../server.cjs');
const { createMailerPoolFromEnv } = require('../src/mail-accounts.cjs');

test('企业 SMTP 不回退模拟，所有账号都必须有有效白名单', () => {
  assert.equal(createMailerPoolFromEnv({}), null);
  assert.throws(() => createMailerPoolFromEnv({}, { required: true }), /SMTP/);
  const account = { name: 'pilot', host: 'smtp.example.test', user: 'pilot@example.test', pass: 'test-only' };
  const config = (...accounts) => ({ SAFE_OFFICE_SMTP_ACCOUNTS: JSON.stringify(accounts) });
  const ready = { ...account, allowTo: ['recipient@example.test'] };
  assert.ok(createMailerPoolFromEnv(config(ready), { required: true }));
  assert.throws(() => createMailerPoolFromEnv(config(ready, { ...account, name: 'other' }), { required: true }), /白名单/);
  assert.throws(() => createMailerPoolFromEnv(config({ ...ready, allowTo: ['@example.test'] }), { required: true }), /邮箱地址/);
});

test('未设置 SAFE_OFFICE_DEVICE：不覆盖默认身份', () => {
  assert.deepEqual(consoleIdentityFromEnv({}), {});
  assert.deepEqual(consoleIdentityFromEnv({ SAFE_OFFICE_DEVICE: '   ' }), {});
});

test('设置 SAFE_OFFICE_DEVICE：deviceId 与显示名一起换', () => {
  assert.deepEqual(consoleIdentityFromEnv({ SAFE_OFFICE_DEVICE: 'ws63-B' }), {
    deviceId: 'ws63-B',
    deviceLabel: 'ws63-B',
  });
  assert.deepEqual(consoleIdentityFromEnv({ SAFE_OFFICE_DEVICE: ' ws63-A ' }), {
    deviceId: 'ws63-A',
    deviceLabel: 'ws63-A',
  });
});
