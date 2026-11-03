'use strict';
// ============================================================
// 多发送账号（v0.43，v0.45 增加别名/签名）
//   - 配置：SAFE_OFFICE_SMTP_ACCOUNTS = JSON 数组，每项
//     { name, host, port, secure, user, pass, from, fromName?, allowTo: [],
//       aliases: [{ address, name }] | string[],
//       signature? }
//     兼容旧的单账号 SAFE_OFFICE_SMTP_* 环境变量
//   - 发送时 operation.mailAccount 选择账号；缺省用默认账号
//   - operation.mailAlias 选择该账号下配置的别名地址；不配置则用 from
//   - signature 在**冻结时**追加进正文（见 console-service），因此确认的就是最终内容
//   - list() 永不返回 pass / signature 正文，只给 hasSignature
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

// 地址校验只做保守格式检查（不追求 RFC 5322 全量）；含 CR/LF/尖括号一律拒绝
function assertAddress(address, label) {
  if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(address) || address.length > 254) {
    throw new TypeError(`${label} 不是合法邮箱地址：${address}`);
  }
  return address;
}

function normalizeAliases(value, accountName) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new TypeError(`SMTP 账号「${accountName}」的 aliases 必须是数组`);
  const seen = new Set();
  return value.map((item, index) => {
    const raw = item && typeof item === 'object' ? item : { address: item };
    const address = assertAddress(
      String(raw.address || '').trim().toLowerCase(),
      `SMTP 账号「${accountName}」aliases[${index}].address`,
    );
    if (seen.has(address)) throw new TypeError(`SMTP 账号「${accountName}」别名重复：${address}`);
    seen.add(address);
    return {
      address,
      name: String(raw.name || '').trim().slice(0, 64),
    };
  });
}

function normalizeSignature(value, accountName) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') throw new TypeError(`SMTP 账号「${accountName}」的 signature 必须是字符串`);
  const text = value.replace(/\r\n?/g, '\n').trim();
  if (text.length > 1000) throw new TypeError(`SMTP 账号「${accountName}」的签名超过 1000 字符`);
  // 只允许换行、制表与普通字符；控制字符（除 \n \t）拒绝，避免污染报文
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    throw new TypeError(`SMTP 账号「${accountName}」的签名含控制字符`);
  }
  return text;
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
    from: assertAddress(String(raw.from || user).trim(), `SMTP 账号「${name}」的 from`),
    fromName: String(raw.fromName || '').trim().slice(0, 64),
    aliases: normalizeAliases(raw.aliases, name),
    signature: normalizeSignature(raw.signature, name),
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
      fromName: '',
      aliases: [],
      signature: '',
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
      name: a.name, from: a.from, fromName: a.fromName || '', host: a.host,
      aliases: (a.aliases || []).map((x) => ({ address: x.address, name: x.name || '' })),
      hasSignature: !!a.signature,
      default: a.name === this.defaultName,
    }));
  }

  // 供控制台冻结时解析账号配置（含签名）；不要把这个对象整体返回给前端
  getAccount(name) {
    const key = String(name || this.defaultName);
    return this.accounts.get(key) || null;
  }

  // 解析最终发件身份：alias 必须属于该账号；空 alias 用账号主地址
  resolveIdentity(accountName, aliasAddress = '') {
    const account = this.getAccount(accountName);
    if (!account) throw new MailerError('rejected', `未知发件账号「${accountName}」`);
    const alias = String(aliasAddress || '').trim().toLowerCase();
    if (!alias) {
      return { account, address: account.from, name: account.fromName || '', alias: '' };
    }
    const hit = (account.aliases || []).find((x) => x.address === alias);
    if (!hit) {
      throw new MailerError('rejected', `账号「${account.name}」没有配置别名「${alias}」`);
    }
    return { account, address: hit.address, name: hit.name || account.fromName || '', alias: hit.address };
  }

  _mailer(name) {
    if (!this.mailers.has(name)) {
      const cfg = this.accounts.get(name);
      this.mailers.set(name, this.mailerFactory({
        host: cfg.host, port: cfg.port, secure: cfg.secure, user: cfg.user,
        pass: cfg.pass, from: cfg.from, fromName: cfg.fromName || '',
        aliases: cfg.aliases || [], allowTo: cfg.allowTo, timeoutMs: cfg.timeoutMs,
      }));
    }
    return this.mailers.get(name);
  }

  async send({ operation, idempotencyKey }) {
    const name = String((operation && operation.mailAccount) || this.defaultName);
    if (!this.accounts.has(name)) {
      throw new MailerError('rejected', `未知发件账号「${name}」`);
    }
    if (operation && operation.mailAlias) {
      // 发送前再校验一次：冻结后被改配置也不能借别名发信
      this.resolveIdentity(name, operation.mailAlias);
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
