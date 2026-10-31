'use strict';
// ============================================================
// 办公套件控制台 HTTP 服务（v0.12）
//   零依赖：node:http + 静态文件 + JSON API
//   仅监听 127.0.0.1；无认证；业务动作全部模拟
//   npm start → http://127.0.0.1:7812
// ============================================================
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { ConsoleService, ConsoleError, VERSION } = require('./src/console-service.cjs');
const { DocumentStore, importBuffer } = require('./src/ingest.cjs');
const { BlobStore, parseKey } = require('./src/blob-store.cjs');
const { FakeMailer } = require('./src/mailer.cjs');
const { createSmtpMailerFromEnv } = require('./src/smtp-mailer.cjs');
const { scanAttachment, findClamav } = require('./src/file-scan.cjs');
const { AuthService, createAuthFromFile } = require('./src/auth.cjs');
const { loadConfigFile } = require('./src/load-config.cjs');
const { registerDocuments } = require('./src/scenario.cjs');
const SFC1 = require('./public/sfc1-browser.js');

// 手机确认端从局域网接入时，只开放这些路径；其余一律 403，避免把整个控制台暴露给会场 Wi-Fi
const LOOPBACK_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const PHONE_ALLOWLIST = new Set([
  '/confirm.html', '/confirm.js', '/confirm.css', '/sfc1-browser.js',
  '/api/phone/pair', '/api/phone/state', '/api/phone/decision', '/api/health',
]);

function isLoopbackReq(req) {
  const addr = req.socket && req.socket.remoteAddress;
  return !addr || LOOPBACK_ADDRS.has(addr);
}

function lanUrls(port) {
  const urls = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) urls.push({ name, url: `http://${net.address}:${port}/confirm.html` });
    }
  }
  return urls;
}

function randomPairingCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const raw = crypto.randomBytes(8);
  let out = '';
  for (let i = 0; i < raw.length; i += 1) out += alphabet[raw[i] % alphabet.length];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const APP_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const REPORT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";

function securityHeaders(res, { csp = APP_CSP } = {}) {
  res.setHeader('Content-Security-Policy', csp);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

function sendJson(res, status, payload) {
  securityHeaders(res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.statusCode = status;
  res.end(JSON.stringify(payload));
}

function sendBinary(res, buffer, { filename = 'attachment', mime = 'application/octet-stream' } = {}) {
  const encoded = encodeURIComponent(filename);
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encoded}`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.statusCode = 200;
  res.end(buffer);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  securityHeaders(res);
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', 'no-store');
  res.statusCode = status;
  res.end(text);
}

function sendHtml(res, status, html, { csp = REPORT_CSP } = {}) {
  securityHeaders(res, { csp });
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.statusCode = status;
  res.end(html);
}

function readJson(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        // 停止累积，但把后续数据读掉：直接 destroy 会让客户端只看到连接中断，
        // 拿不到结构化的 413。这里让请求流走完，响应仍可写回。
        req.removeAllListeners('data');
        req.resume();
        const mb = Math.round((limit / 1024 / 1024) * 10) / 10;
        reject(new ConsoleError('PAYLOAD_TOO_LARGE', `请求体超过 ${mb} MiB`, 413));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        const data = JSON.parse(raw);
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
          return reject(new ConsoleError('BAD_REQUEST', '请求体必须是 JSON 对象'));
        }
        return resolve(data);
      } catch {
        return reject(new ConsoleError('BAD_REQUEST', '请求体不是合法 JSON'));
      }
    });
    req.on('error', (err) => reject(err));
  });
}

function safeResolve(root, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const full = path.resolve(root, `.${decoded}`);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return full;
}

async function serveStatic(res, publicDir, pathname) {
  const relative = pathname === '/' ? '/index.html' : pathname;
  const file = safeResolve(publicDir, relative);
  if (!file) return sendText(res, 404, 'Not Found');
  try {
    const stat = await fs.promises.stat(file);
    if (!stat.isFile()) return sendText(res, 404, 'Not Found');
    const data = await fs.promises.readFile(file);
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    securityHeaders(res);
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'no-store');
    res.statusCode = 200;
    res.end(data);
  } catch (err) {
    if (err && err.code === 'ENOENT') return sendText(res, 404, 'Not Found');
    return sendText(res, 500, 'Internal Server Error');
  }
}

function parsePath(reqUrl) {
  try {
    const url = new URL(reqUrl, 'http://localhost');
    return { pathname: url.pathname, query: url.searchParams };
  } catch {
    return { pathname: '/', query: new URLSearchParams() };
  }
}

// 命令请求上限：附件原始总量 10MB，base64 约 13.4MB，再留 JSON 余量。
const DEFAULT_COMMAND_BODY_LIMIT = 16 * 1024 * 1024;

function parseCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key !== name) continue;
    try { return decodeURIComponent(rest.join('=')); } catch { return null; }
  }
  return null;
}

function setSessionCookie(req, res, token, ttlMs) {
  const attrs = ['Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${Math.floor(ttlMs / 1000)}`];
  if (req.socket && req.socket.encrypted) attrs.push('Secure');
  res.setHeader('Set-Cookie', `sfc_session=${encodeURIComponent(token)}; ${attrs.join('; ')}`);
}

function clearSessionCookie(req, res) {
  setSessionCookie(req, res, '', 0);
}

// 租户上下文：服务层用它过滤文档/操作/运行历史；未启用登录时 actor=null（保持旧行为）
function userContext(req) {
  return {
    actor: req.user ? req.user.username : null,
    role: req.user ? req.user.role : null,
  };
}

// 登录用户只能用自己的角色执行命令，不能靠改 body 提权
function applyUserToCommand(req, body) {
  if (!req.user) return;
  if (body.role && body.role !== req.user.role) {
    throw new ConsoleError('FORBIDDEN', `当前登录角色是「${req.user.role}」，不能以「${body.role}」执行`, 403);
  }
  body.role = req.user.role;
  body.operator = req.user.username;
}

function createConsoleServer({
  service = new ConsoleService(),
  publicDir = path.join(__dirname, 'public'),
  commandBodyLimit = DEFAULT_COMMAND_BODY_LIMIT,
  auth = null,
  allowVirtualConfirm = true,
} = {}) {
  const AUTH_PUBLIC = new Set([
    '/login.html', '/login.css', '/login.js', '/api/login', '/api/logout', '/api/me', '/api/health',
    '/confirm.html', '/confirm.js', '/confirm.css', '/sfc1-browser.js',
    '/api/phone/pair', '/api/phone/state', '/api/phone/decision',
  ]);
  const loginAttempts = new Map();
  const loginRateLimited = (key) => rateLimited(loginAttempts, key, 5, 60 * 1000);
  const passwordAttempts = new Map();
  const twoFactorAttempts = new Map();
  const mapAuthError = (err) => {
    if (err.code === 'USER_NOT_FOUND') return new ConsoleError('NOT_FOUND', err.message, 404);
    if (err.code === 'TOTP_ENABLED' || err.code === 'TOTP_SETUP_REQUIRED') {
      return new ConsoleError('CONFLICT', err.message, 409);
    }
    if (err.code === 'INVALID_TOTP') return new ConsoleError('INVALID_TOTP', err.message, 401);
    if (err.code === 'INVALID_CREDENTIALS') return new ConsoleError('INVALID_CREDENTIALS', err.message, 401);
    return new ConsoleError('BAD_REQUEST', err.message, 400);
  };
  const ROLE_APPROVE = new Set(['员工', '管理员']);
  const ROLE_DEVICE = new Set(['设备助手', '管理员']);
  const ROLE_ADMIN = new Set(['管理员']);
  const ROLE_REVIEW = new Set(['管理员', '审计员']);
  const ROLE_DOC_READ = new Set(['员工', '管理员', '审计员']);
  const ROLE_DOC_WRITE = new Set(['员工', '管理员']);
  const ROLE_STAFF = ROLE_DOC_READ;
  // 设备助手需要看到待审批队列与操作详情（但不读文档正文/审计）
  const ROLE_OP_READ = new Set(['员工', '管理员', '审计员', '设备助手']);
  const ROLE_AUDIT = new Set(['管理员', '审计员']);
  function requireRole(req, roles, action) {
    if (!auth) return; // 未启用登录：保持本地演示行为
    if (!req.user) throw new ConsoleError('AUTH_REQUIRED', '请先登录', 401);
    if (!roles.has(req.user.role)) {
      throw new ConsoleError('FORBIDDEN', '角色「' + req.user.role + '」无权' + action, 403);
    }
  }
  // —— 手机确认端配对会话 ——
  // 配了配对码时，state/decision 必须带 X-Phone-Session；否则局域网任何人都能读待确认详情。
  const phoneSessions = new Map();          // token → { expiresAt }
  const pairAttempts = new Map();           // ip → number[]（1 分钟窗口）
  const decisionAttempts = new Map();
  const SESSION_TTL_MS = 10 * 60 * 1000;
  const PAIR_LIMIT = 5;
  const DECISION_LIMIT = 10;
  const clientIp = (req) => (req.socket && req.socket.remoteAddress) || 'unknown';

  function rateLimited(map, key, max, windowMs = 60 * 1000) {
    const now = Date.now();
    const list = (map.get(key) || []).filter((t) => now - t < windowMs);
    list.push(now);
    map.set(key, list);
    return list.length > max;
  }

  function safeEqual(a, b) {
    const left = Buffer.from(String(a));
    const right = Buffer.from(String(b));
    return left.length === right.length && crypto.timingSafeEqual(left, right);
  }

  function requirePhoneSession(req) {
    if (!service.pairingCode) return; // 本机未启用配对码：保持旧的本地演示行为
    const token = String(req.headers['x-phone-session'] || '');
    const session = phoneSessions.get(token);
    if (!session || session.expiresAt <= Date.now()) {
      if (token) phoneSessions.delete(token);
      throw new ConsoleError('AUTH_REQUIRED', '手机确认端需要先配对（X-Phone-Session 无效或已过期）', 401);
    }
    session.expiresAt = Date.now() + SESSION_TTL_MS; // 滑动续期
  }

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      console.error('[console] unhandled', err);
      try {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ ok: false, error: { code: 'INTERNAL', message: '服务内部错误' } }));
        } else {
          res.destroy();
        }
      } catch { /* ignore */ }
    });
  });

  async function handleRequest(req, res) {
    const { pathname, query } = parsePath(req.url || '/');
    const method = req.method || 'GET';

    // —— 登录（可选；未配置用户时 auth=null，保持旧的本地演示行为）——
    try {
    const cookieToken = parseCookie(req.headers.cookie, 'sfc_session');
    if (pathname === '/api/login' && method === 'POST') {
      if (!auth) throw new ConsoleError('CONFLICT', '未启用登录（没有用户表）', 409);
      if (loginRateLimited(clientIp(req))) {
        throw new ConsoleError('RATE_LIMITED', '登录尝试过多，请 1 分钟后再试', 429);
      }
      const body = await readJson(req);
      const result = auth.login(body.username, body.password, body.code);
      if (!result) throw new ConsoleError('INVALID_CREDENTIALS', '用户名或密码不正确', 401);
      setSessionCookie(req, res, result.token, auth.ttlMs);
      return sendJson(res, 200, { ok: true, user: result.user, expiresAt: new Date(result.expiresAt).toISOString() });
    }
    if (pathname === '/api/logout' && method === 'POST') {
      if (auth && cookieToken) auth.logout(cookieToken);
      clearSessionCookie(req, res);
      return sendJson(res, 200, { ok: true });
    }
    if (pathname === '/api/me' && method === 'GET') {
      if (!auth) return sendJson(res, 200, { ok: true, authEnabled: false, user: null });
      const session = auth.verify(cookieToken);
      if (!session) throw new ConsoleError('AUTH_REQUIRED', '未登录', 401);
      const info = auth.userInfo(session.username);
      return sendJson(res, 200, {
        ok: true,
        authEnabled: true,
        user: { username: session.username, role: session.role, totpEnabled: !!(info && info.totpEnabled) },
        expiresAt: new Date(session.expiresAt).toISOString(),
      });
    }
    if (auth && !AUTH_PUBLIC.has(pathname)) {
      const session = auth.verify(cookieToken);
      if (!session) {
        if (pathname.startsWith('/api/')) {
          throw new ConsoleError('AUTH_REQUIRED', '请先登录', 401);
        }
        res.statusCode = 302;
        res.setHeader('Location', '/login.html');
        return res.end();
      }
      req.user = session;
    }
    } catch (err) {
      if (err instanceof ConsoleError) {
        return sendJson(res, err.status || 400, {
          ok: false, error: { code: err.code, message: err.message, detail: err.detail },
        });
      }
      throw err;
    }

    // 局域网来源只允许确认端相关路径
    if (!isLoopbackReq(req) && !PHONE_ALLOWLIST.has(pathname)) {
      return sendJson(res, 403, {
        ok: false, error: { code: 'LAN_FORBIDDEN', message: '局域网只开放确认端页面与接口' },
      });
    }

    try {
      // ---------- API ----------
      if (pathname === '/api/change-password' && method === 'POST') {
        if (!auth) throw new ConsoleError('CONFLICT', '未启用登录（没有用户表）', 409);
        if (rateLimited(passwordAttempts, clientIp(req), 5, 60 * 1000)) {
          throw new ConsoleError('RATE_LIMITED', '改密尝试过多，请 1 分钟后再试', 429);
        }
        const body = await readJson(req);
        try {
          auth.changePassword(req.user.username, body.oldPassword, body.newPassword, {
            keepToken: parseCookie(req.headers.cookie, 'sfc_session'),
          });
        } catch (err) {
          if (err.code === 'INVALID_CREDENTIALS') {
            throw new ConsoleError('INVALID_CREDENTIALS', err.message, 401);
          }
          throw new ConsoleError('BAD_REQUEST', err.message, 400);
        }
        return sendJson(res, 200, { ok: true });
      }
      // —— 两步验证（TOTP）——
      if (pathname.startsWith('/api/2fa/') && method === 'POST') {
        if (!auth) throw new ConsoleError('CONFLICT', '未启用登录（没有用户表）', 409);
        if (rateLimited(twoFactorAttempts, clientIp(req), 5, 60 * 1000)) {
          throw new ConsoleError('RATE_LIMITED', '两步验证尝试过多，请 1 分钟后再试', 429);
        }
        const body = await readJson(req);
        try {
          if (pathname === '/api/2fa/setup') {
            return sendJson(res, 200, { ok: true, ...auth.beginTotpSetup(req.user.username) });
          }
          if (pathname === '/api/2fa/enable') {
            return sendJson(res, 200, { ok: true, ...auth.enableTotp(req.user.username, body.code) });
          }
          if (pathname === '/api/2fa/disable') {
            return sendJson(res, 200, {
              ok: true,
              ...auth.disableTotp(req.user.username, body.password, body.code),
            });
          }
        } catch (err) {
          throw mapAuthError(err);
        }
        throw new ConsoleError('NOT_FOUND', `未知接口：${pathname}`, 404);
      }
      // —— 用户管理（仅管理员）——
      if (pathname === '/api/users' && method === 'GET') {
        requireRole(req, ROLE_ADMIN, '读取用户列表');
        if (!auth) throw new ConsoleError('CONFLICT', '未启用登录（没有用户表）', 409);
        return sendJson(res, 200, { ok: true, items: auth.listUsers() });
      }
      const userReset = pathname.match(/^\/api\/users\/([^/]+)\/reset-password$/);
      if (userReset) requireRole(req, ROLE_ADMIN, '重置用户密码');
      if (userReset && method === 'POST') {
        if (!auth) throw new ConsoleError('CONFLICT', '未启用登录（没有用户表）', 409);
        const body = await readJson(req);
        try {
          auth.adminResetPassword(decodeURIComponent(userReset[1]), body.newPassword);
        } catch (err) {
          throw mapAuthError(err);
        }
        return sendJson(res, 200, { ok: true });
      }
      if (pathname === '/api/health' && method === 'GET') {
        return sendJson(res, 200, {
          ok: true, service: 'safe-office-console', version: VERSION,
          uptimeSec: service.getState().uptimeSec,
        });
      }
      if (pathname === '/api/bootstrap' && method === 'GET') {
        return sendJson(res, 200, { ok: true, virtualConfirm: allowVirtualConfirm, authUser: req.user ? { username: req.user.username, role: req.user.role } : null, ...service.getBootstrap(userContext(req)) });
      }
      if (pathname === '/api/state' && method === 'GET') {
        return sendJson(res, 200, { ok: true, virtualConfirm: allowVirtualConfirm, authUser: req.user ? { username: req.user.username, role: req.user.role } : null, ...service.getState(userContext(req)) });
      }
      if (pathname === '/api/commands' && method === 'POST') {
        const body = await readJson(req, commandBodyLimit);
        applyUserToCommand(req, body);
        return sendJson(res, 200, await service.runCommand(body));
      }
      if (pathname === '/api/commands' && method === 'GET') {
        return sendJson(res, 200, { ok: true, items: service.listRuns(userContext(req)).slice(0, 50) });
      }
      // 异步任务：起跑即返回 runId；轮询进度 / 取消
      if (pathname === '/api/commands/async' && method === 'POST') {
        const body = await readJson(req, commandBodyLimit);
        applyUserToCommand(req, body);
        return sendJson(res, 202, { ok: true, ...service.startCommand(body) });
      }
      const runMatch = pathname.match(/^\/api\/commands\/([^/]+)$/);
      if (runMatch && method === 'GET') {
        return sendJson(res, 200, { ok: true, ...service.getRun(decodeURIComponent(runMatch[1]), userContext(req)) });
      }
      const runCancel = pathname.match(/^\/api\/commands\/([^/]+)\/cancel$/);
      if (runCancel && method === 'POST') {
        return sendJson(res, 200, service.cancelRun(decodeURIComponent(runCancel[1]), userContext(req)));
      }
      // 浏览器上传导入：请求体为 base64，服务端做扩展名白名单 + 魔数/编码嗅探 + 大小上限
      if (pathname === '/api/documents/import' && method === 'POST') {
        requireRole(req, ROLE_DOC_WRITE, '导入资料');
        if (!service.documentsStore) {
          throw new ConsoleError('CONFLICT', '文档库未启用：请用 npm start 启动（内存模式不接导入）', 409);
        }
        const body = await readJson(req, 8 * 1024 * 1024);
        const filename = typeof body.filename === 'string' ? body.filename : '';
        const contentBase64 = typeof body.contentBase64 === 'string' ? body.contentBase64 : '';
        if (!contentBase64) throw new ConsoleError('BAD_REQUEST', '缺少 contentBase64');
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(contentBase64)) {
          throw new ConsoleError('BAD_REQUEST', 'contentBase64 不是合法 base64');
        }
        try {
          const buffer = Buffer.from(contentBase64, 'base64');
          // 只对导入支持的文档类型做附件安全检查；扩展名不支持时交给 importBuffer 报错
          if (['.txt', '.md', '.docx'].includes(path.extname(filename).toLowerCase())) {
            const scan = scanAttachment(buffer, { filename });
            if (!scan.ok) throw new ConsoleError('BAD_REQUEST', scan.reason);
          }
          const doc = importBuffer(service.documentsStore, {
            filename, buffer, level: body.level,
            owner: req.user ? req.user.username : '',
          });
          // 立即并入文档视图，不用重启
          registerDocuments([{
            id: doc.id, title: doc.title, level: doc.level, body: doc.body, owner: doc.owner || '',
          }]);
          return sendJson(res, 200, {
            ok: true,
            document: { id: doc.id, title: doc.title, level: doc.level, bytes: Buffer.byteLength(doc.body, 'utf8') },
          });
        } catch (err) {
          throw new ConsoleError('BAD_REQUEST', err && err.message ? err.message : '导入失败', 400);
        }
      }
      if (pathname === '/api/documents' && method === 'GET') {
        requireRole(req, ROLE_STAFF, '读取文档列表');
        return sendJson(res, 200, { ok: true, items: service.listDocuments(userContext(req)) });
      }
      const docMatch = pathname.match(/^\/api\/documents\/([^/]+)$/);
      if (docMatch) requireRole(req, ROLE_STAFF, '读取文档');
      if (docMatch && method === 'GET') {
        return sendJson(res, 200, { ok: true, document: service.getDocument(decodeURIComponent(docMatch[1]), userContext(req)) });
      }
      if (pathname === '/api/emails' && method === 'GET') {
        requireRole(req, ROLE_STAFF, '读取邮件列表');
        return sendJson(res, 200, { ok: true, ...service.listEmails(userContext(req)) });
      }
      const outboxMatch = pathname.match(/^\/api\/outbox\/([^/]+)\/reconcile$/);
      if (outboxMatch) requireRole(req, ROLE_STAFF, '核对发件');
      if (outboxMatch && method === 'POST') {
        const body = await readJson(req);
        return sendJson(res, 200, service.reconcileOutbox(decodeURIComponent(outboxMatch[1]), body));
      }
      if (pathname === '/api/bounce' && method === 'POST') {
        requireRole(req, ROLE_REVIEW, '处理退信');
        const body = await readJson(req);
        return sendJson(res, 200, service.ingestBounce({
          eml: body.eml,
          by: req.user ? req.user.username : null,
        }));
      }
      if (pathname === '/api/calendar' && method === 'GET') {
        requireRole(req, ROLE_STAFF, '读取日历');
        return sendJson(res, 200, { ok: true, items: service.listCalendar(userContext(req)) });
      }
      if (pathname === '/api/contacts' && method === 'GET') {
        requireRole(req, ROLE_STAFF, '读取通讯录');
        return sendJson(res, 200, { ok: true, items: service.listContacts() });
      }
      if (pathname === '/api/operations' && method === 'GET') {
        requireRole(req, ROLE_OP_READ, '读取操作列表');
        return sendJson(res, 200, { ok: true, ...service.listOperations({ state: query.get('state') || null, ...userContext(req) }) });
      }
      const opMatch = pathname.match(/^\/api\/operations\/([^/]+)$/);
      if (opMatch) requireRole(req, ROLE_OP_READ, '读取操作详情');
      if (opMatch && method === 'GET') {
        return sendJson(res, 200, { ok: true, ...service.getOperation(decodeURIComponent(opMatch[1]), userContext(req)) });
      }
      const opBody = pathname.match(/^\/api\/operations\/([^/]+)\/body$/);
      if (opBody) requireRole(req, ROLE_DOC_READ, '读取操作正文');
      if (opBody && method === 'GET') {
        return sendJson(res, 200, { ok: true, ...service.getOperationBody(decodeURIComponent(opBody[1]), userContext(req)) });
      }
      if (opBody && method === 'POST') {
        const body = await readJson(req);
        return sendJson(res, 200, service.editOperationBody(decodeURIComponent(opBody[1]), { ...body, ...userContext(req) }));
      }
      const opRevisions = pathname.match(/^\/api\/operations\/([^/]+)\/revisions$/);
      if (opRevisions) requireRole(req, ROLE_DOC_READ, '读取操作历史');
      if (opRevisions && method === 'GET') {
        return sendJson(res, 200, { ok: true, ...service.listOperationRevisions(decodeURIComponent(opRevisions[1]), userContext(req)) });
      }
      const opAttachment = pathname.match(/^\/api\/operations\/([^/]+)\/attachments\/([^/]+)$/);
      if (opAttachment) requireRole(req, ROLE_DOC_READ, '下载附件');
      if (opAttachment && method === 'GET') {
        const file = service.getAttachment(
          decodeURIComponent(opAttachment[1]), decodeURIComponent(opAttachment[2]), userContext(req),
        );
        return sendBinary(res, file.content, { filename: file.name, mime: file.mime });
      }
      const opChallenge = pathname.match(/^\/api\/operations\/([^/]+)\/challenge$/);
      if (opChallenge) requireRole(req, ROLE_APPROVE, '发起确认');
      if (opChallenge && method === 'POST') {
        return sendJson(res, 200, { ok: true, challenge: service.beginChallenge(decodeURIComponent(opChallenge[1]), userContext(req)) });
      }
      const opReject = pathname.match(/^\/api\/operations\/([^/]+)\/reject$/);
      if (opReject) requireRole(req, ROLE_APPROVE, '驳回操作');
      if (opReject && method === 'POST') {
        return sendJson(res, 200, service.rejectOperation(decodeURIComponent(opReject[1]), userContext(req)));
      }
      const opTamper = pathname.match(/^\/api\/operations\/([^/]+)\/verify-tamper$/);
      if (opTamper) requireRole(req, ROLE_APPROVE, '校验操作');
      if (opTamper && method === 'POST') {
        return sendJson(res, 200, service.verifyTamper(decodeURIComponent(opTamper[1]), userContext(req)));
      }
      const opSend = pathname.match(/^\/api\/operations\/([^/]+)\/send$/);
      if (opSend) requireRole(req, ROLE_APPROVE, '执行操作');
      if (opSend && method === 'POST') {
        return sendJson(res, 200, await service.sendOperation(decodeURIComponent(opSend[1]), userContext(req)));
      }
      if (pathname === '/api/rollback' && method === 'POST') {
        requireRole(req, ROLE_ADMIN, '回滚');
        const body = await readJson(req);
        return sendJson(res, 200, service.rollback(body.seq));
      }
      if (pathname === '/api/device' && method === 'GET') {
        return sendJson(res, 200, { ok: true, ...service.getDevice(userContext(req)) });
      }
      if (pathname === '/api/phone/pair' && method === 'POST') {
        if (!service.pairingCode) {
          throw new ConsoleError('CONFLICT', '本机未启用配对码（请用 npm run start:lan 启动）', 409);
        }
        if (rateLimited(pairAttempts, clientIp(req), PAIR_LIMIT)) {
          throw new ConsoleError('RATE_LIMITED', '配对尝试过多，请 1 分钟后再试', 429);
        }
        const body = await readJson(req);
        const code = typeof body.code === 'string' ? body.code.trim() : '';
        if (!safeEqual(code, service.pairingCode)) {
          throw new ConsoleError('INVALID_CODE', '配对码不正确', 401);
        }
        const token = crypto.randomBytes(24).toString('base64url');
        const expiresAt = Date.now() + SESSION_TTL_MS;
        phoneSessions.set(token, { expiresAt });
        return sendJson(res, 200, { ok: true, token, expiresAt: new Date(expiresAt).toISOString(), ttlSec: SESSION_TTL_MS / 1000 });
      }
      if (pathname === '/api/phone/state' && method === 'GET') {
        requirePhoneSession(req);
        return sendJson(res, 200, { ok: true, ...service.getPhoneState() });
      }
      if (pathname === '/api/phone/decision' && method === 'POST') {
        requirePhoneSession(req);
        if (rateLimited(decisionAttempts, clientIp(req), DECISION_LIMIT)) {
          throw new ConsoleError('RATE_LIMITED', '确认提交过于频繁，请稍后再试', 429);
        }
        const body = await readJson(req);
        return sendJson(res, 200, await service.submitPhoneDecision(body.challengeId, body.frame));
      }
      const decideMatch = pathname.match(/^\/api\/device\/challenges\/([^/]+)\/decide$/);
      if (decideMatch) requireRole(req, ROLE_DEVICE, '虚拟设备批准');
      if (decideMatch && method === 'POST') {
        if (!allowVirtualConfirm) {
          throw new ConsoleError('CONFLICT', '已启用真实动作，虚拟设备批准入口已关闭；请用手机/WS63 确认', 409);
        }
        const body = await readJson(req);
        return sendJson(res, 200, await service.decideChallenge(decodeURIComponent(decideMatch[1]), body.decision, userContext(req)));
      }
      const expireMatch = pathname.match(/^\/api\/device\/challenges\/([^/]+)\/expire$/);
      if (expireMatch) requireRole(req, ROLE_DEVICE, '模拟确认超时');
      if (expireMatch && method === 'POST') {
        return sendJson(res, 200, service.expireChallenge(decodeURIComponent(expireMatch[1])));
      }
      const tamperMatch = pathname.match(/^\/api\/device\/challenges\/([^/]+)\/tamper$/);
      if (tamperMatch) requireRole(req, ROLE_DEVICE, '篡改确认帧');
      if (tamperMatch && method === 'POST') {
        return sendJson(res, 200, await service.tamperChallenge(decodeURIComponent(tamperMatch[1])));
      }
      if (pathname === '/api/device/replay' && method === 'POST') {
        requireRole(req, ROLE_DEVICE, '重放确认');
        if (!allowVirtualConfirm) {
          throw new ConsoleError('CONFLICT', '已启用真实动作，虚拟设备入口已关闭', 409);
        }
        return sendJson(res, 200, service.replayLastDecision());
      }
      if (pathname === '/api/governance' && method === 'GET') {
        requireRole(req, ROLE_STAFF, '读取治理数据');
        return sendJson(res, 200, { ok: true, ...service.getGovernance(userContext(req)) });
      }
      if (pathname === '/api/governance/review' && method === 'POST') {
        requireRole(req, ROLE_REVIEW, '风险复核');
        const body = await readJson(req);
        return sendJson(res, 200, service.reviewRisk(body));
      }
      if (pathname === '/api/governance/audit-tamper-demo' && method === 'POST') {
        requireRole(req, ROLE_ADMIN, '审计篡改演示');
        return sendJson(res, 200, service.auditTamperDemo());
      }
      if (pathname === '/api/audit' && method === 'GET') {
        requireRole(req, ROLE_AUDIT, '读取审计日志');
        return sendJson(res, 200, service.listAudit({
          after: query.get('after') || 0,
          limit: query.get('limit') || 100,
          kind: query.get('kind') || '',
        }));
      }
      if (pathname === '/api/report' && method === 'GET') {
        requireRole(req, ROLE_AUDIT, '导出治理报告');
        return sendHtml(res, 200, service.getReport());
      }
      if (pathname === '/api/mode' && method === 'POST') {
        requireRole(req, ROLE_ADMIN, '修改自动模式');
        const body = await readJson(req);
        return sendJson(res, 200, service.setAutoMode(body.mode));
      }
      if (pathname === '/api/reset' && method === 'POST') {
        requireRole(req, ROLE_ADMIN, '重置工作区');
        return sendJson(res, 200, { ok: true, state: service.reset() });
      }
      if (pathname.startsWith('/api/')) {
        return sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: `未知接口：${pathname}` } });
      }

      // ---------- 静态 ----------
      if (method !== 'GET' && method !== 'HEAD') {
        return sendJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: '只支持 GET/HEAD' } });
      }
      return serveStatic(res, publicDir, pathname);
    } catch (err) {
      if (err instanceof ConsoleError) {
        return sendJson(res, err.status || 400, {
          ok: false, error: { code: err.code, message: err.message, detail: err.detail },
        });
      }
      // 不把堆栈返回给浏览器；控制台留一行便于调试
      console.error('[console]', err);
      return sendJson(res, 500, { ok: false, error: { code: 'INTERNAL', message: '服务内部错误' } });
    }
  }
  server.consoleService = service;
  return server;
}

async function startServer({
  port = Number(process.env.PORT) || 7812,
  host = '127.0.0.1',
  allowLan = false,
  service,
  publicDir,
  pairingCode = null,
  documentsStore = null,
  blobStore = null,
  commandBodyLimit = DEFAULT_COMMAND_BODY_LIMIT,
  storeFile = process.env.SAFE_OFFICE_STORE_FILE || ':memory:',
  auditFile = process.env.SAFE_OFFICE_AUDIT_FILE || null,
  mailer = null,
  auth = null,
  allowVirtualConfirm = true,
} = {}) {
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host);
  if (!loopback && !allowLan) {
    throw new Error('控制台默认只监听回环地址；要上局域网请显式传 allowLan: true（且只开放确认端）');
  }
  let instance = service;
  if (!instance) {
    if (pairingCode) {
      const key = Buffer.from(await SFC1.deriveKey(pairingCode));
      instance = new ConsoleService({
        nearfieldKey: key,
        deviceId: 'phone-A',
        deviceLabel: '手机确认端（演示）',
        pairingCode,
        documentsStore,
        blobStore,
        storeFile,
        auditFile,
        mailer: mailer || new FakeMailer(),
      });
    } else {
      instance = new ConsoleService({ documentsStore, blobStore, storeFile, auditFile, mailer: mailer || new FakeMailer() });
    }
  }
  const server = createConsoleServer({ service: instance, publicDir, commandBodyLimit, auth, allowVirtualConfirm });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      resolve({
        server,
        service: instance,
        url: `http://${host}:${actualPort}`,
        phoneUrls: pairingCode ? lanUrls(actualPort) : [],
        pairingCode: instance.pairingCode || null,
        close: () => new Promise((done) => {
          server.close(() => {
            instance.close();
            try { if (documentsStore) documentsStore.close(); } catch { /* ignore */ }
            try { if (blobStore) blobStore.close(); } catch { /* ignore */ }
            done();
          });
        }),
      });
    });
  });
}

if (require.main === module) {
  // 先读 config.env（KEY=VALUE）；命令行/系统环境变量优先，配置文件不覆盖
  const configInfo = loadConfigFile(path.join(__dirname, 'config.env'));
  const argv = process.argv.slice(2);
  const lan = argv.includes('--lan');
  const codeArg = argv.find((arg) => arg.startsWith('--code='));
  const pairingCode = codeArg
    ? codeArg.slice('--code='.length)
    : process.env.SAFE_OFFICE_PHONE_CODE || (lan ? randomPairingCode() : null);
  // 导入的真实资料：默认落在 prototype/data/documents.db（已 gitignore）
  // 控制台默认落盘：操作/审计都在 prototype/data 下（已 gitignore）。
  // 显式设 SAFE_OFFICE_STORE_FILE=:memory: 可回到内存模式（测试/一次性演示）。
  const storeFile = process.env.SAFE_OFFICE_STORE_FILE
    || path.join(__dirname, 'data', 'operations.db');
  const auditFile = process.env.SAFE_OFFICE_AUDIT_FILE
    || path.join(__dirname, 'data', 'audit.jsonl');
  const documentsDb = process.env.SAFE_OFFICE_DOCS_DB
    || path.join(__dirname, 'data', 'documents.db');
  const usersFile = process.env.SAFE_OFFICE_USERS_FILE || path.join(__dirname, 'data', 'users.json');
  const sessionsFile = process.env.SAFE_OFFICE_SESSIONS_FILE || path.join(__dirname, 'data', 'sessions.json');
  let auth = null;
  try {
    auth = createAuthFromFile(usersFile, { sessionFile: sessionsFile });
    if (auth && auth.sessionLoadError) {
      console.warn(`⚠ 会话文件恢复失败（${sessionsFile}）：${auth.sessionLoadError}；旧会话已丢弃`);
    }
  } catch (err) {
    console.error(`✗ 用户表加载失败（${usersFile}）：${err.message}`);
    process.exit(1);
  }
  if (process.env.SAFE_OFFICE_AUTH === 'required' && !auth) {
    console.error(`✗ SAFE_OFFICE_AUTH=required 但没有用户：${usersFile}（用 add-user.cjs 添加）`);
    process.exit(1);
  }
  let smtpMailer = null;
  try {
    smtpMailer = createSmtpMailerFromEnv();
  } catch (err) {
    console.warn(`⚠ SMTP 配置不完整：${err.message}；本次使用模拟发送`);
  }
  // 启用真实动作（SMTP / 真实打印机）时默认关闭虚拟设备批准入口
  const allowVirtualConfirm = String(process.env.SAFE_OFFICE_ALLOW_VIRTUAL_CONFIRM || '').toLowerCase() === '1'
    ? true
    : !(smtpMailer || process.env.SAFE_OFFICE_PRINTER);
  let documentsStore = null;
  try {
    documentsStore = new DocumentStore(documentsDb);
  } catch (err) {
    console.warn(`⚠ 文档库打不开（${documentsDb}）：${err.message}；本次只用样例文档`);
  }
  // 附件内容：默认落在 prototype/data/attachments.db（已 gitignore）
  const attachmentsDb = process.env.SAFE_OFFICE_ATTACHMENTS_DB
    || path.join(__dirname, 'data', 'attachments.db');
  let blobStore = null;
  try {
    const blobKey = parseKey(process.env.SAFE_OFFICE_BLOB_KEY || null);
    blobStore = new BlobStore(attachmentsDb, { key: blobKey });
  } catch (err) {
    console.warn(`⚠ 附件库打不开（${attachmentsDb}）：${err.message}；本次不能带附件`);
  }
  startServer({
    port: Number(process.env.PORT) || 7812,
    host: lan ? '0.0.0.0' : '127.0.0.1',
    allowLan: lan,
    pairingCode,
    documentsStore,
    blobStore,
    storeFile,
    auditFile,
    mailer: smtpMailer || new FakeMailer(),
    auth,
    allowVirtualConfirm,
  }).then(({ url, phoneUrls, pairingCode: code, service }) => {
    console.log(`安全智慧办公 · 办公套件控制台 v${VERSION}`);
    console.log(`  ${url}`);
    const model = service.getState().model;
    console.log(`  模型：${model.mode}${model.model ? ` / ${model.model}` : ''}`);
    if (smtpMailer) console.log('  邮件：SMTP 真实发送（收件人白名单已启用）');
    const clamavMode = String(process.env.SAFE_OFFICE_CLAMAV || 'off').toLowerCase();
    if (clamavMode !== 'off') {
      const scanner = findClamav();
      if (scanner) console.log(`  附件扫描：ClamAV ${clamavMode}（${scanner}）`);
      else console.log(`  附件扫描：ClamAV ${clamavMode}，但未找到扫描器${clamavMode === 'required' ? '——附件将被拒绝' : ''}`);
    }
    if (auth) {
      console.log(`  登录：已启用（${auth.users.size} 个用户，${usersFile}）`);
      console.log(`  会话：持久化 → ${sessionsFile}（只存 token 的 SHA-256）`);
    }
    else console.log('  登录：未启用（本地演示；可用 add-user.cjs 建用户）');
    if (!allowVirtualConfirm) {
      console.log('  虚拟批准：已关闭（检测到真实动作）');
      console.log('    高危确认请用手机确认端（npm run start:lan）');
      console.log('    本机演示可显式打开：SAFE_OFFICE_ALLOW_VIRTUAL_CONFIRM=1 npm start');
    }
    if (configInfo.loaded > 0) console.log(`  配置：config.env（${configInfo.loaded} 项）`);
    else if (!model.model) console.log('  提示：没有 config.env；想用真实模型，复制 config.env.example 再填');
    if (service.storeFile !== ':memory:') {
      console.log(`  持久化：操作 → ${service.storeFile}`);
      console.log(`          审计 → ${service.auditFile || '(未开启)'}`);
      if (service.recoveredInFlight > 0) {
        console.log(`  ⚠ 上次中断的在途发送 ${service.recoveredInFlight} 条已转「待核对」，不会自动重试`);
      }
    } else {
      console.log('  内存模式：重启清空（设 SAFE_OFFICE_STORE_FILE / SAFE_OFFICE_AUDIT_FILE 可落盘）');
    }
    if (documentsStore) {
      const imported = documentsStore.list().length;
      console.log(imported > 0
        ? `  真实资料：${imported} 份（${documentsDb}）`
        : '  真实资料：0 份（导入：npm run import -- <文件> --level 内部）');
    }
    if (code) {
      console.log('  手机确认端已启用：局域网只开放确认页与 /api/phone/*');
      console.log(`    配对码：${code}`);
      for (const item of phoneUrls) console.log(`    手机打开：${item.url}  (${item.name})`);
      if (phoneUrls.length === 0) console.log('    （未找到局域网 IPv4，请检查网络）');
    } else if (auth) {
      console.log('  本机演示：登录已启用；业务动作模拟；确认端为虚拟设备');
    } else {
      console.log('  仅本机演示：无登录；业务动作模拟；确认端为虚拟设备');
    }
    console.log('  业务动作全部模拟；SFC1 为对称密钥，不构成"证明本人在场"');
    console.log('  Ctrl+C 停止');
  }).catch((err) => {
    console.error('控制台启动失败：', err.message);
    process.exitCode = 1;
  });
}

module.exports = { createConsoleServer, startServer, DEFAULT_COMMAND_BODY_LIMIT };
