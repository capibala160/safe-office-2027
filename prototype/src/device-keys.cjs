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

function defaultDeviceTableFile() {
  return path.join(__dirname, '..', 'data', 'devices.json');
}

// 读取设备表；损坏抛错（不静默当空表，避免把"没找到"误判成"需要重新配网"）
function readDeviceTable(file = defaultDeviceTableFile()) {
  if (!fs.existsSync(file)) return [];
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`设备表损坏：${file}（${err.message}）`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`设备表根节点必须是对象：${file}`);
  }
  if (data.devices === undefined) return [];
  if (!Array.isArray(data.devices)) throw new Error(`设备表 devices 必须是数组：${file}`);
  return data.devices.filter((d) => d && typeof d.deviceId === 'string' && typeof d.key === 'string');
}

// 优先按 device_id 精确匹配；否则按标签
function findDevice(table, { label = 'ws63-A', deviceId = null } = {}) {
  if (deviceId) return table.find((d) => d.deviceId === deviceId) || null;
  return table.find((d) => d.label === label) || null;
}

function decodeRecordKey(record) {
  const key = Buffer.from(String(record.key || ''), 'base64');
  if (key.length !== 32) throw new Error(`设备表里 ${record.deviceId} 的钥匙长度不对`);
  return key;
}

/**
 * @param {{demoKey?:boolean, keyHex?:string, envKey?:string, record?:any, production?:boolean}} opts
 * @returns {{key:Buffer, source:'demo'|'arg'|'env'|'table'}}
 */
function chooseDeviceKey({ demoKey = false, keyHex = '', envKey = '', record = null, production = false } = {}) {
  if (demoKey) {
    if (production) throw Object.assign(new Error('生产模式禁止使用演示密钥（--demo-key）'), { code: 'PRODUCTION' });
    return { key: Buffer.from(DEMO_KEY), source: 'demo' };
  }
  const arg = String(keyHex || '').trim();
  if (arg !== '') {
    if (!KEY_HEX_RE.test(arg)) throw Object.assign(new Error('--key 必须是 64 位十六进制'), { code: 'ARG' });
    return { key: Buffer.from(arg, 'hex'), source: 'arg' };
  }
  const env = String(envKey || '').trim();
  if (env !== '') {
    if (!KEY_HEX_RE.test(env)) throw Object.assign(new Error('SAFE_OFFICE_SFC1_KEY 必须是 64 位十六进制'), { code: 'ARG' });
    return { key: Buffer.from(env, 'hex'), source: 'env' };
  }
  if (record) return { key: decodeRecordKey(record), source: 'table' };
  throw Object.assign(new Error(
    '缺少密钥：--key / SAFE_OFFICE_SFC1_KEY / 设备表（先 npm run provision）',
  ), { code: 'ARG' });
}

// 一步到位：读表 + 查找 + 选钥匙（CLI 用）
function resolveDeviceKey({ label = 'ws63-A', deviceId = null, file, production = false, demoKey = false, keyHex = '', envKey } = {}) {
  let record = null;
  try {
    record = findDevice(readDeviceTable(file), { label, deviceId });
  } catch (err) {
    // 设备表损坏：如果显式给了钥匙就继续用，否则报错（不能假装没配过网）
    if (!demoKey && !String(keyHex || '').trim() && !String(envKey || '').trim()) throw err;
  }
  const chosen = chooseDeviceKey({
    demoKey, keyHex, envKey: envKey === undefined ? process.env.SAFE_OFFICE_SFC1_KEY || '' : envKey,
    record, production,
  });
  return { ...chosen, record, label: record ? record.label : label };
}

module.exports = {
  DEMO_KEY,
  defaultDeviceTableFile,
  readDeviceTable,
  findDevice,
  chooseDeviceKey,
  resolveDeviceKey,
};
