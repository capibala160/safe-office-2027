'use strict';
// ============================================================
// 演示执行器（v0.12）
//   邮件走 FakeMailer；删除/打印/设备只记录业务动作，不触达真实系统。
//   满足 FulfillmentService 的 mailer 契约：send({operation, idempotencyKey})
//   以 operationHash 做内存幂等，重复调用返回同一结果。
// ============================================================
const { FakeMailer, MailerError } = require('./mailer.cjs');

class DemoExecutor {
  constructor({ mailer = new FakeMailer(), now = () => Date.now(), onBusinessAction = null, attachmentLoader = null } = {}) {
    this.mailer = mailer;
    this.now = now;
    this.attachmentLoader = attachmentLoader; // sha256 → { content, mime }，真实发送时必须提供
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
      // 冻结记录只存附件元数据；真正发送前按 sha256 取回内容（取不到就明确失败）
      let outgoing = operation;
      if (Array.isArray(operation.attachments) && operation.attachments.length > 0) {
        const files = operation.attachments.map((a) => {
          const blob = typeof this.attachmentLoader === 'function' ? this.attachmentLoader(a.sha256) : null;
          if (!blob || !Buffer.isBuffer(blob.content)) {
            throw new MailerError('rejected', `附件「${a.name}」内容缺失，拒绝发送`);
          }
          return { name: a.name, mime: blob.mime, content: blob.content };
        });
        outgoing = { ...operation, attachmentFiles: files };
      }
      result = await this.mailer.send({ operation: outgoing, idempotencyKey: key });
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
