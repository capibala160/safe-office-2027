# IMAP 退信自动收取（v0.40）

> v0.35 的退信处理只能人工把 `.eml` 粘进治理页。本轮加 IMAP 轮询：
> 定时拉未读邮件，只认 DSN 退信，自动回填发件记录。

## 1. 配置

```ini
SAFE_OFFICE_IMAP_HOST=imap.qq.com
SAFE_OFFICE_IMAP_PORT=993
SAFE_OFFICE_IMAP_SECURE=1
SAFE_OFFICE_IMAP_USER=you@qq.com
SAFE_OFFICE_IMAP_PASS=授权码
SAFE_OFFICE_IMAP_MAILBOX=INBOX
SAFE_OFFICE_IMAP_POLL_MS=60000
SAFE_OFFICE_IMAP_MAX=20
```

- 依赖 `imapflow`（可选加载：没装时只有启用 IMAP 才报错）。
- QQ 邮箱需先在网页版「设置 → 账号」里**开启 IMAP 服务**；密码填授权码（与 SMTP 同一套）。
- 未配置 host → 不启动轮询，控制台行为与 v0.35 一致。

## 2. 轮询规则

1. 只搜**未读**（`seen: false`），每轮最多 `SAFE_OFFICE_IMAP_MAX` 封；
   **游标轮转**：从上一轮扫到的 UID 之后继续、扫到尾部绕回开头，普通邮件不会永远占住前 N 封；
   确认不是退信的 UID 记入内存跳过再次抓取（**不标已读**）；
2. 取原始邮件 → `parseDsn`：
   - 不是退信 / 没有收件人状态 → **忽略且不标已读**（不吞正常邮件）；
   - 是退信 → 交给 `ingestBounce` 回填；
3. 回填成功（含 duplicate/unmatched）→ 标 `\Seen`，避免重复告警；
4. **回填抛错 → 不标已读**，下一轮重试；
5. 单实例并发保护：上一轮没结束，本轮直接跳过；
6. 间隔下限 10 秒；定时器 `unref`，不阻止进程退出。

## 3. 入口与可见性

- 自动：`npm start` 检测到 IMAP 配置就启动；关闭服务时随 `ConsoleService.close()` 停止。
- 手动：`POST /api/bounce/poll`（管理员/审计员）；治理页「退信处理」卡片有「立即轮询邮箱」按钮。
- 治理页显示邮箱、轮询状态、上次时间/错误；审计记录 `IMAP 手动轮询`、`退信`/`退信未回填`，定时轮询的 actor 记为 `imap`。
- 启动日志：`退信轮询：IMAP INBOX（每 60s）`。

## 4. 验证

```bash
npm test        # 367 项：365 通过 + 2 跳过（ClamAV / 真实 Edge 默认跳过）
```

新增 `test/imap-poller.test.cjs` 8 项（注入假 IMAP 客户端，不走网络）：

- 只把 DSN 交给回填，普通邮件不标已读；
- 回填抛错 → 不标已读、错误入 state；
- 单封取信失败只计数，其余照常；
- 并发调用第二轮返回 `skipped: running`；
- 配置解析：缺 host 返回 null、缺凭据抛错、轮询下限 10s；
- 控制台：手动轮询写审计、未配置时明确 409、治理状态正确；
- **回归：25 封未读普通邮件 + 1 封退信，第二轮必须轮到退信**（修复前会永久漏掉）；
- 退信多于单轮上限时按轮转分批处理。

**真实验证待办**：需要在 QQ 邮箱开启 IMAP 后用真实邮箱跑一轮（本机目前未配置）。

## 5. 边界

- 单邮箱、单文件夹；无 IDLE 推送，靠固定间隔。
- 标记 `\Seen` 后同一封退信不会再处理；解析失败的邮件保持未读、每轮重试。
- 授权码明文存在 `config.env`（gitignore），与 SMTP 同口径；建议用独立邮箱/授权码。
- 只处理标准 DSN；非标准退信（人肉回复"地址不存在"）不会被识别。
- 不验证退信真伪：伪造的 DSN 也能让某条发件记录变 `bounced`——这是已知边界，
  审计会记录来源 `imap`，但系统没有 DKIM/SPF 级别的退信来源校验。
