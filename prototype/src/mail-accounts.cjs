'use strict';
// ============================================================
// 多发送账号（v0.43）
//   - 配置：SAFE_OFFICE_SMTP_ACCOUNTS = JSON 数组，每项
//     { name, host, port, secure, user, pass, from, allowTo: [] }
//     兼容旧的单账号 SAFE_OFFICE_SMTP_* 环境变量
//   - 发送时 operation.mailAccount 选择账号；缺省用默认账号
//   - list() 永不返回 pass
// 边界：账号只做发送；IMAP 收件箱仍使用 SAFE_OFFICE_IMAP_*（单邮箱）。
// ============================================================
const { SMTPMailer, createSmtpMailerFromEnv } = require('./smtp-mailer.cjs');
const { MailerError } = require('./mailer.cjs');

function asBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

function normalizeAllowTo(value) {
  if (Array.isArray(value)) return value.map((x) => String(x).trim().toLowerCase()).filter(Boolean);
  return String(value || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function normalizeAccount(raw, index) {
  if (!raw || typeof raw !== 'object') throw new TypeError(`SMTP 账号[${index}] 必须是对象`);
  const name = String(raw.name || '').trim();
  const host = String(raw.host || '').trim();
  const user = String(raw.user || '').trim();
  const pass = String(raw.pass || '');
  if (!name) throw new TypeError(`SMTP 账号[${index}] 缺少 name`);
  if (!host || !user || !pass) throw new TypeError(`SMTP 账号「${name}」缺少 host/user/pass`);
  return {
    name,
    host,
    port: Number(raw.port) || 465,
    secure: raw.secure === undefined ? Number(raw.port || 465) === 465 : asBool(raw.secure, true),
    user,
    pass,
    from: String(raw.from || user),
    allowTo: normalizeAllowTo(raw.allowTo),
    timeoutMs: Number(raw.timeoutMs) || 20000,
  };
}

function parseAccountsFromEnv(env = process.env) {
  const raw = env.SAFE_OFFICE_SMTP_ACCOUNTS;
  if (raw) {
    let list;
    try {
      list = JSON.parse(String(raw));
    } catch (err) {
      throw new Error(`SAFE_OFFICE_SMTP_ACCOUNTS 不是合法 JSON：${err.message}`);
    }
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error('SAFE_OFFICE_SMTP_ACCOUNTS 必须是非空 JSON 数组');
    }
    const accounts = list.map((item, i) => normalizeAccount(item, i));
    const names = new Set();
    for (const a of accounts) {
      if (names.has(a.name)) throw new Error(`SMTP 账号名重复：${a.name}`);
      names.add(a.name);
    }
    const defaultName = String(env.SAFE_OFFICE_SMTP_DEFAULT_ACCOUNT || accounts[0].name);
    if (!names.has(defaultName)) throw new Error(`默认 SMTP 账号不存在：${defaultName}`);
    return { accounts, defaultName };
  }
  // 兼容旧单账号
  const legacy = createSmtpMailerFromEnv(env);
  if (!legacy) return null;
  return {
    accounts: [{
      name: 'default',
      host: legacy.host,
      port: legacy.port,
      secure: legacy.secure,
      user: legacy.user,
      pass: legacy.pass,
      from: legacy.from,
      allowTo: legacy.allowTo,
      timeoutMs: legacy.timeoutMs,
    }],
    defaultName: 'default',
  };
}

class MailerPool {
  constructor({ accounts = [], defaultName = null, mailerFactory = null } = {}) {
    if (!Array.isArray(accounts) || accounts.length === 0) throw new TypeError('MailerPool 需要至少一个账号');
    this.accounts = new Map();
    for (const a of accounts) {
      if (!a || !a.name) throw new TypeError('账号缺少 name');
      if (this.accounts.has(a.name)) throw new TypeError(`账号名重复：${a.name}`);
      this.accounts.set(a.name, a);
    }
    this.defaultName = defaultName || accounts[0].name;
    if (!this.accounts.has(this.defaultName)) throw new TypeError(`默认账号不存在：${this.defaultName}`);
    this.mailerFactory = mailerFactory || ((cfg) => new SMTPMailer(cfg));
    this.mailers = new Map();
  }

  list() {
    return [...this.accounts.values()].map((a) => ({
      name: a.name, from: a.from, host: a.host,
      default: a.name === this.defaultName,
    }));
  }

  _mailer(name) {
    if (!this.mailers.has(name)) {
      const cfg = this.accounts.get(name);
      this.mailers.set(name, this.mailerFactory({
        host: cfg.host, port: cfg.port, secure: cfg.secure, user: cfg.user,
        pass: cfg.pass, from: cfg.from, allowTo: cfg.allowTo, timeoutMs: cfg.timeoutMs,
      }));
    }
    return this.mailers.get(name);
  }

  async send({ operation, idempotencyKey }) {
    const name = String((operation && operation.mailAccount) || this.defaultName);
    if (!this.accounts.has(name)) {
      throw new MailerError('rejected', `未知发件账号「${name}」`);
    }
    return this._mailer(name).send({ operation, idempotencyKey });
  }
}

function createMailerPoolFromEnv(env = process.env) {
  const parsed = parseAccountsFromEnv(env);
  if (!parsed) return null;
  return new MailerPool(parsed);
}

module.exports = {
  parseAccountsFromEnv, normalizeAccount, MailerPool, createMailerPoolFromEnv,
};
