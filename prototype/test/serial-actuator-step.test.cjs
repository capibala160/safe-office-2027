'use strict';
// 双板拓扑的“确认后执行”步骤：用执行端设备（如 ws63-A）的钥匙发 ACTUATOR 帧。
// 这里只测钥匙解析/参数校验/ACK 透传，串口由 actuatorFactory 注入代替。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runActuatorStep } = require('../serial-confirm.cjs');

const KEY_B64 = Buffer.alloc(32, 0x42).toString('base64');

function withDeviceTable(entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfc1-act-'));
  const file = path.join(dir, 'devices.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, devices: entries }));
  return file;
}

function withCleanEnv(fn) {
  const saved = process.env.SAFE_OFFICE_SFC1_KEY;
  delete process.env.SAFE_OFFICE_SFC1_KEY;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (saved === undefined) delete process.env.SAFE_OFFICE_SFC1_KEY;
      else process.env.SAFE_OFFICE_SFC1_KEY = saved;
    });
}

test('runActuatorStep：用设备表钥匙发执行帧并透传 ACK', async () => {
  await withCleanEnv(async () => {
    const file = withDeviceTable([
      { deviceId: 'aabbccdd', label: 'ws63-A', key: KEY_B64 },
    ]);
    let seen = null;
    const ack = await runActuatorStep({
      portPath: 'COM_TEST',
      label: 'ws63-A',
      pin: 13,
      level: 1,
      timeoutMs: 1234,
      deviceTableFile: file,
      actuatorFactory: ({ portPath, key, timeoutMs }) => {
        seen = { portPath, keyLen: key.length, timeoutMs };
        return { send: async (pin, level) => ({ status: 0, pin, level }) };
      },
    });

    assert.deepEqual(seen, { portPath: 'COM_TEST', keyLen: 32, timeoutMs: 1234 });
    assert.equal(ack.status, 0);
    assert.equal(ack.pin, 13);
    assert.equal(ack.level, 1);
    assert.equal(ack.keySource, 'table');
  });
});

test('runActuatorStep：设备表没有该标签时明确报错', async () => {
  await withCleanEnv(async () => {
    const file = withDeviceTable([
      { deviceId: 'aabbccdd', label: 'ws63-A', key: KEY_B64 },
    ]);
    await assert.rejects(
      runActuatorStep({
        portPath: 'COM_TEST',
        label: 'ws63-Z',
        deviceTableFile: file,
        actuatorFactory: () => ({ send: async () => ({ status: 0 }) }),
      }),
      /缺少密钥/,
    );
  });
});

test('runActuatorStep：引脚/电平参数校验', async () => {
  await assert.rejects(
    runActuatorStep({ portPath: 'COM_TEST', pin: 99 }),
    /0–31/,
  );
  await assert.rejects(
    runActuatorStep({ portPath: 'COM_TEST', level: 2 }),
    /level/,
  );
});

test('runActuatorStep：串口占用（Access denied）会重试而不是立刻失败', async () => {
  await withCleanEnv(async () => {
    const file = withDeviceTable([
      { deviceId: 'aabbccdd', label: 'ws63-A', key: KEY_B64 },
    ]);
    let attempts = 0;
    const ack = await runActuatorStep({
      portPath: 'COM_TEST',
      label: 'ws63-A',
      deviceTableFile: file,
      actuatorFactory: () => ({
        send: async (pin, level) => {
          attempts++;
          if (attempts === 1) throw new Error('Opening COM_TEST: Access denied');
          return { status: 0, pin, level };
        },
      }),
    });
    assert.equal(attempts, 2);
    assert.equal(ack.status, 0);
  });
});
