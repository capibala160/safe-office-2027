'use strict';
// 浏览器端 E2E：登录 → 工作台一键样例 → 审批页 → 上传资料 → 改密 → 退出
//             + 手机确认端：控制台发起外发 → 手机配对 → 批准 → 控制台已执行
//             + 治理页退信处理：员工发内网邮件 → 审计员粘贴 DSN → 回填退信
// 运行：npm run e2e（需要本机 Playwright Chromium；不纳入 npm test）
const test = require('node:test');
const assert = require('node:assert');
const { chromium } = require('playwright');
const { startServer } = require('../server.cjs');
const { AuthService, hashPassword } = require('../src/auth.cjs');
const { DocumentStore } = require('../src/ingest.cjs');
const { totpCode } = require('../src/totp.cjs');
const { startMcpServer } = require('../mcp-server.cjs');

async function launch(t) {
  // 优先用系统 Edge（本机已装）；没有则回退 Playwright 自带 Chromium
  let browser;
  try {
    browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge' });
  } catch {
    browser = await chromium.launch({ headless: true });
  }
  t.after(() => browser.close());
  return browser;
}

test('UI：登录 → 运行样例 → 审批页 → 上传 → 改密重登 → 退出', { timeout: 90000 }, async (t) => {
  const mk = (username, role) => {
    const { salt, hash } = hashPassword('password123');
    return { username, role, salt, hash };
  };
  const auth = new AuthService({ users: [mk('alice', '员工'), mk('admin', '管理员')] });
  const started = await startServer({ port: 0, auth, documentsStore: new DocumentStore(':memory:') });
  const browser = await launch(t);
  t.after(() => started.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));

  await page.goto(started.url, { waitUntil: 'domcontentloaded' });
  await page.waitForURL(/\/login\.html/);
  // 登录页不能有内联脚本/样式（CSP 会拦，且原生提交会把密码拼进 URL）
  assert.equal(await page.locator('script:not([src])').count(), 0);
  assert.equal(await page.locator('[style]').count(), 0);
  await page.fill('#username', 'alice');
  await page.fill('#password', 'password123');
  await page.click('#submit');
  await page.waitForURL((url) => !url.pathname.endsWith('/login.html'));
  await page.waitForSelector('#current-user:not([hidden])');
  assert.match(await page.textContent('#current-user'), /alice/);
  assert.equal(await page.locator('#role-select').isDisabled(), true, '登录角色应锁定');
  assert.equal(await page.inputValue('#role-select'), '员工');

  // 工作台一键样例：内网纪要（FakeMailer，不会真发）
  await page.waitForSelector('[data-sample="normal-minutes"]');
  await page.click('[data-sample="normal-minutes"]');
  await page.waitForSelector('#toast.show');
  assert.match(await page.textContent('#toast'), /样例执行完成/);

  // 治理页：员工不能读完整审计，但页面不能报错
  await page.goto(`${started.url}/#/governance`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#view');
  assert.match(await page.textContent('body'), /需要审计员/);

  // 审批页
  await page.goto(`${started.url}/#/approvals`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#view');
  const body = await page.textContent('body');
  assert.match(body, /审批|操作/);

  // 导入只对管理员开放：换 admin 登录
  await page.click('#btn-logout');
  await page.waitForURL(/\/login\.html/);
  await page.fill('#username', 'admin');
  await page.fill('#password', 'password123');
  await page.click('#submit');
  await page.waitForURL((url) => !url.pathname.endsWith('/login.html'));
  await page.waitForSelector('#current-user:not([hidden])');
  assert.match(await page.textContent('#current-user'), /admin/);
  assert.equal(await page.inputValue('#role-select'), '管理员');

  // 文件页：上传真实资料（.txt）并确认进入列表
  await page.goto(`${started.url}/#/files`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#doc-file');
  await page.setInputFiles('#doc-file', {
    name: 'e2e-note.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('E2E 上传测试\n第二行', 'utf8'),
  });
  await page.selectOption('#doc-level', '内部');
  await page.click('#doc-import');
  await page.waitForFunction(() => {
    const toast = document.getElementById('toast');
    return toast && toast.classList.contains('show') && toast.textContent.includes('已导入');
  }, null, { timeout: 15000 });
  // 导入标题取正文首行，不是文件名
  await page.waitForFunction(() => document.body.innerText.includes('E2E 上传测试'));

  // 改密：当前会话保留 → 退出 → 新密码登录
  await page.click('#btn-password');
  await page.waitForSelector('#password-dialog[open]');
  await page.fill('#old-password', 'password123');
  await page.fill('#new-password', 'newpassword123');
  await page.fill('#confirm-password', 'newpassword123');
  await page.click('#password-save');
  await page.waitForFunction(() => !document.getElementById('password-dialog').open);
  await page.waitForFunction(() => {
    const toast = document.getElementById('toast');
    return toast && toast.classList.contains('show') && toast.textContent.includes('密码已修改');
  }, null, { timeout: 15000 });

  await page.click('#btn-logout');
  await page.waitForURL(/\/login\.html/);
  await page.fill('#username', 'admin');
  await page.fill('#password', 'newpassword123');
  await page.click('#submit');
  await page.waitForURL((url) => !url.pathname.endsWith('/login.html'));
  await page.waitForSelector('#current-user:not([hidden])');
  assert.match(await page.textContent('#current-user'), /admin/);

  assert.deepEqual(errors, [], `页面异常：${errors.join('；')}`);
});

test('UI 两步验证：启用 → 登出 → 无码被拒 → 动态码登录', { timeout: 90000 }, async (t) => {
  const { salt, hash } = hashPassword('password123');
  const auth = new AuthService({ users: [{ username: 'alice', role: '员工', salt, hash }] });
  const started = await startServer({ port: 0, auth });
  const browser = await launch(t);
  t.after(() => started.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));

  await page.goto(started.url, { waitUntil: 'domcontentloaded' });
  await page.waitForURL(/\/login\.html/);
  await page.fill('#username', 'alice');
  await page.fill('#password', 'password123');
  await page.click('#submit');
  await page.waitForSelector('#current-user:not([hidden])');

  await page.click('#btn-password');
  await page.waitForSelector('#password-dialog[open]');
  await page.click('#btn-totp');
  await page.waitForSelector('#totp-dialog[open]');
  await page.click('#totp-setup');
  await page.waitForSelector('#totp-enable');
  const secret = (await page.textContent('#totp-body .mono')).trim();
  assert.match(secret, /^[A-Z2-7]+$/);
  await page.fill('#totp-code', totpCode(secret));
  await page.click('#totp-enable');
  await page.waitForFunction(() => !document.getElementById('totp-dialog').open);

  await page.click('#btn-logout');
  await page.waitForURL(/\/login\.html/);
  await page.fill('#username', 'alice');
  await page.fill('#password', 'password123');
  await page.click('#submit');
  await page.waitForSelector('#err:not(:empty)');
  assert.match(await page.textContent('#err'), /不正确/);

  await page.fill('#totp', totpCode(secret));
  await page.click('#submit');
  await page.waitForURL((url) => !url.pathname.endsWith('/login.html'));
  await page.waitForSelector('#current-user:not([hidden])');

  assert.deepEqual(errors, [], `页面异常：${errors.join('；')}`);
});

test('UI 租户隔离：alice 导入的资料 bob 看不到', { timeout: 90000 }, async (t) => {
  const mk = (username) => {
    const { salt, hash } = hashPassword('password123');
    return { username, role: '员工', salt, hash };
  };
  const auth = new AuthService({ users: [mk('alice'), mk('bob')] });
  const started = await startServer({ port: 0, auth, documentsStore: new DocumentStore(':memory:') });
  const browser = await launch(t);
  t.after(() => started.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));

  const login = async (name) => {
    await page.goto(started.url, { waitUntil: 'domcontentloaded' });
    await page.waitForURL(/\/login\.html/);
    await page.fill('#username', name);
    await page.fill('#password', 'password123');
    await page.click('#submit');
    await page.waitForSelector('#current-user:not([hidden])');
  };

  await login('alice');
  await page.goto(`${started.url}/#/files`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#doc-file');
  await page.setInputFiles('#doc-file', {
    name: 'tenant-a.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('租户A私有资料\n只有 alice 可见', 'utf8'),
  });
  await page.selectOption('#doc-level', '内部');
  await page.click('#doc-import');
  await page.waitForFunction(() => document.body.innerText.includes('租户A私有资料'), null, { timeout: 15000 });

  await page.click('#btn-logout');
  await page.waitForURL(/\/login\.html/);
  await login('bob');
  await page.goto(`${started.url}/#/files`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#doc-file');
  await page.waitForFunction(() => document.body.innerText.includes('共享'), null, { timeout: 15000 });
  assert.ok(!(await page.textContent('body')).includes('租户A私有资料'), 'bob 不能看到 alice 的资料');

  assert.deepEqual(errors, [], `页面异常：${errors.join('；')}`);
});

test('UI 手机确认：员工发起外发 → 手机配对 → 批准 → 控制台已执行', { timeout: 90000 }, async (t) => {
  const { salt, hash } = hashPassword('password123');
  const auth = new AuthService({ users: [{ username: 'alice', role: '员工', salt, hash }] });
  const code = 'AB12-CD34';
  const started = await startServer({ port: 0, auth, pairingCode: code, allowVirtualConfirm: false });
  const browser = await launch(t);
  t.after(() => started.close());

  const consolePage = await browser.newPage();
  const errors = [];
  consolePage.on('pageerror', (err) => errors.push(String(err)));
  await consolePage.goto(started.url, { waitUntil: 'domcontentloaded' });
  await consolePage.waitForURL(/\/login\.html/);
  await consolePage.fill('#username', 'alice');
  await consolePage.fill('#password', 'password123');
  await consolePage.click('#submit');
  await consolePage.waitForSelector('#current-user:not([hidden])');

  // 一键外发样例 → 冻结 → 发起 WS63 确认
  await consolePage.waitForSelector('[data-sample="external-confirm"]');
  await consolePage.click('[data-sample="external-confirm"]');
  await consolePage.waitForSelector('#dash-result [data-op-action="challenge"]');
  await consolePage.click('#dash-result [data-op-action="challenge"]');
  await consolePage.waitForSelector('#dev-op');

  // 手机确认端（独立上下文，走真实配对 + 端上签名）
  const phoneContext = await browser.newContext();
  const phonePage = await phoneContext.newPage();
  phonePage.on('pageerror', (err) => errors.push(String(err)));
  await phonePage.goto(`${started.url}/confirm.html`, { waitUntil: 'domcontentloaded' });
  await phonePage.waitForSelector('#pairing:not([hidden])');
  await phonePage.fill('#pairing-input', code);
  await phonePage.click('#pairing-submit');
  await phonePage.waitForSelector('#challenge:not([hidden])', { timeout: 15000 });
  await phonePage.waitForFunction(() => !document.querySelector('#approve').disabled);
  await phonePage.click('#approve');
  await phonePage.waitForSelector('#result:not([hidden])', { timeout: 15000 });
  assert.match(await phonePage.textContent('#result-title'), /已确认/);

  // 控制台：操作已执行
  await consolePage.goto(`${started.url}/#/approvals`, { waitUntil: 'domcontentloaded' });
  await consolePage.waitForSelector('#view .op-card');
  await consolePage.waitForFunction(() => document.body.innerText.includes('已执行'), null, { timeout: 15000 });
  assert.match(await consolePage.textContent('body'), /发起人：alice/);

  assert.deepEqual(errors, [], `页面异常：${errors.join('；')}`);
});

test('UI 退信处理：员工发内网邮件 → 审计员粘贴 DSN → 发件记录退信', { timeout: 90000 }, async (t) => {
  const mk = (username, role) => {
    const { salt, hash } = hashPassword('password123');
    return { username, role, salt, hash };
  };
  const auth = new AuthService({ users: [mk('emp', '员工'), mk('auditor', '审计员')] });
  const started = await startServer({ port: 0, auth });
  const browser = await launch(t);
  t.after(() => started.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));

  const login = async (name) => {
    await page.goto(started.url, { waitUntil: 'domcontentloaded' });
    await page.waitForURL(/\/login\.html/);
    await page.fill('#username', name);
    await page.fill('#password', 'password123');
    await page.click('#submit');
    await page.waitForSelector('#current-user:not([hidden])');
  };

  // 员工：内网纪要样例 → 策略自动确认 → FakeMailer 发送成功
  await login('emp');
  await page.waitForSelector('[data-sample="normal-minutes"]');
  await page.click('[data-sample="normal-minutes"]');
  await page.waitForFunction(() => {
    const toast = document.getElementById('toast');
    return toast && toast.classList.contains('show') && toast.textContent.includes('样例执行完成');
  }, null, { timeout: 15000 });
  const outbox = started.service.store.listOutbox().find((row) => row.state === 'sent');
  assert.ok(outbox && outbox.messageId, '应有已发送记录');

  // 审计员：治理页粘贴退信
  await page.click('#btn-logout');
  await page.waitForURL(/\/login\.html/);
  await login('auditor');
  await page.goto(`${started.url}/#/governance`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#bounce-eml');
  const dsn = [
    'From: Mail Delivery Subsystem <mailer-daemon@example.com>',
    'Subject: Delivery Status Notification',
    'Content-Type: multipart/report; report-type=delivery-status; boundary="E2E-B"',
    '',
    '--E2E-B',
    'Content-Type: message/delivery-status',
    '',
    'Reporting-MTA: dns; mx.example.com',
    '',
    'Final-Recipient: rfc822; team@corp.internal',
    'Action: failed',
    'Status: 5.1.1',
    'Diagnostic-Code: smtp; 550 5.1.1 unknown user',
    '',
    '--E2E-B',
    'Content-Type: message/rfc822',
    '',
    `Message-ID: <${outbox.messageId}>`,
    '',
    '--E2E-B--',
    '',
  ].join('\r\n');
  await page.fill('#bounce-eml', dsn);
  await page.click('#bounce-ingest');
  await page.waitForFunction(() => {
    const toast = document.getElementById('toast');
    return toast && toast.classList.contains('show') && toast.textContent.includes('已回填 1 条退信');
  }, null, { timeout: 15000 });
  assert.match(await page.textContent('#bounce-result'), /回填 1/);
  assert.equal(started.service.store.getOutbox(outbox.outboxId).state, 'bounced');
  assert.match(await page.textContent('body'), /退信处理/);

  assert.deepEqual(errors, [], `页面异常：${errors.join('；')}`);
});

test('UI MCP 接入：管理员在治理页发现并注册 MCP 工具', { timeout: 90000 }, async (t) => {
  const mcp = await startMcpServer({ port: 0 });
  t.after(() => mcp.close());
  const { salt, hash } = hashPassword('password123');
  const auth = new AuthService({ users: [{ username: 'admin', role: '管理员', salt, hash }] });
  const started = await startServer({ port: 0, auth });
  const browser = await launch(t);
  t.after(() => started.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));

  await page.goto(started.url, { waitUntil: 'domcontentloaded' });
  await page.waitForURL(/\/login\.html/);
  await page.fill('#username', 'admin');
  await page.fill('#password', 'password123');
  await page.click('#submit');
  await page.waitForSelector('#current-user:not([hidden])');

  await page.goto(`${started.url}/#/governance`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#mcp-url');
  await page.fill('#mcp-url', mcp.url);
  await page.click('#mcp-discover');
  await page.waitForSelector('[data-mcp-tool]', { timeout: 15000 });
  assert.equal(await page.locator('[data-mcp-tool]').count(), 2);

  await page.click('#mcp-register');
  await page.waitForFunction(() => {
    const toast = document.getElementById('toast');
    return toast && toast.classList.contains('show') && toast.textContent.includes('MCP 工具已注册');
  }, null, { timeout: 15000 });

  // 重渲染后工具注册表里应出现 mcp_ 前缀工具
  await page.waitForFunction(() => document.body.innerText.includes('mcp_wordCount'), null, { timeout: 15000 });
  assert.ok((await page.textContent('body')).includes('mcp_echo'));
  assert.ok(started.service.toolRegistry.get('mcp_wordCount'));

  assert.deepEqual(errors, [], `页面异常：${errors.join('；')}`);
});
