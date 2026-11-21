'use strict';
// 真实模型评测互斥锁：同一账号下两个 eval 会互相拖慢（实测卡在 V-N4/V-N5 附近）。
// 只锁 http 评测；Mock 评测不经过模型，允许并行。
// 锁文件记录 pid + 开始时间 + 输出目录；进程已死/文件损坏时自动接管。
const fs = require('node:fs');
const { dirname } = require('node:path');

/** @param {number} pid @returns {boolean} */
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = 进程存在但无权限访问（例如系统进程），仍算存活
    return Boolean(err && /** @type {any} */ (err).code === 'EPERM');
  }
}

/**
 * @param {string} file
 * @param {{ pid?: number, startedAt?: Date, out?: string }} [info]
 * @returns {() => void} 释放函数（只删除自己持有的锁）
 */
function acquireEvalLock(file, { pid = process.pid, startedAt = new Date(), out = '' } = {}) {
  fs.mkdirSync(dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    /** @type {any} */
    let prev = null;
    try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { prev = null; }
    const prevPid = Number(prev && prev.pid);
    if (prevPid && prevPid !== pid && isProcessAlive(prevPid)) {
      const err = /** @type {Error & { code?: string }} */ (new Error(
        `另一个真实模型评测正在运行（pid ${prevPid}，开始于 ${prev.startedAt || '未知'}，输出 ${prev.out || '未知'}）。`
        + `同一账号并行会互相拖慢；请等它结束，或删掉 ${file} 后重试。`,
      ));
      err.code = 'EVAL_BUSY';
      throw err;
    }
  }
  fs.writeFileSync(file, JSON.stringify({
    pid, startedAt: startedAt.toISOString(), out,
  }, null, 2));
  return () => {
    try {
      const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Number(cur.pid) === pid) fs.unlinkSync(file);
    } catch { /* 已删除或损坏：无需处理 */ }
  };
}

module.exports = { acquireEvalLock, isProcessAlive };
