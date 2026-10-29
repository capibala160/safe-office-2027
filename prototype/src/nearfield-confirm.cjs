'use strict';
// ============================================================
// WS63 确认适配器（v0.11）
//   A 端 NearfieldConfirmer：冻结操作 → SFC1 CHALLENGE → 校验 DECISION
//   B 端 VirtualDevice：无硬件替身（真 HMAC、假设备）
//   传输层只要求 { send(frame) -> Promise<Buffer|null> }，上板换串口/SLE
//   状态机镜像 ws63/protocol.c 的 proto_accept_bound_decision：
//     无 pending → STATE；task → TASK；nonce → NONCE；已用窗口 → REPLAY；
//     now>=expires → EXPIRED（消费 nonce）；绑定设备 → DEVICE；
//     绑定最终操作 → OPERATION；取消 → DECISION（消费 nonce）；成功 → 消费 nonce
//   边界：虚拟设备不是硬件；PSK 在 Node 内存；不做距离/身份/防中继证明
// ============================================================
const crypto = require('node:crypto');
const { encodeChallenge, encodeDecision, decodeFrame } = require('./ws63-protocol.cjs');
const { PROTOCOL_ACTIONS, verifyOperation } = require('./operation.cjs');

const REPLAY_WINDOW = 8;
const SUMMARY_MAX_BYTES = 96;
const UINT32_MAX = 0xffffffff;
const SFC1_MAGIC = Buffer.from('SFC1');
const TASK_DOMAIN = Buffer.from('safe-office/ws63/task-id/v1\0', 'utf8');
const DEVICE_DOMAIN = Buffer.from('safe-office/ws63/device-id/v1\0', 'utf8');

const NEARFIELD_ERROR_CODES = [
  'ARG', 'FRAME', 'VERSION', 'TYPE', 'MAC', 'STATE', 'TASK', 'NONCE',
  'REPLAY', 'EXPIRED', 'DECISION', 'DEVICE', 'OPERATION', 'TIMEOUT',
];

const ERROR_TEXT = {
  ARG: '参数非法',
  FRAME: '帧格式非法',
  VERSION: '协议版本不支持',
  TYPE: '帧类型不支持',
  MAC: 'MAC 校验失败',
  STATE: '没有待确认任务，或状态不允许',
  TASK: 'task_id 不匹配',
  NONCE: 'nonce 不匹配',
  REPLAY: 'nonce 已被消费（重放）',
  EXPIRED: '确认任务已过期',
  DECISION: '用户取消，或决定值非法',
  DEVICE: '设备 ID 与可信配对配置不符',
  OPERATION: '最终操作与确认目标不符或已变化',
  TIMEOUT: '确认端无响应',
};

class NearfieldError extends Error {
  constructor(code, message, extra = {}) {
    super(message || ERROR_TEXT[code] || code, extra.cause ? { cause: extra.cause } : undefined);
    this.name = 'NearfieldError';
    this.code = code;
    for (const [key, value] of Object.entries(extra)) {
      if (key !== 'cause') this[key] = value;
    }
  }
}

function deriveBytes(value, domain, name) {
  if (Buffer.isBuffer(value)) {
    if (value.length !== 8) throw new TypeError(`${name} Buffer 必须是 8 字节`);
    return Buffer.from(value);
  }
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`${name} 必须是非空字符串或 8 字节 Buffer`);
  }
  const digest = crypto.createHash('sha256')
    .update(Buffer.concat([domain, Buffer.from(value, 'utf8')]))
    .digest();
  return Buffer.from(digest.subarray(0, 8));
}

function deriveTaskId(value) {
  return deriveBytes(value, TASK_DOMAIN, 'taskId');
}

function deriveDeviceId(value) {
  return deriveBytes(value, DEVICE_DOMAIN, 'deviceId');
}

// 按 UTF-8 字节截断，绝不切断码点；剩余空间 >=3B 才补省略号
function truncateUtf8(text, maxBytes = SUMMARY_MAX_BYTES) {
  const input = String(text ?? '').toWellFormed();
  let out = '';
  let used = 0;
  for (const ch of input) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (used + size > maxBytes) {
      if (maxBytes - used >= 3) out += '…';
      return out;
    }
    out += ch;
    used += size;
  }
  return out;
}

function buildSummary(operation = {}) {
  const label = PROTOCOL_ACTIONS[operation.protocolAction] || '操作';
  const clean = (value) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  const subject = clean(operation.subject) || '（无主题）';
  const recipient = clean(operation.recipient);
  const sep = '｜';
  const tail = recipient ? `｜→ ${recipient}` : '';
  const labelBytes = Buffer.byteLength(label, 'utf8');
  const fixedBytes = Buffer.byteLength(`${label}${sep}${tail}`, 'utf8');

  // 收件人是"发给谁"的唯一凭据：先保证它完整可见，主题让位。
  // 旧实现整体截断 → 长中文主题能把收件人整个挤掉，确认人看不到发给谁。
  if (Buffer.byteLength(`${label}${tail}`, 'utf8') >= SUMMARY_MAX_BYTES) {
    return `${label}${truncateUtf8(tail, Math.max(0, SUMMARY_MAX_BYTES - labelBytes))}`;
  }
  const shortSubject = truncateUtf8(subject, SUMMARY_MAX_BYTES - fixedBytes);
  return shortSubject ? `${label}${sep}${shortSubject}${tail}` : `${label}${tail}`;
}

class NearfieldConfirmer {
  constructor({
    key,
    expectedDeviceId,
    deviceLabel = null,
    ttlSec = 30,
    now = () => Math.floor(Date.now() / 1000),
    randomBytes = crypto.randomBytes,
    transport = null,
  } = {}) {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new TypeError('key 必须是 32 字节 Buffer');
    if (expectedDeviceId === undefined || expectedDeviceId === null) {
      throw new TypeError('expectedDeviceId 必填（来自可信配对配置）');
    }
    if (!Number.isInteger(ttlSec) || ttlSec <= 0 || ttlSec > UINT32_MAX) {
      throw new TypeError('ttlSec 必须是 1..0xFFFFFFFF 的整数');
    }
    this.key = Buffer.from(key);
    this.expectedDeviceId = deriveDeviceId(expectedDeviceId);
    this.deviceLabel = deviceLabel
      ?? (typeof expectedDeviceId === 'string' ? expectedDeviceId : this.expectedDeviceId.toString('hex'));
    this.ttlSec = ttlSec;
    this.now = now;
    this.randomBytes = randomBytes;
    this.transport = transport;
    this.pending = null;
    this.used = [];
  }

  _now() {
    const now = this.now();
    if (!Number.isInteger(now) || now < 0 || now > UINT32_MAX) {
      throw new NearfieldError('ARG', 'now() 必须返回 uint32 秒');
    }
    return now;
  }

  _nonceUsed(nonce) {
    return this.used.some((used) => used.equals(nonce));
  }

  _markUsed(nonce) {
    this.used.push(Buffer.from(nonce));
    while (this.used.length > REPLAY_WINDOW) this.used.shift();
  }

  _decodeDecision(buffer) {
    if (buffer.length >= 6) {
      if (!buffer.subarray(0, 4).equals(SFC1_MAGIC)) throw new NearfieldError('FRAME', '帧头 magic 非法');
      if (buffer[4] !== 1) throw new NearfieldError('VERSION', '协议版本不支持');
      if (buffer[5] !== 1 && buffer[5] !== 2) throw new NearfieldError('TYPE', '未知帧类型');
    }
    let frame;
    try {
      frame = decodeFrame(buffer, this.key);
    } catch (err) {
      const message = String(err && err.message ? err.message : err);
      if (/MAC/i.test(message)) throw new NearfieldError('MAC', 'MAC 校验失败', { cause: err });
      if (/decision/i.test(message)) throw new NearfieldError('DECISION', '决定帧非法', { cause: err });
      throw new NearfieldError('FRAME', `帧解码失败：${message}`, { cause: err });
    }
    if (frame.type !== 'decision') throw new NearfieldError('TYPE', '期望 DECISION 帧');
    return frame;
  }

  beginChallenge(operation) {
    if (!operation || typeof operation !== 'object') throw new NearfieldError('ARG', '缺少操作记录');
    const check = verifyOperation(operation);
    if (!check.ok || operation.state !== 'frozen') {
      throw new NearfieldError('OPERATION', `冻结记录校验失败：${check.ok ? '状态不是 frozen' : check.reason}`);
    }
    if (!Number.isInteger(operation.protocolAction) || operation.protocolAction < 1 || operation.protocolAction > 4) {
      throw new NearfieldError('OPERATION', 'protocolAction 必须是 1–4 的整数');
    }
    if (!/^[0-9a-f]{64}$/i.test(String(operation.operationHash || ''))) {
      throw new NearfieldError('OPERATION', 'operationHash 非法');
    }
    const operationExpiresAt = Math.floor(Date.parse(operation.expiresAt) / 1000);
    if (!Number.isFinite(operationExpiresAt)) throw new NearfieldError('OPERATION', 'expiresAt 非法');

    const now = this._now();
    if (now >= operationExpiresAt) throw new NearfieldError('EXPIRED', '操作记录已过期');
    if (now + this.ttlSec > UINT32_MAX) throw new NearfieldError('ARG', 'TTL 溢出');

    // 未过期的 pending 不能被覆盖；过期的 pending 先消费再让位（镜像 proto_pending_begin）
    if (this.pending) {
      if (now < this.pending.expiresAt) throw new NearfieldError('STATE', '已有未过期的待确认任务');
      this._markUsed(this.pending.nonce);
      this.pending = null;
    }

    let nonce = this.randomBytes(16);
    if (!Buffer.isBuffer(nonce) || nonce.length !== 16) {
      throw new NearfieldError('ARG', 'randomBytes 必须返回 16 字节 Buffer');
    }
    nonce = Buffer.from(nonce);
    if (this._nonceUsed(nonce)) throw new NearfieldError('REPLAY', 'nonce 已使用');

    const expiresAt = Math.min(now + this.ttlSec, operationExpiresAt);
    const pending = Object.freeze({
      taskId: deriveTaskId(operation.taskId),
      nonce,
      action: operation.protocolAction,
      targetHash: Buffer.from(operation.operationHash, 'hex'),
      issuedAt: now,
      expiresAt,
      summary: buildSummary(operation),
      operationId: operation.operationId,
    });
    const frame = encodeChallenge({
      taskId: pending.taskId,
      nonce: pending.nonce,
      action: pending.action,
      operationHash: pending.targetHash,
      issuedAt: pending.issuedAt,
      expiresAt: pending.expiresAt,
      summary: pending.summary,
    }, this.key);

    this.pending = pending;
    return { pending, frame };
  }

  acceptDecision(pending, buffer, { finalOperation } = {}) {
    // 已无 pending → STATE（与 C 一致）；有 pending 但传入旧/克隆对象 → ARG
    if (!this.pending) throw new NearfieldError('STATE', '没有待确认任务');
    if (!pending || pending !== this.pending) {
      throw new NearfieldError('ARG', 'pending 必须来自本实例最近一次 beginChallenge');
    }
    if (!finalOperation || typeof finalOperation !== 'object') {
      throw new NearfieldError('ARG', '缺少 finalOperation（最终冻结记录）');
    }
    if (!Buffer.isBuffer(buffer)) throw new NearfieldError('FRAME', '决定帧必须是 Buffer');

    // 先解码：帧头/长度/类型/MAC/decision 值域（MAC 先于绑定）
    const decision = this._decodeDecision(buffer);

    // 以下顺序镜像 C accept_decision_internal
    if (!this.pending) throw new NearfieldError('STATE', '没有待确认任务');
    if (!decision.taskId.equals(pending.taskId)) throw new NearfieldError('TASK', 'task_id 不匹配');
    if (!decision.nonce.equals(pending.nonce)) throw new NearfieldError('NONCE', 'nonce 不匹配');
    if (this._nonceUsed(decision.nonce)) throw new NearfieldError('REPLAY', 'nonce 已消费');

    const now = this._now();
    if (now >= pending.expiresAt) {
      this._markUsed(pending.nonce);
      this.pending = null;
      throw new NearfieldError('EXPIRED', '确认任务已过期');
    }
    if (decision.decision > 1) throw new NearfieldError('DECISION', '决定值非法');

    // 绑定检查严格在 MAC 之后：错误 MAC 不泄露设备/操作是否匹配
    if (!decision.deviceId.equals(this.expectedDeviceId)) {
      throw new NearfieldError('DEVICE', '设备 ID 与可信配对配置不符');
    }
    const check = verifyOperation(finalOperation);
    if (!check.ok || finalOperation.state !== 'frozen' ||
        finalOperation.protocolAction !== pending.action ||
        !Buffer.from(finalOperation.operationHash, 'hex').equals(pending.targetHash)) {
      throw new NearfieldError('OPERATION', '最终操作与确认目标不符或已变化');
    }

    if (decision.decision === 0) {
      this._markUsed(decision.nonce);
      this.pending = null;
      throw new NearfieldError('DECISION', '用户取消', { cancelled: true });
    }

    this._markUsed(decision.nonce);
    this.pending = null;
    return {
      decision: 1,
      taskId: Buffer.from(pending.taskId),
      nonce: Buffer.from(pending.nonce),
      deviceId: Buffer.from(this.expectedDeviceId),
      replyDeviceId: Buffer.from(decision.deviceId),
      deviceLabel: this.deviceLabel,
      decidedAt: decision.decidedAt,
      operationId: finalOperation.operationId,
      operationHash: finalOperation.operationHash,
      action: finalOperation.protocolAction,
      confirmationId: `ws63-${pending.taskId.toString('hex')}-${pending.nonce.toString('hex')}`,
    };
  }

  cancel(pending = this.pending) {
    if (!pending || pending !== this.pending) return false;
    this._markUsed(pending.nonce);
    this.pending = null;
    return true;
  }

  abort() {
    return this.cancel(this.pending);
  }

  async requestApproval(operation, { finalOperation = operation, transport = this.transport } = {}) {
    if (!transport || typeof transport.send !== 'function') {
      throw new NearfieldError('ARG', '未配置 transport（send(frame) -> Promise<Buffer|null>）');
    }
    const { pending, frame } = this.beginChallenge(operation);
    let reply;
    try {
      reply = await transport.send(frame);
    } catch (err) {
      this.cancel(pending);
      throw new NearfieldError('TIMEOUT', `确认端无响应：${err.message}`, { cause: err });
    }
    if (!reply) {
      this.cancel(pending);
      throw new NearfieldError('TIMEOUT', '确认端无响应（超时）');
    }
    return this.acceptDecision(pending, reply, { finalOperation });
  }
}

class VirtualDevice {
  constructor({
    key,
    deviceId,
    decide = () => 'approve',
    now = () => Math.floor(Date.now() / 1000),
    replyKey = key,
  } = {}) {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new TypeError('key 必须是 32 字节 Buffer');
    if (deviceId === undefined || deviceId === null) throw new TypeError('deviceId 必填');
    if (!Buffer.isBuffer(replyKey) || replyKey.length !== 32) throw new TypeError('replyKey 必须是 32 字节 Buffer');
    this.key = Buffer.from(key);
    this.deviceId = deriveDeviceId(deviceId);
    this.deviceLabel = typeof deviceId === 'string' ? deviceId : this.deviceId.toString('hex');
    this.replyKey = Buffer.from(replyKey);
    this.decide = decide;
    this.now = now;
  }

  async receive(frame) {
    let challenge;
    try {
      challenge = decodeFrame(frame, this.key);
    } catch {
      return null; // 解不开就静默丢弃，模拟对端无有效应答
    }
    if (challenge.type !== 'challenge') return null;

    const verdict = await this.decide(challenge);
    if (verdict === 'ignore' || verdict === null || verdict === undefined) return null;
    if (verdict !== 'approve' && verdict !== 'cancel') {
      throw new TypeError("decide 必须返回 'approve' | 'cancel' | 'ignore'");
    }
    const now = this.now();
    if (!Number.isInteger(now) || now < 0 || now > UINT32_MAX) throw new TypeError('now() 必须返回 uint32 秒');
    return encodeDecision({
      taskId: challenge.taskId,
      nonce: challenge.nonce,
      decision: verdict === 'approve' ? 1 : 0,
      deviceId: this.deviceId,
      decidedAt: now,
    }, this.replyKey);
  }
}

function createLoopbackTransport(device, { drop = false, tamper = null } = {}) {
  const calls = [];
  return {
    calls,
    async send(frame) {
      calls.push(Buffer.from(frame));
      if (drop) return null;
      const reply = await device.receive(frame);
      if (!reply) return null;
      const mutable = Buffer.from(reply);
      if (typeof tamper === 'function') {
        const changed = tamper(mutable, frame);
        return changed === undefined ? mutable : changed;
      }
      return mutable;
    },
  };
}

async function confirmWithFulfillment({ fulfillment, confirmer, operation }) {
  if (!fulfillment || typeof fulfillment.confirm !== 'function' || !fulfillment.store) {
    throw new TypeError('需要 FulfillmentService');
  }
  if (!confirmer || typeof confirmer.requestApproval !== 'function') {
    throw new TypeError('需要 NearfieldConfirmer');
  }
  if (!operation || typeof operation.operationId !== 'string') throw new TypeError('需要冻结操作记录');

  const stored = fulfillment.store.getOperation(operation.operationId);
  if (!stored) throw new Error(`操作不存在：${operation.operationId}`);

  const approval = await confirmer.requestApproval(stored, { finalOperation: stored });
  const confirmed = fulfillment.confirm(stored.operationId, {
    confirmedHash: stored.operationHash,
    deviceId: confirmer.deviceLabel,
    confirmationId: approval.confirmationId,
  });
  return { approval, ...confirmed };
}

module.exports = {
  NearfieldError,
  NEARFIELD_ERROR_CODES,
  REPLAY_WINDOW,
  SUMMARY_MAX_BYTES,
  deriveTaskId,
  deriveDeviceId,
  truncateUtf8,
  buildSummary,
  NearfieldConfirmer,
  VirtualDevice,
  createLoopbackTransport,
  confirmWithFulfillment,
};
