'use strict';
// ============================================================
// 设备联动真实执行（v0.52，2026-11-04）
//   确认通过后，主机把 SFC1 执行帧（type 0x21，HMAC）发给 WS63，
//   板端验签、查重放、驱动 GPIO，再回 ACK（0x22，回带本次 nonce）。
//   输出：IO13 板载 LED、IO10 蜂鸣器、IO12 继电器（锁体，docs/68）。
//   继电器只在设备名是门锁类（含「锁/门禁/门」或 door/lock）且操作是
//   unlock/open/lock/close 时动作；开灯之类通用 on/off 只驱动 LED。
// 边界：帧带 nonce 防重放；但执行只证明「板子收到的这条命令被执行了」，
//       不证明门锁等真实机构动作（当前无继电器/锁体实物）。
// ============================================================
const crypto = require('node:crypto');
const { encodeActuator, decodeFrame } = require('./ws63-protocol.cjs');

const PIN_LED = 13;
const PIN_BUZZER = 10;
const PIN_RELAY = 12;

// 业务语义 → (pin, level)；未映射返回 null（不猜、不乱动）
// relayPin：配置后**仅门锁类设备**的 unlock/open/lock/close 走继电器（锁体）；
// 通用 on/start/off/stop 仍只驱动 IO13 LED——避免「开灯」这类指令误触门锁。
// null = 沿用 IO13 LED 演示。
const LOCK_OPS_ON = ['unlock', 'open'];
const LOCK_OPS_OFF = ['lock', 'close'];
const GENERIC_OPS_ON = ['on', 'start'];
const GENERIC_OPS_OFF = ['off', 'stop'];
// 业务设备名需含「锁 / 门禁 / 门」或 door/lock（如「会议室-门锁」「front-door」）
const LOCK_DEVICE_RE = /(锁|门禁|门|door|lock)/i;

/** @param {string} device @returns {boolean} */
function isLockDevice(device) {
  return LOCK_DEVICE_RE.test(String(device || ''));
}

/**
 * @param {string} device
 * @param {string} op
 * @param {number | null} [relayPin]
 * @returns {{ pin: number, level: number } | null}
 */
function mapDeviceOp(device, op, relayPin = null) {
  const action = String(op || '').toLowerCase();
  // 只有 IO12 才算「继电器模式」；IO13 是显式 LED，行为与未配置一致
  const relayMode = relayPin === PIN_RELAY;
  if (LOCK_OPS_ON.includes(action)) {
    if (relayMode) return isLockDevice(device) ? { pin: /** @type {number} */ (relayPin), level: 1 } : null;
    return { pin: PIN_LED, level: 1 };
  }
  if (LOCK_OPS_OFF.includes(action)) {
    if (relayMode) return isLockDevice(device) ? { pin: /** @type {number} */ (relayPin), level: 0 } : null;
    return { pin: PIN_LED, level: 0 };
  }
  if (GENERIC_OPS_ON.includes(action)) return { pin: PIN_LED, level: 1 };
  if (GENERIC_OPS_OFF.includes(action)) return { pin: PIN_LED, level: 0 };
  if (['beep', 'alarm'].includes(action)) return { pin: PIN_BUZZER, level: 1 };
  if (['silence', 'mute'].includes(action)) return { pin: PIN_BUZZER, level: 0 };
  return null;
}

const SFC1_HEADER_BYTES = 10;
const SFC1_HMAC_BYTES = 32;
// 各帧型的 payload 长度（ws63-protocol 编码器只会产出这些形状）。
// 校验长度字段有两个作用：把假帧头当噪声跳过；异常长度不会把后面的有效帧「堵死」。
const SFC1_PAYLOAD_RANGE = new Map([
  [1, [66, 162]], // challenge：66 + summary（≤96）
  [2, [37, 37]], // decision
  [0x21, [18, 18]], // actuator
  [0x22, [19, 19]], // actuator ack
]);

/**
 * 合法帧头返回整帧字节数；不是帧头或长度字段异常返回 0（调用方继续向后找帧头）。
 * @param {Buffer} buf @param {number} i @returns {number}
 */
function sfc1FrameLength(buf, i) {
  if (i + SFC1_HEADER_BYTES > buf.length) return 0;
  if (buf[i] !== 0x53 || buf[i + 1] !== 0x46 || buf[i + 2] !== 0x43 || buf[i + 3] !== 0x31) return 0;
  if (buf[i + 4] !== 1 || buf[i + 6] !== 0 || buf[i + 7] !== 0) return 0;
  const range = SFC1_PAYLOAD_RANGE.get(buf[i + 5]);
  if (!range) return 0;
  const payload = buf.readUInt16LE(i + 8) - SFC1_HMAC_BYTES;
  if (payload < range[0] || payload > range[1]) return 0;
  return SFC1_HEADER_BYTES + SFC1_HMAC_BYTES + payload;
}

/**
 * @param {{ portPath?: string, key?: Buffer, timeoutMs?: number, openSerial?: ((opts: { path: string, baudRate: number }) => any) | null, serialPortModule?: any, map?: ((device: string, op: string) => { pin: number, level: number } | null) | null, relayPin?: number | null, now?: () => number }} [options]
 */
function createSerialActuator({
  portPath,
  key,
  timeoutMs = 3000,
  openSerial = null, // 测试注入：({path, baudRate}) => 可写/可读端口对象
  serialPortModule = undefined, // 测试注入：传 null 验证「未安装」分支
  map = null,
  relayPin = null,
  now = () => Date.now(),
} = {}) {
  if (!portPath) throw new TypeError('设备执行需要串口路径');
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new TypeError('设备执行需要 32 字节密钥');
  // 只接受固件实际放行的输出脚：IO12 继电器 / IO13 LED（null 关闭）。
  // 配成 IO10（蜂鸣器）会把「开锁」变成蜂鸣，配成其他脚会被板端拒绝——都在启动时直接失败。
  if (relayPin !== null && relayPin !== PIN_RELAY && relayPin !== PIN_LED) {
    throw new TypeError('relayPin 只支持 IO12（继电器）或 IO13（LED），或 null 关闭');
  }
  /** @type {(device: string, op: string) => { pin: number, level: number } | null} */
  const mapper = typeof map === 'function' ? map : (device, op) => mapDeviceOp(device, op, relayPin);
  if (typeof mapper !== 'function') throw new TypeError('map 必须是函数');

  function resolveCtor() {
    const mod = serialPortModule === undefined
      ? (() => { try { return require('serialport'); } catch { return null; } })()
      : serialPortModule;
    return mod && mod.SerialPort ? mod.SerialPort : null;
  }

  // 先判依赖再构造：serialport 缺失时给出明确错误，而不是 new null 的 TypeError
  /** @param {any} SerialPortCtor @returns {any} */
  function openPort(SerialPortCtor) {
    const path = String(portPath);
    if (openSerial) return openSerial({ path, baudRate: 115200 });
    if (!SerialPortCtor) {
      throw Object.assign(new Error('serialport 未安装（optionalDependencies）'), { code: 'ACTUATOR_NO_SERIALPORT' });
    }
    return new SerialPortCtor({ path, baudRate: 115200 });
  }

  /** @param {number} pin @param {number} level @returns {Promise<any>} */
  function send(pin, level) {
    return new Promise((resolve, reject) => {
      /** @type {any} */
      let port;
      try {
        port = openPort(resolveCtor());
      } catch (err) {
        reject(err);
        return;
      }
      const nonce = crypto.randomBytes(16);
      let done = false;
      // 命令帧是否已经交给串口。只有「确认没写出」的失败才允许重试，
      // 否则板端可能已经执行过一次，重发会变成重复动作。
      let sent = false;
      let buffer = Buffer.alloc(0);
      /** @param {any} [err] @param {any} [result] */
      const finish = (err, result) => {
        if (done) return;
        done = true;
        if (err && typeof err === 'object') err.commandSent = sent;
        try { if (typeof port.close === 'function') port.close(() => {}); } catch { /* ignore */ }
        if (err) reject(err); else resolve(result);
      };
      const timer = setTimeout(() => finish(Object.assign(new Error('等待设备 ACK 超时'), { code: 'ACTUATOR_TIMEOUT' })), timeoutMs);
      timer.unref?.();

      port.on?.('error', (/** @type {any} */ err) => finish(err));
      port.on?.('open', () => {
        try {
          // 先置位再写：即使 write 同步抛错也按「可能已写出」处理，宁可失败也不重发
          sent = true;
          port.write(encodeActuator({ nonce, pin, level }, /** @type {Buffer} */ (key)));
        } catch (err) { finish(err); }
      });
      port.on?.('data', (/** @type {Buffer} */ chunk) => {
        buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
        for (let i = 0; i + SFC1_HEADER_BYTES <= buffer.length; i++) {
          // 长度字段异常的「帧头」直接跳过（不能 break，否则后面的有效 ACK 会被堵死）
          const total = sfc1FrameLength(buffer, i);
          if (!total) continue;
          if (buffer.length < i + total) break; // 合法帧但还没收全：等下一块数据
          const frame = buffer.subarray(i, i + total);
          try {
            const decoded = decodeFrame(frame, /** @type {Buffer} */ (key));
            if (decoded.type === 'actuator-ack') {
              // 1) 必须先绑定本次 nonce：旧回执/其他动作的 ACK 一律忽略
              const ackNonce = decoded.nonce;
              if (!ackNonce || ackNonce.length !== 16 || !crypto.timingSafeEqual(ackNonce, nonce)) {
                continue;
              }
              // 2) nonce 对上但 pin/level 不符：协议异常，直接失败
              if (decoded.pin !== pin || decoded.level !== level) {
                finish(Object.assign(
                  new Error(`ACK 与本次命令不符（pin ${decoded.pin}/${pin}，level ${decoded.level}/${level}）`),
                  { code: 'ACTUATOR_ACK_MISMATCH' },
                ));
                return;
              }
              clearTimeout(timer);
              finish(null, { ...decoded, at: new Date(now()).toISOString() });
              return;
            }
          } catch { /* 继续扫描 */ }
          i += total - 1;
        }
        if (buffer.length > 4096) buffer = buffer.subarray(buffer.length - 1024);
      });
      // 注入的端口可能只有 write/on：同步触发 open
      if (openSerial && typeof port.on !== 'function') {
        finish(new Error('注入端口必须实现 on/write'));
      }
    });
  }

  /** @param {{ device?: string, op?: string }} [options] @returns {Promise<any>} */
  async function actuate({ device = '', op = '' } = {}) {
    const target = mapper(device, op);
    if (!target) {
      throw Object.assign(new Error(`没有映射到物理动作：${device} ${op}`), { code: 'ACTUATOR_MAP' });
    }
    // 确认端刚释放串口时驱动可能还没放开：占用类错误短暂重试（最多 3 次）
    let ack;
    for (let attempt = 1; ; attempt += 1) {
      try {
        ack = await send(target.pin, target.level);
        break;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const busy = /Access denied|EBUSY|Resource busy|busy/i.test(message);
        // 命令已经写出（或可能写出）时绝不重试：板端可能已执行，重发等于重复动作
        const alreadySent = Boolean(err && typeof err === 'object'
          && /** @type {{ commandSent?: boolean }} */ (err).commandSent);
        if (attempt >= 3 || !busy || alreadySent) throw err;
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
    }
    if (ack.status !== 0) {
      throw Object.assign(new Error(`设备执行失败（status=${ack.status}）`), { code: 'ACTUATOR_STATUS' });
    }
    return { ...ack, device, op };
  }

  return { actuate, send, map: mapper, relayPin };
}

module.exports = { createSerialActuator, mapDeviceOp, PIN_LED, PIN_BUZZER, PIN_RELAY };
