'use strict';
// 旧挑战失效 → 收件人/附件对照 → 新版本确认 → 回执：纯逻辑测试（不接真板）
const test = require('node:test');
const assert = require('node:assert');
const {
  attachment, attachmentView, buildComparison, evaluateChecks, pass, renderSummary,
} = require('../scripts/supersede-receipt-check.cjs');

const oldOp = {
  operationId: 'OP-old',
  recipient: 'partner@partner-example.com',
  bodyHash: 'body-old',
  operationHash: 'hash-old',
  attachments: [{ name: 'agenda.txt', size: 10, sha256: 'sha-old' }],
};
const newOp = {
  operationId: 'OP-new',
  recipient: 'review@partner-example.com',
  bodyHash: 'body-new',
  operationHash: 'hash-new',
  attachments: [{ name: 'agenda.txt', size: 20, sha256: 'sha-new' }],
};

test('附件构造：文件名/mime/base64 往返', () => {
  const item = attachment('agenda.txt', 'Agenda: initial draft');
  assert.equal(item.filename, 'agenda.txt');
  assert.equal(item.mime, 'text/plain');
  assert.equal(Buffer.from(item.contentBase64, 'base64').toString('utf8'), 'Agenda: initial draft');
});

test('前后对照：收件人变化 + 同名附件移除/加入 + 双哈希变化', () => {
  const c = buildComparison(oldOp, newOp);
  assert.equal(c.recipient.changed, true);
  assert.equal(c.recipient.from, 'partner@partner-example.com');
  assert.equal(c.recipient.to, 'review@partner-example.com');
  assert.equal(c.attachments.nameReused, true);
  assert.equal(c.attachments.removed.length, 1);
  assert.equal(c.attachments.added.length, 1);
  assert.equal(c.attachments.removed[0].sha256, 'sha-old');
  assert.equal(c.attachments.added[0].sha256, 'sha-new');
  assert.equal(c.bodyHash.changed, true);
  assert.equal(c.operationHash.changed, true);
  assert.deepEqual(attachmentView(oldOp), [{ name: 'agenda.txt', size: 10, sha256: 'sha-old' }]);
});

test('旧挑战被 PC 拒绝：全部断言通过', () => {
  const checks = evaluateChecks({
    oldChallengeState: 'expired',
    oldOperationState: 'rejected',
    oldAttempt: { kind: 'rejected', error: { code: 'CONFLICT', message: '挑战已作废，请检查当前任务状态' } },
    comparison: buildComparison(oldOp, newOp),
    newChallenge: { targetHash: 'hash-new' },
    newDecision: { ok: true, outcome: 'approved' },
    finalOperation: {
      operationHash: 'hash-new', state: 'executed', confirmationId: 'ws63-abc',
      outbox: { state: 'sent', messageId: '<msg@example.com>' },
    },
    auditVerified: true,
    auditVoided: true,
    historyWithdrawn: true,
  });
  assert.equal(pass(checks), true);
  const md = renderSummary({
    checks, comparison: buildComparison(oldOp, newOp),
    old: { challengeId: 'old-challenge', operationId: 'OP-old' },
    new: { challengeId: 'new-challenge', operationId: 'OP-new' },
    receipt: { confirmationId: 'ws63-abc', messageId: '<msg@example.com>' },
  });
  assert.match(md, /旧挑战失效 \| PASS/);
  assert.match(md, /已移除：agenda\.txt/);
  assert.match(md, /已加入：agenda\.txt/);
});

test('旧挑战被提前批准（resolved）→ 失败，不能算作失效演示', () => {
  const checks = evaluateChecks({
    oldChallengeState: 'approved',
    oldOperationState: 'executed',
    oldAttempt: { kind: 'resolved', value: { ok: true, outcome: 'approved' } },
    comparison: buildComparison(oldOp, newOp),
    newChallenge: { targetHash: 'hash-new' },
    newDecision: { ok: true, outcome: 'approved' },
    finalOperation: { operationHash: 'hash-new', state: 'executed', confirmationId: 'x', outbox: { state: 'sent', messageId: 'm' } },
    auditVerified: true,
    auditVoided: false,
    historyWithdrawn: false,
  });
  assert.equal(checks.oldChallengeCannotApprove, false);
  assert.equal(checks.oldChallengeExpired, false);
  assert.equal(checks.oldOperationRejected, false);
  assert.equal(pass(checks), false);
});

test('收件人未变或附件未替换 → 对照断言失败', () => {
  const same = { ...newOp, recipient: oldOp.recipient, attachments: oldOp.attachments };
  const checks = evaluateChecks({
    oldChallengeState: 'expired',
    oldOperationState: 'rejected',
    oldAttempt: { kind: 'rejected', error: { code: 'CONFLICT' } },
    comparison: buildComparison(oldOp, same),
    newChallenge: { targetHash: 'hash-new' },
    newDecision: { ok: true, outcome: 'approved' },
    finalOperation: { operationHash: 'hash-new', state: 'executed', confirmationId: 'x', outbox: { state: 'sent', messageId: 'm' } },
    auditVerified: true,
    auditVoided: true,
    historyWithdrawn: true,
  });
  assert.equal(checks.recipientChanged, false);
  assert.equal(checks.attachmentReplaced, false);
  assert.equal(pass(checks), false);
});

test('回执缺失或审计失败 → 整体失败', () => {
  const checks = evaluateChecks({
    oldChallengeState: 'expired',
    oldOperationState: 'rejected',
    oldAttempt: { kind: 'rejected', error: { code: 'CONFLICT' } },
    comparison: buildComparison(oldOp, newOp),
    newChallenge: { targetHash: 'hash-new' },
    newDecision: { ok: true, outcome: 'approved' },
    finalOperation: { operationHash: 'hash-new', state: 'executed', confirmationId: null, outbox: { state: 'sent', messageId: null } },
    auditVerified: false,
    auditVoided: false,
    historyWithdrawn: false,
  });
  assert.equal(checks.receiptPresent, false);
  assert.equal(checks.auditVerified, false);
  assert.equal(checks.auditVoided, false);
  assert.equal(checks.historyMarkedWithdrawn, false);
  assert.equal(pass(checks), false);
});
