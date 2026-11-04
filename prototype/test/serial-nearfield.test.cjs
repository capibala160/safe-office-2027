'use strict';
// 真板串口工厂：懒打开 / 复用 / 断线重连（docs/11）。用假端口注入，不碰真串口。
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createSerialNearfieldFactory } = require('../src/serial-nearfield.cjs');

class FakePort extends EventEmitter {
  constructor() {
    super();
    this.isOpen = true;
    this.written = [];
  }

  write(buf, cb) {
    this.written.push(Buffer.from(buf));
    if (typeof cb === 'function') cb();
  }

  close(cb) {
    this.isOpen = false;
    this.emit('close');
    if (typeof cb === 'function') cb();
  }
}

class FakeTransport {
  constructor({ port, timeoutMs }) {
    this.port = port;
    this.timeoutMs = timeoutMs;
    this.closed = false;
  }

  close() {
    this.closed = true;
  }
}

function harness() {
  const ports = [];
  const calls = [];
  const factory = createSerialNearfieldFactory({
    portPath: 'COM9',
    openPort: async (opts) => {
      calls.push(opts);
      const port = new FakePort();
      ports.push(port);
      return port;
    },
    Transport: FakeTransport,
  });
  return { factory, ports, calls };
}

test('首次打开并复用；并发只打开一次', async () => {
  const { factory, calls } = harness();
  const [a, b] = await Promise.all([factory(), factory()]);
  assert.equal(a, b);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, 'COM9');
  assert.equal(calls[0].baudRate, 115200);
  assert.equal((await factory()), a);
  assert.equal(calls.length, 1);
});

test('端口 close 后丢弃缓存，下次重新打开', async () => {
  const { factory, ports, calls } = harness();
  const first = await factory();
  ports[0].emit('close');
  assert.equal(first.closed, true, '旧 transport 被关闭');
  const second = await factory();
  assert.notEqual(second, first);
  assert.equal(calls.length, 2);
});

test('transport.close() 会关掉底层端口（否则进程挂住、一直占 COM 口）', async () => {
  const { factory, ports } = harness();
  const transport = await factory();
  assert.equal(ports[0].isOpen, true);
  transport.close();
  assert.equal(ports[0].isOpen, false);
});

test('isOpen=false 时重新打开', async () => {
  const { factory, ports, calls } = harness();
  await factory();
  ports[0].isOpen = false;
  await factory();
  assert.equal(calls.length, 2);
});

test('打开失败抛给调用方，下次仍可重试', async () => {
  let fail = true;
  let calls = 0;
  const factory = createSerialNearfieldFactory({
    portPath: 'COM9',
    openPort: async () => {
      calls += 1;
      if (fail) throw new Error('EBUSY');
      return new FakePort();
    },
    Transport: FakeTransport,
  });
  await assert.rejects(() => factory(), /EBUSY/);
  fail = false;
  const transport = await factory();
  assert.ok(transport);
  assert.equal(calls, 2);
});

test('factory.close() 关闭底层端口并清缓存（下次重新打开）', async () => {
  const { factory, ports, calls } = harness();
  const first = await factory();
  await factory.close();
  assert.equal(ports[0].isOpen, false, '底层端口必须关闭');
  assert.equal(first.closed, true);
  const second = await factory();
  assert.notEqual(second, first);
  assert.equal(calls.length, 2);
});

test('portPath 必填、参数类型校验', () => {
  assert.throws(() => createSerialNearfieldFactory({}), /portPath/);
  assert.throws(() => createSerialNearfieldFactory({ portPath: '  ' }), /portPath/);
  assert.throws(() => createSerialNearfieldFactory({ portPath: 'COM9', baudRate: 0 }), /baudRate/);
  assert.throws(() => createSerialNearfieldFactory({ portPath: 'COM9', timeoutMs: -1 }), /timeoutMs/);
});
