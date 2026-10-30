# 真实 SMTP 发送（v0.21）

> 目标：把“外发邮件”从 `FakeMailer` 换成真实 SMTP，同时保住三条边界：
> **收件人白名单（fail-closed）**、**附件内容发送前重算哈希**、**SMTP 没有幂等键时结果不确定一律 unknown**。
>
> 当前状态：**适配器、白名单、附件链路、错误分类、单测已完成；真实发信尚未执行**——
> 需要你在 `prototype/config.env` 填 QQ 邮箱 **SMTP 授权码**（不是 QQ 密码）。

## 1. 配置（QQ 邮箱）

在 `prototype/config.env` 追加（该文件已 gitignore，不会进仓库）：

```bash
SAFE_OFFICE_SMTP_HOST=smtp.qq.com
SAFE_OFFICE_SMTP_PORT=465
SAFE_OFFICE_SMTP_SECURE=1
SAFE_OFFICE_SMTP_USER=1364387139@qq.com
SAFE_OFFICE_SMTP_PASS=你的QQ邮箱SMTP授权码
SAFE_OFFICE_MAIL_FROM=1364387139@qq.com
SAFE_OFFICE_MAIL_ALLOW_TO=1364387139@qq.com
# SAFE_OFFICE_SMTP_TIMEOUT_MS=20000
```

QQ 邮箱授权码在「设置 → 账户 → POP3/IMAP/SMTP 服务」里生成；**不要把授权码发到聊天/仓库**。

## 2. 安全边界

| 项 | 实现 |
|---|---|
| 收件人 | 必须在 `SAFE_OFFICE_MAIL_ALLOW_TO`；白名单为空 → 拒绝所有发送 |
| 发件人 | `SAFE_OFFICE_MAIL_FROM`，默认等于 SMTP_USER |
| 附件 | 操作冻结只存 `{name,sha256,size}`；发送前由 `DemoExecutor` 按 sha256 取回内容，取不到 → rejected |
| 配置缺失 | 配了 host 但缺 user/pass 或白名单 → 启动时明确报错并回退 FakeMailer（不会静默实发） |
| 错误分类 | 认证/收件人/报文 → `rejected`（failed）；超时/网络 → `unknown`（禁自动重试，人工核对） |
| 幂等 | SMTP 无标准幂等键；只加 `X-Idempotency-Key` 头做追踪，**不承诺只发一次** |

## 3. 先做连通性测试（单封纯文本）

```bash
cd prototype
node send-test-mail.cjs --to=1364387139@qq.com
```

成功输出 `✓ 已提交：messageId=...`；失败会打印 `rejected / timeout / unknown`，不确定时不要连续重发。

## 4. 走完整审批链发送

```bash
npm start   # 控制台默认落盘；启动日志应出现「邮件：SMTP 真实发送」
```

在命令台发起外发（例如把周例会纪要发给 `1364387139@qq.com`），流程仍是：
**规划 → 五道闸 → 冻结 → 确认 → 发送**。确认端可用控制台设备页或手机确认页。
发送前会重算正文哈希与附件内容哈希；不一致直接拒绝。

## 5. 测试（不联网）

`test/smtp-mailer.test.cjs` 6 项：

- 白名单内发送、`X-Idempotency-Key` 进入邮件头
- 白名单外/白名单为空 → rejected，且不调用 transport
- 附件 Buffer 进入 MIME；附件内容缺失 → rejected
- `EAUTH` → rejected；`ETIMEDOUT` → timeout（unknown）
- 环境变量：无 host 返回 null；缺授权码/白名单启动报错
- DemoExecutor 按 sha256 注入附件内容

## 6. 诚实边界

- 未做退信/送达回执解析；`sent` 只代表 SMTP 服务端接受，不代表对方已读。
- 未做 DKIM/SPF 配置；QQ 邮箱作为发件人可能受频控。
- 附件不加密、不扫描病毒；白名单只是限制收件人，不限制正文内容。
- 真实发信尚未在本机执行；上面的配置与测试就绪后，第一步先跑 `send-test-mail.cjs`。
