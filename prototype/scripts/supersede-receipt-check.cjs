'use strict';
// ============================================================
// 真板证据：旧挑战失效 → 收件人/附件前后对照 → 新版本确认 → 查回执
//
// 场景（两板：A 执行端接 PC 串口，B 确认端经 SLE 中继）：
//   1. 冻结一条带附件的外发操作，创建旧挑战并发到 B 板（OLED 显示旧收件人/附件数）
//   2. PC 撤销旧草稿 / 换收件人换附件 → 旧挑战在 PC 侧作废
//   3. 用户在 B 板按 KEY2：板端仍会回 APPROVED，但 PC 必须以“挑战已作废”拒绝，且不执行
//   4. 新建新版本（review@partner-example.com + 同名不同内容附件），B 板显示新摘要
//   5. 再按 KEY2：PC 批准并执行，outbox 回执可查；审计链校验通过
//
// 用法：
//   node scripts/supersede-receipt-check.cjs --port COM11 --device ws63-B
//   node scripts/supersede-receipt-check.cjs --port COM11 --json
//
// 交互：第一轮看到旧版本后先等 5 秒再按 KEY2（PC 已撤销，应被拒绝）；
//       第二轮看到新版本后短按 KEY2 批准。退出码 0 = 全部断言通过。
// ============================================================
const fs = require('node:fs');
const path = require('node:path');
const { ConsoleService } = require('../src/console-service.cjs');
const { createSerialNearfieldFactory } = require('../src/serial-nearfield.cjs');
const { resolveDeviceKey } = require('../src/device-keys.cjs');

const ROOT = path.join(__dirname, '..');

function arg(name, fallback) {
  const argv = process.argv.slice(2);
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith('--')) return argv[i + 1];
  return fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error(`${label}超时（${ms}ms）`), { code: 'TIMEOUT' })), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

function base64(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

function attachment(filename, text) {
  return { filename, mime: 'text/plain', contentBase64: base64(text) };
}

/** @param {any} operation */
function attachmentView(operation) {
  return (operation.attachments || []).map((a) => ({ name: a.name, size: a.size, sha256: a.sha256 }));
}

/**
 * 收件人、附件、正文/操作哈希的前后对照。
 * @param {any} oldOperation
 * @param {any} newOperation
 */
function buildComparison(oldOperation, newOperation) {
  const fromAttachments = attachmentView(oldOperation);
  const toAttachments = attachmentView(newOperation);
  return {
    operationIds: { from: oldOperation.operationId, to: newOperation.operationId },
    recipient: {
      from: oldOperation.recipient,
      to: newOperation.recipient,
      changed: oldOperation.recipient !== newOperation.recipient,
    },
    attachments: {
      from: fromAttachments,
      to: toAttachments,
      removed: fromAttachments.filter((a) => !toAttachments.some((b) => b.sha256 === a.sha256)),
      added: toAttachments.filter((b) => !fromAttachments.some((a) => a.sha256 === b.sha256)),
      nameReused: fromAttachments.some((a) => toAttachments.some((b) => b.name === a.name)),
    },
    bodyHash: {
      from: oldOperation.bodyHash,
      to: newOperation.bodyHash,
      changed: oldOperation.bodyHash !== newOperation.bodyHash,
    },
    operationHash: {
      from: oldOperation.operationHash,
      to: newOperation.operationHash,
      changed: oldOperation.operationHash !== newOperation.operationHash,
    },
  };
}

/**
 * @param {{
 *   oldChallengeState: string,
 *   oldOperationState: string,
 *   oldAttempt: any,
 *   comparison: any,
 *   newChallenge: any,
 *   newDecision: any,
 *   finalOperation: any,
 *   auditVerified: boolean,
 *   auditVoided: boolean,
 *   historyWithdrawn: boolean,
 * }} input
 */
function evaluateChecks(input) {
  const oldRejected = input.oldAttempt && input.oldAttempt.kind === 'rejected';
  const code = oldRejected ? input.oldAttempt.error && input.oldAttempt.error.code : null;
  return {
    oldChallengeExpired: input.oldChallengeState === 'expired',
    oldOperationRejected: input.oldOperationState === 'rejected',
    oldChallengeCannotApprove: oldRejected && code === 'CONFLICT',
    historyMarkedWithdrawn: !!input.historyWithdrawn,
    recipientChanged: !!input.comparison.recipient.changed,
    attachmentReplaced: input.comparison.attachments.removed.length === 1
      && input.comparison.attachments.added.length === 1
      && input.comparison.attachments.nameReused,
    newTargetHashMatches: input.newChallenge.targetHash === input.finalOperation.operationHash,
    newApproved: !!input.newDecision && input.newDecision.ok === true && input.newDecision.outcome === 'approved',
    executed: input.finalOperation.state === 'executed',
    outboxSent: !!(input.finalOperation.outbox && input.finalOperation.outbox.state === 'sent'),
    receiptPresent: !!(input.finalOperation.confirmationId
      && input.finalOperation.outbox && input.finalOperation.outbox.messageId),
    auditVerified: input.auditVerified === true,
    auditVoided: input.auditVoided === true,
  };
}

function pass(checks) {
  return Object.values(checks).every(Boolean);
}

function renderSummary(result) {
  const rows = [
    ['旧挑战失效', result.checks.oldChallengeExpired && result.checks.oldOperationRejected],
    ['旧挑战不能被批准（PC 拒绝）', result.checks.oldChallengeCannotApprove],
    ['收件人前后对照', result.checks.recipientChanged],
    ['同名附件替换（移除 + 加入）', result.checks.attachmentReplaced],
    ['新挑战目标哈希 = 新操作哈希', result.checks.newTargetHashMatches],
    ['新版本真板批准', result.checks.newApproved],
    ['执行完成 + outbox 已发送', result.checks.executed && result.checks.outboxSent],
    ['回执（confirmationId + messageId）', result.checks.receiptPresent],
    ['审计链校验', result.checks.auditVerified],
  ];
  const lines = ['| 项 | 结果 |', '|---|---|'];
  for (const [name, ok] of rows) lines.push(`| ${name} | ${ok ? 'PASS' : 'FAIL'} |`);
  lines.push('');
  lines.push(`收件人：${result.comparison.recipient.from} → ${result.comparison.recipient.to}`);
  lines.push(`附件：${result.comparison.attachments.from.map((a) => a.name).join('、') || '无'} → ` +
    `${result.comparison.attachments.to.map((a) => a.name).join('、') || '无'}`);
  for (const a of result.comparison.attachments.removed) lines.push(`- 已移除：${a.name} sha256=${a.sha256.slice(0, 12)}…`);
  for (const a of result.comparison.attachments.added) lines.push(`- 已加入：${a.name} sha256=${a.sha256.slice(0, 12)}…`);
  lines.push(`旧挑战：${result.old.challengeId.slice(0, 12)}…；旧操作：${result.old.operationId}`);
  lines.push(`新挑战：${result.new.challengeId.slice(0, 12)}…；新操作：${result.new.operationId}`);
  lines.push(`回执：confirmationId=${result.receipt.confirmationId} messageId=${result.receipt.messageId}`);
  return lines.join('\n');
}

async function main() {
  const asJson = process.argv.includes('--json');
  const portPath = String(arg('port', '')).trim();
  if (!portPath) throw Object.assign(new Error('缺少 --port（执行端 A 的串口，例如 COM11）'), { code: 'ARG' });
  const deviceLabel = String(arg('device', 'ws63-B')).trim();
  const { key } = resolveDeviceKey({ label: deviceLabel });

  const transportFactory = createSerialNearfieldFactory({
    portPath,
    logger: asJson ? null : (line) => console.log(line),
  });
  const service = new ConsoleService({
    nearfieldKey: key,
    deviceId: deviceLabel,
    deviceLabel: 'WS63 真板确认端',
    nearfieldTransportFactory: transportFactory,
    ttlSec: 60,
  });
  const log = (line) => { if (!asJson) console.log(line); };
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  let result = null;

  try {
    const sample = service.getDemoSamples().find((s) => s.id === 'external-confirm');
    if (!sample) throw new Error('样例 external-confirm 不存在');
    const oldRun = await service.runCommand({
      ...sample,
      role: sample.role,
      attachments: [attachment('agenda.txt', 'Agenda: initial draft')],
    });
    const oldOperation = oldRun.operations.find((o) => o.action === 'sendExternalEmail');
    if (!oldOperation) throw new Error('旧任务没有冻结外发操作');
    if (!(oldOperation.attachments || []).length) throw new Error('旧操作没有冻结附件');
    const oldChallenge = service.beginChallenge(oldOperation.operationId);

    log(`旧版本已冻结：${oldOperation.recipient}；附件 ${oldOperation.attachments.length} 个`);
    log(`旧挑战 ${oldChallenge.challengeId.slice(0, 12)}… 即将发到 B 板`);
    log('【第一轮】B 屏显示旧版本后请先等 5 秒，不要立刻按；PC 会自动撤销旧草稿。');

    const oldAttemptPromise = service.decideChallenge(oldChallenge.challengeId, 'approve').then(
      (value) => ({ kind: 'resolved', value }),
      (error) => ({ kind: 'rejected', error }),
    );
    await sleep(4000);
    const withdrawn = service.rejectOperation(oldOperation.operationId);
    log(`旧草稿已撤销：voidedChallenges=${withdrawn.voidedChallenges}，旧操作=${withdrawn.operation.state}`);
    log('【第一轮】现在短按 B 板 KEY2：板端会回 APPROVED，但 PC 必须拒绝且不执行。');

    let oldAttempt;
    try {
      oldAttempt = await withTimeout(oldAttemptPromise, 75000, '旧挑战批准等待');
    } catch (err) {
      oldAttempt = { kind: 'timeout', error: err };
      log(`旧挑战等待超时：${err.message}（请确认是否按了 KEY2）`);
    }
    const oldChallengeState = service.challenges.get(oldChallenge.challengeId).state;
    const oldOperationState = service.getOperation(oldOperation.operationId).operation.state;
    const historyWithdrawn = service.challengeHistory.some(
      (h) => h.challengeId === oldChallenge.challengeId && h.outcome === 'withdrawn',
    );

    const newRun = await service.runCommand({
      command: '把周例会纪要发给外部合作方 review@partner-example.com',
      role: '员工',
      tools: ['readDoc', 'sendExternalEmail'],
      documentIds: ['M2'],
      domains: ['partner-example.com'],
      attachments: [attachment('agenda.txt', 'Agenda: updated draft')],
    });
    const newOperation = newRun.operations.find((o) => o.action === 'sendExternalEmail');
    if (!newOperation) throw new Error('新任务没有冻结外发操作');
    const comparison = buildComparison(oldOperation, newOperation);
    if (!comparison.recipient.changed) throw new Error('新操作收件人未变化');
    if (!comparison.attachments.removed.length || !comparison.attachments.added.length) {
      throw new Error('新操作附件未形成替换对照');
    }
    const newChallenge = service.beginChallenge(newOperation.operationId);
    log(`新版本：${newOperation.recipient}；附件已替换；新挑战 ${newChallenge.challengeId.slice(0, 12)}…`);
    log('【第二轮】B 屏显示新版本后短按 KEY2 批准。');

    const newDecision = await withTimeout(
      service.decideChallenge(newChallenge.challengeId, 'approve'),
      80000,
      '新挑战批准等待',
    );
    const finalOperation = service.getOperation(newOperation.operationId).operation;
    const auditVoided = service.audit.entries.some(
      (e) => e.kind === '操作拒绝' && e.detail && e.detail.voidedChallenges === 1,
    );
    const checks = evaluateChecks({
      oldChallengeState,
      oldOperationState,
      oldAttempt,
      comparison,
      newChallenge,
      newDecision,
      finalOperation,
      auditVerified: service.audit.verify(),
      auditVoided,
      historyWithdrawn,
    });
    result = {
      generatedAt: new Date().toISOString(),
      port: portPath,
      device: deviceLabel,
      old: {
        operationId: oldOperation.operationId,
        recipient: oldOperation.recipient,
        attachments: attachmentView(oldOperation),
        challengeId: oldChallenge.challengeId,
        challengeState: oldChallengeState,
        operationState: oldOperationState,
        withdrawn,
        attempt: oldAttempt.kind === 'rejected'
          ? { kind: 'rejected', code: oldAttempt.error && oldAttempt.error.code, message: oldAttempt.error && oldAttempt.error.message }
          : { kind: oldAttempt.kind },
      },
      comparison,
      new: {
        operationId: newOperation.operationId,
        recipient: newOperation.recipient,
        attachments: attachmentView(newOperation),
        challengeId: newChallenge.challengeId,
        targetHash: newChallenge.targetHash,
        decision: { ok: newDecision.ok, outcome: newDecision.outcome, code: newDecision.code || null },
      },
      receipt: {
        confirmationId: finalOperation.confirmationId,
        messageId: finalOperation.outbox && finalOperation.outbox.messageId,
        outboxState: finalOperation.outbox && finalOperation.outbox.state,
        operationState: finalOperation.state,
      },
      audit: {
        verified: service.audit.verify(),
        entries: service.audit.entries.length,
        head: service.audit.entries.length ? service.audit.entries[service.audit.entries.length - 1].hash : null,
      },
      checks,
      ok: pass(checks),
    };

    const outDir = path.join(ROOT, 'out');
    fs.mkdirSync(outDir, { recursive: true });
    const base = path.join(outDir, `supersede-receipt-${stamp}`);
    fs.writeFileSync(`${base}.json`, `${JSON.stringify(result, null, 2)}\n`);
    fs.writeFileSync(`${base}.md`, `${renderSummary(result)}\n`);
    if (asJson) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log('');
      console.log(renderSummary(result));
      console.log('');
      console.log(`证据：${base}.json / ${base}.md`);
    }
    return result.ok ? 0 : 1;
  } finally {
    try { service.close(); } catch { /* ignore */ }
    try { await transportFactory.close(); } catch { /* ignore */ }
  }
}

if (require.main === module) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
      console.error(err && err.message ? err.message : String(err));
      process.exitCode = err && err.code === 'ARG' ? 2 : 1;
    });
}

module.exports = {
  attachment, attachmentView, buildComparison, evaluateChecks, pass, renderSummary,
};
