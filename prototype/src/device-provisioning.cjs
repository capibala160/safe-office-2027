'use strict';
// 设备配网协议（docs/60 方案 A 第一步）。
//
// 目标：把"每台设备唯一的 32B SFC1 密钥"通过串口写进板端 NV，密钥不再编译进镜像。
// 线格式沿用 SFC1 帧头（magic/版本/长度），新增 0x10~0x14 五种类型：
//
//   INIT(0x10)      主机 -> 板端：host_nonce(16)，MAC 全 0（此时还没有会话密钥）
//   CHALLENGE(0x11) 板端 -> 主机：device_id(8) + device_nonce(16)，MAC=(会话密钥)
//   COMMIT(0x12)    主机 -> 板端：device_id(8) + host_nonce(16) + device_nonce(16) + 密文(32)
//   OK(0x13)        板端 -> 主机：device_id(8) + status(1)
//   ERR(0x14)       板端 -> 主机：status(1) + reason(≤32 ASCII)
//
// 会话密钥 = SHA-256("safe-office/provision/v1" || code || host_nonce || device_nonce)。
// 新密钥用 HMAC 派生的密钥流做一次一密（XOR），再由会话密钥做整帧 MAC。
//
// 诚实边界：临时码只有 32 bit，物理接触者可以离线爆破；它防的是"串口旁的旁观者"和误配网，
// 不是物理攻击者。板端必须限次（3 次）限时（10 分钟），失败后作废。

const { createHash, createHmac, timingSafeEqual, randomBytes } = require('node:crypto');

const MAGIC = Buffer.from('SFC1');
const VERSION = 0x01;
const HEADER_LEN = 10;
const MAC_LEN = 32;
const TAG_LEN = 16; // 不单独用：整帧 MAC 用 32 字节，保持与 SFC1 一致

const TYPES = Object.freeze({
  INIT: 0x10,
  CHALLENGE: 0x11,
  COMMIT: 0x12,
  OK: 0x13,
  ERR: 0x14,
  // 配置后探活：用设备密钥签，PONG 证明"板子确实持有这把钥匙"（回执丢失后的恢复用）
  PING: 0x20,
  PONG: 0x21,
});

const STATUS = Object.freeze({
  OK: 0,
  BAD_CODE: 1,
  BAD_MAC: 2,
  BAD_STATE: 3,
  NO_SPACE: 4,
  TOO_MANY: 5,
});

function header(type, payloadLen) {
  const buf = Buffer.alloc(HEADER_LEN);
  MAGIC.copy(buf, 0);
  buf[4] = VERSION;
  buf[5] = type;
  buf[6] = 0;
  buf[7] = 0;
  buf.writeUInt16LE(payloadLen + MAC_LEN, 8);
  return buf;
}

function frame(type, payload, key) {
  const data = Buffer.concat([header(type, payload.length), payload]);
  const mac = key ? createHmac('sha256', key).update(data).digest() : Buffer.alloc(MAC_LEN);
  return Buffer.concat([data, mac]);
}

// 解析帧头，返回 payload 与 MAC 的位置；MAC 校验交给调用方（INIT 不校验）
function parse(raw) {
  const buf = Buffer.from(raw);
  if (buf.length < HEADER_LEN + MAC_LEN) throw new Error('帧太短');
  if (!buf.subarray(0, 4).equals(MAGIC)) throw new Error('magic 不是 SFC1');
  if (buf[4] !== VERSION) throw new Error('版本不支持');
  if (buf[6] !== 0 || buf[7] !== 0) throw new Error('保留位非零');
  if (buf.readUInt16LE(8) + HEADER_LEN !== buf.length) throw new Error('长度不匹配');
  return {
    type: buf[5],
    data: buf.subarray(0, buf.length - MAC_LEN),
    payload: buf.subarray(HEADER_LEN, buf.length - MAC_LEN),
    mac: buf.subarray(-MAC_LEN),
  };
}

function verifyMac(parsed, key) {
  const expected = createHmac('sha256', key).update(parsed.data).digest();
  return expected.length === parsed.mac.length && timingSafeEqual(expected, parsed.mac);
}

function sha256(...parts) {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest();
}

// 会话密钥：临时码 + 双方 nonce（32 bit 的码是弱点，见文件头）
function deriveSessionKey(code, hostNonce, deviceNonce) {
  const codeBuf = Buffer.from(String(code || '').trim().toLowerCase(), 'utf8');
  if (codeBuf.length === 0) throw new TypeError('临时码不能为空');
  if (!Buffer.isBuffer(hostNonce) || hostNonce.length !== 16) throw new TypeError('hostNonce 必须是 16 字节');
  if (!Buffer.isBuffer(deviceNonce) || deviceNonce.length !== 16) throw new TypeError('deviceNonce 必须是 16 字节');
  return sha256(Buffer.from('safe-office/provision/v1\0', 'utf8'), codeBuf, hostNonce, deviceNonce);
}

// 新密钥的一次一密密钥流
function keyStream(sessionKey, hostNonce, deviceNonce) {
  return createHmac('sha256', sessionKey)
    .update(Buffer.from('safe-office/provision/key/v1\0', 'utf8'))
    .update(hostNonce)
    .update(deviceNonce)
    .digest()
    .subarray(0, 32);
}

function encodeInit(hostNonce) {
  if (!Buffer.isBuffer(hostNonce) || hostNonce.length !== 16) throw new TypeError('hostNonce 必须是 16 字节');
  return frame(TYPES.INIT, hostNonce, null); // MAC 全 0
}

function decodeInit(raw) {
  const parsed = parse(raw);
  if (parsed.type !== TYPES.INIT) throw new Error('不是 INIT 帧');
  if (parsed.payload.length !== 16) throw new Error('INIT 负载长度非法');
  return { hostNonce: Buffer.from(parsed.payload) };
}

function encodeChallenge({ deviceId, hostNonce, deviceNonce }, sessionKey) {
  if (!Buffer.isBuffer(deviceId) || deviceId.length !== 8) throw new TypeError('deviceId 必须是 8 字节');
  const payload = Buffer.concat([deviceId, hostNonce, deviceNonce]);
  return frame(TYPES.CHALLENGE, payload, sessionKey);
}

// 只解负载、不验 MAC：主机会先用它拿到 device_nonce 派生会话密钥，再走 decodeChallenge 验 MAC
function peekChallenge(raw) {
  const parsed = parse(raw);
  if (parsed.type !== TYPES.CHALLENGE) throw new Error('不是 CHALLENGE 帧');
  if (parsed.payload.length !== 40) throw new Error('CHALLENGE 负载长度非法');
  return {
    deviceId: Buffer.from(parsed.payload.subarray(0, 8)),
    hostNonce: Buffer.from(parsed.payload.subarray(8, 24)),
    deviceNonce: Buffer.from(parsed.payload.subarray(24, 40)),
  };
}

function decodeChallenge(raw, sessionKey) {
  const parsed = parse(raw);
  if (parsed.type !== TYPES.CHALLENGE) throw new Error('不是 CHALLENGE 帧');
  if (!verifyMac(parsed, sessionKey)) throw new Error('CHALLENGE MAC 校验失败');
  if (parsed.payload.length !== 40) throw new Error('CHALLENGE 负载长度非法');
  return {
    deviceId: Buffer.from(parsed.payload.subarray(0, 8)),
    hostNonce: Buffer.from(parsed.payload.subarray(8, 24)),
    deviceNonce: Buffer.from(parsed.payload.subarray(24, 40)),
  };
}

function encodeCommit({ deviceId, hostNonce, deviceNonce, newKey }, sessionKey) {
  if (!Buffer.isBuffer(newKey) || newKey.length !== 32) throw new TypeError('newKey 必须是 32 字节');
  const mask = keyStream(sessionKey, hostNonce, deviceNonce);
  const cipher = Buffer.alloc(32);
  for (let i = 0; i < 32; i += 1) cipher[i] = newKey[i] ^ mask[i];
  return frame(TYPES.COMMIT, Buffer.concat([deviceId, hostNonce, deviceNonce, cipher]), sessionKey);
}

function decodeCommit(raw, sessionKey) {
  const parsed = parse(raw);
  if (parsed.type !== TYPES.COMMIT) throw new Error('不是 COMMIT 帧');
  if (!verifyMac(parsed, sessionKey)) throw new Error('COMMIT MAC 校验失败');
  if (parsed.payload.length !== 72) throw new Error('COMMIT 负载长度非法');
  const deviceId = Buffer.from(parsed.payload.subarray(0, 8));
  const hostNonce = Buffer.from(parsed.payload.subarray(8, 24));
  const deviceNonce = Buffer.from(parsed.payload.subarray(24, 40));
  const mask = keyStream(sessionKey, hostNonce, deviceNonce);
  const newKey = Buffer.alloc(32);
  for (let i = 0; i < 32; i += 1) newKey[i] = parsed.payload[40 + i] ^ mask[i];
  return { deviceId, hostNonce, deviceNonce, newKey };
}

function encodeOk({ deviceId, status = STATUS.OK }, sessionKey) {
  if (!Buffer.isBuffer(deviceId) || deviceId.length !== 8) throw new TypeError('deviceId 必须是 8 字节');
  return frame(TYPES.OK, Buffer.concat([deviceId, Buffer.from([status])]), sessionKey);
}

function decodeOk(raw, sessionKey) {
  const parsed = parse(raw);
  if (parsed.type !== TYPES.OK) throw new Error('不是 OK 帧');
  if (!verifyMac(parsed, sessionKey)) throw new Error('OK MAC 校验失败');
  if (parsed.payload.length !== 9) throw new Error('OK 负载长度非法');
  return { deviceId: Buffer.from(parsed.payload.subarray(0, 8)), status: parsed.payload[8] };
}

function encodePing(hostNonce, key) {
  if (!Buffer.isBuffer(hostNonce) || hostNonce.length !== 16) throw new TypeError('hostNonce 必须是 16 字节');
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new TypeError('key 必须是 32 字节');
  return frame(TYPES.PING, hostNonce, key);
}

function decodePing(raw, key) {
  const parsed = parse(raw);
  if (parsed.type !== TYPES.PING) throw new Error('不是 PING 帧');
  if (!verifyMac(parsed, key)) throw new Error('PING MAC 校验失败');
  if (parsed.payload.length !== 16) throw new Error('PING 负载长度非法');
  return { hostNonce: Buffer.from(parsed.payload) };
}

function encodePong({ deviceId, hostNonce }, key) {
  if (!Buffer.isBuffer(deviceId) || deviceId.length !== 8) throw new TypeError('deviceId 必须是 8 字节');
  return frame(TYPES.PONG, Buffer.concat([deviceId, hostNonce]), key);
}

function decodePong(raw, key) {
  const parsed = parse(raw);
  if (parsed.type !== TYPES.PONG) throw new Error('不是 PONG 帧');
  if (!verifyMac(parsed, key)) throw new Error('PONG MAC 校验失败');
  if (parsed.payload.length !== 24) throw new Error('PONG 负载长度非法');
  return {
    deviceId: Buffer.from(parsed.payload.subarray(0, 8)),
    hostNonce: Buffer.from(parsed.payload.subarray(8, 24)),
  };
}

function encodeErr({ status, reason = '' }, sessionKey) {
  const text = Buffer.from(String(reason).replace(/[^\x20-\x7E]/g, '?'), 'ascii').subarray(0, 32);
  return frame(TYPES.ERR, Buffer.concat([Buffer.from([status & 0xff, text.length]), text]), sessionKey);
}

function decodeErr(raw, sessionKey) {
  const parsed = parse(raw);
  if (parsed.type !== TYPES.ERR) throw new Error('不是 ERR 帧');
  if (!verifyMac(parsed, sessionKey)) throw new Error('ERR MAC 校验失败');
  if (parsed.payload.length < 2) throw new Error('ERR 负载长度非法');
  const status = parsed.payload[0];
  const len = parsed.payload[1];
  if (parsed.payload.length !== 2 + len) throw new Error('ERR 负载长度非法');
  return { status, reason: parsed.payload.subarray(2, 2 + len).toString('ascii') };
}

module.exports = {
  TYPES,
  STATUS,
  deriveSessionKey,
  keyStream,
  encodeInit,
  decodeInit,
  encodeChallenge,
  peekChallenge,
  decodeChallenge,
  encodeCommit,
  decodeCommit,
  encodeOk,
  decodeOk,
  encodePing,
  decodePing,
  encodePong,
  decodePong,
  encodeErr,
  decodeErr,
  randomNonce: () => randomBytes(16),
  MAGIC,
  MAC_LEN,
  TAG_LEN,
};
