'use strict';
// 手动验证（不进 CI）：文件页上传音频 → 真实腾讯云一句话识别 → 结果入知识库
// 用法：node e2e/audio-check.cjs <音频文件>
const path = require('node:path');
const { loadConfigFile } = require('../src/load-config.cjs');

loadConfigFile(path.join(__dirname, '..', 'config.env'));
const { startServer } = require('../server.cjs');
const { chromium } = require('playwright');

const file = process.argv[2];
if (!file) {
  console.error('用法：node e2e/audio-check.cjs <wav|mp3|m4a>');
  process.exit(2);
}

(async () => {
  const started = await startServer({ port: 0 });
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge' })
    .catch(() => chromium.launch({ headless: true }));
  try {
    const page = await browser.newPage();
    page.on('pageerror', (err) => console.log('PAGEERR:', err.message));
    await page.goto(`${started.url}/#/files`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#audio-file');
    await page.setInputFiles('#audio-file', file);
    await page.fill('#audio-title', 'E2E 录音');
    await page.click('#audio-transcribe');
    await page.waitForFunction(
      () => /转写稿已入知识库/.test(document.querySelector('#audio-result')?.textContent || ''),
      { timeout: 60000 },
    );
    const text = (await page.textContent('#audio-result')).replace(/\s+/g, ' ').trim();
    console.log('RESULT:', text.slice(0, 160));
    const tainted = text.includes('已隔离');
    console.log('TAINTED:', tainted);
    console.log('AUDIO-E2E OK');
  } finally {
    await browser.close();
    await started.close();
  }
})().catch((err) => { console.error('FAIL', err.message); process.exit(1); });
