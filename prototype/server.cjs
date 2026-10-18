'use strict';
// ============================================================
// 办公套件控制台 HTTP 服务（v0.12）
//   零依赖：node:http + 静态文件 + JSON API
//   仅监听 127.0.0.1；无认证；业务动作全部模拟
//   npm start → http://127.0.0.1:7812
// ============================================================
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { ConsoleService, ConsoleError, VERSION } = require('./src/console-service.cjs');

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
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new ConsoleError('PAYLOAD_TOO_LARGE', '请求体超过 1 MiB', 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
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

function createConsoleServer({
  service = new ConsoleService(),
  publicDir = path.join(__dirname, 'public'),
} = {}) {
  const server = http.createServer(async (req, res) => {
    const { pathname, query } = parsePath(req.url || '/');
    const method = req.method || 'GET';

    try {
      // ---------- API ----------
      if (pathname === '/api/health' && method === 'GET') {
        return sendJson(res, 200, {
          ok: true, service: 'safe-office-console', version: VERSION,
          uptimeSec: service.getState().uptimeSec,
        });
      }
      if (pathname === '/api/bootstrap' && method === 'GET') {
        return sendJson(res, 200, { ok: true, ...service.getBootstrap() });
      }
      if (pathname === '/api/state' && method === 'GET') {
        return sendJson(res, 200, { ok: true, ...service.getState() });
      }
      if (pathname === '/api/commands' && method === 'POST') {
        const body = await readJson(req);
        return sendJson(res, 200, await service.runCommand(body));
      }
      if (pathname === '/api/commands' && method === 'GET') {
        return sendJson(res, 200, { ok: true, items: service.runs.slice(0, 50) });
      }
      if (pathname === '/api/documents' && method === 'GET') {
        return sendJson(res, 200, { ok: true, items: service.listDocuments() });
      }
      const docMatch = pathname.match(/^\/api\/documents\/([^/]+)$/);
      if (docMatch && method === 'GET') {
        return sendJson(res, 200, { ok: true, document: service.getDocument(decodeURIComponent(docMatch[1])) });
      }
      if (pathname === '/api/emails' && method === 'GET') {
        return sendJson(res, 200, { ok: true, ...service.listEmails() });
      }
      const outboxMatch = pathname.match(/^\/api\/outbox\/([^/]+)\/reconcile$/);
      if (outboxMatch && method === 'POST') {
        const body = await readJson(req);
        return sendJson(res, 200, service.reconcileOutbox(decodeURIComponent(outboxMatch[1]), body));
      }
      if (pathname === '/api/calendar' && method === 'GET') {
        return sendJson(res, 200, { ok: true, items: service.listCalendar() });
      }
      if (pathname === '/api/contacts' && method === 'GET') {
        return sendJson(res, 200, { ok: true, items: service.listContacts() });
      }
      if (pathname === '/api/operations' && method === 'GET') {
        return sendJson(res, 200, { ok: true, ...service.listOperations({ state: query.get('state') || null }) });
      }
      const opMatch = pathname.match(/^\/api\/operations\/([^/]+)$/);
      if (opMatch && method === 'GET') {
        return sendJson(res, 200, { ok: true, ...service.getOperation(decodeURIComponent(opMatch[1])) });
      }
      const opChallenge = pathname.match(/^\/api\/operations\/([^/]+)\/challenge$/);
      if (opChallenge && method === 'POST') {
        return sendJson(res, 200, { ok: true, challenge: service.beginChallenge(decodeURIComponent(opChallenge[1])) });
      }
      const opReject = pathname.match(/^\/api\/operations\/([^/]+)\/reject$/);
      if (opReject && method === 'POST') {
        return sendJson(res, 200, service.rejectOperation(decodeURIComponent(opReject[1])));
      }
      const opTamper = pathname.match(/^\/api\/operations\/([^/]+)\/verify-tamper$/);
      if (opTamper && method === 'POST') {
        return sendJson(res, 200, service.verifyTamper(decodeURIComponent(opTamper[1])));
      }
      const opSend = pathname.match(/^\/api\/operations\/([^/]+)\/send$/);
      if (opSend && method === 'POST') {
        return sendJson(res, 200, await service.sendOperation(decodeURIComponent(opSend[1])));
      }
      if (pathname === '/api/rollback' && method === 'POST') {
        const body = await readJson(req);
        return sendJson(res, 200, service.rollback(body.seq));
      }
      if (pathname === '/api/device' && method === 'GET') {
        return sendJson(res, 200, { ok: true, ...service.getDevice() });
      }
      const decideMatch = pathname.match(/^\/api\/device\/challenges\/([^/]+)\/decide$/);
      if (decideMatch && method === 'POST') {
        const body = await readJson(req);
        return sendJson(res, 200, await service.decideChallenge(decodeURIComponent(decideMatch[1]), body.decision));
      }
      const expireMatch = pathname.match(/^\/api\/device\/challenges\/([^/]+)\/expire$/);
      if (expireMatch && method === 'POST') {
        return sendJson(res, 200, service.expireChallenge(decodeURIComponent(expireMatch[1])));
      }
      const tamperMatch = pathname.match(/^\/api\/device\/challenges\/([^/]+)\/tamper$/);
      if (tamperMatch && method === 'POST') {
        return sendJson(res, 200, await service.tamperChallenge(decodeURIComponent(tamperMatch[1])));
      }
      if (pathname === '/api/device/replay' && method === 'POST') {
        return sendJson(res, 200, service.replayLastDecision());
      }
      if (pathname === '/api/governance' && method === 'GET') {
        return sendJson(res, 200, { ok: true, ...service.getGovernance() });
      }
      if (pathname === '/api/governance/review' && method === 'POST') {
        const body = await readJson(req);
        return sendJson(res, 200, service.reviewRisk(body));
      }
      if (pathname === '/api/governance/audit-tamper-demo' && method === 'POST') {
        return sendJson(res, 200, service.auditTamperDemo());
      }
      if (pathname === '/api/audit' && method === 'GET') {
        return sendJson(res, 200, service.listAudit({
          after: query.get('after') || 0,
          limit: query.get('limit') || 100,
          kind: query.get('kind') || '',
        }));
      }
      if (pathname === '/api/report' && method === 'GET') {
        return sendHtml(res, 200, service.getReport());
      }
      if (pathname === '/api/mode' && method === 'POST') {
        const body = await readJson(req);
        return sendJson(res, 200, service.setAutoMode(body.mode));
      }
      if (pathname === '/api/reset' && method === 'POST') {
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
  });
  server.consoleService = service;
  return server;
}

function startServer({
  port = Number(process.env.PORT) || 7812,
  host = '127.0.0.1',
  service,
  publicDir,
} = {}) {
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error('控制台只允许监听回环地址（127.0.0.1/localhost/::1）');
  }
  const instance = service || new ConsoleService();
  const server = createConsoleServer({ service: instance, publicDir });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      resolve({
        server,
        service: instance,
        url: `http://${host}:${actualPort}`,
        close: () => new Promise((done) => {
          server.close(() => {
            instance.close();
            done();
          });
        }),
      });
    });
  });
}

if (require.main === module) {
  startServer().then(({ url }) => {
    console.log(`安全智慧办公 · 办公套件控制台 v${VERSION}`);
    console.log(`  ${url}`);
    console.log('  仅本机演示：无登录；业务动作模拟；WS63 为虚拟设备');
    console.log('  Ctrl+C 停止');
  }).catch((err) => {
    console.error('控制台启动失败：', err.message);
    process.exitCode = 1;
  });
}

module.exports = { createConsoleServer, startServer };
