'use strict';
// 设备钥匙解析（docs/60）：把"从哪拿 key"收拢到一处。
//
// 优先级：--demo-key（仅非生产） > --key > SAFE_OFFICE_SFC1_KEY > 设备表（按 --device 标签/device_id）
// 生产模式（SAFE_OFFICE_PRODUCTION=1）禁止演示密钥；找不到任何钥匙直接报错，不回退。
//
// 设备表就是 `npm run provision` 写出的 data/devices.json（不进仓库、权限 600）。

const fs = require('node:fs');
const path = require('node:path');

const DEMO_KEY = Buffer.alloc(32, 0x42);
const KEY_HEX_RE = /^[0-9a-fA-F]{64}$/;

/**
 * @typedef {object} DeviceRecord
 * @property {string} deviceId
 * @property {string} key
 * @property {string} [label]
 * @property {string} [provisionedAt]
 */

/** @returns {string} */
function defaultDeviceTableFile() {
  return path.join(__dirname, '..', 'data', 'devices.json');
}

// 读取设备表；损坏抛错（不静默当空表，避免把"没找到"误判成"需要重新配网"）
/** @param {string} [file] @returns {DeviceRecord[]} */
function readDeviceTable(file = defaultDeviceTableFile()) {
  if (!fs.existsSync(file)) return [];
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    const e = /** @type {Error} */ (err);
    throw new Error(`设备表损坏：${file}（${e.message}）`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`设备表根节点必须是对象：${file}`);
  }
  if (data.devices === undefined) return [];
  if (!Array.isArray(data.devices)) throw new Error(`设备表 devices 必须是数组：${file}`);
  return data.devices.filter((/** @type {any} */ d) => d && typeof d.deviceId === 'string' && typeof d.key === 'string');
}

// 优先按 device_id 精确匹配；否则按标签
/** @param {DeviceRecord[]} table @param {{ label?: string, deviceId?: string | null }} [options] @returns {DeviceRecord | null} */
function findDevice(table, { label = 'ws63-A', deviceId = null } = {}) {
  if (deviceId) return table.find((d) => d.deviceId === deviceId) || null;
  return table.find((d) => d.label === label) || null;
}

/** @param {DeviceRecord} record @returns {Buffer} */
function decodeRecordKey(record) {
  const key = Buffer.from(String(record.key || ''), 'base64');
  if (key.length !== 32) throw new Error(`设备表里 ${record.deviceId} 的钥匙长度不对`);
  return key;
}

/** @param {unknown} key @returns {boolean} */
function isDemoKeyValue(key) {
  return Buffer.isBuffer(key) && key.length === DEMO_KEY.length && key.equals(DEMO_KEY);
}

/**
 * @param {{ demoKey?: boolean, keyHex?: string, envKey?: string, record?: DeviceRecord | null, production?: boolean }} [options]
 * @returns {{ key: Buffer, source: 'demo' | 'arg' | 'env' | 'table' }}
 */
function chooseDeviceKey({ demoKey = false, keyHex = '', envKey = '', record = null, production = false } = {}) {
  /** @type {{ key: Buffer, source: 'demo' | 'arg' | 'env' | 'table' }} */
  let chosen;
  if (demoKey) {
    if (production) throw Object.assign(new Error('生产模式禁止使用演示密钥（--demo-key）'), { code: 'PRODUCTION' });
    chosen = { key: Buffer.from(DEMO_KEY), source: 'demo' };
  } else {
    const arg = String(keyHex || '').trim();
    const env = String(envKey || '').trim();
    if (arg !== '') {
      if (!KEY_HEX_RE.test(arg)) throw Object.assign(new Error('--key 必须是 64 位十六进制'), { code: 'ARG' });
      chosen = { key: Buffer.from(arg, 'hex'), source: 'arg' };
    } else if (env !== '') {
      if (!KEY_HEX_RE.test(env)) throw Object.assign(new Error('SAFE_OFFICE_SFC1_KEY 必须是 64 位十六进制'), { code: 'ARG' });
      chosen = { key: Buffer.from(env, 'hex'), source: 'env' };
    } else if (record) {
      chosen = { key: decodeRecordKey(record), source: 'table' };
    } else {
      throw Object.assign(new Error(
        '缺少密钥：--key / SAFE_OFFICE_SFC1_KEY / 设备表（先 npm run provision）',
      ), { code: 'ARG' });
    }
  }
  // 生产模式按"最终值"拦：--key / 环境变量 / 设备表里塞同一把 0x42×32 也不行（复核第六轮）
  if (production && isDemoKeyValue(chosen.key)) {
    throw Object.assign(new Error(`生产模式禁止使用演示密钥（来源：${chosen.source}）`), { code: 'PRODUCTION' });
  }
  return chosen;
}

// 一步到位：读表 + 查找 + 选钥匙（CLI 用）
/**
 * @param {{ label?: string, deviceId?: string | null, file?: string, production?: boolean, demoKey?: boolean, keyHex?: string, envKey?: string }} [options]
 * @returns {{ key: Buffer, source: 'demo' | 'arg' | 'env' | 'table', record: DeviceRecord | null, label: string }}
 */
function resolveDeviceKey({ label = 'ws63-A', deviceId = null, file = defaultDeviceTableFile(), production = false, demoKey = false, keyHex = '', envKey } = {}) {
  // 先把"生效的环境变量"算出来：显式传入优先，其次 process.env。
  // 设备表读取失败时要用它判断是否还能继续（复核第六轮：CLI 曾忽略有效的环境变量密钥）。
  const effectiveEnv = envKey === undefined ? (process.env.SAFE_OFFICE_SFC1_KEY || '') : envKey;
  const hasExplicit = demoKey || String(keyHex || '').trim() !== '' || String(effectiveEnv || '').trim() !== '';

  let record = null;
  try {
    record = findDevice(readDeviceTable(file), { label, deviceId });
  } catch (err) {
    // 设备表损坏：显式给了钥匙就继续用，否则报错（不能假装没配过网）
    if (!hasExplicit) throw err;
  }
  const chosen = chooseDeviceKey({
    demoKey, keyHex, envKey: effectiveEnv, record, production,
  });
  return { ...chosen, record, label: record && record.label ? record.label : label };
}

module.exports = {
  DEMO_KEY,
  defaultDeviceTableFile,
  readDeviceTable,
  findDevice,
  chooseDeviceKey,
  resolveDeviceKey,
};
