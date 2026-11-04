'use strict';
// 手动验证（不进 CI）：真实点击「开始共享」→ getDisplayMedia → 状态徽章 → 停止
// 用 --auto-select-desktop-capture-source 跳过系统选屏窗口（自动化无法点原生对话框）
const { chromium } = require('playwright');
const { startServer } = require('../server.cjs');
const { AuthService, hashPassword } = require('../src/auth.cjs');
const { DocumentStore } = require('../src/ingest.cjs');

(async () => {
  const mk = (username, role) => {
    const { salt, hash } = hashPassword('password123');
    return { username, role, salt, hash };
  };
  const auth = new AuthService({ users: [mk('alice', '员工'), mk('admin', '管理员')] });
  const started = await startServer({ port: 0, auth, documentsStore: new DocumentStore(':memory:') });
  const browser = await chromium.launch({
    headless: false,
    channel: 'msedge',
    args: [
      '--auto-select-desktop-capture-source=Entire screen',
      '--use-fake-ui-for-media-stream',
      '--enable-usermedia-screen-capturing',
    ],
  });
  try {
    const page = await browser.newPage();
    page.on('pageerror', (err) => console.log('PAGEERR:', err.message));
    await page.goto(started.url, { waitUntil: 'domcontentloaded' });
    await page.waitForURL(/\/login\.html/);
    await page.fill('#username', 'alice');
    await page.fill('#password', 'password123');
    await page.click('#submit');
    await page.waitForURL((u) => !u.pathname.endsWith('/login.html'));
    await page.goto(`${started.url}/#/device`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#share-start');

    await page.click('#share-start');
    await page.waitForFunction(() => /共享中/.test(document.querySelector('#share-status')?.textContent || ''), { timeout: 20000 })
      .catch(async () => {
        throw new Error(`开始共享失败，状态：${await page.textContent('#share-status')}`);
      });
    console.log('STATUS1:', (await page.textContent('#share-status')).trim());

    const videoVisible = await page.locator('#share-video').isVisible();
    console.log('VIDEO_VISIBLE:', videoVisible);

    await page.click('#share-stop');
    await page.waitForFunction(() => /已停止/.test(document.querySelector('#share-status')?.textContent || ''), { timeout: 10000 });
    console.log('STATUS2:', (await page.textContent('#share-status')).trim());
    console.log('SHARE-E2E OK');
  } finally {
    await browser.close();
    await started.close();
  }
})().catch((err) => { console.error('FAIL', err.message); process.exit(1); });
