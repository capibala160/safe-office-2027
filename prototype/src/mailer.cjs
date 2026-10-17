'use strict';
// ============================================================
// 邮件适配器（v0.10）
//   MailerError.kind：
//     rejected —— 明确失败（4xx、地址非法），可标记 failed
//     timeout  —— 客户端超时：对方可能已接收 → unknown，禁止自动重试
//     network  —— 连接中断：结果不确定 → unknown
//     unknown  —— 其他不确定 → unknown
//   FakeMailer：测试/演示用，可模拟"已接收但客户端超时"
//   HttpMailer：零依赖 fetch，要求服务端支持 Idempotency-Key（SMTP 没有标准幂等）
// 边界：本项目不实现 SMTP；真实发送优先选支持幂等键/状态查询的 HTTP 邮件服务。
// ============================================================
class MailerError extends Error {
  constructor(kind, message, options = {}) {
    super(message, options);
    this.name = 'MailerError';
    this.kind = kind;
  }
}

function assertOperation(operation) {
  if (!operation || typeof operation !== 'object' ||
      typeof operation.recipient !== 'string' || operation.recipient === '' ||
      typeof operation.body !== 'string') {
    throw new MailerError('rejected', '操作记录缺少 recipient/body');
  }
}

class FakeMailer {
  constructor({ behavior = 'sent', messageId = 'fake-message-1' } = {}) {
    this.behavior = behavior;
    this.messageId = messageId;
    this.calls = [];
    this.delivered = [];
  }

  _deliver(idempotencyKey) {
    const existing = this.delivered.find((d) => d.idempotencyKey === idempotencyKey);
    if (existing) return existing;
    const record = { idempotencyKey, messageId: `${this.messageId}-${this.delivered.length + 1}` };
    this.delivered.push(record);
    return record;
  }

  async send({ operation, idempotencyKey }) {
    assertOperation(operation);
    this.calls.push({ idempotencyKey, operationId: operation.operationId });
    switch (this.behavior) {
      case 'sent': {
        const r = this._deliver(idempotencyKey);
        return { status: 'sent', messageId: r.messageId };
      }
      case 'accepted-then-timeout': {
        this._deliver(idempotencyKey); // 模拟服务端已接收
        throw new MailerError('timeout', '模拟：服务端已接收但客户端超时');
      }
      case 'timeout':
        throw new MailerError('timeout', '模拟：请求超时');
      case 'network':
        throw new MailerError('network', '模拟：网络中断');
      case 'rejected':
        throw new MailerError('rejected', '模拟：收件人拒绝');
      case 'idempotent': {
        const r = this._deliver(idempotencyKey);
        return { status: 'sent', messageId: r.messageId };
      }
      default:
        throw new MailerError('unknown', `未知 FakeMailer 行为：${this.behavior}`);
    }
  }
}

class HttpMailer {
  constructor({
    endpoint,
    apiKey = '',
    timeoutMs = 10000,
    idempotencyHeader = 'Idempotency-Key',
    fetchImpl = globalThis.fetch,
    buildBody = (op) => ({
      to: op.recipient,
      subject: op.subject || '',
      text: op.body,
      attachments: op.attachments,
    }),
  } = {}) {
    this.endpoint = endpoint;
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.idempotencyHeader = idempotencyHeader;
    this.fetchImpl = fetchImpl;
    this.buildBody = buildBody;
  }

  async send({ operation, idempotencyKey }) {
    assertOperation(operation);
    if (!this.endpoint || typeof this.fetchImpl !== 'function') {
      throw new MailerError('unknown', '邮件服务未配置（endpoint/fetch）');
    }
    if (!idempotencyKey) throw new MailerError('rejected', '缺少幂等键');
    let resp;
    try {
      resp = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
          [this.idempotencyHeader]: idempotencyKey,
        },
        body: JSON.stringify(this.buildBody(operation)),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new MailerError('timeout', '邮件请求超时（结果未知，禁止自动重试）', { cause: err });
      }
      throw new MailerError('network', `邮件请求失败：${err && err.message ? err.message : err}`, { cause: err });
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      const kind = (resp.status >= 400 && resp.status < 500 &&
        resp.status !== 408 && resp.status !== 429) ? 'rejected' : 'unknown';
      throw new MailerError(kind, `邮件服务返回 HTTP ${resp.status}${text ? `：${text.slice(0, 200)}` : ''}`);
    }
    const data = await resp.json().catch(() => ({}));
    return { status: 'sent', messageId: data.messageId || data.id || null };
  }
}

module.exports = { MailerError, FakeMailer, HttpMailer };
