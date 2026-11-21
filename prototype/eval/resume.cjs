'use strict';
// ============================================================
// 评测续跑：从 eval-partial.json 复用“已完成且无故障”的样本
//   key 必须带 repeatIndex —— repeat>1 时同一 case 有多轮，不能互相覆盖
//   故障样本（modelFault）一律重跑，避免把噪声当结论
// ============================================================

/**
 * @param {{ runs?: any[] } | null | undefined} prior
 * @returns {Map<string, any>}
 */
function buildPriorRuns(prior) {
  const map = new Map();
  for (const row of (prior && prior.runs) || []) {
    if (!row || row.modelFault) continue;
    map.set(`${row.tier}|${row.caseId}|${row.repeatIndex ?? 0}`, row);
  }
  return map;
}

module.exports = { buildPriorRuns };
