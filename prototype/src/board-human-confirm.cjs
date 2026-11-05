'use strict';
// 闸4 的真板确认实现（docs/59 方案 A 第 2 批）。
//
// 把 runtime 的高危步骤映射成一条 SFC1 CHALLENGE：
//   operationHash = digest(payload)（与运行时将要执行的内容绑定）
//   summary       = ASCII 短摘要（板端 OLED 无中文字库，中文会显示 ?）
// 板端按键后回 DECISION；这里验 MAC / taskId / nonce / device_id / TTL，再交给闸4。
//
// 边界：失败一律返回 approved:false——**不提供任何回退到 nearfieldOnline 的路径**；
//       action 码沿用 SFC1 v1 的 1–4（uploadToCloud / shareScreen 暂借用 DEVICE），
//       真实动作写在摘要里。PSK 仍由调用方传入，密钥管理不在这里解决。

const { randomBytes } = require('node:crypto');
const { encodeChallenge, decodeFrame } = require('./ws63-protocol.cjs');
const { deriveDeviceId } = require('./nearfield-confirm.cjs');

/** @type {Record<string, number>} */
const ACTION_PROTOCOL = {
  sendExternalEmail: 1,
  deleteDoc: 2,
  printDoc: 3,
  deviceControl: 4,
  uploadToCloud: 4,
  shareScreen: 4,
};

/** @type {Record<string, string>} */
const ACTION_LABEL = {
  sendExternalEmail: 'SEND EXT',
  deleteDoc: 'DELETE',
  printDoc: 'PRINT',
  deviceControl: 'DEVICE',
  uploadToCloud: 'UPLOAD',
  shareScreen: 'SHARE',
};

const SUMMARY_MAX = 96;

// OLED 只有 ASCII 字库：非可打印字符一律替换成 ?，再按字节截断
/** @param {any} value @param {number} [maxBytes] @returns {string} */
function toAscii(value, maxBytes = SUMMARY_MAX) {
  const text = String(value === undefined || value === null ? '' : value).replace(/[^\x20-\x7E]/g, '?');
  return Buffer.from(text, 'ascii').subarray(0, maxBytes).toString('ascii');
}

/** @param {any} operation @returns {string} */
function defaultSummary(operation) {
  const action = String(operation.action || '');
  const label = ACTION_LABEL[action] || toAscii(action || 'ACTION', 12).toUpperCase();
  const args = operation.args || {};
  const target = args.to || args.id || args.target || args.printer || args.name || '';
  return toAscii(target ? `${label} ${target}` : label, SUMMARY_MAX);
}

/**
 * @param {{ transportFactory: () => Promise<{ send: (frame: Buffer) => Promise<any> }>, key: Buffer | (() => Buffer), deviceId: string | Buffer | (() => string | Buffer), ttlSec?: number, now?: () => number, summaryOf?: (operation: any) => string, logger?: ((line: string) => void) | null }} [options]
 * @returns {(params?: { operation?: any }) => Promise<{ approved: boolean, method: string, proof?: any }>}
 */
function createBoardHumanConfirm({
  transportFactory,
  key,
  deviceId,
  ttlSec = 30,
  now = () => Math.floor(Date.now() / 1000),
  summaryOf = defaultSummary,
  logger = null,
} = /** @type {any} */ ({})) {
  if (typeof transportFactory !== 'function') throw new TypeError('transportFactory 必填');
  // key / deviceId 支持传函数：控制台切换设备时不必重建 runtime 的 humanConfirm
  if (typeof key !== 'function' && (!Buffer.isBuffer(key) || key.length !== 32)) {
    throw new TypeError('key 必须是 32 字节 Buffer（或返回 Buffer 的函数）');
  }
  if (typeof deviceId !== 'function' && (typeof deviceId !== 'string' || deviceId.trim() === '')) {
    throw new TypeError('deviceId 必填（字符串或返回字符串的函数）');
  }
  if (!Number.isInteger(ttlSec) || ttlSec <= 0) throw new TypeError('ttlSec 必须是正整数');
  if (typeof now !== 'function') throw new TypeError('now 必须是函数');

  const keySource = typeof key === 'function' ? key : () => key;
  const deviceSource = typeof deviceId === 'function' ? deviceId : () => deviceId;
  const currentKey = () => {
    const value = keySource();
    if (!Buffer.isBuffer(value) || value.length !== 32) throw new TypeError('key 必须是 32 字节 Buffer');
    return value;
  };
  const currentDeviceId = () => {
    const value = deviceSource();
    if (typeof value !== 'string' || value.trim() === '') throw new TypeError('deviceId 必填');
    return value;
  };
  /** @param {string} line */
  const log = (line) => { if (typeof logger === 'function') logger(line); };

  return async function boardHumanConfirm({ operation } = {}) {
    if (!operation || typeof operation.contentHash !== 'string' || !/^[0-9a-f]{64}$/i.test(operation.contentHash)) {
      return { approved: false, method: '确认端参数错误：缺少 32 字节 contentHash' };
    }
    let keyNow;
    let expectedDevice;
    try {
      keyNow = currentKey();
      expectedDevice = deriveDeviceId(currentDeviceId());
    } catch (err) {
      return { approved: false, method: `确认端参数错误：${err instanceof Error ? err.message : String(err)}` };
    }

    const action = ACTION_PROTOCOL[operation.action] || 4;
    const issuedAt = now();
    const taskId = randomBytes(8);
    const nonce = randomBytes(16);
    const summary = toAscii(summaryOf(operation), SUMMARY_MAX);
    const frame = encodeChallenge({
      taskId,
      nonce,
      action,
      operationHash: Buffer.from(operation.contentHash, 'hex'),
      issuedAt,
      expiresAt: issuedAt + ttlSec,
      summary,
    }, keyNow);

    let transport;
    try {
      transport = await transportFactory();
    } catch (err) {
      return { approved: false, method: `确认端不可用：${err instanceof Error ? err.message : String(err)}` };
    }

    log(`闸4 板端确认：${summary}（TTL ${ttlSec}s）`);
    let reply;
    try {
      reply = await transport.send(frame);
    } catch (err) {
      return { approved: false, method: `确认端异常：${err instanceof Error ? err.message : String(err)}` };
    }
    if (!reply) return { approved: false, method: '板端无响应（超时）' };

    let decision;
    try {
      decision = decodeFrame(reply, keyNow);
    } catch (err) {
      return { approved: false, method: `决定帧非法：${err instanceof Error ? err.message : String(err)}` };
    }
    if (decision.type !== 'decision') return { approved: false, method: '不是决定帧' };
    if (!decision.taskId.equals(taskId) || !decision.nonce.equals(nonce)) {
      return { approved: false, method: '决定帧与挑战不匹配' };
    }
    if (!decision.deviceId.equals(expectedDevice)) {
      return { approved: false, method: `设备不符：${decision.deviceId.toString('hex')}` };
    }
    if (now() > issuedAt + ttlSec) return { approved: false, method: '挑战已过期' };
    if (decision.decision === 0) return { approved: false, method: '用户在板端取消' };

    return {
      approved: true,
      method: 'WS63 真板（SFC1）',
      proof: {
        confirmationId: `ws63-${nonce.toString('hex').slice(0, 16)}`,
        deviceLabel: currentDeviceId(),
        decidedAt: decision.decidedAt,
      },
    };
  };
}

module.exports = {
  createBoardHumanConfirm,
  defaultSummary,
  toAscii,
  ACTION_PROTOCOL,
};
