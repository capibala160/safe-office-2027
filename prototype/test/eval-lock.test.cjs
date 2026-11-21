'use strict';
// 评测互斥锁：活进程持锁时拒绝第二个真实模型评测；死进程/坏文件的锁可接管。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const { join } = require('node:path');
const { acquireEvalLock, isProcessAlive } = require('../eval/lock.cjs');

function tmpLock() {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'eval-lock-'));
  return join(dir, '.eval.lock');
}

test('存活判断：当前进程 true，明显不存在的 pid false', () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(99999999), false);
  assert.equal(isProcessAlive(0), false);
  assert.equal(isProcessAlive(-1), false);
});

test('互斥：活进程持锁时，第二个评测报 EVAL_BUSY 且不覆盖锁', () => {
  const file = tmpLock();
  const release = acquireEvalLock(file, { pid: process.ppid, out: 'first' });
  try {
    assert.throws(
      () => acquireEvalLock(file, { pid: process.pid, out: 'second' }),
      (err) => err && /** @type {any} */ (err).code === 'EVAL_BUSY' && /另一个真实模型评测/.test(err.message),
    );
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.pid, process.ppid);
    assert.equal(saved.out, 'first');
  } finally {
    release();
    assert.equal(fs.existsSync(file), false);
  }
});

test('接管：死进程留下的锁可以直接覆盖', () => {
  const file = tmpLock();
  fs.writeFileSync(file, JSON.stringify({ pid: 99999999, startedAt: '2026-01-01T00:00:00.000Z', out: 'stale' }));
  const release = acquireEvalLock(file, { pid: process.pid, out: 'fresh' });
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.pid, process.pid);
    assert.equal(saved.out, 'fresh');
  } finally {
    release();
  }
});

test('接管：损坏的锁文件不阻塞（按无锁处理）', () => {
  const file = tmpLock();
  fs.writeFileSync(file, '{ not json');
  const release = acquireEvalLock(file, { pid: process.pid, out: 'fresh' });
  try {
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, process.pid);
  } finally {
    release();
  }
});

test('释放：只删除自己持有的锁，不误删别人的', () => {
  const file = tmpLock();
  const release = acquireEvalLock(file, { pid: process.pid, out: 'mine' });
  // 病态场景：我的锁被别人接管后，我的释放不得删掉对方的锁
  fs.writeFileSync(file, JSON.stringify({ pid: process.ppid, out: 'other' }));
  release();
  assert.equal(fs.existsSync(file), true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, process.ppid);
  fs.unlinkSync(file);
});

test('释放后可再次获取', () => {
  const file = tmpLock();
  const release = acquireEvalLock(file, { pid: process.pid, out: 'a' });
  release();
  const release2 = acquireEvalLock(file, { pid: process.pid, out: 'b' });
  try {
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).out, 'b');
  } finally {
    release2();
  }
});
