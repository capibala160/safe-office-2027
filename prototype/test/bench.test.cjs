'use strict';
// 压测 harness 冒烟：只验证统计结构与真实 HTTP 链路，不追求数字
const test = require('node:test');
const assert = require('node:assert/strict');
const { runBench } = require('../bench/load.cjs');

test('压测：读请求统计 p50/p95/p99、RPS、RSS', async () => {
  const result = await runBench({ concurrency: 2, requests: 6, scenario: 'read' });
  assert.equal(result.requests, 6);
  assert.equal(result.ok, 6);
  assert.equal(result.errors, 0);
  assert.ok(result.rps > 0);
  for (const key of ['mean', 'p50', 'p95', 'p99', 'max']) {
    assert.ok(Number.isFinite(result.latencyMs[key]), `${key} 必须是数字`);
    assert.ok(result.latencyMs[key] >= 0);
  }
  assert.ok(result.latencyMs.p50 <= result.latencyMs.p99);
  assert.ok(Number.isFinite(result.rssMb.delta));
});

test('压测：混合场景真的执行命令（生成操作记录）', async () => {
  const result = await runBench({ concurrency: 1, requests: 4, scenario: 'command' });
  assert.equal(result.ok, 4);
  assert.equal(result.errors, 0);
  assert.ok(result.latencyMs.max > 0);
});
