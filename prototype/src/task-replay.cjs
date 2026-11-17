'use strict';
// ============================================================
// 任务证据回放（2026-11-17）
//   把一次运行的「要求 → 计划 → 闸/风险 → 批准 → 实际调用 → 回执」拼成一条时间线，
//   并给出证据完整性（审计链、冻结记录校验、附件是否还在）。
//
//   只读视图：不修改审计/操作/发送记录；没有数据就留空，不补造。
//   边界：
//   - 计划阶段只展示运行记录里的 planHash/modelId，不保存原始计划文本；
//   - 批准只有 operationHash/confirmationId/deviceId，不保存板端原始帧；
//   - 回执以 outbox 状态为准（sent 只证明服务端已发，不等于对方已读）。
// ============================================================

const GATE_KINDS = new Set([
  '闸1触发', '闸2拒绝', '闸3拒绝', '闸3脱敏', '闸5拒绝', '闸5脱敏',
  '策略拒绝', '沙箱拒绝', '计划校验', '风险冻结', '风险', '委托',
  'Agent拒绝', '数据访问拒绝', '来源闭包拒绝', '附件来源检查', '附件来源拒绝',
  '规划拒绝', '规划失败', '生成拒绝', '生成失败', '确认', '待确认',
]);

/**
 * @typedef {object} ReplayInput
 * @property {any} run 控制台 run 记录（command/role/tools/audit/at/risk…）
 * @property {any[]} auditEntries 该 run 的审计切片
 * @property {any[]} operations 该 run 的操作（含 operationId/planHash/state…）
 * @property {(operationId: string) => any} outboxByOperation
 * @property {(operation: any) => {ok: boolean, reason?: string}} verifyOperation
 */

/**
 * @param {ReplayInput} input
 */
function buildTaskReplay({ run, auditEntries, operations, outboxByOperation, verifyOperation }) {
  if (!run || typeof run !== 'object') throw new TypeError('缺少 run 记录');
  const entries = Array.isArray(auditEntries) ? auditEntries : [];
  const ops = Array.isArray(operations) ? operations : [];

  const gates = entries
    .filter((e) => e && GATE_KINDS.has(e.kind))
    .map((e) => ({ seq: e.seq, at: e.ts, kind: e.kind, detail: e.detail }));

  const calls = entries
    .filter((e) => e && e.kind === '执行')
    .map((e) => ({ seq: e.seq, at: e.ts, n: e.detail && e.detail.n, action: e.detail && e.detail.action, outcome: e.detail && e.detail.outcome }));

  const approvals = ops.map((op) => {
    const box = typeof outboxByOperation === 'function' ? outboxByOperation(op.operationId) : null;
    return {
      operationId: op.operationId,
      action: op.action,
      recipient: op.recipient,
      level: op.level,
      state: op.state,
      operationHash: op.operationHash,
      confirmationId: op.confirmationId || null,
      deviceId: op.deviceId || null,
      planHash: op.planHash || null,
      modelId: op.modelId || null,
      expiresAt: op.expiresAt,
      receipt: box ? {
        state: box.state,
        messageId: box.messageId || null,
        lastError: box.lastError || null,
        note: box.note || null,
      } : null,
    };
  });

  const warnings = [];
  /** @type {{operationId: string, ok: boolean, reason?: string}[]} */
  const operationIntegrity = [];
  for (const op of ops) {
    let check;
    try {
      check = verifyOperation(op);
    } catch (errRaw) {
      const err = /** @type {any} */ (errRaw);
      check = { ok: false, reason: err && err.message ? err.message : String(err) };
    }
    operationIntegrity.push({ operationId: op.operationId, ok: Boolean(check.ok), reason: check.ok ? undefined : check.reason });
    if (!check.ok) warnings.push(`操作 ${op.operationId.slice(0, 8)}… 冻结记录校验失败：${check.reason}`);
  }
  const integrity = {
    auditVerified: Boolean(run.audit && run.audit.verified),
    auditRange: run.audit ? { from: run.audit.from, to: run.audit.to, count: run.audit.count } : null,
    operations: operationIntegrity,
  };
  if (!integrity.auditVerified) warnings.push('审计链校验未通过：回放条目可能被篡改或缺失');
  for (const approval of approvals) {
    if (approval.receipt && approval.receipt.state === 'unknown') {
      warnings.push(`操作 ${approval.operationId.slice(0, 8)}… 发送结果未知（禁止自动重试，需人工核对）`);
    }
  }

  return {
    runId: run.runId,
    at: run.at,
    command: run.command,
    role: run.role,
    operator: run.operator || null,
    tools: run.tools || [],
    documents: run.documentIds || [],
    risk: run.risk || null,
    gates,
    calls,
    approvals,
    integrity,
    warnings,
  };
}

/** @param {ReturnType<typeof buildTaskReplay>} replay @returns {string[]} */
function renderTaskReplay(replay) {
  const lines = [];
  lines.push(`任务回放 ${replay.runId}（${replay.at}｜${replay.role}${replay.operator ? `/${replay.operator}` : ''}）`);
  lines.push(`要求：${replay.command}`);
  lines.push(`工具：${(replay.tools || []).join('、') || '(无)'}；文档：${(replay.documents || []).join('、') || '(无)'}`);
  if (replay.risk) lines.push(`风险：${replay.risk.score}/${replay.risk.threshold}${replay.risk.frozen ? '（已冻结）' : ''}`);

  lines.push('— 计划/批准/实际调用 —');
  for (const approval of replay.approvals) {
    lines.push(`批准 ${approval.operationId.slice(0, 8)}… ${approval.action} → ${approval.recipient}｜级=${approval.level}｜状态=${approval.state}`);
    lines.push(`  hash=${String(approval.operationHash || '').slice(0, 12)}…｜确认=${approval.confirmationId || '(无)'}｜设备=${approval.deviceId || '(无)'}`);
    if (approval.receipt) {
      lines.push(`  回执：state=${approval.receipt.state}${approval.receipt.messageId ? ` messageId=${approval.receipt.messageId}` : ''}${approval.receipt.lastError ? ` error=${approval.receipt.lastError}` : ''}`);
    } else {
      lines.push('  回执：(未发送)');
    }
  }
  for (const call of replay.calls) {
    lines.push(`  [${call.n}] ${call.action} → ${String(call.outcome || '').slice(0, 80)}`);
  }
  if (replay.calls.length === 0) lines.push('  (没有执行记录)');

  if (replay.gates.length > 0) {
    lines.push('— 闸/风险事件 —');
    for (const gate of replay.gates.slice(0, 20)) {
      lines.push(`  #${gate.seq} ${gate.kind}：${JSON.stringify(gate.detail).slice(0, 120)}`);
    }
  }

  lines.push('— 证据完整性 —');
  lines.push(`  审计链：${replay.integrity.auditVerified ? '✅ 通过' : '❌ 未通过'}`);
  for (const op of replay.integrity.operations) {
    lines.push(`  操作 ${op.operationId.slice(0, 8)}…：${op.ok ? '✅ 冻结记录一致' : `❌ ${op.reason}`}`);
  }
  if (replay.warnings.length > 0) {
    lines.push('— 警告 —');
    for (const warning of replay.warnings) lines.push(`  ⚠️ ${warning}`);
  }
  return lines;
}

module.exports = { buildTaskReplay, renderTaskReplay, GATE_KINDS };
