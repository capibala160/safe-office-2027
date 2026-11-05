'use strict';
// ============================================================
// SFC1 端上核心（浏览器 + Node 共用）
//   目的：确认端在浏览器里自己算 HMAC、自己组 DECISION 帧，
//         不把签名动作交给服务器。
//   与 src/ws63-protocol.cjs 的字节布局必须完全一致（有 parity 测试）。
//   只依赖 WebCrypto（crypto.subtle），不碰 DOM。
// ============================================================
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else /** @type {any} */ (root).SFC1 = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const HEADER_LEN = 10;
  const MAC_LEN = 32;
  const MIN_FRAME = HEADER_LEN + MAC_LEN;
  const MAX_FRAME = 1024;
  const MAGIC = new Uint8Array([0x53, 0x46, 0x43, 0x31]); // "SFC1"
  const VERSION = 1;
  const TYPE_CHALLENGE = 1;
  const TYPE_DECISION = 2;
  const ACTION_MIN = 1;
  const ACTION_MAX = 4;
  const SUMMARY_MAX_BYTES = 96;

  const TASK_DOMAIN = 'safe-office/ws63/task-id/v1\0';
  const DEVICE_DOMAIN = 'safe-office/ws63/device-id/v1\0';
  const PAIRING_SALT = 'safe-office/sfc1/phone/v1';
  const PAIRING_INFO = 'psk';

  const encoder = new TextEncoder();

  function subtle() {
    const c = typeof globalThis !== 'undefined' ? globalThis.crypto : null;
    if (!c || !c.subtle) throw new Error('WebCrypto 不可用（需要 https 或 localhost）');
    return c.subtle;
  }

  function toU8(/** @type {any} */ value, name = 'bytes') {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    throw new TypeError(`${name} 必须是 Uint8Array`);
  }

  function concat(/** @type {any} */ parts) {
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) { out.set(p, offset); offset += p.length; }
    return out;
  }

  function u32le(/** @type {any} */ value) {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new RangeError('invalid uint32');
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, value, true);
    return b;
  }

  function readU32le(/** @type {any} */ bytes, /** @type {any} */ offset) {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
  }

  function hexToBytes(/** @type {any} */ hex) {
    const clean = String(hex || '').trim();
    if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) throw new TypeError('非法十六进制');
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i += 1) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    return out;
  }

  function bytesToHex(/** @type {any} */ bytes) {
    return Array.from(toU8(bytes)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  function bytesToBase64(/** @type {any} */ bytes) {
    const u8 = toU8(bytes);
    let binary = '';
    for (let i = 0; i < u8.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, /** @type {any} */ (u8.subarray(i, i + 0x8000)));
    }
    return btoa(binary);
  }

  function base64ToBytes(/** @type {any} */ text) {
    const binary = atob(String(text || ''));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  }

  async function sha256(/** @type {any} */ bytes) {
    if (!hasWebCrypto()) return sha256Sync(bytes);
    return new Uint8Array(await subtle().digest('SHA-256', /** @type {any} */ (toU8(bytes))));
  }

  // ---------- 纯 JS 兜底：局域网 http 页面没有 crypto.subtle ----------
  // 仅用于演示；非恒时实现，不能当生产密码学用。
  const SHA256_K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);

  function rotr(/** @type {any} */ x, /** @type {any} */ n) { return (x >>> n) | (x << (32 - n)); }

  function sha256Sync(/** @type {any} */ input) {
    const bytes = toU8(input);
    const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
    padded.set(bytes);
    padded[bytes.length] = 0x80;
    const view = new DataView(padded.buffer);
    const bits = bytes.length * 8;
    view.setUint32(padded.length - 8, Math.floor(bits / 0x100000000), false);
    view.setUint32(padded.length - 4, bits >>> 0, false);

    const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const w = new Uint32Array(64);

    for (let offset = 0; offset < padded.length; offset += 64) {
      for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4, false);
      for (let i = 16; i < 64; i += 1) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let a = h[0]; let b = h[1]; let c = h[2]; let d = h[3];
      let e = h[4]; let f = h[5]; let g = h[6]; let hh = h[7];
      for (let i = 0; i < 64; i += 1) {
        const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const ch = (e & f) ^ (~e & g);
        const t1 = (hh + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
        const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + maj) >>> 0;
        hh = g; g = f; f = e; e = (d + t1) >>> 0;
        d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0;
      h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
      h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0;
      h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
    }
    const out = new Uint8Array(32);
    const outView = new DataView(out.buffer);
    for (let i = 0; i < 8; i += 1) outView.setUint32(i * 4, h[i], false);
    return out;
  }

  function hmacSync(/** @type {any} */ keyBytes, /** @type {any} */ dataBytes) {
    let key = toU8(keyBytes, 'key');
    if (key.length > 64) key = sha256Sync(key);
    const pad = new Uint8Array(64);
    pad.set(key);
    const ipad = new Uint8Array(64);
    const opad = new Uint8Array(64);
    for (let i = 0; i < 64; i += 1) { ipad[i] = pad[i] ^ 0x36; opad[i] = pad[i] ^ 0x5c; }
    return sha256Sync(concat([opad, sha256Sync(concat([ipad, toU8(dataBytes)]))]));
  }

  function hkdfSync(/** @type {any} */ ikm, /** @type {any} */ salt, /** @type {any} */ info) {
    const prk = hmacSync(salt, ikm);
    return hmacSync(prk, concat([info, new Uint8Array([1])]));
  }

  function hasWebCrypto() {
    const c = typeof globalThis !== 'undefined' ? globalThis.crypto : null;
    return !!(c && c.subtle);
  }

  async function hmac(/** @type {any} */ keyBytes, /** @type {any} */ dataBytes) {
    const key = toU8(keyBytes, 'key');
    if (key.length !== 32) throw new TypeError('key 必须是 32 字节');
    if (!hasWebCrypto()) return hmacSync(key, toU8(dataBytes));
    const cryptoKey = await subtle().importKey('raw', /** @type {any} */ (key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Uint8Array(await subtle().sign('HMAC', cryptoKey, /** @type {any} */ (toU8(dataBytes))));
  }

  // 常量时间比较，避免在端上泄漏 MAC 比对进度
  function equalBytes(/** @type {any} */ a, /** @type {any} */ b) {
    const x = toU8(a);
    const y = toU8(b);
    if (x.length !== y.length) return false;
    let diff = 0;
    for (let i = 0; i < x.length; i += 1) diff |= x[i] ^ y[i];
    return diff === 0;
  }

  async function seal(/** @type {any} */ type, /** @type {any} */ payload, /** @type {any} */ keyBytes) {
    const header = new Uint8Array([0x53, 0x46, 0x43, 0x31, VERSION, type, 0, 0, 0, 0]);
    new DataView(header.buffer).setUint16(8, payload.length + MAC_LEN, true);
    const data = concat([header, payload]);
    return concat([data, await hmac(keyBytes, data)]);
  }

  function requireBytes(/** @type {any} */ value, /** @type {any} */ length, /** @type {any} */ name) {
    const out = toU8(value, name);
    if (out.length !== length) throw new TypeError(`${name}: 期望 ${length} 字节`);
    return out;
  }

  async function encodeDecision(/** @type {any} */ decision, /** @type {any} */ keyBytes) {
    if (!decision || typeof decision !== 'object') throw new TypeError('缺少 decision');
    const decisionValue = decision.decision;
    if (decisionValue !== 0 && decisionValue !== 1) throw new RangeError('decision 只能是 0 或 1');
    const payload = concat([
      requireBytes(decision.taskId, 8, 'taskId'),
      requireBytes(decision.nonce, 16, 'nonce'),
      new Uint8Array([decisionValue]),
      requireBytes(decision.deviceId, 8, 'deviceId'),
      u32le(decision.decidedAt),
    ]);
    return seal(TYPE_DECISION, payload, keyBytes);
  }

  async function decodeFrame(/** @type {any} */ buffer, /** @type {any} */ keyBytes) {
    const b = toU8(buffer, 'frame');
    if (b.length < MIN_FRAME || b.length > MAX_FRAME) throw new Error('invalid frame length');
    for (let i = 0; i < 4; i += 1) if (b[i] !== MAGIC[i]) throw new Error('invalid header');
    if (b[4] !== VERSION || b[6] !== 0 || b[7] !== 0) throw new Error('invalid header');
    if (b[5] !== TYPE_CHALLENGE && b[5] !== TYPE_DECISION) throw new Error('invalid header');
    const length = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint16(8, true);
    if (length + HEADER_LEN !== b.length) throw new Error('invalid header');

    const data = b.subarray(0, b.length - MAC_LEN);
    const expected = await hmac(keyBytes, data);
    if (!equalBytes(expected, b.subarray(b.length - MAC_LEN))) throw new Error('invalid MAC');

    const p = b.subarray(HEADER_LEN, b.length - MAC_LEN);
    const common = { taskId: p.slice(0, 8), nonce: p.slice(8, 24) };
    if (b[5] === TYPE_DECISION) {
      if (p.length !== 37 || p[24] > 1) throw new Error('invalid decision');
      return { type: 'decision', ...common, decision: p[24], deviceId: p.slice(25, 33), decidedAt: readU32le(p, 33) };
    }
    if (p.length < 66 || p[65] > SUMMARY_MAX_BYTES || p.length !== 66 + p[65]) throw new Error('invalid challenge');
    if (p[24] < ACTION_MIN || p[24] > ACTION_MAX) throw new Error('invalid action');
    const issuedAt = readU32le(p, 57);
    const expiresAt = readU32le(p, 61);
    if (expiresAt <= issuedAt) throw new Error('invalid lifetime');
    const summary = new TextDecoder('utf-8', { fatal: true }).decode(p.subarray(66));
    return { type: 'challenge', ...common, action: p[24], operationHash: p.slice(25, 57), issuedAt, expiresAt, summary };
  }

  async function deriveDeviceId(/** @type {any} */ value) {
    if (typeof value !== 'string' || !value) throw new TypeError('deviceId 必须是非空字符串');
    const digest = await sha256(concat([encoder.encode(DEVICE_DOMAIN), encoder.encode(value)]));
    return digest.slice(0, 8);
  }

  async function deriveTaskId(/** @type {any} */ value) {
    if (typeof value !== 'string' || !value) throw new TypeError('taskId 必须是非空字符串');
    const digest = await sha256(concat([encoder.encode(TASK_DOMAIN), encoder.encode(value)]));
    return digest.slice(0, 8);
  }

  // 配对码 → PSK：两端用同一 HKDF 参数，码本身不进网络
  function normalizeCode(/** @type {any} */ code) {
    return String(code || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  }

  // 同步版本：服务端起步时用（不需要等 WebCrypto）
  function deriveKeySync(/** @type {any} */ code) {
    const normalized = normalizeCode(code);
    if (normalized.length < 6) throw new TypeError('配对码至少 6 位');
    return hkdfSync(encoder.encode(`sfc1-pairing:${normalized}`), encoder.encode(PAIRING_SALT), encoder.encode(PAIRING_INFO));
  }

  async function deriveKey(/** @type {any} */ code) {
    const normalized = normalizeCode(code);
    if (normalized.length < 6) throw new TypeError('配对码至少 6 位');
    const ikm = encoder.encode(`sfc1-pairing:${normalized}`);
    const salt = encoder.encode(PAIRING_SALT);
    const info = encoder.encode(PAIRING_INFO);
    if (!hasWebCrypto()) return deriveKeySync(code);
    const base = await subtle().importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
    const bits = await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, base, 256);
    return new Uint8Array(bits);
  }

  return {
    HEADER_LEN, MAC_LEN, MIN_FRAME, MAX_FRAME, SUMMARY_MAX_BYTES,
    TYPE_CHALLENGE, TYPE_DECISION, ACTION_MIN, ACTION_MAX,
    PAIRING_SALT, PAIRING_INFO,
    toU8, concat, u32le, hexToBytes, bytesToHex, bytesToBase64, base64ToBytes,
    sha256, sha256Sync, hmac, hmacSync, hkdfSync, hasWebCrypto,
    seal, encodeDecision, decodeFrame,
    deriveDeviceId, deriveTaskId, deriveKey, deriveKeySync, normalizeCode,
  };
});
