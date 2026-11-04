'use strict';
// SFC1 v1 wire codec. Keys and transport are supplied by the trusted application.
const { createHmac, timingSafeEqual } = require('node:crypto');
const ACTION_MIN = 1;
const ACTION_MAX = 4;
/** @param {any} value @param {number} length @param {string} name @returns {Buffer} */
function bytes(value, length, name) {
  if (!Buffer.isBuffer(value) || value.length !== length) throw new TypeError(`${name}: expected ${length} bytes`);
  return value;
}
/** @param {number} value @returns {Buffer} */
function u32(value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new RangeError('invalid uint32');
  const b = Buffer.alloc(4); b.writeUInt32LE(value); return b;
}
/** @param {number} value @param {number} [max] @returns {Buffer} */
function byte(value, max = 255) {
  if (!Number.isInteger(value) || value < 0 || value > max) throw new RangeError('invalid byte');
  return Buffer.from([value]);
}
/** @param {number} type @param {Buffer} payload @param {Buffer} key @returns {Buffer} */
function frame(type, payload, key) {
  bytes(key, 32, 'key');
  const header = Buffer.from([83, 70, 67, 49, 1, type, 0, 0, 0, 0]);
  header.writeUInt16LE(payload.length + 32, 8);
  const data = Buffer.concat([header, payload]);
  return Buffer.concat([data, createHmac('sha256', key).update(data).digest()]);
}
/** @param {{taskId:Buffer, nonce:Buffer, action:number, operationHash:Buffer, issuedAt:number, expiresAt:number, summary:string}} c @param {Buffer} key @returns {Buffer} */
function encodeChallenge(c, key) {
  if (typeof c.summary !== 'string') throw new TypeError('summary must be a string');
  const summary = Buffer.from(c.summary, 'utf8');
  if (summary.length > 96 || summary.includes(0)) throw new RangeError('summary exceeds 96 bytes or contains NUL');
  if (c.expiresAt <= c.issuedAt) throw new RangeError('invalid challenge lifetime');
  if (!Number.isInteger(c.action) || c.action < ACTION_MIN || c.action > ACTION_MAX) throw new RangeError('invalid action');
  return frame(1, Buffer.concat([bytes(c.taskId, 8, 'taskId'), bytes(c.nonce, 16, 'nonce'),
    byte(c.action), bytes(c.operationHash, 32, 'operationHash'), u32(c.issuedAt), u32(c.expiresAt),
    byte(summary.length), summary]), key);
}
/** @param {{taskId:Buffer, nonce:Buffer, decision:number, deviceId:Buffer, decidedAt:number}} d @param {Buffer} key @returns {Buffer} */
function encodeDecision(d, key) {
  return frame(2, Buffer.concat([bytes(d.taskId, 8, 'taskId'), bytes(d.nonce, 16, 'nonce'),
    byte(d.decision, 1), bytes(d.deviceId, 8, 'deviceId'), u32(d.decidedAt)]), key);
}
/** @param {{nonce:Buffer, pin:number, level:number}} a @param {Buffer} key @returns {Buffer} */
function encodeActuator(a, key) {
  return frame(0x21, Buffer.concat([
    bytes(a.nonce, 16, 'nonce'), byte(a.pin), byte(a.level, 1),
  ]), key);
}
/** @param {Buffer} input @param {Buffer} key @returns {any} */
function decodeFrame(input, key) {
  bytes(key, 32, 'key');
  if (!Buffer.isBuffer(input) || input.length < 42) throw new Error('invalid frame');
  const b = Buffer.from(input);
  if (!b.subarray(0, 4).equals(Buffer.from('SFC1')) || b[4] !== 1 || b[6] || b[7] ||
      b.readUInt16LE(8) + 10 !== b.length || ![1, 2, 0x21, 0x22].includes(b[5])) throw new Error('invalid header');
  const data = b.subarray(0, -32);
  const expected = createHmac('sha256', key).update(data).digest();
  if (!timingSafeEqual(expected, b.subarray(-32))) throw new Error('invalid MAC');
  const p = b.subarray(10, -32);
  if (b[5] === 0x22) {
    if (p.length !== 19 || p[18] > 1) throw new Error('invalid actuator ack');
    return {
      type: 'actuator-ack',
      nonce: Buffer.from(p.subarray(0, 16)),
      status: p[16],
      pin: p[17],
      level: p[18],
    };
  }
  if (b[5] === 0x21) {
    if (p.length !== 18 || p[17] > 1) throw new Error('invalid actuator');
    return { type: 'actuator', nonce: Buffer.from(p.subarray(0, 16)), pin: p[16], level: p[17] };
  }
  const common = { taskId: Buffer.from(p.subarray(0, 8)), nonce: Buffer.from(p.subarray(8, 24)) };
  if (b[5] === 2) {
    if (p.length !== 37 || p[24] > 1) throw new Error('invalid decision');
    return { type: 'decision', ...common, decision: p[24], deviceId: Buffer.from(p.subarray(25, 33)), decidedAt: p.readUInt32LE(33) };
  }
  if (p.length < 66 || p[65] > 96 || p.length !== 66 + p[65]) throw new Error('invalid challenge');
  if (p[24] < ACTION_MIN || p[24] > ACTION_MAX) throw new Error('invalid action');
  const issuedAt = p.readUInt32LE(57), expiresAt = p.readUInt32LE(61);
  if (expiresAt <= issuedAt) throw new Error('invalid lifetime');
  const summary = new TextDecoder('utf-8', { fatal: true }).decode(p.subarray(66));
  if (summary.includes('\0')) throw new Error('invalid summary');
  return { type: 'challenge', ...common, action: p[24], operationHash: Buffer.from(p.subarray(25, 57)), issuedAt, expiresAt, summary };
}
module.exports = { encodeChallenge, encodeDecision, encodeActuator, decodeFrame };
