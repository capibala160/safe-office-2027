'use strict';
// ============================================================
// 串口 transport（v0.14 草案）
//   作用：把 SFC1 二进制帧经 USB-UART 送到 WS63，并收回 DECISION 帧。
//   契约与 nearfield-confirm.cjs 一致：send(frame) -> Promise<Buffer|null>
//   null 表示超时/无有效应答，由 NearfieldConfirmer 转成 TIMEOUT。
//
//   边界：
//   - 不负责打开/关闭串口。port 由调用方注入（如 serialport 的实例），
//     只要求 write(Buffer) + EventEmitter 的 'data'/'error'/'close'。
//   - 只做帧边界、超时、串行化；MAC/绑定/重放仍由 NearfieldConfirmer 校验。
//   - 默认只把 DECISION 帧交给上层（板端若回显 CHALLENGE，会被忽略）。
// ============================================================
const { EventEmitter } = require('node:events');

const MAGIC = Buffer.from('SFC1');
const HEADER_LEN = 10;
const MAC_LEN = 32;
const MIN_FRAME = HEADER_LEN + MAC_LEN;
const DEFAULT_MAX_FRAME = 1024;
const TYPE_CHALLENGE = 1;
const TYPE_DECISION = 2;

// 从任意字节流中切出完整 SFC1 帧；坏长度/前置噪声会自动重新同步
class SerialFrameParser {
  constructor({ maxFrameBytes = DEFAULT_MAX_FRAME } = {}) {
    if (!Number.isInteger(maxFrameBytes) || maxFrameBytes < MIN_FRAME) {
      throw new TypeError(`maxFrameBytes 必须是不小于 ${MIN_FRAME} 的整数`);
    }
    this.maxFrameBytes = maxFrameBytes;
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    if (!Buffer.isBuffer(chunk)) throw new TypeError('chunk 必须是 Buffer');
    if (chunk.length === 0) return [];
    this.buffer = this.buffer.length
      ? Buffer.concat([this.buffer, chunk])
      : Buffer.from(chunk);

    const frames = [];
    for (;;) {
      const index = this.buffer.indexOf(MAGIC);
      if (index < 0) {
        // 末尾可能是半个 magic，保留最后 3 字节
        if (this.buffer.length > MAGIC.length - 1) {
          this.buffer = this.buffer.subarray(this.buffer.length - (MAGIC.length - 1));
        }
        break;
      }
      if (index > 0) this.buffer = this.buffer.subarray(index);
      if (this.buffer.length < HEADER_LEN) break;

      const length = this.buffer.readUInt16LE(8); // payload + MAC
      const total = HEADER_LEN + length;
      if (length < MAC_LEN || total > this.maxFrameBytes) {
        // 长度不可信：丢掉当前 magic 的第一个字节，继续找下一个
        this.buffer = this.buffer.subarray(1);
        continue;
      }
      if (this.buffer.length < total) break;
      frames.push(Buffer.from(this.buffer.subarray(0, total)));
      this.buffer = this.buffer.subarray(total);
    }
    return frames;
  }

  reset() {
    this.buffer = Buffer.alloc(0);
  }
}

class SerialTransport {
  constructor({
    port,
    timeoutMs = 5000,
    replyType = TYPE_DECISION,
    maxFrameBytes = DEFAULT_MAX_FRAME,
    logger = null,
  } = {}) {
    if (!port || typeof port.write !== 'function' || typeof port.on !== 'function') {
      throw new TypeError('port 需要 write(Buffer) 和 EventEmitter.on');
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError('timeoutMs 必须是正整数');
    }
    if (replyType !== TYPE_CHALLENGE && replyType !== TYPE_DECISION) {
      throw new TypeError('replyType 只支持 1（CHALLENGE）或 2（DECISION）');
    }
    this.port = port;
    this.timeoutMs = timeoutMs;
    this.replyType = replyType;
    this.logger = typeof logger === 'function' ? logger : null;
    this.parser = new SerialFrameParser({ maxFrameBytes });
    this.waiter = null;
    this.queue = Promise.resolve();
    this.closed = false;

    this._onData = (chunk) => this._handleChunk(chunk);
    this._onError = (err) => this._fail(err);
    this._onClose = () => this._fail(new Error('串口已关闭'));
    port.on('data', this._onData);
    port.on('error', this._onError);
    port.on('close', this._onClose);
  }

  _handleChunk(chunk) {
    let frames;
    try {
      frames = this.parser.push(chunk);
    } catch (err) {
      this._fail(err);
      return;
    }
    for (const frame of frames) {
      if (frame[5] !== this.replyType) {
        if (this.logger) this.logger(`忽略帧类型 ${frame[5]}`);
        continue;
      }
      if (!this.waiter) {
        if (this.logger) this.logger('没有等待中的请求，丢弃帧');
        continue;
      }
      const waiter = this.waiter;
      this.waiter = null;
      clearTimeout(waiter.timer);
      waiter.resolve(frame);
    }
  }

  _fail(err) {
    if (!this.waiter) {
      if (this.logger) this.logger(`串口错误（无等待请求）：${err && err.message ? err.message : err}`);
      return;
    }
    const waiter = this.waiter;
    this.waiter = null;
    clearTimeout(waiter.timer);
    waiter.reject(err);
  }

  _sendOnce(frame) {
    if (this.closed) return Promise.reject(new Error('transport 已关闭'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.waiter && this.waiter.timer === timer) {
          this.waiter = null;
          resolve(null); // 契约：无有效应答
        }
      }, this.timeoutMs);
      this.waiter = { resolve, reject, timer };
      try {
        this.port.write(frame);
      } catch (err) {
        clearTimeout(timer);
        this.waiter = null;
        reject(err);
      }
    });
  }

  // 串行化：同一时刻只允许一个 CHALLENGE 在途，避免应答串台
  send(frame) {
    if (!Buffer.isBuffer(frame)) return Promise.reject(new TypeError('frame 必须是 Buffer'));
    if (this.closed) return Promise.reject(new Error('transport 已关闭'));
    const run = () => this._sendOnce(frame);
    this.queue = this.queue.then(run, run);
    return this.queue;
  }

  // 只解绑监听，不关闭底层串口（port 归调用方所有）
  close() {
    if (this.closed) return;
    this.closed = true;
    if (typeof this.port.removeListener === 'function') {
      this.port.removeListener('data', this._onData);
      this.port.removeListener('error', this._onError);
      this.port.removeListener('close', this._onClose);
    }
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      clearTimeout(waiter.timer);
      waiter.reject(new Error('transport 已关闭'));
    }
  }
}

function createSerialTransport(options) {
  return new SerialTransport(options);
}

module.exports = {
  SerialFrameParser,
  SerialTransport,
  createSerialTransport,
  MAGIC,
  HEADER_LEN,
  MAC_LEN,
  MIN_FRAME,
  TYPE_CHALLENGE,
  TYPE_DECISION,
};
