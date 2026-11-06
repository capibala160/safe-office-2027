'use strict';
// eFuse 只读探测的纯函数测试 + 源码安全守卫（docs/60 阶段 B）。
// 硬件读写在真板验收，本文件只保证：解析正确、探测模块不含任何写 API。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseProbeBlock, renderPreview } = require('../scripts/efuse-probe.cjs');

const FIRMWARE_DIR = path.join(__dirname, '..', '..', 'ws63', 'firmware', 'board-confirm');

const SAMPLE = [
  'noise before\r\n',
  '=== EFUSE PROBE (READ-ONLY) ===\r\n',
  'user_area: abs=222 len=16\r\n',
  'user_read rc=0\r\n',
  'user_hex: 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00\r\n',
  'direct_read rc=0\r\n',
  'direct_hex: 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00\r\n',
  'match=yes\r\n',
  'ones=0 all_zero=yes\r\n',
  '=== END EFUSE PROBE ===\r\n',
].join('');

test('parseProbeBlock：完整块解析出 16 字节与判定字段', () => {
  const result = parseProbeBlock(SAMPLE);
  assert.equal(result.found, true);
  assert.equal(result.complete, true);
  assert.equal(result.hex.length, 16);
  assert.deepEqual(result.hex, new Array(16).fill(0));
  assert.equal(result.ones, 0);
  assert.equal(result.allZero, true);
  assert.equal(result.match, true);
});

test('parseProbeBlock：非零内容不臆测为全 0', () => {
  const body = SAMPLE
    .replace(/direct_hex:.*\r\n/, 'direct_hex: 01 00 00 00 00 00 00 00 00 00 00 00 00 00 00 80\r\n')
    .replace(/ones=0 all_zero=yes/, 'ones=2 all_zero=no');
  const result = parseProbeBlock(body);
  assert.equal(result.hex[0], 1);
  assert.equal(result.hex[15], 0x80);
  assert.equal(result.ones, 2);
  assert.equal(result.allZero, false);
});

test('parseProbeBlock：缺结束标记时 complete=false', () => {
  const result = parseProbeBlock(SAMPLE.replace('=== END EFUSE PROBE ===\r\n', ''));
  assert.equal(result.found, true);
  assert.equal(result.complete, false);
});

test('parseProbeBlock：没有探测块时 found=false', () => {
  const result = parseProbeBlock('M3 SFC1 ready\r\n');
  assert.equal(result.found, false);
  assert.equal(result.complete, false);
});

test('renderPreview：控制字符转义、CR 丢弃', () => {
  assert.equal(renderPreview(Buffer.from([0x61, 0x0d, 0x0a, 0x00])), 'a\n\\x00');
});

test('安全守卫：板端探测模块不引用任何 eFuse 写接口', () => {
  const source = fs.readFileSync(path.join(FIRMWARE_DIR, 'efuse_probe.c'), 'utf8');
  assert.doesNotMatch(source, /uapi_efuse_(user_)?write_buffer/);
  assert.doesNotMatch(source, /uapi_efuse_(user_)?write_bit/);
  assert.doesNotMatch(source, /efuse_write_customer_rsvd/);
});

test('安全守卫：CLI 只调用只读报告函数', () => {
  const source = fs.readFileSync(path.join(FIRMWARE_DIR, 'board_confirm_m3.c'), 'utf8');
  assert.match(source, /efuse_probe_report\(\)/);
  assert.doesNotMatch(source, /uapi_efuse_(user_)?write_buffer/);
  assert.doesNotMatch(source, /uapi_efuse_(user_)?write_bit/);
});

test('安全守卫：地址常量与 docs/60 一致（222 / 16B）', () => {
  const header = fs.readFileSync(path.join(FIRMWARE_DIR, 'efuse_probe.h'), 'utf8');
  assert.match(header, /#define EFUSE_PROBE_USER_ABS_OFFSET\s+222u/);
  assert.match(header, /#define EFUSE_PROBE_USER_LEN\s+16u/);
});
