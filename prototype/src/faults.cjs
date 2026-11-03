'use strict';
// ============================================================
// 统一模型故障分类（v0.7 · 04 报告 F-06 整改）
//   模型调用可能以多种方式失败：超时 / 网络故障 / HTTP 错误 /
//   返回非法 JSON / 返回空内容 / 未配置 / 越出模型边界。
//   运行时把这一切归一为固定类别 → 统一 fail-closed：
//   不执行任何步骤、审计留痕（含原始原因）、用户可见结果。
//   平台无关实现——上板时平移 ArkTS，分类规则不变。
// ============================================================

class ModelFault extends Error {
  /** @param {string} faultClass @param {string} reason */
  constructor(faultClass, reason) {
    super(`模型故障（${faultClass}）：${reason}`);
    this.name = 'ModelFault';
    this.faultClass = faultClass;
    this.faultReason = reason;
  }
}

// 分类优先级：已归类 > 明确语义（未配置/边界拒绝/HTTP/空响应）> 超时 > 非法JSON > 网络 > 未知
// 默认「未知故障」同样 fail-closed——宁可拒绝，不放过不确定。
/** @param {unknown} err @returns {{class:string, reason:string}} */
function classifyModelFault(err) {
  if (err instanceof ModelFault) return { class: err.faultClass, reason: err.faultReason };
  const e = /** @type {any} */ (err);
  const name = String((e && e.name) || '');
  const msg = String((e && e.message) || e || '未知错误');
  if (name === 'TimeoutError' || name === 'AbortError') return { class: '模型超时', reason: msg };
  if (/未配置/.test(msg)) return { class: '模型未配置', reason: msg };
  if (/模型边界拒绝/.test(msg)) return { class: '模型边界拒绝', reason: msg };
  if (/HTTP \d+/.test(msg)) return { class: '模型HTTP错误', reason: msg };
  if (/空内容|空响应/.test(msg)) return { class: '模型空响应', reason: msg };
  if (err instanceof SyntaxError || /合法 ?JSON|Unexpected token|JSON 解析/.test(msg)) {
    return { class: '模型非法JSON', reason: msg };
  }
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|socket|network/i.test(msg)) return { class: '模型网络故障', reason: msg };
  return { class: '未知故障', reason: msg };
}

/** @param {unknown} err @returns {ModelFault} */
function asModelFault(err) {
  const f = classifyModelFault(err);
  return new ModelFault(f.class, f.reason);
}

module.exports = { ModelFault, classifyModelFault, asModelFault };
