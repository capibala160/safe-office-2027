'use strict';
// ============================================================
// 确认 → 执行 → 留档 的最小闭环（v0.10）
//   prepare：冻结最终操作记录并入库
//   confirm：核对确认方提交的 operationHash，状态 frozen→confirmed，入 outbox
//   send：执行前再次校验记录；超时/网络中断 → unknown，禁止自动重试
//   reconcile：人工核对 unknown → sent/failed
// 边界：确认适配器（模拟/WS63）只负责"谁确认了哪个哈希"；
//       本服务不声称外部邮件服务只执行一次。
// ============================================================
const { sealOperation, verifyOperation } = require('./operation.cjs');
const { MailerError } = require('./mailer.cjs');

class FulfillmentService {
  constructor({ store, mailer, now = () => Date.now() } = {}) {
    if (!store) throw new TypeError('FulfillmentService 需要 store');
    if (!mailer) throw new TypeError('FulfillmentService 需要 mailer');
    this.store = store;
    this.mailer = mailer;
    this.now = now;
  }

  prepare(input) {
    const sealed = sealOperation(input);
    return this.store.insertOperation(sealed);
  }

  confirm(operationId, { confirmationId = null, deviceId = null, confirmedHash } = {}) {
    const operation = this.store.getOperation(operationId);
    if (!operation) throw new Error(`操作不存在：${operationId}`);
    if (operation.state !== 'frozen') throw new Error(`操作状态 ${operation.state} 不能确认`);
    if (Date.parse(operation.expiresAt) <= this.now()) {
      this.store.setOperationState(operationId, 'expired');
      throw new Error('操作已过期，必须重新生成');
    }
    const check = verifyOperation(operation);
    if (!check.ok) throw new Error(`冻结记录校验失败：${check.reason}`);
    if (typeof confirmedHash !== 'string' || confirmedHash.toLowerCase() !== operation.operationHash.toLowerCase()) {
      throw new Error('确认哈希与冻结记录不一致，拒绝确认');
    }
    const confirmed = this.store.setOperationState(operationId, 'confirmed', { confirmationId, deviceId });
    const outbox = this.store.enqueueOutbox(confirmed);
    return { operation: confirmed, outbox };
  }

  async send(outboxId) {
    const row = this.store.getOutbox(outboxId);
    if (!row) throw new Error(`发件记录不存在：${outboxId}`);
    if (row.state === 'sent') {
      return { state: 'sent', messageId: row.messageId, duplicate: true };
    }
    if (row.state === 'unknown') {
      return { state: 'unknown', messageId: row.messageId, error: row.lastError, note: '结果待核实，禁止自动重试' };
    }
    if (row.state === 'sending') {
      return { state: 'sending', note: '发送中，请勿重复调用' };
    }
    if (row.state === 'failed') {
      return { state: 'failed', error: row.lastError, note: '明确失败；如需重试请新建操作记录' };
    }

    const operation = this.store.getOperation(row.operationId);
    if (!operation) throw new Error(`操作不存在：${row.operationId}`);
    if (Date.parse(operation.expiresAt) <= this.now()) {
      this.store.setOutboxState(row.outboxId, 'failed', { error: '操作已过期' });
      this.store.setOperationState(operation.operationId, 'expired');
      return { state: 'failed', error: '操作已过期' };
    }
    const check = verifyOperation(operation);
    if (!check.ok) {
      this.store.setOutboxState(row.outboxId, 'failed', { error: `冻结记录校验失败：${check.reason}` });
      this.store.setOperationState(operation.operationId, 'failed', { result: { reason: check.reason } });
      return { state: 'failed', error: check.reason };
    }

    this.store.setOutboxState(row.outboxId, 'sending', { incrementAttempts: true });
    this.store.setOperationState(operation.operationId, 'executing');
    try {
      const result = await this.mailer.send({ operation, idempotencyKey: row.idempotencyKey });
      this.store.setOutboxState(row.outboxId, 'sent', { messageId: result.messageId || null });
      this.store.setOperationState(operation.operationId, 'executed', {
        result: { messageId: result.messageId || null },
      });
      return { state: 'sent', messageId: result.messageId || null };
    } catch (err) {
      const kind = err instanceof MailerError ? err.kind : 'unknown';
      const state = kind === 'rejected' ? 'failed' : 'unknown';
      this.store.setOutboxState(row.outboxId, state, { error: err.message });
      if (state === 'failed') {
        this.store.setOperationState(operation.operationId, 'failed', {
          result: { error: err.message, kind },
        });
      }
      // unknown：操作保持 executing，等待人工核对，绝不自动重试
      return {
        state,
        error: err.message,
        note: state === 'unknown' ? '结果待核实，禁止自动重试' : '明确失败；如需重试请新建操作记录',
      };
    }
  }

  // v0.35 退信登记：按原始 Message-ID 找到发件记录，sent/unknown → bounced。
  //   - 只改本地状态，绝不自动重发（重发必须新建操作并重新确认）
  //   - 重复导入同一封退信是幂等操作
  //   - 已 failed/bounced 的记录不再处理，由上层如实报告跳过原因
  recordBounce({
    messageId = null, idempotencyKey = null,
    recipient = null, status = '', diagnostic = '', note = '',
  } = {}) {
    const id = String(messageId || '').trim();
    const key = String(idempotencyKey || '').trim().toLowerCase();
    if (!id && !key) {
      return { matched: false, reason: '退信既没有 Message-ID 也没有幂等键' };
    }
    let rows = id ? this.store.listOutboxByMessageId(id) : [];
    let matchedBy = rows.length > 0 ? 'messageId' : null;
    // 回退：MTA 改写 Message-ID 时，用发信时写入的 X-Idempotency-Key 匹配
    if (rows.length === 0 && key) {
      rows = this.store.listOutboxByIdempotencyKey(key);
      matchedBy = rows.length > 0 ? 'idempotencyKey' : null;
    }
    if (rows.length === 0) {
      return { matched: false, reason: '未找到对应发件记录（Message-ID / 幂等键均未命中）' };
    }
    if (rows.length > 1) {
      return { matched: false, reason: '同一匹配键命中多条发件记录，拒绝自动回填' };
    }
    const row = rows[0];
    if (row.state === 'bounced') {
      return { matched: true, duplicate: true, outbox: row, matchedBy, reason: '该发件记录已登记过退信' };
    }
    if (row.state !== 'sent') {
      const reason = row.state === 'unknown'
        ? '发件记录为待核实（无服务端 Message-ID），请先人工核对为已发送'
        : `发件记录状态 ${row.state} 不接受退信`;
      return { matched: true, skipped: true, outbox: row, reason };
    }
    const summary = [
      '投递退信',
      recipient ? `收件人 ${recipient}` : '',
      status ? `状态 ${status}` : '',
      diagnostic || '',
      note || '',
    ].filter(Boolean).join('；');
    const updated = this.store.setOutboxState(row.outboxId, 'bounced', { error: summary });
    const operation = this.store.getOperation(row.operationId);
    // unknown 的发件记录对应操作还停在 executing：退信证明投递曾发生，落 executed 并留结果
    if (operation && operation.state === 'executing') {
      this.store.setOperationState(operation.operationId, 'executed', {
        result: { bounced: true, recipient, status, diagnostic, messageId: id },
      });
    }
    return {
      matched: true,
      matchedBy,
      outbox: updated,
      operation: operation ? this.store.getOperation(operation.operationId) : null,
      previousState: row.state,
    };
  }

  // 人工核对后消除 unknown；只允许 unknown → sent/failed
  reconcile(outboxId, { state, messageId = null, note = '' } = {}) {
    const row = this.store.getOutbox(outboxId);
    if (!row) throw new Error(`发件记录不存在：${outboxId}`);
    if (row.state !== 'unknown') throw new Error('只有 unknown 状态需要人工核对');
    if (state !== 'sent' && state !== 'failed') throw new Error('reconcile 只接受 sent/failed');
    this.store.setOutboxState(outboxId, state, {
      messageId,
      error: state === 'failed' ? (note || '人工核对为失败') : null,
    });
    const operation = this.store.getOperation(row.operationId);
    if (state === 'sent' && operation.state === 'executing') {
      this.store.setOperationState(operation.operationId, 'executed', { result: { messageId, note } });
    }
    if (state === 'failed' && operation.state === 'executing') {
      this.store.setOperationState(operation.operationId, 'failed', { result: { note } });
    }
    return this.store.getOutbox(outboxId);
  }

  // 进程重启后调用：sending 的结果未知，统一转 unknown，等待人工核对
  recoverInFlight() {
    let count = 0;
    for (const row of this.store.listOutbox()) {
      if (row.state === 'sending') {
        const operation = this.store.getOperation(row.operationId);
        if (operation && operation.state === 'confirmed') {
          this.store.setOperationState(operation.operationId, 'executing');
        }
        this.store.setOutboxState(row.outboxId, 'unknown', { error: '进程中断，结果待核实' });
        count += 1;
      }
    }
    return count;
  }
}

module.exports = { FulfillmentService };
