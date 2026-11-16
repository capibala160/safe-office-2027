'use strict';
// SFC1 探活：向设备表里的某台设备发 PING(0x20)，验证 PONG(0x21)。
// 用途：确认板子到底有没有写进这把钥匙（不依赖配网窗口）。
//
// 用法：
//   node scripts/ping-device.cjs --port COM11 --device ws63-A
//   node scripts/ping-device.cjs --port COM11 --device ws63-B   # 双板：A 按 device_id 转发给 B
//
// 退出码：0 通过；1 失败（无响应/绑定不符/参数错误）。

const { openSerialPort, SerialFrameParser } = require('../src/serial-transport.cjs');
const { resolveDeviceKey } = require('../src/device-keys.cjs');
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

async function main() {
  const portPath = arg('port', 'COM11');
  const label = arg('device', 'ws63-A');
  const timeoutMs = Number(arg('timeout', '4000'));
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error('--timeout 必须是正整数');

  const { key, record } = resolveDeviceKey({ label });
  if (!record) throw new Error(`设备表里没有 ${label}：先 npm run provision`);

  const nonce = P.randomNonce();
  const port = await openSerialPort({ path: portPath, baudRate: 115200 });
  const parser = new SerialFrameParser();
  const frames = [];
  port.on('data', (chunk) => {
    for (const frame of parser.push(Buffer.from(chunk))) frames.push(frame);
  });

  try {
    await new Promise((resolve) => port.write(P.encodePing(nonce, key), () => resolve()));
    const deadline = Date.now() + timeoutMs;
    let pong = null;
    while (Date.now() < deadline) {
      const index = frames.findIndex((frame) => frame[5] === P.TYPES.PONG);
      if (index >= 0) {
        const [frame] = frames.splice(index, 1);
        pong = P.decodePong(frame, key);
        break;
      }
      await sleep(30);
    }
    if (!pong) {
      console.error(`✗ ${label} 无 PONG（链路断开、钥匙不对或设备不在线）`);
      return 1;
    }
    if (!pong.hostNonce.equals(nonce) || pong.deviceId.toString('hex') !== record.deviceId) {
      console.error('✗ PONG 绑定不符（nonce 或 device_id 不一致）');
      return 1;
    }
    console.log(`✓ ${label} PONG device_id=${record.deviceId}`);
    return 0;
  } finally {
    await new Promise((resolve) => {
      try { port.close(() => resolve()); } catch { resolve(); }
      setTimeout(resolve, 1000).unref?.();
    });
  }
}

if (require.main === module) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
      console.error(`参数/运行错误：${err && err.message ? err.message : err}`);
      process.exitCode = 1;
    });
}

module.exports = { main };
