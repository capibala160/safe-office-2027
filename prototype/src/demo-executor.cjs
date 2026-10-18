'use strict';
// ============================================================
// 演示执行器（v0.12）
//   邮件走 FakeMailer；删除/打印/设备只记录业务动作，不触达真实系统。
//   满足 FulfillmentService 的 mailer 契约：send({operation, idempotencyKey})
//   以 operationHash 做内存幂等，重复调用返回同一结果。
// ============================================================
const { FakeMailer } = require('./mailer.cjs');

class DemoExecutor {
  constructor({ mailer = new FakeMailer(), now = () => Date.now(), onBusinessAction = null } = {}) {
    this.mailer = mailer;
    this.now = now;
    this.onBusinessAction = onBusinessAction;
    this.actions = [];
    this.results = new Map();
  }

  async send({ operation, idempotencyKey }) {
    if (!operation || typeof operation !== 'object') throw new TypeError('缺少操作记录');
    const key = idempotencyKey || operation.operationHash;
    if (this.results.has(key)) return this.results.get(key);

    let result;
    if (operation.protocolAction === 1) {
      result = await this.mailer.send({ operation, idempotencyKey: key });
    } else {
      const record = {
        at: new Date(this.now()).toISOString(),
        operationId: operation.operationId,
        protocolAction: operation.protocolAction,
        action: operation.action,
        recipient: operation.recipient,
        subject: operation.subject,
      };
      this.actions.push(record);
      if (typeof this.onBusinessAction === 'function') {
        await this.onBusinessAction({ operation, idempotencyKey: key, record });
      }
      result = { status: 'sent', messageId: `demo-${operation.protocolAction}-${this.actions.length}` };
    }
    this.results.set(key, result);
    return result;
  }

  reset() {
    this.actions = [];
    this.results.clear();
  }
}

module.exports = { DemoExecutor };
