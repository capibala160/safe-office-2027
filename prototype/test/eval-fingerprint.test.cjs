'use strict';
// 评测续跑配置指纹：任一实验配置变化都必须换指纹
const test = require('node:test');
const assert = require('node:assert');
const { experimentFingerprint, promptFingerprint } = require('../eval/fingerprint.cjs');

const BASE = {
  modelName: 'glm-5.3-flash', llmKind: 'http', corpusVersion: '2026-10-17-v1',
  split: 'dev', tiers: ['full'], repeats: 1, ablation: [],
};

test('指纹：同配置稳定，任一关键项变化都不同', () => {
  const a = experimentFingerprint(BASE);
  assert.equal(a, experimentFingerprint({ ...BASE, tiers: ['full'] }));
  assert.notEqual(a, experimentFingerprint({ ...BASE, modelName: 'other' }));
  assert.notEqual(a, experimentFingerprint({ ...BASE, llmKind: 'mock' }));
  assert.notEqual(a, experimentFingerprint({ ...BASE, corpusVersion: 'v2' }));
  assert.notEqual(a, experimentFingerprint({ ...BASE, split: 'validation' }));
  assert.notEqual(a, experimentFingerprint({ ...BASE, tiers: ['none', 'full'] }));
  assert.notEqual(a, experimentFingerprint({ ...BASE, repeats: 2 }));
  assert.notEqual(a, experimentFingerprint({ ...BASE, ablation: ['gate4'] }));
});

test('指纹：包含提示词版本，提示词哈希是 64 位十六进制', () => {
  assert.match(promptFingerprint(), /^[0-9a-f]{64}$/);
});

test('指纹：尾延迟预算显式开档才变化，默认档保持旧指纹', () => {
  const base = experimentFingerprint(BASE);
  // 旧指纹常量（v0.55 及以前）：默认预算不得改变它，否则历史 partial 全部无法续跑
  assert.equal(base, '5a6e3b009537c84f5bd3d6343fb8ff31faddcd0e77964ff20847f3615a46823c');
  assert.equal(experimentFingerprint({ ...BASE, budget: {} }), base, '默认预算不得改变旧指纹');
  const lowGen = experimentFingerprint({ ...BASE, budget: { generateReasoningEffort: 'low' } });
  assert.notEqual(lowGen, base, '生成降档必须换指纹');
  assert.notEqual(
    lowGen,
    experimentFingerprint({ ...BASE, budget: { reasoningEffort: 'low' } }),
    '全局降档与仅生成降档必须是不同实验',
  );
  assert.equal(
    experimentFingerprint({ ...BASE, budget: { generateReasoningEffort: 'low', planMaxTokens: 0 } }),
    lowGen,
    '归一化后同配置指纹稳定',
  );
});
