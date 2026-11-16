'use strict';
// ============================================================
// WS63 串口确认 CLI（M3，2026-11-04）
//   把 NearfieldConfirmer 的传输层从虚拟设备换成真实 USB-UART：
//     冻结操作 → SFC1 CHALLENGE → 板端 OLED/按键 → SFC1 DECISION → 验 MAC/绑定
//
// 用法：
//   node serial-confirm.cjs --port COM12 --demo-key --to partner@example.com --subject "Quarterly report"
//   node serial-confirm.cjs --port COM12 --key <64 hex> --device ws63-A ...
//
// 边界：
//   - 只做确认闭环，不发送邮件/不落盘操作库（FakeMailer + :memory:）
//   - 演示密钥必须显式 --demo-key；真实密钥走 --key 或 SAFE_OFFICE_SFC1_KEY
//   - 串口另一端必须是烧了 M3 固件的 WS63；虚拟设备请用 demo-nearfield.cjs
// ============================================================
const { parseArgs } = require('node:util');
const { sealOperation } = require('./src/operation.cjs');
const { OperationStore } = require('./src/store.cjs');
const { FakeMailer } = require('./src/mailer.cjs');
const { FulfillmentService } = require('./src/fulfillment.cjs');
const { NearfieldConfirmer, buildSummary } = require('./src/nearfield-confirm.cjs');
const { openSerialPort, SerialTransport } = require('./src/serial-transport.cjs');

const { resolveDeviceKey } = require('./src/device-keys.cjs');
const { createSerialActuator } = require('./src/device-actuator.cjs');
const ACTION_MAP = {
  sendExternalEmail: 1,
  deleteDoc: 2,
  printDoc: 3,
  deviceControl: 4,
};
const DEFAULT_TTL_SEC = 30;
const DEFAULT_TIMEOUT_MS = 15000;

// 钥匙来源：--demo-key（仅非生产）> --key > SAFE_OFFICE_SFC1_KEY > 设备表（--device 标签）
function parseKeyOption(values) {
  return resolveDeviceKey({
    label: values.device,
    production: process.env.SAFE_OFFICE_PRODUCTION === '1',
    demoKey: Boolean(values['demo-key']),
    keyHex: values.key || '',
  });
}

function buildOperation({ action, to, subject, body, level = '内部', ttlSec }) {
  const protocolAction = ACTION_MAP[action];
  if (!protocolAction) throw new Error(`不支持的动作：${action}（可选 ${Object.keys(ACTION_MAP).join(' / ')}）`);
  if (!to) throw new Error('缺少 --to');
  const now = Date.now();
  return sealOperation({
    taskId: `SERIAL-${now}`,
    action,
    protocolAction,
    tool: action,
    recipient: to,
    subject: subject || `Serial confirm ${new Date(now).toISOString()}`,
    body: body || '串口确认演示正文',
    attachments: [],
    sourceDocIds: [],
    level,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + Math.max(600, ttlSec * 2) * 1000).toISOString(),
    modelId: 'serial-cli',
    planHash: `plan-${now}`,
  });
}

function closePort(port) {
  return new Promise((resolve) => {
    if (!port || typeof port.close !== 'function' || port.isOpen === false) {
      resolve();
      return;
    }
    try {
      port.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

/**
 * 跑一次串口确认闭环。测试用 portFactory 注入假串口。
 * @returns {Promise<object>} approval
 */
async function runSerialConfirmation({
  portPath,
  key,
  deviceId = 'ws63-A',
  operation,
  ttlSec = DEFAULT_TTL_SEC,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  portFactory = null,
  logger = () => {},
} = {}) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new TypeError('key 必须是 32 字节 Buffer');
  if (!operation) throw new TypeError('缺少冻结操作');

  const port = await openSerialPort({ path: portPath, factory: portFactory, baudRate: 115200 });
  const transport = new SerialTransport({ port, timeoutMs, logger });
  try {
    const confirmer = new NearfieldConfirmer({
      key,
      expectedDeviceId: deviceId,
      ttlSec,
      transport,
    });
    logger(`已打开 ${portPath}，等待板端确认（TTL ${ttlSec}s，回复超时 ${timeoutMs}ms）`);
    return await confirmer.requestApproval(operation, { finalOperation: operation });
  } finally {
    transport.close();
    await closePort(port);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 确认通过后，用“执行端设备”的钥匙发 SFC1 执行帧（双板拓扑：挑战端 B、执行端 A）。
 * 只在确认成功后调用；串口与确认用的是同一个物理口（先关后开），所以带重试。
 * @returns {Promise<{status: number, pin: number, level: number, keySource: string}>}
 */
async function runActuatorStep({
  portPath,
  label = 'ws63-A',
  pin = 12,
  level = 1,
  timeoutMs = 4000,
  deviceTableFile = undefined,
  actuatorFactory = createSerialActuator,
  logger = () => {},
} = {}) {
  if (!portPath) throw new TypeError('缺少串口路径');
  if (!Number.isInteger(pin) || pin < 0 || pin > 31) throw new TypeError('--actuator-pin 必须是 0–31 的整数');
  if (level !== 0 && level !== 1) throw new TypeError('--actuator-level 只能是 0 或 1');

  const resolved = resolveDeviceKey({ label, file: deviceTableFile });
  const actuator = actuatorFactory({ portPath, key: resolved.key, timeoutMs });
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const ack = await actuator.send(pin, level);
      logger(`执行结果：status=${ack.status} pin=${ack.pin} level=${ack.level}`);
      return { ...ack, keySource: resolved.source };
    } catch (err) {
      lastErr = err;
      if (attempt < 3 && /Access denied|EBUSY|busy/i.test(String(err && err.message))) {
        await sleep(250);
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error('执行失败');
}

async function main() {
  const { values } = parseArgs({
    options: {
      port: { type: 'string' },
      to: { type: 'string' },
      subject: { type: 'string' },
      body: { type: 'string' },
      action: { type: 'string', default: 'sendExternalEmail' },
      level: { type: 'string', default: '内部' },
      device: { type: 'string', default: 'ws63-A' },
      ttl: { type: 'string', default: String(DEFAULT_TTL_SEC) },
      timeout: { type: 'string', default: String(DEFAULT_TIMEOUT_MS) },
      key: { type: 'string' },
      'demo-key': { type: 'boolean', default: false },
      /* 双板拓扑：确认通过后再用“执行端 A”的钥匙发执行帧；不传则不执行 */
      'actuator-device': { type: 'string' },
      'actuator-pin': { type: 'string', default: '12' },
      'actuator-level': { type: 'string', default: '1' },
      'actuator-timeout': { type: 'string', default: '4000' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log('用法：node serial-confirm.cjs --port COM12 --demo-key --to <收件人> [--subject ...] [--action sendExternalEmail]');
    return 0;
  }
  if (!values.port) throw new Error('缺少 --port（例如 COM12）');

  const ttlSec = Number(values.ttl);
  const timeoutMs = Number(values.timeout);
  if (!Number.isInteger(ttlSec) || ttlSec <= 0) throw new Error('--ttl 必须是正整数');
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error('--timeout 必须是正整数');

  const { key, source } = parseKeyOption(values);
  const operation = buildOperation({
    action: values.action,
    to: values.to,
    subject: values.subject,
    body: values.body,
    level: values.level,
    ttlSec,
  });

  const store = new OperationStore(':memory:');
  const service = new FulfillmentService({ store, mailer: new FakeMailer() });
  const prepared = service.prepare(operation);

  const log = values.json ? () => {} : (line) => console.log(line);
  log(`操作 ${prepared.operationId} 已冻结：${buildSummary(prepared)}`);
  const sourceText = {
    demo: '演示密钥（仅用于联调）',
    env: '环境变量 SAFE_OFFICE_SFC1_KEY',
    arg: '命令行参数 --key',
    table: '设备表（data/devices.json）',
  }[source] || source;
  log(`密钥来源：${sourceText}`);
  log('请在板端确认：短按 KEY2 = 批准，长按 KEY2 = 取消');

  try {
    const approval = await runSerialConfirmation({
      portPath: values.port,
      key,
      deviceId: values.device,
      operation: prepared,
      ttlSec,
      timeoutMs,
      logger: log,
    });
    let actuatorAck = null;
    if (values['actuator-device']) {
      const pin = Number(values['actuator-pin']);
      const level = Number(values['actuator-level']);
      const actTimeout = Number(values['actuator-timeout']);
      if (!Number.isInteger(actTimeout) || actTimeout <= 0) throw new Error('--actuator-timeout 必须是正整数');
      try {
        actuatorAck = await runActuatorStep({
          portPath: values.port,
          label: String(values['actuator-device']),
          pin,
          level,
          timeoutMs: actTimeout,
          logger: log,
        });
      } catch (err) {
        if (values.json) {
          console.log(JSON.stringify({
            ok: false,
            stage: 'actuator',
            code: err.code || null,
            message: err.message,
          }, null, 2));
        } else {
          console.error(`执行失败：${err.code || 'ERROR'} ${err.message}`);
        }
        store.close();
        return 1;
      }
    }

    if (values.json) {
      console.log(JSON.stringify({
        ok: true,
        decision: approval.decision,
        device: approval.deviceLabel,
        operationId: prepared.operationId,
        confirmationId: approval.confirmationId,
        actuator: actuatorAck,
      }, null, 2));
    } else {
      log(`确认结果：decision=${approval.decision}（1=批准 0=取消）device=${approval.deviceLabel}`);
      log(`confirmationId=${approval.confirmationId}`);
    }
    store.close();
    // 取消不会走到这里：NearfieldConfirmer 对 decision=0 抛 DECISION（cancelled:true），
    // 由 catch 统一返回 1。2026-11-04 拍板保持该行为，不引入退出码 2。
    return 0;
  } catch (err) {
    if (values.json) {
      console.log(JSON.stringify({ ok: false, code: err.code || null, message: err.message }, null, 2));
    } else {
      console.error(`确认失败：${err.code || 'ERROR'} ${err.message}`);
    }
    store.close();
    return 1;
  }
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch((err) => {
    console.error(`参数错误：${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  ACTION_MAP,
  DEFAULT_TTL_SEC,
  DEFAULT_TIMEOUT_MS,
  buildOperation,
  runSerialConfirmation,
  runActuatorStep,
};
