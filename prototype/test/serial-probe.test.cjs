'use strict';
// 串口探测工具的纯函数测试（v0.48）。硬件相关部分（打开/回环）不在这里测，
// 用 docs/58 的现场步骤验收。
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseBaudList,
  renderPreview,
  findMarkers,
} = require('../scripts/serial-probe.cjs');

test('parseBaudList：逗号分隔、去重、去空白', () => {
  assert.deepEqual(parseBaudList('115200'), [115200]);
  assert.deepEqual(parseBaudList('115200,921600'), [115200, 921600]);
  assert.deepEqual(parseBaudList(' 115200 , 115200 ,74880 '), [115200, 74880]);
});

test('parseBaudList：非法输入抛错', () => {
  assert.throws(() => parseBaudList(''), /不能为空/);
  assert.throws(() => parseBaudList('abc'), /非法波特率/);
  assert.throws(() => parseBaudList('-1'), /非法波特率/);
  assert.throws(() => parseBaudList('1200.5'), /非法波特率/);
  assert.throws(() => parseBaudList('5000000'), /非法波特率/);
  assert.throws(() => parseBaudList(' , '), /至少要有一个/);
});

test('renderPreview：可打印字符原样、控制字符转义', () => {
  const buf = Buffer.from([0x62, 0x6f, 0x6f, 0x74, 0x2e, 0x0d, 0x0a, 0x00, 0x1b, 0x41]);
  assert.equal(renderPreview(buf), 'boot.\n\\x00\\x1bA');
});

test('renderPreview：按 max 截断', () => {
  assert.equal(renderPreview(Buffer.from('abcdef'), 3), 'abc');
  assert.equal(renderPreview(Buffer.alloc(0)), '');
});

test('findMarkers：大小写不敏感，多个标志都能命中', () => {
  const boot = Buffer.from('boot.\r\nFlash Init Succ!\r\nAPP|dbg uart init ok.\r\n');
  const found = findMarkers(boot);
  assert.ok(found.includes('boot.'));
  assert.ok(found.includes('flash init'));
  assert.ok(found.includes('app|'));
  assert.deepEqual(findMarkers(Buffer.from('nothing here')), []);
});

test('findMarkers：二进制噪声不会误报', () => {
  const noise = Buffer.from([0x00, 0xff, 0x10, 0x80, 0x7f]);
  assert.deepEqual(findMarkers(noise), []);
});
