'use strict';
// 评测续跑 key：repeat>1 时必须区分轮次，故障样本必须重跑
const test = require('node:test');
const assert = require('node:assert');
const { buildPriorRuns } = require('../eval/resume.cjs');

test('续跑 key：同一 case 的三轮分别保留，不互相覆盖', () => {
  const map = buildPriorRuns({
    runs: [
      { tier: 'full', caseId: 'V-N1', repeatIndex: 0, ok: true },
      { tier: 'full', caseId: 'V-N1', repeatIndex: 1, ok: true },
      { tier: 'full', caseId: 'V-N1', repeatIndex: 2, ok: true },
    ],
  });
  assert.equal(map.size, 3);
  assert.equal(map.get('full|V-N1|0').repeatIndex, 0);
  assert.equal(map.get('full|V-N1|1').repeatIndex, 1);
  assert.equal(map.get('full|V-N1|2').repeatIndex, 2);
});

test('续跑：故障样本全部跳过，其余保留', () => {
  const map = buildPriorRuns({
    runs: [
      { tier: 'full', caseId: 'V-A1', repeatIndex: 0 },
      { tier: 'full', caseId: 'V-A1', repeatIndex: 1, modelFault: '模型超时' },
      { tier: 'none', caseId: 'V-N1', repeatIndex: 2, modelFault: null },
    ],
  });
  assert.equal(map.size, 2);
  assert.equal(map.has('full|V-A1|1'), false);
  assert.equal(map.has('none|V-N1|2'), true);
});

test('续跑：旧格式没有 repeatIndex 时按第 0 轮处理', () => {
  const map = buildPriorRuns({ runs: [{ tier: 'none', caseId: 'V-N2' }] });
  assert.equal(map.size, 1);
  assert.equal(map.has('none|V-N2|0'), true);
  assert.equal(buildPriorRuns(null).size, 0);
});
