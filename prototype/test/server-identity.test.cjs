'use strict';
// 控制台设备身份（docs/60 复核第六轮）：SAFE_OFFICE_DEVICE 必须同时决定 deviceId 与显示名，
// 否则 B 板的决定帧会因 device_id 不符被拒。
const test = require('node:test');
const assert = require('node:assert/strict');
const { consoleIdentityFromEnv } = require('../server.cjs');

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
