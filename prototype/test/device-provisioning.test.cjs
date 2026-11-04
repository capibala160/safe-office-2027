'use strict';
// 配网协议（docs/60 方案 A）：帧编解码、会话密钥、错码/篡改/重放。
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const P = require('../src/device-provisioning.cjs');

const CODE = 'A1B2C3D4';
const HOST_NONCE = randomBytes(16);
const DEVICE_NONCE = randomBytes(16);
const DEVICE_ID = Buffer.from('ws63-Axx'); // 8 字节
const NEW_KEY = randomBytes(32);

function session(code = CODE) {
  return P.deriveSessionKey(code, HOST_NONCE, DEVICE_NONCE);
}

test('INIT：MAC 全 0、host_nonce 可解出', () => {
  const frame = P.encodeInit(HOST_NONCE);
  const decoded = P.decodeInit(frame);
  assert.ok(decoded.hostNonce.equals(HOST_NONCE));
  assert.ok(frame.subarray(-32).equals(Buffer.alloc(32)), 'INIT 的 MAC 应为全 0');
});

test('完整配网：challenge → commit → ok，密钥端到端一致', () => {
  const key = session();
  const challenge = P.encodeChallenge({ deviceId: DEVICE_ID, hostNonce: HOST_NONCE, deviceNonce: DEVICE_NONCE }, key);
  const seen = P.decodeChallenge(challenge, key);
  assert.ok(seen.deviceId.equals(DEVICE_ID));
  assert.ok(seen.hostNonce.equals(HOST_NONCE));
  assert.ok(seen.deviceNonce.equals(DEVICE_NONCE));

  const commit = P.encodeCommit({ deviceId: DEVICE_ID, hostNonce: HOST_NONCE, deviceNonce: DEVICE_NONCE, newKey: NEW_KEY }, key);
  const received = P.decodeCommit(commit, key);
  assert.ok(received.newKey.equals(NEW_KEY), '板端解出的新密钥必须与主机一致');

  const ok = P.encodeOk({ deviceId: DEVICE_ID, status: P.STATUS.OK }, key);
  const ack = P.decodeOk(ok, key);
  assert.equal(ack.status, P.STATUS.OK);
});

test('peekChallenge：不验 MAC 也能拿到 nonce（主机派生会话密钥用）', () => {
  const frame = P.encodeChallenge({ deviceId: DEVICE_ID, hostNonce: HOST_NONCE, deviceNonce: DEVICE_NONCE }, session());
  const peek = P.peekChallenge(frame);
  assert.ok(peek.deviceNonce.equals(DEVICE_NONCE));
  assert.ok(peek.hostNonce.equals(HOST_NONCE));
  assert.throws(() => P.decodeChallenge(frame, Buffer.alloc(32, 0)), /MAC/);
});

test('错临时码：CHALLENGE MAC 校验失败', () => {
  const good = session();
  const challenge = P.encodeChallenge({ deviceId: DEVICE_ID, hostNonce: HOST_NONCE, deviceNonce: DEVICE_NONCE }, good);
  const wrong = session('WRONG123');
  assert.throws(() => P.decodeChallenge(challenge, wrong), /MAC/);
});

test('篡改 COMMIT：MAC 校验失败', () => {
  const key = session();
  const commit = P.encodeCommit({ deviceId: DEVICE_ID, hostNonce: HOST_NONCE, deviceNonce: DEVICE_NONCE, newKey: NEW_KEY }, key);
  const bad = Buffer.from(commit);
  bad[20] ^= 0x01;
  assert.throws(() => P.decodeCommit(bad, key), /MAC/);
});

test('nonce 不匹配：解出的密钥与主机发送的不同（板端必须比对 nonce）', () => {
  const key = session();
  const commit = P.encodeCommit({ deviceId: DEVICE_ID, hostNonce: HOST_NONCE, deviceNonce: DEVICE_NONCE, newKey: NEW_KEY }, key);
  // 用另一组 nonce 的会话密钥去解：MAC 直接失败
  const otherKey = P.deriveSessionKey(CODE, randomBytes(16), DEVICE_NONCE);
  assert.throws(() => P.decodeCommit(commit, otherKey), /MAC/);
});

test('PING/PONG：设备密钥验签，错钥一律 MAC 失败（恢复流程用）', () => {
  const key = randomBytes(32);
  const nonce = randomBytes(16);
  const ping = P.encodePing(nonce, key);
  assert.ok(P.decodePing(ping, key).hostNonce.equals(nonce));
  assert.throws(() => P.decodePing(ping, randomBytes(32)), /MAC/);

  const pong = P.encodePong({ deviceId: DEVICE_ID, hostNonce: nonce }, key);
  const seen = P.decodePong(pong, key);
  assert.ok(seen.deviceId.equals(DEVICE_ID));
  assert.ok(seen.hostNonce.equals(nonce));
  assert.throws(() => P.decodePong(pong, randomBytes(32)), /MAC/);
});

test('ERR：状态与原因可读，中文替换成 ?', () => {
  const key = session();
  const frame = P.encodeErr({ status: P.STATUS.TOO_MANY, reason: '尝试过多' }, key);
  const err = P.decodeErr(frame, key);
  assert.equal(err.status, P.STATUS.TOO_MANY);
  assert.ok(!/[^\x20-\x7E]/.test(err.reason));
});

test('参数校验：nonce/密钥长度、空临时码', () => {
  assert.throws(() => P.encodeInit(Buffer.alloc(15)), /16 字节/);
  assert.throws(() => P.deriveSessionKey('', HOST_NONCE, DEVICE_NONCE), /临时码/);
  assert.throws(() => P.deriveSessionKey(CODE, Buffer.alloc(15), DEVICE_NONCE), /hostNonce/);
  assert.throws(() => P.encodeCommit({ deviceId: DEVICE_ID, hostNonce: HOST_NONCE, deviceNonce: DEVICE_NONCE, newKey: Buffer.alloc(31) }, session()), /32 字节/);
});

test('帧头：magic/版本/长度不符一律拒绝', () => {
  const frame = P.encodeInit(HOST_NONCE);
  const badMagic = Buffer.from(frame);
  badMagic[0] = 0x00;
  assert.throws(() => P.decodeInit(badMagic), /magic/);

  const badVersion = Buffer.from(frame);
  badVersion[4] = 0x02;
  assert.throws(() => P.decodeInit(badVersion), /版本/);

  const badLength = Buffer.from(frame);
  badLength.writeUInt16LE(999, 8);
  assert.throws(() => P.decodeInit(badLength), /长度/);
});
