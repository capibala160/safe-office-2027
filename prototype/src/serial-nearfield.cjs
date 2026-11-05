'use strict';
// 真板确认端的串口传输工厂（docs/11 下一步）：懒打开 + 断线后下次自动重连。
//
// 行为：
//   - 第一次 getTransport() 打开串口，之后复用同一个 SerialTransport
//   - 端口 close/error 或 isOpen=false 时丢弃缓存，下一次 getTransport() 重新打开
//   - 并发调用只会打开一次（共享同一个 Promise）
//
// 边界：没有后台重连线程/退避重试——重连发生在"下一次发起确认"时；
//       打开失败会把错误抛给调用方，由控制台返回 TRANSPORT。

const { openSerialPort, SerialTransport } = require('./serial-transport.cjs');

/**
 * @param {{ portPath?: string, baudRate?: number, timeoutMs?: number, openPort?: (opts: { path: string, baudRate: number }) => Promise<any>, Transport?: any, logger?: ((line: string) => void) | null }} [options]
 * @returns {(() => Promise<any>) & { close: () => Promise<void> }}
 */
function createSerialNearfieldFactory({
  portPath,
  baudRate = 115200,
  timeoutMs = 65000,
  openPort = openSerialPort,
  Transport = SerialTransport,
  logger = null,
} = {}) {
  if (typeof portPath !== 'string' || portPath.trim() === '') {
    throw new TypeError('portPath 必填（例如 COM11）');
  }
  if (!Number.isInteger(baudRate) || baudRate <= 0) throw new TypeError('baudRate 必须是正整数');
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs 必须是正整数');

  /** @type {any} */
  let transport = null;
  /** @type {Promise<any> | null} */
  let opening = null;
  /** @param {string} line */
  const log = (line) => { if (typeof logger === 'function') logger(line); };

  /** @param {any} candidate @returns {boolean} */
  function alive(candidate) {
    return !!candidate && !!candidate.port && candidate.port.isOpen !== false;
  }

  async function open() {
    const port = await openPort({ path: String(portPath).trim(), baudRate });
    const created = /** @type {any} */ (new Transport({ port, timeoutMs }));
    // SerialTransport.close() 只摘监听、不关端口；这里补上，否则进程会挂住并一直占着 COM 口
    const detach = typeof created.close === 'function' ? created.close.bind(created) : null;
    // 返回 Promise 并在端口真正关闭后 resolve：调用方（设备执行）随后要独占同一串口，
    // 不等 close 完成就直接 open 会 "Access denied"（2026-11-04 真板复现）。
    created.close = () => new Promise((/** @type {(value?: void) => void} */ resolve) => {
      if (detach) {
        try { detach(); } catch { /* ignore */ }
      }
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };
      try {
        if (port.isOpen === false || typeof port.close !== 'function') { done(); return; }
        port.close(() => done());
        setTimeout(done, 500); // 驱动未回调时兜底，避免调用方永久挂起
      } catch { done(); }
    });
    const drop = () => {
      if (transport === created) transport = null;
      try { created.close(); } catch { /* ignore */ }
    };
    if (typeof port.once === 'function') {
      port.once('close', drop);
      port.once('error', drop);
    }
    log(`串口已打开：${String(portPath).trim()} @${baudRate}`);
    return created;
  }

  /** @type {(() => Promise<any>) & { close: () => Promise<void> }} */
  const getTransport = async () => {
    if (alive(transport)) return transport;
    if (opening) return opening;
    if (transport) {
      log('串口已断开，重新打开');
      try { transport.close(); } catch { /* ignore */ }
      transport = null;
    }
    opening = open()
      .then((created) => { transport = created; return created; })
      .finally(() => { opening = null; });
    return opening;
  };

  // 工厂持有传输缓存，也必须负责关闭：否则调用方（控制台/脚本）拿不到内部 transport，
  // 进程会挂着并一直占 COM 口（2026-11-04 实际踩到）。
  getTransport.close = async () => {
    const current = transport;
    transport = null;
    if (!current) return;
    try { await current.close(); } catch { /* ignore */ }
  };

  return getTransport;
}

module.exports = { createSerialNearfieldFactory };
