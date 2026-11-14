'use strict';
// M2 双板验收脚本的日志解析测试（不打开串口）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { BoardLog } = require('../scripts/sle-link-verify.cjs');

function silentLog() {
  return new BoardLog('T', { logger: () => {} });
}

test('BoardLog: 跨 chunk 拼行并统计字节/行数', () => {
  const log = silentLog();
  log.push(Buffer.from('SFC1 LINK: init role=ex'));
  log.push(Buffer.from('ec ret=0\r\n'));
  assert.equal(log.init, 'exec');
  assert.equal(log.lines, 1);
  assert.ok(log.bytes > 0);
});

test('BoardLog: 识别 confirm 角色', () => {
  const log = silentLog();
  log.push(Buffer.from('SFC1 LINK: init role=confirm ret=0\n'));
  assert.equal(log.init, 'confirm');
});

test('BoardLog: ALIVE 计数与超时后恢复', () => {
  const log = silentLog();
  log.push(Buffer.from('SFC1 LINK: ALIVE peer=confirm\r\n'));
  log.push(Buffer.from('SFC1 LINK: peer lost (timeout 3500ms)\r\n'));
  log.push(Buffer.from('SFC1 LINK: ALIVE peer=confirm\r\n'));
  assert.equal(log.alive, 2);
  assert.equal(log.lost, 1);
  assert.equal(log.lastAliveAfterLoss, true);
});

test('BoardLog: 首次 ALIVE 之前掉线不算恢复', () => {
  const log = silentLog();
  log.push(Buffer.from('SFC1 LINK: peer lost (timeout 3500ms)\r\n'));
  log.push(Buffer.from('SFC1 LINK: ALIVE peer=confirm\r\n'));
  assert.equal(log.lost, 1);
  assert.equal(log.lastAliveAfterLoss, false);
});

test('BoardLog: 空行/无关行不影响统计', () => {
  const log = silentLog();
  log.push(Buffer.from('\r\n\r\nother output\r\n'));
  assert.equal(log.lines, 1);
  assert.equal(log.init, null);
  assert.equal(log.alive, 0);
});
