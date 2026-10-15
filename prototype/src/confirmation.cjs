'use strict';
const crypto = require('node:crypto');
const digest = operation => crypto.createHash('sha256').update(JSON.stringify(operation)).digest('hex');

// 协议原型：生产环境替换密钥保管及应答传输，HMAC 本身不证明距离或身份。
class ConfirmationService {
  constructor({ key = crypto.randomBytes(32), now = Date.now, ttlMs = 30000 } = {}) {
    this.key = key;
    this.now = now;
    this.ttlMs = ttlMs;
    this.pending = new Map();
  }
  challenge(operation) {
    for (const [nonce, c] of this.pending) if (c.expiresAt <= this.now()) this.pending.delete(nonce);
    const c = { nonce: crypto.randomBytes(24).toString('hex'), operationHash: digest(operation), expiresAt: this.now() + this.ttlMs };
    this.pending.set(c.nonce, c);
    return structuredClone(c);
  }
  // 仅供离线模拟持有设备响应；真实节点应在可信界面展示操作并由用户主动确认。
  simulateResponse(c) {
    return { ...c, mac: crypto.createHmac('sha256', this.key).update(JSON.stringify(c)).digest('hex') };
  }
  consume(response, operation) {
    if (!response) return false;
    const c = this.pending.get(response.nonce);
    if (!c) return false;
    this.pending.delete(response.nonce);
    if (c.expiresAt <= this.now() || c.operationHash !== digest(operation)) return false;
    const expected = Buffer.from(this.simulateResponse(c).mac, 'hex');
    const actual = Buffer.from(String(response.mac || ''), 'hex');
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  }
}
module.exports = { ConfirmationService, digest };
