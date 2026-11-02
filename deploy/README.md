# 部署（HTTPS / Docker）

项目默认只监听 `127.0.0.1:7812`，这是刻意的：控制台能触发真实发信/打印/删除，不应直接暴露公网。

## 方案 A：本机 + nginx 反向代理（推荐）

1. 复制配置模板：`cp prototype/config.env.example prototype/config.env`，填 SMTP/IMAP/模型 key。
2. 首次部署先创建管理员（写入 `prototype/data/users.json`）：
   ```bash
   cd prototype
   SAFE_OFFICE_NEW_USER_PASSWORD='至少8位的强密码' node add-user.cjs admin 管理员
   ```
3. **强制登录启动**（没有用户表时拒绝启动，不能匿名操作）：
   ```bash
   SAFE_OFFICE_AUTH=required npm start
   ```
   只监听 `127.0.0.1`，不要改成公网地址。
4. 用 `deploy/nginx.conf.example` 配置 HTTPS，`certbot --nginx -d 你的域名` 申请证书。
5. 访问 `https://你的域名`。

## 方案 B：Docker Compose

```bash
cp prototype/config.env.example prototype/config.env   # 填 key；不要提交

# 首次部署：先创建管理员（写入 prototype/data/users.json，挂载进容器）
cd prototype
SAFE_OFFICE_NEW_USER_PASSWORD='至少8位的强密码' node add-user.cjs admin 管理员
cd ..

docker compose up -d --build
docker compose logs -f
```

> `docker-compose.yml` 已设置 `SAFE_OFFICE_AUTH=required`：没有用户表时容器会拒绝启动（fail-closed），
> 不会像本地免登录演示那样匿名放行。首次管理员必须在 `up` 之前创建。

- 端口只映射到 `127.0.0.1:7812`，仍需前面的 nginx/Caddy 终止 TLS。
- `prototype/data` 挂载为卷，保存 SQLite/审计/附件；备份这个目录。
- `SAFE_OFFICE_TRUST_PROXY=1` 仅在前置可信代理时开启；直接把 7812 暴露公网会被 LAN 限制拒绝，也不安全。
- 镜像不包含 `config.env`、`data/`、`out/`（见 `.dockerignore`）。

## 健康检查

```bash
cd prototype
npm run health                       # 默认 http://127.0.0.1:7812
node scripts/healthcheck.cjs --url=http://127.0.0.1:7812 --min-free-mb=2048 --json
```

失败告警 webhook（钉钉/企业微信/Slack 的机器人地址均可，POST `{text, checks}`）：

```bash
SAFE_OFFICE_ALERT_WEBHOOK='https://...' npm run health
# 或 node scripts/healthcheck.cjs --webhook=https://...
```

可放进 cron（每 10 分钟），失败时退出码非 0 并触发 webhook：

```cron
*/10 * * * * cd /path/to/prototype && SAFE_OFFICE_ALERT_WEBHOOK='https://...' node scripts/healthcheck.cjs >> out/health.log 2>&1
```

## 附件保留

设置 `SAFE_OFFICE_ATTACHMENT_RETENTION_DAYS=30` 后，服务启动时清理一次“超过 30 天且没有任何操作引用”的附件内容；被历史操作引用的附件会保留（避免回滚/复核丢证据）。也可管理员调用：

```bash
curl -X POST https://你的域名/api/attachments/prune \
  -H 'Content-Type: application/json' -b cookie.txt -d '{"days":30}'
```
