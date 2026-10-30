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
