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

  // 工作台：任务输入 + 快捷填入
  await page.waitForSelector('#dash-command');
  await page.click('[data-quick="纪要"]');
  assert.match(await page.inputValue('#dash-command'), /周例会/);

  // 演示场景：一键样例（内网纪要，FakeMailer，不会真发）
  await page.goto(`${started.url}/#/demo`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-sample="normal-minutes"]');
  await page.click('[data-sample="normal-minutes"]');
  await page.waitForSelector('#toast.show');
  assert.match(await page.textContent('#toast'), /样例执行完成/);

  // 任务内确认：外发样例 → 发起确认 → 抽屉批准（不再跳设备页）
  await page.click('[data-sample="external-confirm"]');
  await page.waitForSelector('[data-op-action="challenge"]', { timeout: 15000 });
  await page.click('[data-op-action="challenge"]');
  await page.waitForSelector('#confirm-drawer', { timeout: 15000 });
  assert.match(await page.textContent('#confirm-drawer'), /partner@partner-example\.com/);
  // 四眼原则：员工可以发起，但不能代替设备助手批准
  assert.equal(await page.locator('#drawer-approve').count(), 0, '员工不应看到直接批准按钮');
  assert.match(await page.textContent('#confirm-drawer'), /设备助手/);
  await page.click('#drawer-close-ok');
  await page.waitForSelector('#confirm-drawer', { state: 'detached' });

  // 治理页：员工不能读完整审计，但页面不能报错
  await page.goto(`${started.url}/#/governance`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#view');
  assert.match(await page.textContent('body'), /需要审计员/);

  // 审批页
  await page.goto(`${started.url}/#/approvals`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#view');
  const body = await page.textContent('body');
  assert.match(body, /审批|操作/);

  // 设备页：屏幕共享卡片（真实投屏入口）存在且默认目标正确
  await page.goto(`${started.url}/#/device`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#share-start');
  assert.equal(await page.locator('#share-target').inputValue(), '会议室大屏');
  assert.ok(await page.locator('#share-stop').isDisabled());

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
  await page.waitForSelector('#audio-transcribe');
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
  // v0.53.3：打开即自动生成二维码，无需再点“生成密钥”
  await page.waitForSelector('#totp-qr');
  assert.match(await page.getAttribute('#totp-qr', 'src'), /^data:image\//, '应自动显示 TOTP 二维码');
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
  await consolePage.goto(`${started.url}/#/demo`, { waitUntil: 'domcontentloaded' });
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
  await page.goto(`${started.url}/#/demo`, { waitUntil: 'domcontentloaded' });
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

test('UI 设备确认：员工发起外发 → 设备助手在工作台抽屉批准 → 操作已执行', { timeout: 90000 }, async (t) => {
  const mk = (username, role) => {
    const { salt, hash } = hashPassword('password123');
    return { username, role, salt, hash };
  };
  const auth = new AuthService({ users: [mk('emp', '员工'), mk('dev', '设备助手')] });
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

  // 员工：冻结一条外发，不发起挑战
  await login('emp');
  await page.goto(`${started.url}/#/demo`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-sample="external-confirm"]');
  await page.click('[data-sample="external-confirm"]');
  await page.waitForSelector('#dash-result [data-op-action="challenge"]', { timeout: 15000 });
  const op = started.service.store.listOperations()[0];
  assert.ok(op && op.state === 'frozen');

  // 发起人先发起确认（员工不能自己批准）
  await page.click('#dash-result [data-op-action="challenge"]');
  await page.waitForSelector('#confirm-drawer', { timeout: 15000 });
  assert.equal(await page.locator('#drawer-approve').count(), 0, '员工不应看到直接批准按钮');
  await page.click('#drawer-close-ok');
  await page.waitForSelector('#confirm-drawer', { state: 'detached' });

  // 设备助手：换人后在工作台待办里直接确认（四眼原则：不能是自己发起的）
  await page.click('#btn-logout');
  await page.waitForURL(/\/login\.html/);
  await login('dev');
  await page.waitForSelector('[data-op-action="challenge"]', { timeout: 15000 });
  await page.click('[data-op-action="challenge"]');
  await page.waitForSelector('#confirm-drawer', { timeout: 15000 });
  assert.match(await page.textContent('#confirm-drawer'), /partner@partner-example\.com/);
  await page.click('#drawer-approve');
  await page.waitForSelector('#drawer-done', { timeout: 15000 });
  assert.match(await page.textContent('#drawer-result'), /已批准/);
  await page.click('#drawer-done');
  await page.waitForSelector('#confirm-drawer', { state: 'detached' });

  const executed = started.service.store.getOperation(op.operationId);
  assert.equal(executed.state, 'executed');
  assert.equal(started.service.store.getOutboxByOperation(op.operationId).state, 'sent');

  await page.goto(`${started.url}/#/approvals`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.innerText.includes('已执行'), null, { timeout: 15000 });

  assert.deepEqual(errors, [], `页面异常：${errors.join('；')}`);
});

test('UI 文档共享：alice 导入并共享给 bob → bob 看到共享给我 → 撤销后消失', { timeout: 90000 }, async (t) => {
  const mk = (username, role) => {
    const { salt, hash } = hashPassword('password123');
    return { username, role, salt, hash };
  };
  const auth = new AuthService({ users: [mk('alice', '员工'), mk('bob', '员工')] });
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
    await page.waitForURL((url) => !url.pathname.endsWith('/login.html'));
    await page.waitForSelector('#current-user:not([hidden])');
  };

  await login('alice');
  await page.goto(`${started.url}/#/files`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#doc-file');
  await page.setInputFiles('#doc-file', {
    name: 'e2e-share.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('共享测试资料\n第二行', 'utf8'),
  });
  await page.selectOption('#doc-level', '内部');
  await page.click('#doc-import');
  await page.waitForFunction(() => document.body.innerText.includes('共享测试资料'), null, { timeout: 15000 });

  // 所有者共享给 bob
  await page.locator('tr', { hasText: '共享测试资料' }).first().locator('[data-share]').click();
  await page.waitForSelector('#share-target');
  await page.selectOption('#share-target', 'bob');
  await page.click('#share-add');
  await page.waitForFunction(() => {
    const toast = document.getElementById('toast');
    return toast && toast.textContent.includes('已共享给 bob');
  }, null, { timeout: 15000 });

  // bob 登录：文档可见并标「共享给我」
  await page.click('#btn-logout');
  await page.waitForURL(/\/login\.html/);
  await login('bob');
  await page.goto(`${started.url}/#/files`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.innerText.includes('共享测试资料'), null, { timeout: 15000 });
  assert.match(await page.textContent('body'), /共享给我/);

  // alice 撤销后，bob 不再可见
  await page.click('#btn-logout');
  await page.waitForURL(/\/login\.html/);
  await login('alice');
  await page.goto(`${started.url}/#/files`, { waitUntil: 'domcontentloaded' });
  await page.locator('tr', { hasText: '共享测试资料' }).first().locator('[data-share]').click();
  await page.waitForSelector('[data-share-revoke="bob"]');
  await page.click('[data-share-revoke="bob"]');
  await page.waitForFunction(() => {
    const toast = document.getElementById('toast');
    return toast && toast.textContent.includes('已撤销');
  }, null, { timeout: 15000 });

  await page.click('#btn-logout');
  await page.waitForURL(/\/login\.html/);
  await login('bob');
  await page.goto(`${started.url}/#/files`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#view');
  await page.waitForTimeout(500);
  assert.ok(!(await page.textContent('body')).includes('共享测试资料'), '撤销后 bob 不应再看到该文档');

  assert.deepEqual(errors, [], `页面异常：${errors.join('；')}`);
});

// ---------- v0.47 新增：审计快照 / 账号禁用 / 自动回信 ----------
function e2eUser(username, role) {
  const { salt, hash } = hashPassword('password123');
  return { username, role, salt, hash };
}

async function e2eLogin(page, base, name, password = 'password123') {
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForURL(/\/login\.html/);
  await page.fill('#username', name);
  await page.fill('#password', password);
  await page.click('#submit');
  await page.waitForURL((url) => !url.pathname.endsWith('/login.html'));
  await page.waitForSelector('#current-user:not([hidden])');
}

test('UI：审计外部快照导出与校验', { timeout: 90000 }, async (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { ConsoleService } = require('../src/console-service.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-office-e2e-export-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const auth = new AuthService({ users: [e2eUser('admin', '管理员')] });
  const service = new ConsoleService({
    storeFile: ':memory:',
    auditFile: path.join(dir, 'audit.jsonl'),
    auditCheckpointFile: path.join(dir, 'audit.jsonl.head'),
    auditTenantCheckpointFile: path.join(dir, 'audit.tenants.json'),
    auditArchiveDir: path.join(dir, 'audit-archive'),
    auditExternalDir: path.join(dir, 'external'),
  });
  service.audit.append('E2E 预置', { ok: true });
  const started = await startServer({ port: 0, service, auth });
  t.after(() => started.close());
  const browser = await launch(t);
  const page = await browser.newPage();

  await e2eLogin(page, started.url, 'admin');
  await page.goto(`${started.url}/#/governance`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#gov-export');
  await page.click('#gov-export');
  await page.waitForFunction(() => {
    const box = document.getElementById('gov-export-result');
    return box && box.textContent.includes('已导出');
  }, null, { timeout: 15000 });

  await page.click('#gov-verify-export');
  await page.waitForFunction(() => {
    const box = document.getElementById('gov-export-result');
    return box && box.textContent.includes('校验：通过');
  }, null, { timeout: 15000 });
  assert.match(await page.textContent('#gov-export-result'), /检查 \d+\/\d+ 个文件/);
});

test('UI：管理员禁用账号后该账号无法登录', { timeout: 90000 }, async (t) => {
  const auth = new AuthService({ users: [e2eUser('admin', '管理员'), e2eUser('alice', '员工')] });
  const started = await startServer({ port: 0, auth });
  t.after(() => started.close());
  const browser = await launch(t);
  const page = await browser.newPage();
  page.on('dialog', (dialog) => dialog.accept());

  await e2eLogin(page, started.url, 'admin');
  await page.goto(`${started.url}/#/governance`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-toggle-user="alice"]');
  await page.click('[data-toggle-user="alice"]');
  await page.waitForFunction(() => {
    const toast = document.getElementById('toast');
    return toast && toast.textContent.includes('已禁用「alice」');
  }, null, { timeout: 15000 });

  await page.click('#btn-logout');
  await page.waitForURL(/\/login\.html/);
  await page.fill('#username', 'alice');
  await page.fill('#password', 'password123');
  await page.click('#submit');
  await page.waitForFunction(() => {
    const err = document.getElementById('err');
    return err && err.textContent.trim().length > 0;
  }, null, { timeout: 15000 });
  assert.match(await page.url(), /\/login\.html/);
  assert.match(await page.textContent('#err'), /不正確|不正确|禁用|INVALID|用户名/);
});

test('UI：管理员在治理页新增账号并可登录', { timeout: 90000 }, async (t) => {
  const auth = new AuthService({ users: [e2eUser('admin', '管理员')] });
  const started = await startServer({ port: 0, auth });
  t.after(() => started.close());
  const browser = await launch(t);
  const page = await browser.newPage();

  await e2eLogin(page, started.url, 'admin');
  await page.goto(`${started.url}/#/governance`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#new-user-name');
  await page.fill('#new-user-name', 'bob');
  await page.selectOption('#new-user-role', '员工');
  await page.fill('#new-user-pass', 'password123');
  await page.click('#gov-create-user');
  await page.waitForFunction(() => {
    const toast = document.getElementById('toast');
    return toast && toast.textContent.includes('已新增「bob」');
  }, null, { timeout: 15000 });
  await page.waitForSelector('[data-reset-user="bob"]');

  await page.click('#btn-logout');
  await page.waitForURL(/\/login\.html/);
  await page.fill('#username', 'bob');
  await page.fill('#password', 'password123');
  await page.click('#submit');
  await page.waitForURL((url) => !url.pathname.endsWith('/login.html'));
  await page.waitForSelector('#current-user:not([hidden])');
  assert.match(await page.textContent('#current-user'), /bob/);
});

test('UI：审计员按策略自动回信（固定模板，不读来信正文）', { timeout: 90000 }, async (t) => {
  const { ConsoleService } = require('../src/console-service.cjs');
  const auth = new AuthService({ users: [e2eUser('auditor', '审计员')] });
  let seq = 0;
  const inboxReader = {
    async fetch() {
      seq += 1;
      const sender = `inbox${seq}@partner-example.com`;
      return {
        items: [{
          uid: seq,
          from: sender,
          date: new Date().toISOString(),
          messageId: `<e2e-${seq}@partner-example.com>`,
          headers: { 'message-id': `<e2e-${seq}@partner-example.com>`, from: sender },
        }],
      };
    },
  };
  const autoReplyPolicy = {
    enabled: true,
    allow: [{ domain: 'partner-example.com' }],
    subject: '自动回复：已收到您的来信',
    template: '您好，已收到您的来信。',
    account: '',
    maxPerHour: 5,
    perSenderHours: 24,
    maxAgeHours: 24,
    maxPerScan: 10,
    pollMs: 600000,
  };
  const service = new ConsoleService({ storeFile: ':memory:', inboxReader, autoReplyPolicy });
  const started = await startServer({ port: 0, service, auth });
  t.after(() => started.close());
  const browser = await launch(t);
  const page = await browser.newPage();

  await e2eLogin(page, started.url, 'auditor');
  await page.goto(`${started.url}/#/mail`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#auto-reply-scan');
  await page.click('#auto-reply-scan');
  await page.waitForFunction(() => {
    const box = document.getElementById('auto-reply-result');
    return box && box.textContent.includes('已回 1 封');
  }, null, { timeout: 20000 });
  assert.match(await page.textContent('#auto-reply-result'), /扫描 \d+ 封/);
});

test('UI：风险说明可定位到隔离原文并展示移除的动作', { timeout: 45000 }, async (t) => {
  const started = await startServer({ port: 0 });
  t.after(() => started.close());
  const browser = await launch(t);
  const page = await browser.newPage();
  await page.goto(`${started.url}/#/demo`);
  await page.click('[data-sample="injection"]');
  const result = page.locator('#dash-result');
  await result.getByText('已移除动作 · 对外发邮件').waitFor();
  await result.getByRole('button', { name: '查看命中原文' }).click();
  const match = result.locator('mark.risk-match').first();
  await match.waitFor();
  assert.match(await match.textContent(), /忽略以上所有指令/);
  assert.equal(await match.evaluate((element) => element === document.activeElement), true);
  assert.equal(await result.locator('[data-op-action="challenge"]').count(), 0);
});

test('UI：任务状态查询断线后恢复，提交只发生一次', { timeout: 45000 }, async (t) => {
  const started = await startServer({ port: 0 });
  t.after(() => started.close());
  const browser = await launch(t);
  const page = await browser.newPage();
  let submissions = 0;
  const queriedRuns = [];
  await page.route('**/api/commands/async', async (route) => {
    submissions += 1;
    await route.continue();
  });
  await page.route(/\/api\/commands\/RUN-\d+$/, async (route) => {
    queriedRuns.push(new URL(route.request().url()).pathname);
    if (queriedRuns.length === 1) await route.abort('internetdisconnected');
    else await route.continue();
  });

  await page.goto(started.url);
  await page.click('[data-quick="外发"]');
  await page.click('#dash-start');
  await page.click('#cmd-run');
  const connection = page.locator('#run-connection');
  await connection.waitFor();
  assert.match(await connection.innerText(), /连接恢复后会继续查询此任务/);
  assert.equal(await page.locator('#cmd-run').isDisabled(), true);
  assert.equal(await page.locator('#run-cancel').isDisabled(), true);

  await page.locator('#cmd-result .op-card').waitFor();
  assert.equal(submissions, 1);
  assert.ok(queriedRuns.length >= 2);
  assert.equal(new Set(queriedRuns).size, 1);
  assert.equal(await page.locator('#cmd-run').isEnabled(), true);
});

test('UI：提交超时未收到回执 → 暂停重提并引导工作台', { timeout: 30000 }, async (t) => {
  const started = await startServer({ port: 0 });
  t.after(() => started.close());
  const browser = await launch(t);
  const page = await browser.newPage();
  await page.addInitScript(() => { window.SAFE_OFFICE_POST_TIMEOUT_MS = 300; });
  let submissions = 0;
  await page.route('**/api/commands/async', async (route) => {
    submissions += 1;
    await new Promise((resolve) => setTimeout(resolve, 2500));
    try { await route.continue(); } catch { /* 测试已结束 */ }
  });

  await page.goto(started.url);
  await page.click('[data-quick="外发"]');
  await page.click('#dash-start');
  await page.click('#cmd-run');
  const notice = page.locator('#cmd-result .notice.block');
  await notice.waitFor();
  assert.match(await notice.innerText(), /未收到提交回执/);
  assert.match(await notice.innerText(), /工作台/);
  assert.equal(submissions, 1, '超时后不得自动重提');
  assert.equal(await page.locator('#cmd-run').isDisabled(), true);
  assert.equal(await page.locator('#cmd-clear').isDisabled(), true);
});

test('UI：多次查询失败后暂停自动重连，可手动继续', { timeout: 45000 }, async (t) => {
  const started = await startServer({ port: 0 });
  t.after(() => started.close());
  const browser = await launch(t);
  const page = await browser.newPage();
  await page.addInitScript(() => { window.SAFE_OFFICE_POLL_MAX_RETRIES = 2; });
  let failing = true;
  await page.route(/\/api\/commands\/RUN-\d+$/, async (route) => {
    if (failing) await route.abort('internetdisconnected');
    else await route.continue();
  });

  await page.goto(started.url);
  await page.click('[data-quick="外发"]');
  await page.click('#dash-start');
  await page.click('#cmd-run');
  await page.waitForFunction(() => {
    const el = document.getElementById('run-connection');
    return el && !el.hidden && el.textContent.includes('自动重连已暂停');
  }, null, { timeout: 20000 });
  const connection = page.locator('#run-connection');
  assert.match(await connection.innerText(), /已保留最后收到的进度/);
  assert.equal(await page.locator('#cmd-run').isDisabled(), true, '暂停期间不能重复提交');
  assert.equal(await page.locator('#run-cancel').isDisabled(), true);

  failing = false;
  await page.click('#run-retry');
  await page.locator('#cmd-result .op-card').waitFor({ timeout: 20000 });
  assert.equal(await page.locator('#cmd-run').isEnabled(), true);
});

test('UI：对照收件人和同名附件改动，撤销旧挑战后核对新回执', { timeout: 60000 }, async (t) => {
  const password = hashPassword('password123');
  const auth = new AuthService({ users: [
    { username: 'emp', role: '员工', ...password },
    { username: 'dev', role: '设备助手', ...password },
  ] });
  const started = await startServer({ port: 0, auth });
  t.after(() => started.close());
  const browser = await launch(t);
  const logIn = async (username) => {
    const page = await browser.newPage();
    await page.goto(started.url);
    await page.fill('#username', username);
    await page.fill('#password', 'password123');
    await page.click('#submit');
    await page.waitForSelector('#current-user:not([hidden])');
    return page;
  };
  const file = (content) => ({ name: 'agenda.txt', mimeType: 'text/plain', buffer: Buffer.from(content) });
  const employee = await logIn('emp');
  await employee.click('[data-quick="外发"]');
  await employee.click('#dash-start');
  await employee.locator('#cmd-files').setInputFiles(file('Agenda: initial draft'));
  await employee.click('#cmd-run');
  const initialResult = employee.locator('#cmd-result .op-card');
  await initialResult.locator('[data-op-action="challenge"]').click();
  await employee.click('#drawer-close-ok');
  const original = started.service.store.listOperations()[0];
  const oldChallenge = started.service.listOperations({ actor: 'emp', role: '员工' }).items[0].challenge;
  await initialResult.locator('[data-op-action="detail"]').click();
  await employee.getByText('修改收件人与附件', { exact: true }).click();
  await employee.fill('#op-replace-to', 'review@partner-example.com');
  await employee.locator('#op-replace button').click();
  await employee.locator('#cmd-files').setInputFiles(file('Agenda: updated draft'));
  assert.match(await employee.locator('#cmd-comparison').innerText(), /review@partner-example\.com/);
  assert.equal(started.service.store.getOperation(original.operationId).state, 'rejected');
  assert.equal(started.service.challenges.get(oldChallenge.challengeId).state, 'expired');
  await employee.click('#cmd-run');
  const comparison = employee.locator('#cmd-result .mail-comparison');
  await comparison.waitFor();
  assert.match(await comparison.innerText(), /agenda\.txt\s+已移除[\s\S]*agenda\.txt\s+已加入/);
  await employee.reload();
  await comparison.waitFor();
  assert.match(await comparison.innerText(), /partner@partner-example\.com[\s\S]*review@partner-example\.com/);
  await employee.locator('#cmd-result [data-op-action="challenge"]').click();
  await employee.click('#drawer-close-ok');

  const helper = await logIn('dev');
  await helper.locator('[data-op-action="challenge"]').click();
  assert.match(await helper.locator('#confirm-drawer').innerText(), /review@partner-example\.com[\s\S]*agenda\.txt/);
  await helper.click('#drawer-approve');
  await helper.locator('#drawer-result').getByText(/回执编号/).waitFor();
  assert.equal(await helper.locator('#drawer-result a').count(), 0);
  await employee.locator('#cmd-result').getByText('查看本任务回放').click();
  await employee.locator('.receipt-item').waitFor();
  assert.match(await employee.locator('.receipt-item').innerText(), /review@partner-example\.com/);
  assert.equal(started.service.store.listOperations().filter((operation) => operation.state === 'executed').length, 1);
});

test('UI：任务回放页展示批准/回执与审计完整性', { timeout: 60000 }, async (t) => {
  const mk = (username, role) => {
    const { salt, hash } = hashPassword('password123');
    return { username, role, salt, hash };
  };
  const auth = new AuthService({ users: [mk('alice', '员工')] });
  const started = await startServer({ port: 0, auth, documentsStore: new DocumentStore(':memory:') });
  t.after(() => started.close());
  const browser = await launch(t);
  const page = await browser.newPage();

  await e2eLogin(page, started.url, 'alice');
  await page.goto(`${started.url}/#/demo`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-sample="normal-minutes"]');
  await page.click('[data-sample="normal-minutes"]');
  await page.waitForSelector('#toast.show');

  assert.equal(await page.locator('a[href="#/replay"]').count(), 1, '侧栏应有任务回放入口');
  await page.goto(`${started.url}/#/replay`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => {
      const el = document.getElementById('replay-out');
      return el && el.textContent.trim().length > 0;
    },
    null,
    { timeout: 20000 },
  );
  const text = await page.textContent('#replay-out');
  assert.match(text, /批准与回执/, `回放内容：${text.slice(0, 300)}`);
  assert.match(text, /审计链通过/, `回放内容：${text.slice(0, 300)}`);
  assert.match(text, /闸与风险事件/);
});
