'use strict';
// 手动验证：向板端发送 SFC1 执行帧（0x21）并等待 ACK（0x22）
// 用法：node scripts/actuator-test.cjs --port COM11 --pin 13 --level 1
const { resolveDeviceKey } = require('../src/device-keys.cjs');
const { createSerialActuator } = require('../src/device-actuator.cjs');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}

(async () => {
  const portPath = arg('--port', 'COM11');
  const pin = Number(arg('--pin', '13'));
  const level = Number(arg('--level', '1'));
  const label = arg('--device', 'ws63-A');
  const timeoutMs = Number(arg('--timeout', '4000'));
  const { key, source } = resolveDeviceKey({ label });
  const actuator = createSerialActuator({ portPath, key, timeoutMs });
  const ack = await actuator.send(pin, level);
  console.log(JSON.stringify({ ok: ack.status === 0, ...ack, keySource: source }, null, 2));
  process.exit(ack.status === 0 ? 0 : 1);
})().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err.message, code: err.code || null }));
  process.exit(1);
});
