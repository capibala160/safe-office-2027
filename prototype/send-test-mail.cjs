#!/usr/bin/env node
'use strict';
// 真实 SMTP 连通性测试：只发一封纯文本，不带附件、不走审批链。
// 用法：node send-test-mail.cjs [--to=1364387139@qq.com]
// 配置全部从 config.env / 环境变量读；收件人必须在 SAFE_OFFICE_MAIL_ALLOW_TO 里。
const path = require('node:path');
const { loadConfigFile } = require('./src/load-config.cjs');
const { createSmtpMailerFromEnv } = require('./src/smtp-mailer.cjs');
const { MailerError } = require('./src/mailer.cjs');

const info = loadConfigFile(path.join(__dirname, 'config.env'));
const toArg = process.argv.find((a) => a.startsWith('--to='));
const to = toArg ? toArg.slice('--to='.length) : '';

(async () => {
  const mailer = createSmtpMailerFromEnv();
  if (!mailer) {
    console.error('未配置 SMTP：请在 config.env 填 SAFE_OFFICE_SMTP_HOST/USER/PASS 与 SAFE_OFFICE_MAIL_ALLOW_TO');
    process.exitCode = 1;
    return;
  }
  const recipient = to || mailer.allowTo[0];
  console.log(`配置：config.env ${info.loaded} 项；SMTP ${mailer.host}:${mailer.port}；白名单 ${mailer.allowTo.join(', ')}`);
  console.log(`发送测试邮件 → ${recipient}`);
  try {
    const result = await mailer.send({
      operation: {
        recipient,
        subject: '安全智慧办公 · SMTP 连通性测试',
        body: `这是一封自动测试邮件。\n时间：${new Date().toISOString()}\n如果收到，说明 SMTP 配置可用。`,
      },
      idempotencyKey: `manual-test-${Date.now()}`,
    });
    console.log(`✓ 已提交：messageId=${result.messageId || '(服务端未返回)'}`);
  } catch (err) {
    const kind = err instanceof MailerError ? err.kind : 'unknown';
    console.error(`✗ 发送失败（${kind}）：${err.message}`);
    if (kind !== 'rejected') console.error('  结果可能不确定，不要立刻重复发送；先到邮箱确认。');
    process.exitCode = 1;
  }
})();
