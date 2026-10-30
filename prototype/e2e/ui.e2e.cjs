'use strict';
// 浏览器端 E2E：登录 → 工作台一键样例 → 审批页 → 退出
// 运行：npm run e2e（需要本机 Playwright Chromium；不纳入 npm test）
const test = require('node:test');
const assert = require('node:assert');
const { chromium } = require('playwright');
const { startServer } = require('../server.cjs');
const { AuthService, hashPassword } = require('../src/auth.cjs');

test('UI：登录 → 运行样例 → 打开审批页 → 退出', { timeout: 90000 }, async (t) => {
  const { salt, hash } = hashPassword('password123');
  const auth = new AuthService({ users: [{ username: 'alice', role: '员工', salt, hash }] });
  const started = await startServer({ port: 0, auth });
  // 优先用系统 Edge（本机已装）；没有则回退 Playwright 自带 Chromium
  let browser;
  try {
    browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge' });
  } catch {
    browser = await chromium.launch({ headless: true });
  }
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));

  t.after(async () => {
    await browser.close();
    await started.close();
  });

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

  // 退出
  await page.click('#btn-logout');
  await page.waitForURL(/\/login\.html/);
  assert.deepEqual(errors, [], `页面异常：${errors.join('；')}`);
});
