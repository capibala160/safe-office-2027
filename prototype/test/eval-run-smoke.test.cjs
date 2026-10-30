'use strict';
// run.cjs 冒烟：入口脚本必须能真正跑完（防止漏 import 这类只在 CLI 暴露的错误）
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('eval/run.cjs：Mock 开发集能跑完并产出 JSON', { timeout: 60000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-office-eval-'));
  try {
    const out = execFileSync(process.execPath, [
      path.join(__dirname, '..', 'eval', 'run.cjs'),
      '--tiers=full', '--split=dev', '--out=' + dir,
    ], { cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 50000 });
    assert.match(out, /完整网关/);
    const data = JSON.parse(fs.readFileSync(path.join(dir, 'eval-results.json'), 'utf8'));
    assert.equal(data.meta.fingerprint.length, 64);
    assert.ok(data.runs.length >= 14);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
