'use strict';
// SFC1 负向测试工具的纯函数测试（v0.48）。真板断言见 docs/57 §6.5。
const test = require('node:test');
const assert = require('node:assert/strict');
const { tamperMac, buildChallenge, DEMO_KEY } = require('../scripts/sfc1-negative.cjs');
const { decodeFrame } = require('../src/ws63-protocol.cjs');

test('tamperMac：只翻 MAC 最后一个字节，其余字节不动', () => {
  const { frame } = buildChallenge({ ttlSec: 2, key: DEMO_KEY });
  const bad = tamperMac(frame);
  assert.equal(bad.length, frame.length);
  assert.equal(bad[bad.length - 1], frame[frame.length - 1] ^ 0x01);
  assert.ok(bad.subarray(0, -1).equals(frame.subarray(0, -1)));
  assert.throws(() => decodeFrame(bad, DEMO_KEY), /invalid MAC/);
});

test('buildChallenge：帧可被同密钥解出，TTL/summary/action 正确', () => {
  const { frame, nonce } = buildChallenge({ ttlSec: 2, summary: 'REPLAY-TEST', key: DEMO_KEY });
  const decoded = decodeFrame(frame, DEMO_KEY);
  assert.equal(decoded.type, 'challenge');
  assert.equal(decoded.summary, 'REPLAY-TEST');
  assert.equal(decoded.action, 1);
  assert.equal(decoded.expiresAt - decoded.issuedAt, 2);
  assert.ok(decoded.nonce.equals(nonce));
});

test('buildChallenge：不同 nonce/任务不会撞帧', () => {
  const a = buildChallenge({ ttlSec: 2, key: DEMO_KEY }).frame;
  const b = buildChallenge({ ttlSec: 2, key: DEMO_KEY }).frame;
  assert.ok(!a.equals(b));
});
