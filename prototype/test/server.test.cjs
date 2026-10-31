'use strict';
// 控制台 HTTP 服务测试（v0.12）
//   使用 port=0 启动独立实例，fetch 走真实 HTTP 栈。
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, DEFAULT_COMMAND_BODY_LIMIT } = require('../server.cjs');
const { AuthService, hashPassword } = require('../src/auth.cjs');
const { totpCode } = require('../src/totp.cjs');
const { DocumentStore } = require('../src/ingest.cjs');
const { FakeMailer } = require('../src/mailer.cjs');

async function boot(t) {
  const started = await startServer({ port: 0 });
  t.after(() => started.close());
  return started;
}

async function json(url, options) {
  const res = await fetch(url, options);
  const data = await res.json();
  return { res, data };
}

function post(url, body) {
  return json(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body === undefined ? {} : body),
  });
}

const externalCommand = {
  command: '把周例会纪要发给外部参会方 partner@partner-example.com',
  role: '员工',
  tools: ['readDoc', 'sendExternalEmail'],
  documentIds: ['M2'],
  domains: ['partner-example.com'],
};

test('退信接口：员工 403，审计员可回填，非退信 400', async (t) => {
  const mk = (username, role) => {
    const { salt, hash } = hashPassword('password123');
    return { username, role, salt, hash };
  };
  const auth = new AuthService({ users: [mk('emp', '员工'), mk('auditor', '审计员')] });
  const started = await startServer({ port: 0, auth });
  t.after(() => started.close());
  const cookie = (name) => `sfc_session=${auth.login(name, 'password123').token}`;

  // 内网邮件：策略自动确认 → 立即 sent，拿到 FakeMailer 的 messageId
  const run = await fetch(`${started.url}/api/commands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie('emp') },
    body: JSON.stringify({
      command: '把周例会纪要整理一下，发到部门内网邮箱 team@corp.internal',
      tools: ['readDoc', 'summarize', 'sendInternalEmail'], documentIds: ['M2'],
    }),
  });
  assert.equal(run.status, 200);
  const op = (await run.json()).operations[0];
  assert.equal(op.outbox.state, 'sent');
  const messageId = op.outbox.messageId;

  const dsn = [
    'From: Mail Delivery Subsystem <mailer-daemon@example.com>',
    'Subject: Delivery Status Notification',
    'Content-Type: multipart/report; report-type=delivery-status; boundary="B1"',
    '',
    '--B1',
    'Content-Type: message/delivery-status',
    '',
    'Reporting-MTA: dns; mx.example.com',
    '',
    'Final-Recipient: rfc822; team@corp.internal',
    'Action: failed',
    'Status: 5.1.1',
    'Diagnostic-Code: smtp; 550 5.1.1 unknown user',
    '',
    '--B1',
    'Content-Type: message/rfc822',
    '',
    `Message-ID: <${messageId}>`,
    '',
    '--B1--',
    '',
  ].join('\r\n');

  const empBounce = await fetch(`${started.url}/api/bounce`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie('emp') },
    body: JSON.stringify({ eml: dsn }),
  });
  assert.equal(empBounce.status, 403);

  const auditorBounce = await fetch(`${started.url}/api/bounce`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie('auditor') },
    body: JSON.stringify({ eml: dsn }),
  });
  assert.equal(auditorBounce.status, 200);
  const bounced = await auditorBounce.json();
  assert.equal(bounced.summary.bounced, 1);

  const maybeSent = await fetch(`${started.url}/api/emails`, { headers: { Cookie: cookie('emp') } });
  const emails = await maybeSent.json();
  assert.equal(emails.counts.bounced, 1);

  const notDsn = await fetch(`${started.url}/api/bounce`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie('auditor') },
    body: JSON.stringify({ eml: 'From: a@b.c\r\nSubject: hi\r\n\r\nhello' }),
  });
  assert.equal(notDsn.status, 400);
});

test('健康检查与版本', async (t) => {
  const { url } = await boot(t);
  const { res, data } = await json(`${url}/api/health`);
  assert.equal(res.status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.version, '0.40.2');
});

test('静态首页与资源', async (t) => {
  const { url } = await boot(t);
  const home = await fetch(`${url}/`);
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-type'), /text\/html/);
  const html = await home.text();
  assert.ok(html.includes('安全智慧办公'));
  assert.ok(html.includes('/app.js'));

  const css = await fetch(`${url}/styles.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);
  const js = await fetch(`${url}/app.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
});

test('静态路径穿越拒绝', async (t) => {
  const { url } = await boot(t);
  const encoded = await fetch(`${url}/%2e%2e/package.json`);
  assert.ok([403, 404].includes(encoded.status));
  const text = await encoded.text();
  assert.ok(!text.includes('safe-office-prototype'));

  const missing = await fetch(`${url}/nope.js`);
  assert.equal(missing.status, 404);
});

test('命令 API：参数校验与正常执行', async (t) => {
  const { url } = await boot(t);
  const empty = await post(`${url}/api/commands`, {});
  assert.equal(empty.res.status, 400);
  assert.equal(empty.data.error.code, 'BAD_REQUEST');

  const { data } = await post(`${url}/api/commands`, {
    command: '把周例会纪要整理一下，发到部门内网邮箱 team@corp.internal',
    role: '员工',
    tools: ['readDoc', 'summarize', 'sendInternalEmail'],
    documentIds: ['M2'],
  });
  assert.equal(data.ok, true);
  assert.ok(data.runId.startsWith('RUN-'));
  assert.equal(data.operations.length, 1);
  assert.equal(data.operations[0].state, 'executed');

  const ops = await json(`${url}/api/operations`);
  assert.equal(ops.data.ok, true);
  assert.ok(ops.data.items.length >= 1);
});

test('模块读接口：文档/通讯录/日历/治理', async (t) => {
  const { url } = await boot(t);
  const docs = await json(`${url}/api/documents`);
  assert.equal(docs.data.ok, true);
  assert.ok(docs.data.items.length >= 7);

  const contacts = await json(`${url}/api/contacts`);
  assert.ok(contacts.data.items.length >= 2);
  assert.ok(contacts.data.items.every((c) => c.phone === '[手机号已脱敏]' && c.email === '[邮箱已脱敏]'));

  const calendar = await json(`${url}/api/calendar`);
  assert.ok(Array.isArray(calendar.data.items));
  assert.ok(calendar.data.items.length >= 2);

  const governance = await json(`${url}/api/governance`);
  assert.equal(governance.data.ok, true);
  assert.ok(governance.data.policy['员工']);
  assert.ok(Array.isArray(governance.data.capabilities));
  assert.ok(Array.isArray(governance.data.perf));
});

test('外发 HTTP 闭环：命令 → 挑战 → 设备批准 → 发送', async (t) => {
  const { url } = await boot(t);
  const cmd = await post(`${url}/api/commands`, externalCommand);
  assert.equal(cmd.data.ok, true);
  assert.equal(cmd.data.operations.length, 1);
  const op = cmd.data.operations[0];
  assert.equal(op.state, 'frozen');

  const challenge = await post(`${url}/api/operations/${op.operationId}/challenge`, {});
  assert.equal(challenge.data.ok, true);
  assert.ok(challenge.data.challenge.summary.includes('外发'));

  const device = await json(`${url}/api/device`);
  assert.equal(device.data.pending.length, 1);

  const decided = await post(`${url}/api/device/challenges/${challenge.data.challenge.challengeId}/decide`, { decision: 'approve' });
  assert.equal(decided.data.ok, true);
  assert.equal(decided.data.outcome, 'approved');
  assert.equal(decided.data.operation.state, 'executed');
  assert.equal(decided.data.send.state, 'sent');

  const emails = await json(`${url}/api/emails`);
  assert.ok(emails.data.items.some((e) => e.operationId === op.operationId && e.outbox && e.outbox.state === 'sent'));
});

test('取消与重放 API', async (t) => {
  const { url } = await boot(t);
  const cmd = await post(`${url}/api/commands`, externalCommand);
  const op = cmd.data.operations[0];
  const challenge = await post(`${url}/api/operations/${op.operationId}/challenge`, {});
  const id = challenge.data.challenge.challengeId;

  const cancelled = await post(`${url}/api/device/challenges/${id}/decide`, { decision: 'cancel' });
  assert.equal(cancelled.data.ok, false);
  assert.equal(cancelled.data.outcome, 'cancelled');
  assert.equal(cancelled.data.code, 'DECISION');
  assert.equal(cancelled.data.operation.state, 'rejected');

  const replay = await post(`${url}/api/device/replay`, {});
  assert.equal(replay.data.ok, false);
  assert.equal(replay.data.code, 'STATE');
});

test('超时与重新发起 API', async (t) => {
  const { url } = await boot(t);
  const cmd = await post(`${url}/api/commands`, externalCommand);
  const op = cmd.data.operations[0];
  const challenge = await post(`${url}/api/operations/${op.operationId}/challenge`, {});
  const id = challenge.data.challenge.challengeId;

  const expired = await post(`${url}/api/device/challenges/${id}/expire`, {});
  assert.equal(expired.data.code, 'EXPIRED');
  assert.equal(expired.data.operation.state, 'frozen');

  const retry = await post(`${url}/api/operations/${op.operationId}/challenge`, {});
  assert.equal(retry.data.ok, true);
  const approved = await post(`${url}/api/device/challenges/${retry.data.challenge.challengeId}/decide`, { decision: 'approve' });
  assert.equal(approved.data.ok, true);
  assert.equal(approved.data.operation.state, 'executed');
});

test('篡改演示 API：只读校验 + 帧篡改', async (t) => {
  const { url } = await boot(t);
  const cmd = await post(`${url}/api/commands`, externalCommand);
  const op = cmd.data.operations[0];

  const verify = await post(`${url}/api/operations/${op.operationId}/verify-tamper`, {});
  assert.equal(verify.data.original.ok, true);
  assert.equal(verify.data.tampered.ok, false);

  const challenge = await post(`${url}/api/operations/${op.operationId}/challenge`, {});
  const id = challenge.data.challenge.challengeId;
  const tampered = await post(`${url}/api/device/challenges/${id}/tamper`, {});
  assert.equal(tampered.data.ok, false);
  assert.equal(tampered.data.code, 'MAC');

  const approved = await post(`${url}/api/device/challenges/${id}/decide`, { decision: 'approve' });
  assert.equal(approved.data.ok, true);
});

test('风险冻结与复核 API', async (t) => {
  const { url, service } = await boot(t);
  service.risk.add(60, '测试：风险冻结');
  const blocked = await post(`${url}/api/commands`, externalCommand);
  assert.equal(blocked.data.operations.length, 0);
  assert.ok(blocked.data.lines.some((l) => l.includes('风险冻结拦截')));

  const review = await post(`${url}/api/governance/review`, { outcome: 'clear', note: '测试复核' });
  assert.equal(review.data.ok, true);
  assert.equal(review.data.risk.score, 0);
  assert.equal(review.data.risk.frozen, false);
});

test('自动模式 API：全自动批准外发；重置回人在环', async (t) => {
  const { url } = await boot(t);
  const mode = await post(`${url}/api/mode`, { mode: 'auto-full' });
  assert.equal(mode.data.ok, true);
  assert.equal(mode.data.autoMode, 'auto-full');

  const cmd = await post(`${url}/api/commands`, externalCommand);
  assert.equal(cmd.data.operations.length, 1);
  assert.equal(cmd.data.operations[0].state, 'executed');
  assert.equal(cmd.data.operations[0].confirmationId, 'auto-full');

  const state = await json(`${url}/api/state`);
  assert.equal(state.data.autoMode, 'auto-full');

  const reset = await post(`${url}/api/reset`, {});
  assert.equal(reset.data.state.autoMode, 'manual');
});

test('审计链与治理报告 API', async (t) => {
  const { url } = await boot(t);
  await post(`${url}/api/commands`, {
    command: '查一下张伟的联系方式', role: '员工', tools: ['readContact'], documentIds: [],
  });
  const audit = await json(`${url}/api/audit?limit=20`);
  assert.equal(audit.data.ok, true);
  assert.ok(audit.data.items.length > 0);
  assert.equal(audit.data.verified, true);

  const tamper = await post(`${url}/api/governance/audit-tamper-demo`, {});
  assert.equal(tamper.data.original, true);
  assert.equal(tamper.data.tampered, false);

  const report = await fetch(`${url}/api/report`);
  assert.equal(report.status, 200);
  assert.match(report.headers.get('content-type'), /text\/html/);
  assert.ok((await report.text()).includes('治理报告'));
});

test('未知路由与坏 JSON', async (t) => {
  const { url } = await boot(t);
  const unknown = await json(`${url}/api/nope`);
  assert.equal(unknown.res.status, 404);
  assert.equal(unknown.data.error.code, 'NOT_FOUND');

  const bad = await fetch(`${url}/api/commands`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{',
  });
  assert.equal(bad.status, 400);
  const data = await bad.json();
  assert.equal(data.error.code, 'BAD_REQUEST');
});

test('重置 API：审计/操作/风险清零', async (t) => {
  const { url } = await boot(t);
  await post(`${url}/api/commands`, {
    command: '把周例会纪要整理一下，发到部门内网邮箱 team@corp.internal',
    role: '员工', tools: ['readDoc', 'summarize', 'sendInternalEmail'], documentIds: ['M2'],
  });
  const reset = await post(`${url}/api/reset`, {});
  assert.equal(reset.data.ok, true);
  assert.equal(reset.data.state.counts.audit, 0);
  assert.equal(reset.data.state.counts.operations, 0);

  const state = await json(`${url}/api/state`);
  assert.equal(state.data.counts.audit, 0);
  assert.equal(state.data.risk.score, 0);
});

test('请求体超限：返回结构化 413，不断连接', async (t) => {
  const started = await startServer({ port: 0, commandBodyLimit: 1024 });
  t.after(() => started.close());
  const body = JSON.stringify({ command: 'x'.repeat(4096), role: '员工' });
  const res = await fetch(`${started.url}/api/commands`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
  });
  assert.equal(res.status, 413);
  const data = await res.json();
  assert.equal(data.error.code, 'PAYLOAD_TOO_LARGE');
  assert.match(data.error.message, /请求体超过/);
});

test('命令请求上限覆盖 10MB 附件（base64 膨胀后仍有余量）', () => {
  const base64 = Math.ceil((10 * 1024 * 1024 * 4) / 3);
  assert.ok(DEFAULT_COMMAND_BODY_LIMIT > base64 + 64 * 1024,
    `上限 ${DEFAULT_COMMAND_BODY_LIMIT} 应大于 base64 ${base64} + JSON 余量`);
});

test('手机确认端：配对会话保护 state/decision，错误配对有限流', async (t) => {
  const started = await startServer({ port: 0, pairingCode: 'ABCD-EFGH' });
  t.after(() => started.close());

  const noAuth = await fetch(`${started.url}/api/phone/state`);
  assert.equal(noAuth.status, 401);
  assert.equal((await noAuth.json()).error.code, 'AUTH_REQUIRED');

  const wrong = await post(`${started.url}/api/phone/pair`, { code: 'WRONG-CODE' });
  assert.equal(wrong.res.status, 401);
  assert.equal(wrong.data.error.code, 'INVALID_CODE');

  const paired = await post(`${started.url}/api/phone/pair`, { code: 'ABCD-EFGH' });
  assert.equal(paired.res.status, 200);
  assert.ok(paired.data.token);

  const authed = await fetch(`${started.url}/api/phone/state`, {
    headers: { 'X-Phone-Session': paired.data.token },
  });
  assert.equal(authed.status, 200);

  const decisionNoAuth = await fetch(`${started.url}/api/phone/decision`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(decisionNoAuth.status, 401);
});

test('手机确认端：配对失败 5 次后第 6 次返回 429', async (t) => {
  const started = await startServer({ port: 0, pairingCode: 'ABCD-EFGH' });
  t.after(() => started.close());
  for (let i = 0; i < 5; i++) {
    const r = await post(`${started.url}/api/phone/pair`, { code: `BAD${i}` });
    assert.equal(r.res.status, 401);
  }
  const limited = await post(`${started.url}/api/phone/pair`, { code: 'BAD6' });
  assert.equal(limited.res.status, 429);
  assert.equal(limited.data.error.code, 'RATE_LIMITED');
});

test('登录：未登录 401 / 未登录页面 302 / 登录后可访问 / 角色不可提权 / 登出', async (t) => {
  const { salt, hash } = hashPassword('password123');
  const auth = new AuthService({ users: [{ username: 'alice', role: '员工', salt, hash }] });
  const started = await startServer({ port: 0, auth });
  t.after(() => started.close());

  const unauth = await fetch(`${started.url}/api/bootstrap`);
  assert.equal(unauth.status, 401);
  assert.equal((await unauth.json()).error.code, 'AUTH_REQUIRED');

  const page = await fetch(`${started.url}/`, { redirect: 'manual' });
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), '/login.html');

  const bad = await post(`${started.url}/api/login`, { username: 'alice', password: 'wrong' });
  assert.equal(bad.res.status, 401);

  const login = await post(`${started.url}/api/login`, { username: 'alice', password: 'password123' });
  assert.equal(login.res.status, 200);
  const cookie = String(login.res.headers.get('set-cookie')).split(';')[0];
  assert.match(cookie, /^sfc_session=/);

  const authed = await fetch(`${started.url}/api/bootstrap`, { headers: { Cookie: cookie } });
  assert.equal(authed.status, 200);
  const bootData = await authed.json();
  assert.deepEqual(bootData.authUser, { username: 'alice', role: '员工' });

  const mismatch = await fetch(`${started.url}/api/commands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ command: '查一下张伟的联系方式', role: '管理员', tools: ['readContact'], documentIds: [] }),
  });
  assert.equal(mismatch.status, 403);
  assert.equal((await mismatch.json()).error.code, 'FORBIDDEN');

  const logout = await fetch(`${started.url}/api/logout`, { method: 'POST', headers: { Cookie: cookie } });
  assert.equal(logout.status, 200);
  const after = await fetch(`${started.url}/api/me`, { headers: { Cookie: cookie } });
  assert.equal(after.status, 401);
});

test('接口权限：访客不能审批/改模式/复核/重置；员工可发起，设备助手可批准，管理员可改模式', async (t) => {
  const mk = (username, role) => {
    const { salt, hash } = hashPassword('password123');
    return { username, role, salt, hash };
  };
  const users = [
    mk('emp', '员工'), mk('visitor', '访客'), mk('device', '设备助手'),
    mk('admin', '管理员'), mk('auditor', '审计员'),
  ];
  const auth = new AuthService({ users });
  const started = await startServer({ port: 0, auth, allowVirtualConfirm: true });
  t.after(() => started.close());
  const cookie = (name) => `sfc_session=${auth.login(name, 'password123').token}`;

  const run = await fetch(`${started.url}/api/commands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie('emp') },
    body: JSON.stringify({
      command: '把周例会纪要发给外部参会方 partner@partner-example.com',
      role: '员工', tools: ['readDoc', 'sendExternalEmail'], documentIds: ['M2'],
      domains: ['partner-example.com'],
    }),
  });
  assert.equal(run.status, 200);
  const op = (await run.json()).operations[0];
  assert.ok(op);

  const challengeAsVisitor = await fetch(`${started.url}/api/operations/${op.operationId}/challenge`, {
    method: 'POST', headers: { Cookie: cookie('visitor') },
  });
  assert.equal(challengeAsVisitor.status, 403);

  const modeAsVisitor = await fetch(`${started.url}/api/mode`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie('visitor') },
    body: JSON.stringify({ mode: 'auto-full' }),
  });
  assert.equal(modeAsVisitor.status, 403);

  const resetAsVisitor = await fetch(`${started.url}/api/reset`, { method: 'POST', headers: { Cookie: cookie('visitor') } });
  assert.equal(resetAsVisitor.status, 403);

  const reviewAsVisitor = await fetch(`${started.url}/api/governance/review`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie('visitor') },
    body: JSON.stringify({ outcome: 'clear' }),
  });
  assert.equal(reviewAsVisitor.status, 403);

  // 读取面：访客不能看审计/报告/操作/文档；员工不能看审计/报告；审计员可以
  for (const path of ['/api/audit', '/api/report', '/api/operations', '/api/documents']) {
    const r = await fetch(`${started.url}${path}`, { headers: { Cookie: cookie('visitor') } });
    assert.equal(r.status, 403, `访客不应能读 ${path}`);
  }
  assert.equal((await fetch(`${started.url}/api/operations`, { headers: { Cookie: cookie('emp') } })).status, 200);
  assert.equal((await fetch(`${started.url}/api/audit`, { headers: { Cookie: cookie('emp') } })).status, 403);
  assert.equal((await fetch(`${started.url}/api/audit`, { headers: { Cookie: cookie('auditor') } })).status, 200);
  assert.equal((await fetch(`${started.url}/api/report`, { headers: { Cookie: cookie('auditor') } })).status, 200);

  const challenge = await fetch(`${started.url}/api/operations/${op.operationId}/challenge`, {
    method: 'POST', headers: { Cookie: cookie('emp') },
  });
  assert.equal(challenge.status, 200);
  const { challenge: ch } = await challenge.json();

  // 员工不能冒充设备批准
  const decideAsEmp = await fetch(`${started.url}/api/device/challenges/${ch.challengeId}/decide`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie('emp') },
    body: JSON.stringify({ decision: 'approve' }),
  });
  assert.equal(decideAsEmp.status, 403);

  const decideAsDevice = await fetch(`${started.url}/api/device/challenges/${ch.challengeId}/decide`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie('device') },
    body: JSON.stringify({ decision: 'approve' }),
  });
  assert.equal(decideAsDevice.status, 200);

  const modeAsAdmin = await fetch(`${started.url}/api/mode`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie('admin') },
    body: JSON.stringify({ mode: 'manual' }),
  });
  assert.equal(modeAsAdmin.status, 200);
});

test('虚拟批准入口：allowVirtualConfirm=false 时设备助手也拿 409', async (t) => {
  const { salt, hash } = hashPassword('password123');
  const auth = new AuthService({ users: [{ username: 'device', role: '设备助手', salt, hash }] });
  const started = await startServer({ port: 0, auth, allowVirtualConfirm: false });
  t.after(() => started.close());
  const token = auth.login('device', 'password123').token;
  const res = await fetch(`${started.url}/api/device/challenges/whatever/decide`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: `sfc_session=${token}` },
    body: JSON.stringify({ decision: 'approve' }),
  });
  assert.equal(res.status, 409);
  const boot = await fetch(`${started.url}/api/bootstrap`, { headers: { Cookie: `sfc_session=${token}` } });
  assert.equal(boot.status, 200);
  assert.equal((await boot.json()).virtualConfirm, false, '前端应能感知虚拟批准已关闭');
});

test('改密接口：原密码错误 401、新密码过短 400、成功后其他会话失效、新密码可登录', async (t) => {
  const { salt, hash } = hashPassword('password123');
  const auth = new AuthService({ users: [{ username: 'alice', role: '员工', salt, hash }] });
  const started = await startServer({ port: 0, auth });
  t.after(() => started.close());

  const first = await post(`${started.url}/api/login`, { username: 'alice', password: 'password123' });
  const cookie1 = String(first.res.headers.get('set-cookie')).split(';')[0];
  const second = await post(`${started.url}/api/login`, { username: 'alice', password: 'password123' });
  const cookie2 = String(second.res.headers.get('set-cookie')).split(';')[0];
  const change = (cookie, body) => fetch(`${started.url}/api/change-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(body),
  });

  const wrong = await change(cookie1, { oldPassword: 'wrong-password', newPassword: 'newpassword123' });
  assert.equal(wrong.status, 401);
  assert.equal((await wrong.json()).error.code, 'INVALID_CREDENTIALS');

  const short = await change(cookie1, { oldPassword: 'password123', newPassword: 'short' });
  assert.equal(short.status, 400);
  assert.equal((await short.json()).error.code, 'BAD_REQUEST');

  const same = await change(cookie1, { oldPassword: 'password123', newPassword: 'password123' });
  assert.equal(same.status, 400);

  const ok = await change(cookie1, { oldPassword: 'password123', newPassword: 'newpassword123' });
  assert.equal(ok.status, 200);

  assert.equal((await fetch(`${started.url}/api/me`, { headers: { Cookie: cookie1 } })).status, 200, '当前会话保留');
  assert.equal((await fetch(`${started.url}/api/me`, { headers: { Cookie: cookie2 } })).status, 401, '其他会话失效');

  const oldLogin = await post(`${started.url}/api/login`, { username: 'alice', password: 'password123' });
  assert.equal(oldLogin.res.status, 401);
  const newLogin = await post(`${started.url}/api/login`, { username: 'alice', password: 'newpassword123' });
  assert.equal(newLogin.res.status, 200);
});

test('四眼原则：HTTP 审批拒绝发起人，换一位管理员可批准', async (t) => {
  const mk = (username, role) => {
    const { salt, hash } = hashPassword('password123');
    return { username, role, salt, hash };
  };
  const auth = new AuthService({ users: [mk('admin1', '管理员'), mk('admin2', '管理员')] });
  const started = await startServer({ port: 0, auth, allowVirtualConfirm: true });
  t.after(() => started.close());
  const cookie = (name) => `sfc_session=${auth.login(name, 'password123').token}`;

  // 管理员角色本身不做业务动作：直接经服务层冻结一条发起人为 admin1 的操作
  const sample = started.service.getDemoSamples().find((s) => s.id === 'external-confirm');
  const run = await started.service.runCommand({ ...sample, role: '员工', operator: 'admin1' });
  const op = run.operations[0];
  assert.equal(op.createdBy, 'admin1');

  const challengeRes = await fetch(`${started.url}/api/operations/${op.operationId}/challenge`, {
    method: 'POST', headers: { Cookie: cookie('admin1') },
  });
  assert.equal(challengeRes.status, 200);
  const { challenge } = await challengeRes.json();

  const decide = (name) => fetch(`${started.url}/api/device/challenges/${challenge.challengeId}/decide`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie(name) },
    body: JSON.stringify({ decision: 'approve' }),
  });

  const self = await decide('admin1');
  assert.equal(self.status, 403);
  assert.equal((await self.json()).error.code, 'FORBIDDEN');

  const detail = await fetch(`${started.url}/api/operations/${op.operationId}`, { headers: { Cookie: cookie('admin2') } });
  assert.equal((await detail.json()).operation.state, 'frozen', '被拒后操作仍冻结');

  const other = await decide('admin2');
  assert.equal(other.status, 200);
  const result = await other.json();
  assert.equal(result.outcome, 'approved');
  assert.equal(result.operation.state, 'executed');
});

test('两步验证：启用后登录必须带码，/api/me 标记，关闭后恢复', async (t) => {
  const { salt, hash } = hashPassword('password123');
  const auth = new AuthService({ users: [{ username: 'alice', role: '员工', salt, hash }] });
  const started = await startServer({ port: 0, auth });
  t.after(() => started.close());
  const login = (code) => post(`${started.url}/api/login`, {
    username: 'alice', password: 'password123', ...(code ? { code } : {}),
  });

  const first = await login();
  const cookie = String(first.res.headers.get('set-cookie')).split(';')[0];

  const setup = await fetch(`${started.url}/api/2fa/setup`, { method: 'POST', headers: { Cookie: cookie } });
  assert.equal(setup.status, 200);
  const { secret } = await setup.json();
  const enable = await fetch(`${started.url}/api/2fa/enable`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ code: totpCode(secret) }),
  });
  assert.equal(enable.status, 200);

  const me = await fetch(`${started.url}/api/me`, { headers: { Cookie: cookie } });
  assert.equal((await me.json()).user.totpEnabled, true);

  const noCode = await login();
  assert.equal(noCode.res.status, 401);
  const wrongCode = await login('000000');
  assert.equal(wrongCode.res.status, 401);
  const withCode = await login(totpCode(secret));
  assert.equal(withCode.res.status, 200);

  const disable = await fetch(`${started.url}/api/2fa/disable`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ password: 'password123', code: totpCode(secret) }),
  });
  assert.equal(disable.status, 200);
  const afterDisable = await login();
  assert.equal(afterDisable.res.status, 200);
});

test('用户管理：管理员可列出/重置，非管理员 403', async (t) => {
  const mk = (username, role) => {
    const { salt, hash } = hashPassword('password123');
    return { username, role, salt, hash };
  };
  const auth = new AuthService({ users: [mk('admin', '管理员'), mk('alice', '员工')] });
  const started = await startServer({ port: 0, auth });
  t.after(() => started.close());
  const cookie = (name) => `sfc_session=${auth.login(name, 'password123').token}`;

  assert.equal((await fetch(`${started.url}/api/users`, { headers: { Cookie: cookie('alice') } })).status, 403);
  const list = await fetch(`${started.url}/api/users`, { headers: { Cookie: cookie('admin') } });
  assert.equal(list.status, 200);
  const users = (await list.json()).items;
  assert.deepEqual(users.map((u) => u.username), ['admin', 'alice']);

  const aliceCookie = cookie('alice');
  const reset = await fetch(`${started.url}/api/users/alice/reset-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie('admin') },
    body: JSON.stringify({ newPassword: 'resetpass123' }),
  });
  assert.equal(reset.status, 200);
  assert.equal((await fetch(`${started.url}/api/me`, { headers: { Cookie: aliceCookie } })).status, 401, '目标会话失效');
  assert.equal((await post(`${started.url}/api/login`, { username: 'alice', password: 'password123' })).res.status, 401);
  const newLogin = await post(`${started.url}/api/login`, { username: 'alice', password: 'resetpass123' });
  assert.equal(newLogin.res.status, 200);
  const freshAlice = String(newLogin.res.headers.get('set-cookie')).split(';')[0];

  const forbidden = await fetch(`${started.url}/api/users/admin/reset-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: freshAlice },
    body: JSON.stringify({ newPassword: 'whatever123' }),
  });
  assert.equal(forbidden.status, 403);
});

test('租户隔离：文档/操作/运行历史互不可见，管理员与审批角色可见', async (t) => {
  const mk = (username, role) => {
    const { salt, hash } = hashPassword('password123');
    return { username, role, salt, hash };
  };
  const auth = new AuthService({
    users: [mk('alice', '员工'), mk('bob', '员工'), mk('admin', '管理员'), mk('device', '设备助手')],
  });
  const started = await startServer({
    port: 0, auth, documentsStore: new DocumentStore(':memory:'),
  });
  t.after(() => started.close());
  const cookie = (name) => `sfc_session=${auth.login(name, 'password123').token}`;

  // 员工可以导入自己的资料（v0.33 起；owner=登录用户）
  const imported = await fetch(`${started.url}/api/documents/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie('alice') },
    body: JSON.stringify({
      filename: 'alice-note.txt',
      level: '内部',
      contentBase64: Buffer.from('Alice 私有资料\n只给 alice 看').toString('base64'),
    }),
  });
  assert.equal(imported.status, 200);
  const aliceDoc = (await imported.json()).document;
  assert.match(aliceDoc.id, /^IMP-/);

  const aliceDocs = await fetch(`${started.url}/api/documents`, { headers: { Cookie: cookie('alice') } });
  assert.ok((await aliceDocs.json()).items.some((d) => d.id === aliceDoc.id), 'alice 能看到自己导入的资料');
  const bobDocs = await fetch(`${started.url}/api/documents`, { headers: { Cookie: cookie('bob') } });
  assert.ok(!(await bobDocs.json()).items.some((d) => d.id === aliceDoc.id), 'bob 不能看到 alice 的资料');
  const adminDocs = await fetch(`${started.url}/api/documents`, { headers: { Cookie: cookie('admin') } });
  assert.ok((await adminDocs.json()).items.some((d) => d.id === aliceDoc.id), '管理员跨租户可见');
  assert.equal((await fetch(`${started.url}/api/documents/${aliceDoc.id}`, { headers: { Cookie: cookie('bob') } })).status, 404);

  // bob 显式申请 alice 的文档 ID：令牌会把它裁掉
  const crossRun = await fetch(`${started.url}/api/commands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie('bob') },
    body: JSON.stringify({
      command: '读取 Alice 私有资料', role: '员工', tools: ['readDoc'], documentIds: [aliceDoc.id],
    }),
  });
  assert.equal(crossRun.status, 200);
  const cross = await crossRun.json();
  assert.ok(!cross.documentIds.includes(aliceDoc.id), '跨租户文档不能进令牌');
  assert.ok(cross.deniedDocs.includes(aliceDoc.id), '裁剪要留痕');

  // alice 发起外发 → 冻结操作
  const sample = started.service.getDemoSamples().find((s) => s.id === 'external-confirm');
  const runRes = await fetch(`${started.url}/api/commands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie('alice') },
    body: JSON.stringify(sample),
  });
  assert.equal(runRes.status, 200);
  const run = await runRes.json();
  const op = run.operations[0];
  assert.ok(op, '应产生冻结操作');

  const aliceOps = await fetch(`${started.url}/api/operations`, { headers: { Cookie: cookie('alice') } });
  assert.ok((await aliceOps.json()).items.some((o) => o.operationId === op.operationId));
  const bobOps = await fetch(`${started.url}/api/operations`, { headers: { Cookie: cookie('bob') } });
  assert.ok(!(await bobOps.json()).items.some((o) => o.operationId === op.operationId), 'bob 不能看到 alice 的操作');
  assert.equal((await fetch(`${started.url}/api/operations/${op.operationId}`, { headers: { Cookie: cookie('bob') } })).status, 404);
  assert.equal((await fetch(`${started.url}/api/operations/${op.operationId}`, { headers: { Cookie: cookie('admin') } })).status, 200);
  assert.equal((await fetch(`${started.url}/api/operations/${op.operationId}`, { headers: { Cookie: cookie('device') } })).status, 200, '设备助手需要审批队列');

  // 运行历史
  assert.equal((await fetch(`${started.url}/api/commands/${run.runId}`, { headers: { Cookie: cookie('bob') } })).status, 404);
  const bobRuns = await fetch(`${started.url}/api/commands`, { headers: { Cookie: cookie('bob') } });
  assert.ok(!(await bobRuns.json()).items.some((r) => r.runId === run.runId));
  const adminRuns = await fetch(`${started.url}/api/commands`, { headers: { Cookie: cookie('admin') } });
  assert.ok((await adminRuns.json()).items.some((r) => r.runId === run.runId));

  // 快照计数：bob 的待确认数不应包含 alice 的操作
  const bobState = await (await fetch(`${started.url}/api/state`, { headers: { Cookie: cookie('bob') } })).json();
  assert.equal(bobState.counts.pendingOperations, 0);
  assert.ok(bobState.audit.recent.every((e) => e.actor !== 'alice'), 'bob 看不到 alice 的审计条目');
  const aliceState = await (await fetch(`${started.url}/api/state`, { headers: { Cookie: cookie('alice') } })).json();
  assert.equal(aliceState.counts.pendingOperations, 1);
});

test('坏 Cookie：不崩溃，返回 401/200', async (t) => {
  const { salt, hash } = hashPassword('password123');
  const auth = new AuthService({ users: [{ username: 'alice', role: '员工', salt, hash }] });
  const started = await startServer({ port: 0, auth });
  t.after(() => started.close());

  const health = await fetch(`${started.url}/api/health`, { headers: { Cookie: 'sfc_session=%ZZ' } });
  assert.equal(health.status, 200);
  const boot = await fetch(`${started.url}/api/bootstrap`, { headers: { Cookie: 'sfc_session=%ZZ' } });
  assert.equal(boot.status, 401);
  // 进程仍存活
  const again = await fetch(`${started.url}/api/health`);
  assert.equal(again.status, 200);
});

test('发件核对：他人记录 404，本人可核对；设备助手不能核对', async (t) => {
  const mk = (username, role) => {
    const { salt, hash } = hashPassword('password123');
    return { username, role, salt, hash };
  };
  const auth = new AuthService({
    users: [mk('alice', '员工'), mk('bob', '员工'), mk('dev', '设备助手')],
  });
  const started = await startServer({
    port: 0, auth, mailer: new FakeMailer({ behavior: 'accepted-then-timeout' }),
  });
  t.after(() => started.close());
  const cookie = (name) => `sfc_session=${auth.login(name, 'password123').token}`;

  // alice 发起外发（结果会因 accepted-then-timeout 变成 unknown）
  const run = await fetch(`${started.url}/api/commands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie('alice') },
    body: JSON.stringify(externalCommand),
  });
  assert.equal(run.status, 200);
  const op = (await run.json()).operations[0];

  const challengeRes = await fetch(`${started.url}/api/operations/${op.operationId}/challenge`, {
    method: 'POST', headers: { Cookie: cookie('alice') },
  });
  assert.equal(challengeRes.status, 200);
  const challenge = (await challengeRes.json()).challenge;

  // 设备助手批准 → 发送 unknown（不是成功）
  const decideRes = await fetch(`${started.url}/api/device/challenges/${challenge.challengeId}/decide`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie('dev') },
    body: JSON.stringify({ decision: 'approve' }),
  });
  assert.equal(decideRes.status, 200);
  const decided = await decideRes.json();
  assert.equal(decided.outcome, 'approved-but-unknown');
  assert.equal(decided.ok, false);

  const aliceView = await fetch(`${started.url}/api/operations/${op.operationId}`, {
    headers: { Cookie: cookie('alice') },
  });
  const outboxId = (await aliceView.json()).operation.outbox.outboxId;
  assert.ok(outboxId);

  const bobRead = await fetch(`${started.url}/api/operations/${op.operationId}`, {
    headers: { Cookie: cookie('bob') },
  });
  assert.equal(bobRead.status, 404, 'Bob 看不到 Alice 的操作');

  const bobReconcile = await fetch(`${started.url}/api/outbox/${encodeURIComponent(outboxId)}/reconcile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie('bob') },
    body: JSON.stringify({ state: 'sent', messageId: 'bob-forged' }),
  });
  assert.equal(bobReconcile.status, 404, 'Bob 不能改 Alice 的发件状态');
  assert.equal(started.service.store.getOutbox(outboxId).state, 'unknown', '状态未被改动');

  const devReconcile = await fetch(`${started.url}/api/outbox/${encodeURIComponent(outboxId)}/reconcile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie('dev') },
    body: JSON.stringify({ state: 'sent' }),
  });
  assert.equal(devReconcile.status, 403, '设备助手不参与发件核对');

  const aliceReconcile = await fetch(`${started.url}/api/outbox/${encodeURIComponent(outboxId)}/reconcile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie('alice') },
    body: JSON.stringify({ state: 'sent', messageId: 'alice-fixed' }),
  });
  assert.equal(aliceReconcile.status, 200);
  assert.equal((await aliceReconcile.json()).outbox.state, 'sent');
});
