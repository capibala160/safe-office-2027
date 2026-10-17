'use strict';
// ============================================================
// 最终操作记录（v0.10）
//   目的：把"确认"和"执行"绑到同一条不可变记录上。
//   - 冻结：记录创建后计算 bodyHash / attachmentHashes / operationHash
//   - 校验：执行前重算哈希；正文、收件人、附件、来源任一变化都拒绝
//   - 状态：frozen → confirmed → executing → executed / failed
//   - operationHash 就是 WS63 挑战里的 target_hash（32 字节）
// 边界：记录含正文，本地 SQLite 明文存储；生产需加密/最小化留存。
// ============================================================
const crypto = require('node:crypto');

const PROTOCOL_ACTIONS = {
  1: '外发',
  2: '删除',
  3: '打印',
  4: '设备控制',
};

const TRANSITIONS = {
  frozen: new Set(['confirmed', 'rejected', 'expired']),
  confirmed: new Set(['executing', 'expired', 'failed']),
  executing: new Set(['executed', 'failed']),
  executed: new Set(),
  failed: new Set(),
  rejected: new Set(),
  expired: new Set(),
};

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${name} 必须是非空字符串`);
  }
  return value;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

function normalizeAttachments(attachments = []) {
  if (!Array.isArray(attachments)) throw new TypeError('attachments 必须是数组');
  return attachments.map((a, i) => {
    if (!a || typeof a !== 'object') throw new TypeError(`attachments[${i}] 非法`);
    const name = requiredString(a.name, `attachments[${i}].name`);
    let sha = a.sha256;
    if (sha === undefined && a.data !== undefined) {
      const buf = Buffer.isBuffer(a.data) ? a.data : Buffer.from(String(a.data), 'utf8');
      sha = sha256Hex(buf);
    }
    if (typeof sha !== 'string' || !/^[0-9a-f]{64}$/i.test(sha)) {
      throw new TypeError(`attachments[${i}].sha256 必须是 64 位十六进制`);
    }
    const size = a.size === undefined
      ? (a.data !== undefined ? (Buffer.isBuffer(a.data) ? a.data.length : Buffer.byteLength(String(a.data))) : 0)
      : a.size;
    if (!Number.isInteger(size) || size < 0) throw new TypeError(`attachments[${i}].size 非法`);
    return { name, sha256: sha.toLowerCase(), size };
  });
}

function canonicalRecord(record) {
  return JSON.stringify({
    operationId: record.operationId,
    taskId: record.taskId,
    action: record.action,
    protocolAction: record.protocolAction,
    tool: record.tool,
    recipient: record.recipient,
    subject: record.subject,
    bodyHash: record.bodyHash,
    attachmentHashes: record.attachmentHashes,
    sourceDocIds: record.sourceDocIds,
    level: record.level,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    modelId: record.modelId,
    planHash: record.planHash,
  });
}

function computeOperationHash(record) {
  return sha256Hex(canonicalRecord(record));
}

// 创建并冻结一条最终操作记录；任何字段变化都必须重新创建/重新确认
function sealOperation(input = {}) {
  if (!input || typeof input !== 'object') throw new TypeError('操作记录必须是对象');
  const body = input.body === undefined ? '' : String(input.body);
  const attachments = normalizeAttachments(input.attachments || []);
  const createdAt = input.createdAt || new Date().toISOString();
  const expiresAt = input.expiresAt;
  if (typeof expiresAt !== 'string' || Number.isNaN(Date.parse(expiresAt))) {
    throw new TypeError('expiresAt 必须是 ISO 时间字符串');
  }
  if (Date.parse(expiresAt) <= Date.parse(createdAt)) {
    throw new RangeError('expiresAt 必须晚于 createdAt');
  }
  const protocolAction = input.protocolAction;
  if (!PROTOCOL_ACTIONS[protocolAction]) throw new RangeError('protocolAction 必须是 1–4');

  const base = {
    operationId: input.operationId || crypto.randomUUID(),
    taskId: requiredString(input.taskId, 'taskId'),
    action: requiredString(input.action, 'action'),
    protocolAction,
    tool: input.tool || input.action,
    recipient: requiredString(input.recipient, 'recipient'),
    subject: input.subject || '',
    body,
    bodyHash: sha256Hex(Buffer.from(body, 'utf8')),
    attachments,
    attachmentHashes: attachments.map((a) => ({ ...a })),
    sourceDocIds: Array.isArray(input.sourceDocIds) ? [...input.sourceDocIds] : [],
    level: input.level || '内部',
    createdAt,
    expiresAt,
    modelId: input.modelId || '',
    planHash: input.planHash || '',
    state: 'frozen',
  };
  base.operationHash = computeOperationHash(base);
  return deepFreeze(base);
}

// 执行前校验：正文/附件/记录字段任一变化 → 失败
function verifyOperation(record) {
  if (!record || typeof record !== 'object') return { ok: false, reason: '缺少操作记录' };
  if (!/^[0-9a-f]{64}$/i.test(String(record.operationHash || ''))) {
    return { ok: false, reason: 'operationHash 非法' };
  }
  const bodyHash = sha256Hex(Buffer.from(String(record.body ?? ''), 'utf8'));
  if (bodyHash !== record.bodyHash) {
    return { ok: false, reason: '正文已变化', expectedHash: record.bodyHash, actualHash: bodyHash };
  }
  let attachments;
  try {
    attachments = normalizeAttachments(record.attachments || []);
  } catch (err) {
    return { ok: false, reason: `附件非法：${err.message}` };
  }
  const attachmentHashes = attachments.map((a) => ({ ...a }));
  if (JSON.stringify(attachmentHashes) !== JSON.stringify(record.attachmentHashes)) {
    return { ok: false, reason: '附件已变化' };
  }
  if (!PROTOCOL_ACTIONS[record.protocolAction]) {
    return { ok: false, reason: 'protocolAction 非法' };
  }
  const actualHash = computeOperationHash({ ...record, bodyHash, attachmentHashes });
  if (String(record.operationHash).toLowerCase() !== actualHash) {
    return { ok: false, reason: '操作记录已变化', expectedHash: record.operationHash, actualHash };
  }
  return { ok: true, reason: 'ok', actualHash };
}

// 状态迁移：不改 operationHash（状态不在规范化哈希内），返回新冻结记录
function transition(record, next, { at = new Date().toISOString() } = {}) {
  if (!record || !TRANSITIONS[record.state]) throw new TypeError('未知操作状态');
  if (!TRANSITIONS[record.state].has(next)) {
    throw new RangeError(`非法状态迁移：${record.state} → ${next}`);
  }
  return deepFreeze({ ...record, state: next, updatedAt: at });
}

function describeOperation(record) {
  const label = PROTOCOL_ACTIONS[record.protocolAction] || '未知动作';
  return `${label} → ${record.recipient}（正文 ${String(record.bodyHash).slice(0, 8)}…）`;
}

module.exports = {
  PROTOCOL_ACTIONS, TRANSITIONS,
  sealOperation, verifyOperation, transition, describeOperation,
  computeOperationHash, sha256Hex,
};
