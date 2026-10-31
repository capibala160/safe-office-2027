'use strict';
// TOTP：RFC 6238 附录 B 向量 + Base32 + 窗口/篡改
const test = require('node:test');
const assert = require('node:assert');
const {
  base32Encode, base32Decode, hotp, totpCode, verifyTotp, otpauthUri,
} = require('../src/totp.cjs');

const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // ASCII "12345678901234567890"

test('Base32：编码/解码往返，非法字符拒绝', () => {
  const buf = Buffer.from('12345678901234567890', 'ascii');
  assert.equal(base32Encode(buf), SECRET);
  assert.deepEqual(base32Decode(SECRET), buf);
  assert.deepEqual(base32Decode('gezd gnbv gy3t qojq gezd gnbv gy3t qojq'), buf);
  assert.throws(() => base32Decode('not-base32!'), /Base32/);
});

test('HOTP/TOTP：RFC 6238 SHA-1 向量（8 位）', () => {
  const vectors = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];
  for (const [time, expected] of vectors) {
    assert.equal(hotp(SECRET, Math.floor(time / 30), 8), expected, `T=${time}`);
    assert.equal(totpCode(SECRET, { now: time * 1000, digits: 8 }), expected, `TOTP T=${time}`);
  }
});

test('验证：当前窗口通过、±1 步通过、远端拒绝、错码拒绝', () => {
  const now = 1234567890 * 1000;
  const code = totpCode(SECRET, { now });
  assert.equal(verifyTotp(SECRET, code, { now }), true);
  assert.equal(verifyTotp(SECRET, code, { now: now + 30_000 }), true, '前一步仍接受');
  assert.equal(verifyTotp(SECRET, code, { now: now + 90_000 }), false, '超过窗口拒绝');
  assert.equal(verifyTotp(SECRET, '000000', { now }), false);
  assert.equal(verifyTotp(SECRET, 'abcdef', { now }), false);
});

test('otpauth URI：包含密钥/账号/发行方', () => {
  const uri = otpauthUri({ secret: SECRET, account: 'alice', issuer: '安全智慧办公' });
  assert.match(uri, /^otpauth:\/\/totp\//);
  assert.match(uri, /secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ/);
  assert.match(uri, /issuer=/);
  assert.match(uri, /digits=6/);
  assert.match(uri, /period=30/);
});
