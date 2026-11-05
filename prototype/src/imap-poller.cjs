'use strict';
// ============================================================
// IMAP 退信轮询（v0.39）
//   - 仅在配置 SAFE_OFFICE_IMAP_HOST/USER/PASS 时启用（依赖 imapflow，可选）
//   - 只取未读邮件：能解析成 DSN 的才处理并标记 \Seen；
//     普通邮件不标记已读（不吞用户邮件）
//   - 处理失败（解析/回填抛错）不标记已读，下一轮重试
// 边界：单邮箱、单文件夹、固定间隔轮询（无 IDLE 推送）；凭据与本机 config.env 同口径。
// ============================================================
const { parseDsn } = require('./dsn.cjs');

/**
 * @typedef {{ host: string, port: number, secure: boolean, user: string, pass: string, mailbox: string, pollMs: number, maxPerPoll: number, timeoutMs: number }} ImapConfig
 */

/** @type {any} */
let ImapFlow = null;
try {
  ({ ImapFlow } = require('imapflow'));
} catch { /* 未安装时在启用处明确报错 */ }

/** @param {unknown} value @param {boolean} [fallback] @returns {boolean} */
function asBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

/** @param {NodeJS.ProcessEnv} [env] @returns {ImapConfig | null} */
function createImapConfigFromEnv(env = process.env) {
  const host = env.SAFE_OFFICE_IMAP_HOST;
  if (!host) return null;
  const user = env.SAFE_OFFICE_IMAP_USER || '';
  const pass = env.SAFE_OFFICE_IMAP_PASS || '';
  if (!user || !pass) {
    throw new Error('IMAP 已配置 host 但缺少 SAFE_OFFICE_IMAP_USER / SAFE_OFFICE_IMAP_PASS');
  }
  return {
    host: String(host),
    port: Number(env.SAFE_OFFICE_IMAP_PORT) || 993,
    secure: asBool(env.SAFE_OFFICE_IMAP_SECURE, true),
    user,
    pass,
    mailbox: env.SAFE_OFFICE_IMAP_MAILBOX || 'INBOX',
    pollMs: Math.max(10000, Number(env.SAFE_OFFICE_IMAP_POLL_MS) || 60000),
    maxPerPoll: Math.max(1, Number(env.SAFE_OFFICE_IMAP_MAX) || 20),
    timeoutMs: Math.max(1000, Number(env.SAFE_OFFICE_IMAP_TIMEOUT_MS) || 20000),
  };
}

class ImapBouncePoller {
  /** @param {{ config?: ImapConfig, ingest?: (eml: string) => any, factory?: ((cfg: ImapConfig) => any) | null, now?: () => number, logger?: ((message: string) => void) | null }} [options] */
  constructor({ config, ingest, factory = null, now = () => Date.now(), logger = null } = {}) {
    if (!config || typeof config.host !== 'string') throw new TypeError('ImapBouncePoller 需要 config');
    if (typeof ingest !== 'function') throw new TypeError('ImapBouncePoller 需要 ingest(eml)');
    this.config = config;
    this.ingest = ingest;
    this.now = now;
    this.logger = logger;
    this.factory = factory || ((/** @type {ImapConfig} */ cfg) => {
      if (!ImapFlow) throw new Error('imapflow 未安装：npm install imapflow 后再启用 IMAP');
      return new ImapFlow({
        host: cfg.host,
        port: cfg.port,
        secure: cfg.secure,
        auth: { user: cfg.user, pass: cfg.pass },
        logger: false,
        connectionTimeout: cfg.timeoutMs,
        greetingTimeout: cfg.timeoutMs,
        socketTimeout: cfg.timeoutMs,
      });
    });
    this.timer = null;
    this.running = false;
    // v0.40.1：游标轮转 + 非退信 UID 记忆，避免普通邮件占满窗口把退信饿死
    this.cursorUid = 0;
    this.ignoredUids = new Set();
    /** @type {{ configured: boolean, lastAt: string | null, lastResult: any, lastError: string | null, totalDsns: number, totalBounced: number }} */
    this.state = {
      configured: true,
      lastAt: null,
      lastResult: null,
      lastError: null,
      totalDsns: 0,
      totalBounced: 0,
    };
  }

  // 候选 UID：未读 + 最近 7 天的退信特征邮件（用户可能先点开看过，不能只因已读就漏掉）。
  // 单个查询服务端不支持就跳过；全部失败才抛错。
  /** @param {any} client @returns {Promise<number[]>} */
  async _searchCandidateUids(client) {
    const since = new Date(this.now() - 7 * 24 * 60 * 60 * 1000);
    const queries = [
      { seen: false },
      // 不依赖主题编码：最近 7 天的邮件全扫一遍（已读退信也能覆盖），
      // 普通邮件靠 ignoredUids 记忆避免重复抓取
      { since },
      { since, subject: '退信' },
      { since, subject: 'Delivery Status' },
      { since, subject: 'Undelivered' },
      { since, from: 'mailer-daemon' },
    ];
    const uids = new Set();
    let ok = 0;
    let lastError = null;
    for (const query of queries) {
      try {
        const res = await client.search(query, { uid: true });
        ok += 1;
        for (const uid of res || []) uids.add(Number(uid));
      } catch (err) {
        lastError = err;
      }
    }
    if (ok === 0 && lastError) throw lastError;
    return [...uids].filter((uid) => Number.isInteger(uid) && uid > 0).sort((a, b) => a - b);
  }

  async poll() {
    if (this.running) return { skipped: 'running' };
    this.running = true;
    const startedAt = this.now();
    let client = null;
    try {
      client = this.factory(this.config);
      await client.connect();
      await client.mailboxOpen(this.config.mailbox);
      const uids = await this._searchCandidateUids(client);
      const unseen = (Array.isArray(uids) ? uids : [])
        .map(Number)
        .filter((uid) => Number.isInteger(uid) && uid > 0)
        .filter((uid) => !this.ignoredUids.has(uid))
        .sort((a, b) => a - b);
      // 游标轮转：从上一轮扫到的 UID 之后继续，扫到尾部再绕回开头。
      // 普通邮件保持未读，但不会永远占住前 N 个位置（否则后面的退信永远轮不到）。
      /** @type {number[]} */
      let list = [];
      if (unseen.length > 0) {
        const start = unseen.findIndex((uid) => uid > this.cursorUid);
        const ordered = start === -1 ? unseen : [...unseen.slice(start), ...unseen.slice(0, start)];
        list = ordered.slice(0, this.config.maxPerPoll);
      }
      const result = {
        scanned: list.length, dsn: 0, bounced: 0, duplicate: 0,
        unmatched: 0, ignored: 0, errors: 0, markedSeen: 0,
      };
      for (const uid of list) {
        let source;
        try {
          const msg = await client.fetchOne(uid, { source: true, envelope: true }, { uid: true });
          source = msg && msg.source ? String(msg.source) : '';
        } catch (err) {
          result.errors += 1;
          this.state.lastError = `取信失败 UID ${uid}：${err instanceof Error ? err.message : String(err)}`;
          continue;
        }
        const parsed = parseDsn(source);
        // 不是退信：不处理、不标已读（避免吞掉正常邮件），但记住 UID 不再重复抓取
        if (!parsed.isDsn || parsed.reports.length === 0) {
          result.ignored += 1;
          this.ignoredUids.add(uid);
          continue;
        }
        let outcome;
        try {
          outcome = this.ingest(source);
        } catch (err) {
          result.errors += 1;
          this.state.lastError = `回填失败 UID ${uid}：${err instanceof Error ? err.message : String(err)}`;
          continue;   // 不标已读，下一轮重试
        }
        if (outcome && outcome.skipped) {
          result.ignored += 1;
          this.ignoredUids.add(uid);
          continue;
        }
        result.dsn += 1;
        if (outcome && outcome.summary) {
          result.bounced += outcome.summary.bounced;
          result.duplicate += outcome.summary.duplicate;
          result.unmatched += outcome.summary.unmatched;
          result.ignored += outcome.summary.ignored;
        }
        await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
        result.markedSeen += 1;
        // 已处理过的退信（含用户先点开过的）不再重复抓取
        this.ignoredUids.add(uid);
      }

      if (list.length) this.cursorUid = list[list.length - 1];
      if (this.ignoredUids.size > 5000) this.ignoredUids.clear();
      this.state.lastAt = new Date(startedAt).toISOString();
      this.state.lastResult = result;
      if (result.errors === 0) this.state.lastError = null;
      this.state.totalDsns += result.dsn;
      this.state.totalBounced += result.bounced;
      return result;
    } catch (err) {
      this.state.lastAt = new Date(startedAt).toISOString();
      this.state.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      this.running = false;
      if (client) {
        try { await client.logout(); } catch { /* ignore */ }
      }
    }
  }

  start() {
    if (this.timer) return this;
    const run = async () => {
      try {
        await this.poll();
      } catch (err) {
        if (this.logger) this.logger(`IMAP 轮询失败：${err instanceof Error ? err.message : String(err)}`);
      }
    };
    run();
    this.timer = setInterval(run, this.config.pollMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    return this;
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    return this;
  }
}

/** @param {{ ingest?: (eml: string) => any, env?: NodeJS.ProcessEnv, logger?: ((message: string) => void) | null, factory?: ((cfg: ImapConfig) => any) | null }} [options] @returns {ImapBouncePoller | null} */
function createBouncePollerFromEnv({ ingest, env = process.env, logger = null, factory = null } = {}) {
  const config = createImapConfigFromEnv(env);
  if (!config) return null;
  return new ImapBouncePoller({ config, ingest, logger, factory });
}

module.exports = {
  ImapBouncePoller,
  createImapConfigFromEnv,
  createBouncePollerFromEnv,
};
