'use strict';
// 硬件证据一键脚本：纯函数与编排逻辑（不接真板）
const test = require('node:test');
const assert = require('node:assert');
const {
  buildMatrix, percentile, parseSerialConfirmOutput, judgeSerialRound,
  parseNegativeJson, summarize, renderSummaryMarkdown, runMatrix,
} = require('../scripts/evidence-run.cjs');

test('矩阵：默认 39 轮（20 批准 + 5 取消 + 5 超时 + 3+3+3）', () => {
  const matrix = buildMatrix();
  assert.equal(matrix.length, 39);
  assert.equal(matrix.filter((x) => x.phase === 'approve').length, 20);
  assert.equal(matrix.filter((x) => x.phase === 'cancel').length, 5);
  assert.equal(matrix.filter((x) => x.phase === 'timeout').length, 5);
  assert.equal(matrix.filter((x) => x.phase === 'tamper').length, 3);
  assert.equal(matrix.filter((x) => x.phase === 'replay').length, 3);
  assert.equal(matrix.filter((x) => x.phase === 'disconnect').length, 3);
  assert.deepEqual(buildMatrix({ approve: 2 }), [
    { phase: 'approve', index: 1 }, { phase: 'approve', index: 2 },
  ]);
});

test('串口输出解析：批准 + 执行 ACK / 取消 / 超时', () => {
  const ok = parseSerialConfirmOutput([
    '确认结果：decision=1（1=批准 0=取消）device=ws63-B',
    '执行结果：status=0 pin=12 level=1',
  ].join('\n'));
  assert.equal(ok.decision, 1);
  assert.deepEqual(ok.actuator, { status: 0, pin: 12, level: 1 });
  assert.equal(ok.failCode, null);

  const cancel = parseSerialConfirmOutput('确认失败：DECISION 用户取消');
  assert.equal(cancel.failCode, 'DECISION');

  const timeout = parseSerialConfirmOutput('确认失败：TIMEOUT 等待板端确认超时');
  assert.equal(timeout.failCode, 'TIMEOUT');
});

test('判定：批准必须 decision=1 且 ACK status=0 level=1', () => {
  assert.equal(judgeSerialRound('approve', { code: 0 }, {
    decision: 1, actuator: { status: 0, pin: 12, level: 1 },
  }).ok, true);
  assert.equal(judgeSerialRound('approve', { code: 0 }, {
    decision: 1, actuator: { status: 1, pin: 12, level: 1 },
  }).ok, false);
  assert.equal(judgeSerialRound('approve', { code: 0 }, { decision: 0, actuator: null }).ok, false);
});

test('判定：取消/超时/断链必须 fail-closed 且没有执行帧', () => {
  assert.equal(judgeSerialRound('cancel', { code: 1 }, { failCode: 'DECISION', actuator: null }).ok, true);
  assert.equal(judgeSerialRound('cancel', { code: 1 }, {
    failCode: 'DECISION', actuator: { status: 0, pin: 12, level: 1 },
  }).ok, false);
  assert.equal(judgeSerialRound('timeout', { code: 1 }, { failCode: 'TIMEOUT', actuator: null }).ok, true);
  assert.equal(judgeSerialRound('disconnect', { code: 1 }, { failCode: 'TIMEOUT', actuator: null }).ok, true);
  assert.equal(judgeSerialRound('disconnect', { code: 0 }, { decision: 1, actuator: { status: 0, level: 1 } }).ok, false);
});

test('sfc1-negative JSON：取最后一个对象', () => {
  const j = parseNegativeJson('前置日志\n{"ok":true,"results":[{"ok":true,"name":"MAC"}]}\n');
  assert.equal(j.ok, true);
  assert.equal(j.results[0].name, 'MAC');
  assert.equal(parseNegativeJson('没有 JSON'), null);
});

test('汇总：按阶段统计 + 批准前 10 轮口径 + 时延分位数', () => {
  const rounds = [];
  for (let i = 1; i <= 12; i++) {
    rounds.push({
      phase: 'approve', index: i, ok: i !== 12,
      timings: { sinceChallengeOpenMs: i * 100, processMs: i * 1000 },
    });
  }
  rounds.push({ phase: 'cancel', index: 1, ok: true, timings: {} });
  const s = summarize(rounds);
  assert.equal(s.byPhase.approve.attempts, 12);
  assert.equal(s.byPhase.approve.passed, 11);
  assert.equal(s.approveMetric.counted, 10);
  assert.equal(s.approveMetric.passed, 10);
  assert.equal(s.latency.samples, 12);
  assert.equal(s.latency.p50SinceOpenMs, 600);
  assert.equal(s.latency.p95SinceOpenMs, 1200);
  assert.equal(s.overallOk, false);
  assert.equal(percentile([], 0.5), null);
});

test('Markdown 摘要包含边界口径', () => {
  const md = renderSummaryMarkdown(summarize([
    { phase: 'approve', index: 1, ok: true, timings: { sinceChallengeOpenMs: 900, processMs: 2000 } },
  ]), {
    startedAt: '2026-11-21T00:00:00.000Z', port: 'COM12', confirmPort: 'COM11',
    device: 'ws63-B', actuatorDevice: 'ws63-A', pin: 12,
  });
  assert.match(md, /ACK≠开锁/);
  assert.match(md, /未装续流二极管/);
  assert.match(md, /P50 900 ms/);
});

test('编排：假 runner 按矩阵顺序执行并回调', async () => {
  const seen = [];
  const rounds = await runMatrix({
    matrix: buildMatrix({ approve: 2, cancel: 1 }),
    log: () => {},
    runner: async (item) => ({ phase: item.phase, index: item.index, ok: true }),
    onRound: (r) => seen.push(`${r.phase}#${r.index}`),
  });
  assert.deepEqual(rounds.map((r) => `${r.phase}#${r.index}`), ['approve#1', 'approve#2', 'cancel#1']);
  assert.deepEqual(seen, ['approve#1', 'approve#2', 'cancel#1']);
});
