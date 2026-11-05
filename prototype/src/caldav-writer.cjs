'use strict';
// CalDAV 写入适配器（docs/61）：
//   把 .ics 通过 PUT 写到 CalDAV 日历集合（Radicale / Nextcloud / iCloud 等）。
//
// 流程：先 If-None-Match:* 创建；412（已存在）时 GET 拿 ETag，再 If-Match 更新。
// 认证：HTTP Basic（用户名 + 应用专用密码），只从环境变量读，不落日志。
// 边界：只证明服务器接受了事件（HTTP 2xx）；不证明手机端已同步，也不证明参会人收到通知。
// 明文 HTTP 会把 Basic 凭据暴露在链路上——生产必须用 HTTPS。

const DEFAULT_TIMEOUT_MS = 10000;
const UID_RE = /^[A-Za-z0-9._@-]{1,128}$/;

/** @param {{ url?: string, username?: string, password?: string }} [options] @returns {URL} */
function assertConfig({ url, username, password } = {}) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    throw new TypeError('CalDAV URL 非法');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError('CalDAV URL 必须是 http(s)');
  }
  if (typeof username !== 'string' || username.trim() === '') throw new TypeError('CalDAV 用户名必填');
  if (typeof password !== 'string' || password === '') throw new TypeError('CalDAV 密码必填');
  return parsed;
}

/** @param {string} baseUrl @param {string} uid @returns {string} */
function eventUrl(baseUrl, uid) {
  if (!UID_RE.test(String(uid || ''))) throw new TypeError('uid 含非法字符');
  return `${String(baseUrl).replace(/\/+$/, '')}/${encodeURIComponent(uid)}.ics`;
}

/** @param {string | undefined} username @param {string | undefined} password @returns {string} */
function basicAuth(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

/**
 * @param {{ url?: string, username?: string, password?: string, timeoutMs?: number, fetchImpl?: typeof fetch }} [options]
 * @returns {{ putEvent: (input: { uid: string, ics: string }) => Promise<{ ok: boolean, status: number, etag: string | null, url: string }>, deleteEvent: (uid: string) => Promise<{ ok: boolean, missing: boolean }> }}
 */
function createCalDavWriter({
  url,
  username,
  password,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
} = {}) {
  assertConfig({ url, username, password });
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl 必须是函数');
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs 必须是正整数');

  const headers = {
    Authorization: basicAuth(username, password),
    'Content-Type': 'text/calendar; charset=utf-8',
  };

  /** @param {string} method @param {string} target @param {Record<string, string>} [extraHeaders] @param {string} [body] @returns {Promise<Response>} */
  async function request(method, target, extraHeaders = {}, body) {
    let response;
    try {
      response = await fetchImpl(target, {
        method,
        headers: { ...headers, ...extraHeaders },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const e = /** @type {{ message?: string }} */ (err);
      const error = /** @type {any} */ (new Error(`CalDAV 请求失败（${method}）：${e && e.message ? e.message : err}`));
      error.code = 'CALDAV_NETWORK';
      throw error;
    }
    return response;
  }

  /** @param {{ uid: string, ics: string }} input */
  async function putEvent({ uid, ics }) {
    if (typeof ics !== 'string' || !ics.includes('BEGIN:VCALENDAR')) {
      throw new TypeError('ics 必须包含 BEGIN:VCALENDAR');
    }
    const target = eventUrl(String(url), uid);
    let response = await request('PUT', target, { 'If-None-Match': '*' }, ics);

    // 已存在：取 ETag 后按 If-Match 更新（避免覆盖别人并发改过的版本）
    if (response.status === 412) {
      const head = await request('GET', target);
      if (!head.ok) {
        const error = /** @type {any} */ (new Error(`CalDAV 已存在但读取失败：HTTP ${head.status}`));
        error.code = 'CALDAV_CONFLICT';
        throw error;
      }
      const etag = head.headers.get('etag');
      response = await request('PUT', target, etag ? { 'If-Match': etag } : {}, ics);
    }

    if (response.status !== 200 && response.status !== 201 && response.status !== 204) {
      const text = await response.text().catch(() => '');
      const error = /** @type {any} */ (new Error(`CalDAV 写入失败：HTTP ${response.status}${text ? ` ${text.slice(0, 120)}` : ''}`));
      error.code = 'CALDAV_HTTP';
      error.status = response.status;
      throw error;
    }
    return { ok: true, status: response.status, etag: response.headers.get('etag') || null, url: target };
  }

  /** @param {string} uid */
  async function deleteEvent(uid) {
    const response = await request('DELETE', eventUrl(String(url), uid));
    if (response.status === 404) return { ok: true, missing: true };
    if (!response.ok && response.status !== 204) {
      const error = /** @type {any} */ (new Error(`CalDAV 删除失败：HTTP ${response.status}`));
      error.code = 'CALDAV_HTTP';
      error.status = response.status;
      throw error;
    }
    return { ok: true, missing: false };
  }

  return { putEvent, deleteEvent };
}

module.exports = {
  createCalDavWriter, eventUrl, basicAuth, assertConfig, UID_RE,
};
