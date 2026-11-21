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
    const normalRuns = data.runs.filter((run) => run.kind === 'normal');
    const calls = data.matrix.full.all.latency.normalModelCalls;
    assert.equal(calls.measuredRuns, normalRuns.length);
    assert.equal(calls.planning.count, normalRuns.flatMap((run) => run.modelCalls.planningCallsMs).length);
    assert.ok(normalRuns.some((run) => run.modelCalls.generationCallsMs.length > 0));
    const report = fs.readFileSync(path.join(dir, 'eval-report.html'), 'utf8');
    assert.match(report, /正常任务的模型调用耗时/);
    const slowest = normalRuns.reduce((longest, run) => run.totalMs > longest.totalMs ? run : longest);
    const timingTable = report.split('完整网关耗时最长的正常任务')[1];
    assert.ok(timingTable.startsWith(`</h2>`));
    assert.ok(timingTable.split('</table>')[0].includes(`${slowest.caseId} ·`));

    execFileSync(process.execPath, [
      path.join(__dirname, '..', 'eval', 'run.cjs'),
      '--tiers=full', '--split=validation', '--kind=normal', '--cases=V-N8,V-N4,V-N8', '--out=' + dir,
    ], { encoding: 'utf8', timeout: 50000 });
    const selected = JSON.parse(fs.readFileSync(path.join(dir, 'eval-results.json'), 'utf8'));
    assert.deepEqual(selected.meta.caseIds, ['V-N4', 'V-N8']);
    assert.deepEqual(selected.runs.map((run) => run.caseId).sort(), selected.meta.caseIds);
    assert.match(fs.readFileSync(path.join(dir, 'eval-report.html'), 'utf8'), /指定用例 V-N4、V-N8/);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
