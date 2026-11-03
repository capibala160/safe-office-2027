'use strict';
// ============================================================
// 自动回信策略（v0.46）
//   目标：对白名单内的个人来信做固定模板回复，不引入模型、不读取来信正文。
//
//   安全边界（全部是硬条件，任一不满足就跳过）：
//   - 默认关闭；开启必须配置 SAFE_OFFICE_AUTOREPLY_ALLOW_TO（fail-closed）
//   - 只回白名单地址/域名；绝不回自己、邮件列表、自动回复、退信/机器地址
//   - 模板与主题固定，不拼接来信主题/正文 → 不可信输入不会进入外发内容
//   - 同一 Message-ID 只回一次；同一发件人 24h 内只回一次；全局每小时有配额
//   - 只回最近 N 小时内的邮件，避免首次开启时把历史邮件全部回一遍
//   - 发送仍走冻结→确认→outbox 闭环；失败/结果未知一律不自动重试
// ============================================================

const DEFAULT_SUBJECT = '自动回复：已收到您的来信';
const DEFAULT_TEMPLATE = [
  '您好，',
  '',
  '已收到您的来信，我们会在工作时间内尽快处理。',
  '',
  '本邮件由系统自动发送。',
].join('\n');

const MACHINE_LOCAL_PARTS = /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounce|notifications?)$/i;

function asBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

// "Name <addr@example.com>" / "addr@example.com" → 小写地址；解析不了返回 ''
function senderAddress(from) {
  const text = String(from || '').trim();
  if (!text) return '';
  const m = text.match(/<([^<>\s]+@[^<>\s]+)>/);
  const raw = (m ? m[1] : (text.includes('@') && !text.includes(' ') ? text : '')).trim().toLowerCase();
  if (!raw || raw.length > 254) return '';
  return /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(raw) ? raw : '';
}

// 去重键只认 Message-ID：UID 在不同 UIDVALIDITY / 重启后可能变化，不能作为回信凭证。
function normalizeMessageKey(item) {
  const raw = (item && (item.messageId || (item.headers && item.headers['message-id']))) || '';
  const id = String(raw).trim().replace(/^<|>$/g, '').toLowerCase();
  return id ? `mid:${id}` : '';
}

function parseAllowlist(raw) {
  const list = String(raw || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const rules = [];
  const seen = new Set();
  for (const entry of list) {
    let rule;
    if (entry.startsWith('@')) {
      const domain = entry.slice(1);
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
        throw new Error(`自动回信白名单域名非法：${entry}`);
      }
      rule = { domain };
    } else {
      if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(entry) || entry.length > 254) {
        throw new Error(`自动回信白名单地址非法：${entry}`);
      }
      rule = { address: entry };
    }
    const key = rule.address || `@${rule.domain}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rules.push(rule);
  }
  return rules;
}

function parseAutoReplyConfig(env = process.env) {
  if (!asBool(env.SAFE_OFFICE_AUTOREPLY, false)) {
    return { enabled: false };
  }
  const allow = parseAllowlist(env.SAFE_OFFICE_AUTOREPLY_ALLOW_TO);
  if (allow.length === 0) {
    throw new Error('自动回信已开启但未设置 SAFE_OFFICE_AUTOREPLY_ALLOW_TO（白名单，fail-closed）');
  }
  const template = String(env.SAFE_OFFICE_AUTOREPLY_TEMPLATE || DEFAULT_TEMPLATE).replace(/\r\n?/g, '\n').trim();
  if (!template) throw new Error('自动回信模板不能为空');
  if (template.length > 2000) throw new Error('自动回信模板超过 2000 字符');
  const subject = String(env.SAFE_OFFICE_AUTOREPLY_SUBJECT || DEFAULT_SUBJECT).replace(/[\r\n]+/g, ' ').trim();
  if (!subject) throw new Error('自动回信主题不能为空');
  return {
    enabled: true,
    allow,
    subject: subject.slice(0, 120),
    template,
    account: String(env.SAFE_OFFICE_AUTOREPLY_ACCOUNT || '').trim(),
    maxPerHour: clampInt(env.SAFE_OFFICE_AUTOREPLY_MAX_PER_HOUR, 1, 100, 5),
    perSenderHours: clampInt(env.SAFE_OFFICE_AUTOREPLY_SENDER_HOURS, 1, 24 * 7, 24),
    maxAgeHours: clampInt(env.SAFE_OFFICE_AUTOREPLY_MAX_AGE_HOURS, 1, 24 * 7, 24),
    maxPerScan: clampInt(env.SAFE_OFFICE_AUTOREPLY_MAX, 1, 50, 10),
    pollMs: clampInt(env.SAFE_OFFICE_AUTOREPLY_POLL_MS, 60000, 24 * 60 * 60 * 1000, 5 * 60 * 1000),
  };
}

// 单封邮件的判断：纯函数 + 注入查询，便于单测
// ctx: { selfAddresses:Set, hasReplied(key), lastReplyTo(addr), countLastHour() }
function evaluateAutoReply(item, config, ctx) {
  if (!config || !config.enabled) return { decision: 'skip', reason: 'auto-reply-disabled' };
  const from = senderAddress(item && item.from);
  if (!from) return { decision: 'skip', reason: 'sender-invalid' };
  if ((ctx.selfAddresses || new Set()).has(from)) return { decision: 'skip', reason: 'self' };

  const allowed = config.allow.some((rule) => (
    rule.address ? rule.address === from : from.endsWith(`@${rule.domain}`)
  ));
  if (!allowed) return { decision: 'skip', reason: 'sender-not-allowed' };

  const headers = (item && item.headers) || {};
  const autoSubmitted = String(headers['auto-submitted'] || '').trim().toLowerCase();
  if (autoSubmitted && autoSubmitted !== 'no') return { decision: 'skip', reason: 'auto-submitted' };
  const suppress = String(headers['x-auto-response-suppress'] || '').trim().toLowerCase();
  if (suppress && suppress !== 'none') return { decision: 'skip', reason: 'auto-response-suppressed' };
  if (headers['list-id'] || headers['list-unsubscribe']) {
    return { decision: 'skip', reason: 'mailing-list' };
  }
  const precedence = String(headers.precedence || '').trim().toLowerCase();
  if (/^(bulk|list|junk)$/.test(precedence)) return { decision: 'skip', reason: 'bulk' };
  const local = from.split('@')[0];
  if (MACHINE_LOCAL_PARTS.test(local)) return { decision: 'skip', reason: 'machine-sender' };

  const key = normalizeMessageKey(item);
  if (!key) return { decision: 'skip', reason: 'no-message-id' };
  if (ctx.hasReplied(key)) return { decision: 'skip', reason: 'duplicate', messageKey: key };

  const sentAt = Date.parse(String((item && item.date) || ''));
  if (!Number.isFinite(sentAt)) return { decision: 'skip', reason: 'date-invalid', messageKey: key };
  const ageMs = ctx.now - sentAt;
  if (ageMs > config.maxAgeHours * 60 * 60 * 1000) {
    return { decision: 'skip', reason: 'too-old', messageKey: key };
  }
  if (ageMs < -60 * 60 * 1000) return { decision: 'skip', reason: 'date-in-future', messageKey: key };

  const lastTo = ctx.lastReplyTo(from);
  if (lastTo && ctx.now - Date.parse(lastTo) < config.perSenderHours * 60 * 60 * 1000) {
    return { decision: 'skip', reason: 'sender-rate-limit', messageKey: key };
  }
  if (ctx.countLastHour() >= config.maxPerHour) {
    return { decision: 'skip', reason: 'global-rate-limit', messageKey: key };
  }
  return { decision: 'reply', reason: 'allowed', messageKey: key, recipient: from };
}

module.exports = {
  parseAutoReplyConfig, evaluateAutoReply, senderAddress, normalizeMessageKey,
  parseAllowlist, DEFAULT_SUBJECT, DEFAULT_TEMPLATE,
};
