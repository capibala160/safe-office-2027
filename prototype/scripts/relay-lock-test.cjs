'use strict';
// 真实继电器/锁体通断自检（2026-11-17，需先接好 IO12 → 继电器模块）
//
// 用法：
//   node scripts/relay-lock-test.cjs --port COM11 --device ws63-A
//   node scripts/relay-lock-test.cjs --port COM11 --device ws63-A --times 3 --hold 1500
//
// 做什么：按 SFC1 执行帧（0x21）依次发 level=1 / level=0，每次等待 ACK；
//         观察到继电器“咔哒”与锁体动作即通过。**不做**任何业务语义映射，
//         只验证「板端引脚 → 继电器 → 锁体」这条电气链路。
//
// 安全：默认只允许 IO12（继电器）；每次动作后都会回到 level=0（断电/上锁），
//       即使脚本中途失败也不会把锁长期保持在“开”的状态。
// 退出码：0 全部 ACK；1 失败。

const { resolveDeviceKey } = require('../src/device-keys.cjs');
const { createSerialActuator } = require('../src/device-actuator.cjs');

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
  const times = Number(arg('times', '2'));
  const holdMs = Number(arg('hold', '1000'));
  if (!Number.isInteger(times) || times < 1 || times > 20) throw new Error('--times 必须是 1–20 的整数');
  if (!Number.isInteger(holdMs) || holdMs < 100 || holdMs > 30000) throw new Error('--hold 必须是 100–30000 毫秒');

  const { key, record } = resolveDeviceKey({ label });
  if (!record) throw new Error(`设备表里没有 ${label}：先 npm run provision`);
  const actuator = createSerialActuator({ portPath, key, timeoutMs: 5000 });

  console.log(`继电器/锁体自检：${label} @ ${portPath}，IO12，${times} 轮，每轮保持 ${holdMs}ms`);
  let ok = 0;
  for (let i = 1; i <= times; i++) {
    try {
      const on = await actuator.send(12, 1);
      console.log(`  [${i}] level=1 → ACK status=${on.status} pin=${on.pin} level=${on.level}（请听继电器“咔哒”/看锁体开）`);
      await sleep(holdMs);
      const off = await actuator.send(12, 0);
      console.log(`  [${i}] level=0 → ACK status=${off.status} pin=${off.pin} level=${off.level}（应回到断电/上锁）`);
      if (on.status === 0 && off.status === 0) ok += 1;
    } catch (err) {
      console.error(`  [${i}] 失败：${err && err.message ? err.message : err}`);
      // 失败也尽量把锁复位到低电平
      try { await actuator.send(12, 0); } catch { /* 忽略 */ }
    }
  }
  console.log(`完成：${ok}/${times} 轮 ACK 通过`);
  return ok === times ? 0 : 1;
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
