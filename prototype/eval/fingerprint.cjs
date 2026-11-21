'use strict';
// 评测配置指纹：续跑只能复用“同模型、同提示词、同语料、同档位/轮数/消融层”的旧样本。
// 任一变化 → 指纹不同 → 忽略旧结果，避免把不同实验混在一起。
const crypto = require('node:crypto');
const { PLAN_SYSTEM_PROMPT } = require('../src/llm.cjs');

function promptFingerprint() {
  return crypto.createHash('sha256').update(PLAN_SYSTEM_PROMPT).digest('hex');
}

// 尾延迟预算归一化：默认（全空/0）不进指纹，保持旧实验可续跑；
// 一旦显式开档，指纹必须变化，避免把不同预算的实验混在一起续跑。
function normalizeBudget(budget = {}) {
  return {
    reasoningEffort: budget.reasoningEffort || null,
    planReasoningEffort: budget.planReasoningEffort || null,
    generateReasoningEffort: budget.generateReasoningEffort || null,
    planMaxTokens: Number(budget.planMaxTokens) || 0,
    generateMaxTokens: Number(budget.generateMaxTokens) || 0,
  };
}

function isDefaultBudget(normalized) {
  return normalized.reasoningEffort === null
    && normalized.planReasoningEffort === null
    && normalized.generateReasoningEffort === null
    && normalized.planMaxTokens === 0
    && normalized.generateMaxTokens === 0;
}

function experimentFingerprint({
  modelName = '', llmKind = '', corpusVersion = '', split = 'all',
  tiers = [], repeats = 1, ablation = [], budget = {},
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
  const normalized = normalizeBudget(budget);
  if (!isDefaultBudget(normalized)) payload.budget = normalized;
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

module.exports = { experimentFingerprint, promptFingerprint };
