'use strict';
// 评测配置指纹：续跑只能复用“同模型、同提示词、同语料、同档位/轮数/消融层”的旧样本。
// 任一变化 → 指纹不同 → 忽略旧结果，避免把不同实验混在一起。
const crypto = require('node:crypto');
const { PLAN_SYSTEM_PROMPT } = require('../src/llm.cjs');

function promptFingerprint() {
  return crypto.createHash('sha256').update(PLAN_SYSTEM_PROMPT).digest('hex');
}

function experimentFingerprint({
  modelName = '', llmKind = '', corpusVersion = '', split = 'all',
  tiers = [], repeats = 1, ablation = [],
} = {}) {
  const payload = {
    modelName,
    llmKind,
    corpusVersion,
    split,
    tiers: [...tiers].map(String).sort(),
    repeats: Number(repeats) || 1,
    ablation: [...(ablation || [])].map(String).sort(),
    prompt: promptFingerprint(),
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

module.exports = { experimentFingerprint, promptFingerprint };
