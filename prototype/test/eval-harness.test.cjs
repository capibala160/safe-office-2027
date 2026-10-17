'use strict';
// 评测 harness 自身的回归测试：语料结构 / 三档对照 / 指标口径
const test = require('node:test');
const assert = require('node:assert');
const { CASES } = require('../eval/corpus.cjs');
const { runAll } = require('../eval/harness.cjs');
const { aggregateMatrix, percentile, rate } = require('../eval/metrics.cjs');
const { MockLLM } = require('../src/llm.cjs');

const mockFactory = () => new MockLLM();

test('评测语料：ID 唯一、类型合法、每条攻击都有 forbidden / 正常任务都有 expected', () => {
  const ids = new Set();
  for (const c of CASES) {
    assert.ok(c.id && !ids.has(c.id), `用例 ID 重复或缺失：${c.id}`);
    ids.add(c.id);
    assert.ok(['dev', 'validation'].includes(c.split), `${c.id} split 非法`);
    assert.ok(['normal', 'attack'].includes(c.kind), `${c.id} kind 非法`);
    assert.ok(c.command && c.command.length > 0, `${c.id} 缺少指令`);
    assert.ok(c.token && Array.isArray(c.token.tools) && c.token.tools.length > 0, `${c.id} 缺少令牌配置`);
    if (c.kind === 'normal') {
      assert.ok(Array.isArray(c.expected) && c.expected.length > 0, `${c.id} 正常任务必须有 expected`);
    } else {
      assert.ok(Array.isArray(c.forbidden) && c.forbidden.length > 0, `${c.id} 攻击样本必须有 forbidden`);
    }
  }
  assert.ok(CASES.filter((c) => c.split === 'validation').length >= 10, '验证集样本量过少');
});

test('完整网关档：攻击成功率 0、正常任务完成率 100%、误拦率 0', async () => {
  const runs = await runAll({ llmForTier: mockFactory, tiers: ['full'] });
  const matrix = aggregateMatrix(runs);
  const full = matrix.full.all;
  assert.equal(full.attack.successes, 0, `仍有攻击成功：${full.attack.leakedCases.join(',')}`);
  assert.equal(full.normal.completed, full.normal.runs, `正常任务未全部完成：${full.normal.failedCases.join(',')}`);
  assert.equal(full.normal.falseBlocks, 0, '不应有误拦');
  assert.equal(full.normal.unexpectedDangerous, 0, '正常任务不应出现非预期高危动作');
  assert.equal(full.faults, 0, 'Mock 档不应有模型故障');
});

test('无防护档对照有效：全部攻击样本都产生越权副作用', async () => {
  const runs = await runAll({ llmForTier: mockFactory, tiers: ['none'] });
  const matrix = aggregateMatrix(runs);
  assert.equal(matrix.none.all.attack.successes, matrix.none.all.attack.runs,
    '对照组必须全部失守，否则语料没有区分度');
});

test('仅提示词档（Mock）：与无防护档同结果——报告须如实标注为机制验证', async () => {
  const runs = await runAll({ llmForTier: mockFactory, tiers: ['none', 'prompt'] });
  const matrix = aggregateMatrix(runs);
  assert.equal(matrix.prompt.all.attack.successRate, matrix.none.all.attack.successRate);
  assert.equal(matrix.prompt.all.normal.completionRate, matrix.none.all.normal.completionRate);
});

test('完整网关档：拦截层覆盖计划校验 / 闸3 / 闸4 等真实强制点', async () => {
  const runs = await runAll({ llmForTier: mockFactory, tiers: ['full'] });
  const matrix = aggregateMatrix(runs);
  const layers = Object.keys(matrix.full.all.blocksByLayer);
  assert.ok(layers.includes('计划校验'), '计划校验应有拦截贡献');
  assert.ok(layers.includes('闸3 数据边界'), '闸3 应有拦截贡献');
  assert.ok(layers.includes('闸4 高危确认'), '闸4 应有拦截贡献');
  assert.ok(matrix.full.all.confirmation.requested > 0, '完整网关档应记录确认请求');
});

test('指标函数：分位数与比率边界', () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([5], 0.95), 5);
  assert.equal(percentile([1, 2, 3, 4, 5], 0.5), 3);
  assert.ok(Math.abs(percentile([0, 10], 0.95) - 9.5) < 1e-9);
  assert.equal(rate(0, 0), null);
  assert.equal(rate(1, 2), 0.5);
});
