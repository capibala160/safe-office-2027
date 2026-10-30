'use strict';
// ============================================================
// SMTP 邮件适配器（v0.21）
//   - QQ/163/企业邮箱等标准 SMTP；授权码从环境变量读，绝不入库
//   - **收件人白名单**：SAFE_OFFICE_MAIL_ALLOW_TO 为空时拒绝所有发送（fail-closed）
//   - 附件：由 DemoExecutor 注入 attachmentFiles（Buffer），这里只组 MIME
//   - SMTP 没有标准幂等键：X-Idempotency-Key 只作追踪；结果不确定一律 unknown
// 边界：不证明"对方已读"；不做退信解析；不替代 HTTP 邮件服务的状态查询。
// ============================================================
const { MailerError } = require('./mailer.cjs');

let nodemailer = null;
try {
  // 可选依赖：没装时只在真正启用 SMTP 时明确报错，核心功能不受影响
  nodemailer = require('nodemailer');
} catch { /* ignore */ }

function asBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

function assertOperation(operation) {
  if (!operation || typeof operation !== 'object' ||
      typeof operation.recipient !== 'string' || operation.recipient === '' ||
      typeof operation.body !== 'string') {
    throw new MailerError('rejected', '操作记录缺少 recipient/body');
  }
}

class SMTPMailer {
  constructor({
    host, port = 465, secure = true, user, pass, from = null,
    allowTo = [], transport = null, timeoutMs = 20000,
  } = {}) {
    this.host = host;
    this.port = Number(port) || 465;
    this.secure = !!secure;
    this.user = user;
    this.pass = pass;
    this.from = from || user;
    this.allowTo = (allowTo || []).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
    this.transport = transport;
    this.timeoutMs = timeoutMs;
  }

  _transport() {
    if (this.transport) return this.transport;
    if (!nodemailer) {
      throw new MailerError('unknown', 'nodemailer 未安装：npm install nodemailer 后再启用 SMTP');
    }
    if (!this.host || !this.user || !this.pass) {
      throw new MailerError('unknown', 'SMTP 未配置：需要 host/user/pass');
    }
    this.transport = nodemailer.createTransport({
      host: this.host,
      port: this.port,
      secure: this.secure,
      auth: { user: this.user, pass: this.pass },
      connectionTimeout: this.timeoutMs,
      greetingTimeout: this.timeoutMs,
      socketTimeout: this.timeoutMs,
    });
    return this.transport;
  }

  _checkRecipient(to) {
    if (this.allowTo.length === 0) {
      throw new MailerError('rejected', '收件人白名单为空：拒绝发送（fail-closed）');
    }
    if (!this.allowTo.includes(to.toLowerCase())) {
      throw new MailerError('rejected', `收件人「${to}」不在白名单内，拒绝发送`);
    }
  }

  async send({ operation, idempotencyKey }) {
    assertOperation(operation);
    const to = String(operation.recipient).trim();
    this._checkRecipient(to);

    const attachmentFiles = Array.isArray(operation.attachmentFiles) ? operation.attachmentFiles : [];
    for (const file of attachmentFiles) {
      if (!file || !Buffer.isBuffer(file.content) || !file.name) {
        throw new MailerError('rejected', '附件内容缺失或非法，拒绝发送');
      }
    }

    const mail = {
      from: this.from,
      to,
      subject: operation.subject || '',
      text: operation.body,
      attachments: attachmentFiles.map((file) => ({
        filename: file.name,
        content: file.content,
        contentType: file.mime || 'application/octet-stream',
      })),
      headers: idempotencyKey ? { 'X-Idempotency-Key': idempotencyKey } : {},
    };

    let info;
    try {
      info = await this._transport().sendMail(mail);
    } catch (err) {
      const code = String((err && err.code) || '');
      const message = String((err && err.message) || err);
      // 认证/收件人/报文错误 = 明确失败；网络/超时 = 结果不确定（unknown，禁自动重试）
      if (/^(EAUTH|EENVELOPE|EMESSAGE|EATTACHMENT)$/.test(code) ||
          /auth|authentication|recipient|mailbox|invalid/i.test(message)) {
        throw new MailerError('rejected', `SMTP 拒绝：${message}`, { cause: err });
      }
      if (/^(ETIMEDOUT|ETIMEOUT)$/.test(code) || /timeout/i.test(message)) {
        throw new MailerError('timeout', `SMTP 超时（结果未知）：${message}`, { cause: err });
      }
      throw new MailerError('unknown', `SMTP 发送失败（结果未知）：${message}`, { cause: err });
    }
    return { status: 'sent', messageId: (info && info.messageId) || null };
  }
}

// 环境变量 → SMTPMailer；未配置 host 返回 null（走 FakeMailer）。
// 配了 host 但缺 user/pass，直接抛错，避免"看起来配了其实没发"。
function createSmtpMailerFromEnv(env = process.env) {
  if (!env.SAFE_OFFICE_SMTP_HOST) return null;
  const user = env.SAFE_OFFICE_SMTP_USER || '';
  const pass = env.SAFE_OFFICE_SMTP_PASS || '';
  if (!user || !pass) {
    throw new Error('SMTP 已配置 host 但缺少 SAFE_OFFICE_SMTP_USER / SAFE_OFFICE_SMTP_PASS');
  }
  const allowTo = String(env.SAFE_OFFICE_MAIL_ALLOW_TO || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (allowTo.length === 0) {
    throw new Error('启用 SMTP 必须设置 SAFE_OFFICE_MAIL_ALLOW_TO（收件人白名单）');
  }
  return new SMTPMailer({
    host: env.SAFE_OFFICE_SMTP_HOST,
    port: Number(env.SAFE_OFFICE_SMTP_PORT) || 465,
    secure: asBool(env.SAFE_OFFICE_SMTP_SECURE, Number(env.SAFE_OFFICE_SMTP_PORT || 465) === 465),
    user,
    pass,
    from: env.SAFE_OFFICE_MAIL_FROM || user,
    allowTo,
    timeoutMs: Number(env.SAFE_OFFICE_SMTP_TIMEOUT_MS) || 20000,
  });
}

module.exports = { SMTPMailer, createSmtpMailerFromEnv, asBool };
