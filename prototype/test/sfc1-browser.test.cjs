'use strict';
// 端上 SFC1 核心测试（v0.14）
//   目标：浏览器实现的帧与 Node/C 侧字节完全一致，否则手机签出来的 DECISION 上板必挂。
const test = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');
const SFC1 = require('../public/sfc1-browser.js');
const { encodeChallenge, encodeDecision, decodeFrame } = require('../src/ws63-protocol.cjs');
const { deriveDeviceId: nodeDeriveDeviceId } = require('../src/nearfield-confirm.cjs');

const KEY = Buffer.alloc(32, 0x42);
const PASS = {
  taskId: Buffer.from('0101010101010101', 'hex'),
  nonce: Buffer.from('02020202020202020202020202020202', 'hex'),
  decision: 1,
  deviceId: Buffer.from('0303030303030303', 'hex'),
  decidedAt: 1_800_000_000,
};

test('DECISION 帧与 Node 实现逐字节一致', async () => {
  const nodeFrame = encodeDecision(PASS, KEY);
  const browserFrame = await SFC1.encodeDecision(PASS, KEY);
  assert.equal(SFC1.bytesToHex(browserFrame), nodeFrame.toString('hex'));
});

test('取消帧（decision=0）同样一致', async () => {
  const nodeFrame = encodeDecision({ ...PASS, decision: 0 }, KEY);
  const browserFrame = await SFC1.encodeDecision({ ...PASS, decision: 0 }, KEY);
  assert.equal(SFC1.bytesToHex(browserFrame), nodeFrame.toString('hex'));
});

test('端上能解 Node 生成的 CHALLENGE 并校验 MAC', async () => {
  const frame = encodeChallenge({
    taskId: PASS.taskId, nonce: PASS.nonce, action: 2,
    operationHash: Buffer.alloc(32, 0x07), issuedAt: 1_800_000_000,
    expiresAt: 1_800_000_030, summary: '发送邮件｜周例会纪要｜→ partner@partner-example.com',
  }, KEY);
  const parsed = await SFC1.decodeFrame(frame, KEY);
  assert.equal(parsed.type, 'challenge');
  assert.equal(parsed.action, 2);
  assert.equal(parsed.summary, '发送邮件｜周例会纪要｜→ partner@partner-example.com');
  assert.equal(SFC1.bytesToHex(parsed.taskId), PASS.taskId.toString('hex'));
  assert.equal(SFC1.bytesToHex(parsed.nonce), PASS.nonce.toString('hex'));
});

test('端上解帧：错密钥与篡改都拒绝', async () => {
  const frame = encodeChallenge({
    taskId: PASS.taskId, nonce: PASS.nonce, action: 1,
    operationHash: Buffer.alloc(32, 0x07), issuedAt: 1_800_000_000,
    expiresAt: 1_800_000_030, summary: '测试',
  }, KEY);
  await assert.rejects(() => SFC1.decodeFrame(frame, Buffer.alloc(32, 0x43)), /invalid MAC/);

  const tampered = Buffer.from(frame);
  tampered[30] ^= 0x01;
  await assert.rejects(() => SFC1.decodeFrame(tampered, KEY), /invalid MAC/);
});

test('device_id 派生与 Node 侧一致', async () => {
  for (const value of ['phone-A', 'ws63-A', '白鹭确认端']) {
    const node = nodeDeriveDeviceId(value);
    const browser = await SFC1.deriveDeviceId(value);
    assert.equal(Buffer.from(browser).toString('hex'), node.toString('hex'), value);
  }
});

test('配对码派生：确定性、32 字节、忽略大小写与分隔符', async () => {
  const a = await SFC1.deriveKey('AB12-CD34');
  const b = await SFC1.deriveKey('ab12 cd34');
  assert.equal(a.length, 32);
  assert.equal(SFC1.bytesToHex(a), SFC1.bytesToHex(b));
  const c = await SFC1.deriveKey('AB12-CD35');
  assert.notEqual(SFC1.bytesToHex(a), SFC1.bytesToHex(c));
  await assert.rejects(() => SFC1.deriveKey('ABC'), /至少 6 位/);
});

test('纯 JS SHA-256 与 Node 一致（含分组边界长度）', () => {
  for (const len of [0, 1, 3, 55, 56, 63, 64, 65, 127, 128, 1000]) {
    const input = Buffer.alloc(len);
    for (let i = 0; i < len; i += 1) input[i] = (i * 31 + 7) & 0xff;
    assert.equal(
      Buffer.from(SFC1.sha256Sync(input)).toString('hex'),
      nodeCrypto.createHash('sha256').update(input).digest('hex'),
      `len=${len}`,
    );
  }
});

test('纯 JS HMAC-SHA256 与 Node 一致', () => {
  for (const keyLen of [16, 32, 64, 100]) {
    const key = Buffer.alloc(keyLen, 0x5a);
    const data = Buffer.from('SFC1 手机确认端 fallback 测试', 'utf8');
    assert.equal(
      Buffer.from(SFC1.hmacSync(key, data)).toString('hex'),
      nodeCrypto.createHmac('sha256', key).update(data).digest('hex'),
      `keyLen=${keyLen}`,
    );
  }
});

test('纯 JS HKDF 与 Node hkdfSync 一致，且与 WebCrypto 路径相同', async () => {
  const ikm = Buffer.from('sfc1-pairing:AB12CD34', 'utf8');
  const salt = Buffer.from(SFC1.PAIRING_SALT, 'utf8');
  const info = Buffer.from(SFC1.PAIRING_INFO, 'utf8');
  const expected = Buffer.from(nodeCrypto.hkdfSync('sha256', ikm, salt, info, 32)).toString('hex');
  assert.equal(Buffer.from(SFC1.hkdfSync(ikm, salt, info)).toString('hex'), expected);
  if (SFC1.hasWebCrypto()) {
    assert.equal(SFC1.bytesToHex(await SFC1.deriveKey('AB12CD34')), expected);
  }
  assert.equal(SFC1.bytesToHex(SFC1.deriveKeySync('AB12-CD34')), expected);
});

test('Node 侧 decodeFrame 能接受端上签的 DECISION', async () => {
  const frame = await SFC1.encodeDecision(PASS, KEY);
  const parsed = decodeFrame(Buffer.from(frame), KEY);
  assert.equal(parsed.type, 'decision');
  assert.equal(parsed.decision, 1);
  assert.equal(parsed.decidedAt, PASS.decidedAt);
});
