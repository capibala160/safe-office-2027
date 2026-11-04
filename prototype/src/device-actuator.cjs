'use strict';
// ============================================================
// 设备联动真实执行（v0.52，2026-11-04）
//   确认通过后，主机把 SFC1 执行帧（type 0x21，HMAC）发给 WS63，
//   板端验签、查重放、驱动 GPIO，再回 ACK（0x22）。
//   只映射两个可观测输出：IO13 板载 LED、IO10 蜂鸣器（docs/10 M0 记录）。
// 边界：帧带 nonce 防重放；但执行只证明「板子收到的这条命令被执行了」，
//       不证明门锁等真实机构动作（当前无继电器/锁体）。
// ============================================================
const crypto = require('node:crypto');
const { encodeActuator, decodeFrame } = require('./ws63-protocol.cjs');

const PIN_LED = 13;
const PIN_BUZZER = 10;

// 业务语义 → (pin, level)；未映射返回 null（不猜、不乱动）
function mapDeviceOp(device, op) {
  const action = String(op || '').toLowerCase();
  if (['unlock', 'open', 'on', 'start'].includes(action)) return { pin: PIN_LED, level: 1 };
  if (['lock', 'close', 'off', 'stop'].includes(action)) return { pin: PIN_LED, level: 0 };
  if (['beep', 'alarm'].includes(action)) return { pin: PIN_BUZZER, level: 1 };
  if (['silence', 'mute'].includes(action)) return { pin: PIN_BUZZER, level: 0 };
  return null;
}

function isSfc1Header(buf, i) {
  return buf[i] === 0x53 && buf[i + 1] === 0x46 && buf[i + 2] === 0x43 && buf[i + 3] === 0x31
    && buf[i + 4] === 1 && buf[i + 6] === 0 && buf[i + 7] === 0
    && (buf[i + 5] === 0x21 || buf[i + 5] === 0x22 || buf[i + 5] === 1 || buf[i + 5] === 2);
}

function createSerialActuator({
  portPath,
  key,
  timeoutMs = 3000,
  openSerial = null, // 测试注入：({path, baudRate}) => 可写/可读端口对象
  map = mapDeviceOp,
  now = () => Date.now(),
} = {}) {
  if (!portPath) throw new TypeError('设备执行需要串口路径');
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new TypeError('设备执行需要 32 字节密钥');
  if (typeof map !== 'function') throw new TypeError('map 必须是函数');

  function send(pin, level) {
    return new Promise((resolve, reject) => {
      const SerialPortCtor = openSerial
        ? null
        : (() => { try { return require('serialport').SerialPort; } catch { return null; } })();
      const port = openSerial ? openSerial({ path: portPath, baudRate: 115200 }) : new SerialPortCtor({ path: portPath, baudRate: 115200 });
      if (!port) {
        reject(new Error('serialport 未安装（optionalDependencies）'));
        return;
      }
      let done = false;
      let buffer = Buffer.alloc(0);
      const finish = (err, result) => {
        if (done) return;
        done = true;
        try { if (typeof port.close === 'function') port.close(() => {}); } catch { /* ignore */ }
        if (err) reject(err); else resolve(result);
      };
      const timer = setTimeout(() => finish(Object.assign(new Error('等待设备 ACK 超时'), { code: 'ACTUATOR_TIMEOUT' })), timeoutMs);
      timer.unref?.();

      port.on?.('error', (err) => finish(err));
      port.on?.('open', () => {
        try {
          const frame = encodeActuator({ nonce: crypto.randomBytes(16), pin, level }, key);
          port.write(frame);
        } catch (err) { finish(err); }
      });
      port.on?.('data', (chunk) => {
        buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
        for (let i = 0; i + 10 <= buffer.length; i++) {
          if (!isSfc1Header(buffer, i)) continue;
          const total = 10 + buffer.readUInt16LE(i + 8);
          if (buffer.length < i + total) break;
          const frame = buffer.subarray(i, i + total);
          try {
            const decoded = decodeFrame(frame, key);
            if (decoded.type === 'actuator-ack') {
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

  async function actuate({ device = '', op = '' } = {}) {
    const target = map(device, op);
    if (!target) {
      throw Object.assign(new Error(`没有映射到物理动作：${device} ${op}`), { code: 'ACTUATOR_MAP' });
    }
    const ack = await send(target.pin, target.level);
    if (ack.status !== 0) {
      throw Object.assign(new Error(`设备执行失败（status=${ack.status}）`), { code: 'ACTUATOR_STATUS' });
    }
    return { ...ack, device, op };
  }

  return { actuate, send, map };
}

module.exports = { createSerialActuator, mapDeviceOp, PIN_LED, PIN_BUZZER };
