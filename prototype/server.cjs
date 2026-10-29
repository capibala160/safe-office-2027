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
const { BlobStore } = require('./src/blob-store.cjs');
const { loadConfigFile } = require('./src/load-config.cjs');
const { registerDocuments } = require('./src/scenario.cjs');
const SFC1 = require('./public/sfc1-browser.js');

// 手机确认端从局域网接入时，只开放这些路径；其余一律 403，避免把整个控制台暴露给会场 Wi-Fi
const LOOPBACK_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const PHONE_ALLOWLIST = new Set([
  '/confirm.html', '/confirm.js', '/confirm.css', '/sfc1-browser.js',
  '/api/phone/state', '/api/phone/decision', '/api/health',
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

    // 局域网来源只允许确认端相关路径
    if (!isLoopbackReq(req) && !PHONE_ALLOWLIST.has(pathname)) {
      return sendJson(res, 403, {
        ok: false, error: { code: 'LAN_FORBIDDEN', message: '局域网只开放确认端页面与接口' },
      });
    }

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
      // 异步任务：起跑即返回 runId；轮询进度 / 取消
      if (pathname === '/api/commands/async' && method === 'POST') {
        const body = await readJson(req);
        return sendJson(res, 202, { ok: true, ...service.startCommand(body) });
      }
      const runMatch = pathname.match(/^\/api\/commands\/([^/]+)$/);
      if (runMatch && method === 'GET') {
        return sendJson(res, 200, { ok: true, ...service.getRun(decodeURIComponent(runMatch[1])) });
      }
      const runCancel = pathname.match(/^\/api\/commands\/([^/]+)\/cancel$/);
      if (runCancel && method === 'POST') {
        return sendJson(res, 200, service.cancelRun(decodeURIComponent(runCancel[1])));
      }
      // 浏览器上传导入：请求体为 base64，服务端做扩展名白名单 + 魔数/编码嗅探 + 大小上限
      if (pathname === '/api/documents/import' && method === 'POST') {
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
          const doc = importBuffer(service.documentsStore, {
            filename, buffer: Buffer.from(contentBase64, 'base64'), level: body.level,
          });
          // 立即并入文档视图，不用重启
          registerDocuments([{ id: doc.id, title: doc.title, level: doc.level, body: doc.body }]);
          return sendJson(res, 200, {
            ok: true,
            document: { id: doc.id, title: doc.title, level: doc.level, bytes: Buffer.byteLength(doc.body, 'utf8') },
          });
        } catch (err) {
          throw new ConsoleError('BAD_REQUEST', err && err.message ? err.message : '导入失败', 400);
        }
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
      const opBody = pathname.match(/^\/api\/operations\/([^/]+)\/body$/);
      if (opBody && method === 'GET') {
        return sendJson(res, 200, { ok: true, ...service.getOperationBody(decodeURIComponent(opBody[1])) });
      }
      if (opBody && method === 'POST') {
        const body = await readJson(req);
        return sendJson(res, 200, service.editOperationBody(decodeURIComponent(opBody[1]), body));
      }
      const opRevisions = pathname.match(/^\/api\/operations\/([^/]+)\/revisions$/);
      if (opRevisions && method === 'GET') {
        return sendJson(res, 200, { ok: true, ...service.listOperationRevisions(decodeURIComponent(opRevisions[1])) });
      }
      const opAttachment = pathname.match(/^\/api\/operations\/([^/]+)\/attachments\/([^/]+)$/);
      if (opAttachment && method === 'GET') {
        const file = service.getAttachment(
          decodeURIComponent(opAttachment[1]), decodeURIComponent(opAttachment[2]),
        );
        return sendBinary(res, file.content, { filename: file.name, mime: file.mime });
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
      if (pathname === '/api/phone/state' && method === 'GET') {
        return sendJson(res, 200, { ok: true, ...service.getPhoneState() });
      }
      if (pathname === '/api/phone/decision' && method === 'POST') {
        const body = await readJson(req);
        return sendJson(res, 200, await service.submitPhoneDecision(body.challengeId, body.frame));
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

async function startServer({
  port = Number(process.env.PORT) || 7812,
  host = '127.0.0.1',
  allowLan = false,
  service,
  publicDir,
  pairingCode = null,
  documentsStore = null,
  blobStore = null,
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
      });
    } else {
      instance = new ConsoleService({ documentsStore, blobStore });
    }
  }
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
  const documentsDb = process.env.SAFE_OFFICE_DOCS_DB
    || path.join(__dirname, 'data', 'documents.db');
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
    blobStore = new BlobStore(attachmentsDb);
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
  }).then(({ url, phoneUrls, pairingCode: code, service }) => {
    console.log(`安全智慧办公 · 办公套件控制台 v${VERSION}`);
    console.log(`  ${url}`);
    const model = service.getState().model;
    console.log(`  模型：${model.mode}${model.model ? ` / ${model.model}` : ''}`);
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

module.exports = { createConsoleServer, startServer };
