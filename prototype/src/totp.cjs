'use strict';
// ============================================================
// TOTP（RFC 6238）最小实现（v0.32）
//   - 只依赖 node:crypto；HMAC-SHA1 / 30 秒 / 6 位
//   - 用于登录第二步验证；不提供二维码，只给 otpauth URI 与 Base32 密钥
// 边界：密钥存在 users.json（0600）；没有防暴力破解之外的设备绑定/恢复码。
// ============================================================
const crypto = require('node:crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;

/** @param {Buffer | Uint8Array} buffer @returns {string} */
function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** @param {string} text @returns {Buffer} */
function base32Decode(text) {
  const clean = String(text || '').toUpperCase().replace(/[\s=-]/g, '');
  if (!clean || !/^[A-Z2-7]+$/.test(clean)) throw new Error('Base32 密钥非法');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** @param {number} [bytes] @returns {string} */
function generateSecret(bytes = 20) {
  return base32Encode(crypto.randomBytes(bytes));
}

/** @param {string} secret @param {number} counter @param {number} [digits] @returns {string} */
function hotp(secret, counter, digits = DIGITS) {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const binary = ((mac[offset] & 0x7f) << 24)
    | ((mac[offset + 1] & 0xff) << 16)
    | ((mac[offset + 2] & 0xff) << 8)
    | (mac[offset + 3] & 0xff);
  return String(binary % (10 ** digits)).padStart(digits, '0');
}

/** @param {string} secret @param {{ now?: number, step?: number, digits?: number }} [options] @returns {string} */
function totpCode(secret, { now = Date.now(), step = STEP_SECONDS, digits = DIGITS } = {}) {
  return hotp(secret, Math.floor(now / 1000 / step), digits);
}

/**
 * @param {string} secret
 * @param {string} code
 * @param {{ now?: number, step?: number, digits?: number, window?: number }} [options]
 * @returns {boolean}
 */
function verifyTotp(secret, code, {
  now = Date.now(), step = STEP_SECONDS, digits = DIGITS, window = 1,
} = {}) {
  const text = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6,8}$/.test(text)) return false;
  if (text.length !== digits) return false;
  const counter = Math.floor(now / 1000 / step);
  let ok = false;
  for (let offset = -window; offset <= window; offset += 1) {
    const expected = hotp(secret, counter + offset, digits);
    if (expected.length === text.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(text))) {
      ok = true;
    }
  }
  return ok;
}

/** @param {{ secret: string, account: string, issuer?: string }} params @returns {string} */
function otpauthUri({ secret, account, issuer = '安全智慧办公' }) {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(String(account || ''))}`;
  const query = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}

module.exports = {
  base32Encode, base32Decode, generateSecret, hotp, totpCode, verifyTotp, otpauthUri,
  STEP_SECONDS, DIGITS,
};
