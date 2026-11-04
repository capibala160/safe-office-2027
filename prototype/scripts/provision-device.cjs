'use strict';
// 设备配网工具（docs/60 方案 A）：把一机一钥写进板端 NV。
//
// 用法（板子处于未配置状态，OLED/串口会显示 8 位临时码）：
//   node scripts/provision-device.cjs --port COM11 --code A1B2C3D4
//   node scripts/provision-device.cjs --port COM11 --code A1B2C3D4 --label ws63-A --out data/devices.json
//   node scripts/provision-device.cjs --port COM11 --code A1B2C3D4 --key <64位hex>
//
// 退出码：0 成功；1 失败（超时/MAC/窗口关闭等）；2 参数错误。
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { openSerialPort, SerialFrameParser } = require('../src/serial-transport.cjs');
const P = require('../src/device-provisioning.cjs');

function arg(name, fallback) {
  const argv = process.argv.slice(2);
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  if (index !== -1 && index + 1 < argv.length && !argv[index + 1].startsWith('--')) {
    return argv[index + 1];
  }
  return fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 状态文件损坏时抛这个错：调用方必须停下，保留原文件（评审问题 2）
class StateFileError extends Error {
  constructor(file, cause) {
    super(`状态文件损坏，已保留原文件：${file}（${cause && cause.message ? cause.message : cause}）`);
    this.code = 'STATE_FILE';
    this.file = file;
  }
}

function readJsonFile(file) {
  if (!fs.existsSync(file)) return null;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new StateFileError(file, err);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new StateFileError(file, err);
  }
}

// 原子写：临时文件写完 + fsync 后 rename 覆盖，避免中断留下半截文件
function atomicWriteJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const text = `${JSON.stringify(data, null, 2)}\n`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
  try { fs.chmodSync(file, 0o600); } catch { /* Windows 上忽略 */ }
}

function saveDevice(file, { deviceId, label, key }) {
  let table = readJsonFile(file);
  if (!table) table = { version: 2, devices: [] };
  if (!Array.isArray(table.devices)) table.devices = [];
  table.version = 2;
  const deviceIdHex = deviceId.toString('hex');
  const entry = {
    deviceId: deviceIdHex,
    label,
    key: key.toString('base64'),
    provisionedAt: new Date().toISOString(),
  };
  const index = table.devices.findIndex((d) => d.deviceId === deviceIdHex);
  if (index >= 0) table.devices[index] = entry;
  else table.devices.push(entry);
  atomicWriteJson(file, table);
  return entry;
}

// 回执可能丢：COMMIT 之前先把"这次要写的钥匙"落盘，OK 之后再提升到设备表。
// pending 按 deviceId 存多条：给设备 B 配钥不会覆盖 A 尚未恢复的记录，
// 清除也只清本次设备（评审问题 1）。
function pendingFileFor(outFile) {
  return path.join(path.dirname(outFile), 'devices.pending.json');
}

function isPendingRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && typeof value.deviceId === 'string' && typeof value.key === 'string';
}

// 读 pending：兼容 v1 单条旧格式（{pending:{deviceId,key,...}}），统一返回 { [deviceId]: record }。
// 损坏一律抛 StateFileError——不能把"解析失败"当成空表，否则下一次保存会覆盖残存钥匙。
function readPendingAll(file) {
  const data = readJsonFile(file);
  if (!data) return {};
  if (typeof data !== 'object' || Array.isArray(data)) {
    throw new StateFileError(file, new Error('根节点必须是对象'));
  }
  const pending = data.pending;
  if (pending === undefined || pending === null) return {};
  if (typeof pending !== 'object' || Array.isArray(pending)) {
    throw new StateFileError(file, new Error('pending 必须是对象'));
  }
  // v1 迁移：单条记录对象
  if (isPendingRecord(pending)) {
    return { [pending.deviceId]: pending };
  }
  const out = {};
  for (const [deviceId, record] of Object.entries(pending)) {
    if (!isPendingRecord(record)) {
      throw new StateFileError(file, new Error(`pending.${deviceId} 不是合法记录`));
    }
    out[deviceId] = record;
  }
  return out;
}

function listPending(file) {
  return Object.values(readPendingAll(file));
}

function readPendingFor(file, deviceId) {
  if (!deviceId) return null;
  return readPendingAll(file)[deviceId] || null;
}

function writePending(file, record) {
  const all = readPendingAll(file); // 父目录/兼容/损坏检查都在里面
  all[record.deviceId] = record;
  atomicWriteJson(file, { version: 2, pending: all });
}

// 只清指定设备；没有其它设备记录时删掉文件
function clearPending(file, deviceId) {
  if (!deviceId) return;
  const all = readPendingAll(file);
  if (!Object.prototype.hasOwnProperty.call(all, deviceId)) return;
  delete all[deviceId];
  if (Object.keys(all).length === 0) {
    try { fs.unlinkSync(file); } catch { /* ignore */ }
    return;
  }
  atomicWriteJson(file, { version: 2, pending: all });
}

// 选钥匙：显式 --key 优先；否则复用同设备的 pending；否则新随机
function chooseKey({ keyHex = '', pending = null, deviceIdHex = '', random = randomBytes } = {}) {
  if (keyHex !== '') return { key: Buffer.from(keyHex, 'hex'), source: 'arg' };
  if (pending && pending.deviceId === deviceIdHex) {
    const key = Buffer.from(pending.key, 'base64');
    if (key.length !== 32) throw new Error('pending 文件里的钥匙长度不对');
    return { key, source: 'pending' };
  }
  return { key: random(32), source: 'random' };
}

async function main() {
  const asJson = process.argv.includes('--json');
  const recover = process.argv.includes('--recover');
  const portPath = String(arg('port', '')).trim();
  const code = String(arg('code', '')).trim();
  const label = String(arg('label', 'ws63-A')).trim();
  const outFile = String(arg('out', path.join(__dirname, '..', 'data', 'devices.json')));
  const timeoutMs = Number(arg('timeout', 5000));
  const keyHex = String(arg('key', '')).trim();

  if (!portPath) throw Object.assign(new Error('缺少 --port（例如 COM11）'), { code: 'ARG' });
  if (!recover && !/^[0-9a-fA-F]{8}$/.test(code)) {
    throw Object.assign(new Error('--code 必须是 8 位十六进制（板端 OLED/串口显示）'), { code: 'ARG' });
  }
  if (keyHex !== '' && !/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw Object.assign(new Error('--key 必须是 64 位十六进制'), { code: 'ARG' });
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw Object.assign(new Error('--timeout 必须是正整数毫秒'), { code: 'ARG' });
  }

  const hostNonce = P.randomNonce();
  const port = await openSerialPort({ path: portPath, baudRate: 115200 });
  const parser = new SerialFrameParser();
  const frames = [];
  port.on('data', (chunk) => {
    for (const frame of parser.push(Buffer.from(chunk))) frames.push(frame);
  });

  const closePort = () => new Promise((resolve) => {
    try { port.close(() => resolve()); } catch { resolve(); }
    setTimeout(resolve, 1000).unref?.();
  });

  async function nextFrame(types, waitMs) {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const index = frames.findIndex((f) => types.includes(f[5]));
      if (index >= 0) {
        const [frame] = frames.splice(index, 1);
        return frame;
      }
      if (Date.now() >= deadline) return null;
      await sleep(30);
    }
  }

  try {
    // --recover：回执丢失后的自动恢复。按 pending 逐台发 PING(0x20)，
    // 板端用当前设备密钥验签并回 PONG(0x21)；验过才登记到设备表。
    if (recover) {
      const pendingFile = pendingFileFor(outFile);
      const records = listPending(pendingFile);
      if (records.length === 0) {
        console.log('没有 pending 记录，无需恢复');
        return 0;
      }
      let failed = 0;
      for (const record of records) {
        const key = Buffer.from(record.key, 'base64');
        if (key.length !== 32) {
          failed += 1;
          console.log(`✗ ${record.deviceId} pending 钥匙长度非法`);
          continue;
        }
        const pingNonce = P.randomNonce();
        await new Promise((resolve) => port.write(P.encodePing(pingNonce, key), () => resolve()));
        const pongFrame = await nextFrame([P.TYPES.PONG], timeoutMs);
        if (!pongFrame) {
          failed += 1;
          console.log(`✗ ${record.deviceId}（${record.label}）无响应：板子未持有该钥匙或不在线`);
          continue;
        }
        let pong;
        try {
          pong = P.decodePong(pongFrame, key);
        } catch (err) {
          failed += 1;
          console.log(`✗ ${record.deviceId} PONG 校验失败：${err.message}`);
          continue;
        }
        if (!pong.hostNonce.equals(pingNonce) || pong.deviceId.toString('hex') !== record.deviceId) {
          failed += 1;
          console.log(`✗ ${record.deviceId} PONG 绑定不符`);
          continue;
        }
        saveDevice(outFile, { deviceId: pong.deviceId, label: record.label, key });
        clearPending(pendingFile, record.deviceId);
        console.log(`✓ ${record.deviceId}（${record.label}）已验证，钥匙已登记到设备表`);
      }
      console.log(failed === 0 ? '恢复完成' : `${failed} 条未恢复，pending 保留`);
      return failed === 0 ? 0 : 1;
    }

    await new Promise((resolve) => port.write(P.encodeInit(hostNonce), () => resolve()));
    const challengeFrame = await nextFrame([P.TYPES.CHALLENGE], timeoutMs);
    if (!challengeFrame) {
      throw new Error('板端没有响应 CHALLENGE（临时码窗口是否已过？串口是否被占用？）');
    }

    const peek = P.peekChallenge(challengeFrame);
    if (!peek.hostNonce.equals(hostNonce)) throw new Error('CHALLENGE 里的 host_nonce 与本次不一致');
    const sessionKey = P.deriveSessionKey(code, hostNonce, peek.deviceNonce);
    const challenge = P.decodeChallenge(challengeFrame, sessionKey); // 这里验 MAC：临时码错就失败

    const deviceIdHex = challenge.deviceId.toString('hex');
    const pendingFile = pendingFileFor(outFile);
    const pending = readPendingFor(pendingFile, deviceIdHex);
    const chosen = chooseKey({ keyHex, pending, deviceIdHex });
    const newKey = chosen.key;
    if (chosen.source === 'pending' && !asJson) {
      console.log('发现同设备的 pending 钥匙：这次复用它（上次可能已写入但回执丢失）');
    }

    // 先落盘再发 COMMIT：回执丢了也不会出现"设备换了钥、主机没留钥"
    writePending(pendingFile, {
      deviceId: deviceIdHex,
      label,
      key: newKey.toString('base64'),
      createdAt: new Date().toISOString(),
    });

    await new Promise((resolve) => port.write(P.encodeCommit({
      deviceId: challenge.deviceId,
      hostNonce,
      deviceNonce: peek.deviceNonce,
      newKey,
    }, sessionKey), () => resolve()));

    const reply = await nextFrame([P.TYPES.OK, P.TYPES.ERR], timeoutMs);
    if (!reply) {
      throw new Error(`板端没有回复配网结果（可能已断电或窗口关闭）。`
        + `钥匙已保存在 ${pendingFile}：若板端提示 key installed，请按该文件手工登记，`
        + '或对同一设备重跑本命令以复用这把钥匙');
    }
    if (reply[5] === P.TYPES.ERR) {
      const err = P.decodeErr(reply, sessionKey);
      clearPending(pendingFile, deviceIdHex);
      throw new Error(`板端拒绝配网：status=${err.status} ${err.reason}`);
    }
    const ok = P.decodeOk(reply, sessionKey);
    const entry = saveDevice(outFile, { deviceId: ok.deviceId, label, key: newKey });
    clearPending(pendingFile, deviceIdHex);

    if (asJson) {
      console.log(JSON.stringify({ ok: true, deviceId: entry.deviceId, label, file: outFile }, null, 2));
    } else {
      console.log(`配网成功：device_id=${entry.deviceId} label=${label}`);
      console.log(`设备表已更新：${outFile}（权限 600，钥匙不要入库）`);
      console.log('板端应打印 "SFC1 PROV: key installed"；之后用该设备的 key 才能确认。');
    }
    return 0;
  } finally {
    await closePort();
  }
}

if (require.main === module) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
      console.error(err && err.message ? err.message : String(err));
      process.exitCode = err && err.code === 'ARG' ? 2 : 1;
    });
}

module.exports = {
  saveDevice,
  writePending,
  readPendingAll,
  listPending,
  readPendingFor,
  clearPending,
  pendingFileFor,
  chooseKey,
};
