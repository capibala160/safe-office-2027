# CalDAV 接入与 Radicale 部署（2026-11-04）

> 目标：让控制台的"会议预约"真正写进一个可同步的日历账户（手机 DAVx⁵ 能看到）。
> 主机侧适配器已完成（`src/caldav-writer.cjs`，mock 服务器单测通过）；
> 本文是服务器侧部署步骤，目标机 `101.132.160.81`（与往思站点同一台）。

## 1. 架构

```
控制台 runtime ──(scheduleMeeting)──> calendarWriter
                                      ├─ 本地 .ics（可选，SAFE_OFFICE_CALENDAR_DIR）
                                      └─ CalDAV PUT ──> Radicale（101.132.160.81:5232）
                                                             │
手机 DAVx⁵ ──────────── CalDAV 同步 ──────────────────────────┘
```

## 2. 服务器部署（Ubuntu/Debian；CentOS 把 apt 换成 dnf）

```bash
# ① 专用用户与目录
sudo useradd -r -s /usr/sbin/nologin radicale || true
sudo mkdir -p /opt/radicale /var/lib/radicale/collections /etc/radicale
sudo chown -R radicale:radicale /var/lib/radicale

# ② 独立的 Python 环境（不污染系统 Python）
sudo python3 -m venv /opt/radicale/venv
sudo /opt/radicale/venv/bin/pip install --upgrade pip
sudo /opt/radicale/venv/bin/pip install 'radicale[bcrypt]'

# ③ 账号（会提示输入密码；生成一个长随机密码）
sudo apt install -y apache2-utils
sudo htpasswd -B -c /etc/radicale/users safeoffice
sudo chown root:radicale /etc/radicale/users && sudo chmod 640 /etc/radicale/users

# ④ 配置
sudo tee /etc/radicale/config >/dev/null <<'EOF'
[server]
hosts = 0.0.0.0:5232
max_connections = 20

[auth]
type = htpasswd
htpasswd_filename = /etc/radicale/users
htpasswd_encryption = bcrypt
delay = 1

[storage]
filesystem_folder = /var/lib/radicale/collections

[rights]
type = owner_only

[logging]
level = warning
EOF

# ⑤ systemd
sudo tee /etc/systemd/system/radicale.service >/dev/null <<'EOF'
[Unit]
Description=Radicale CalDAV server
After=network.target

[Service]
User=radicale
Group=radicale
ExecStart=/opt/radicale/venv/bin/radicale --config /etc/radicale/config
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now radicale
systemctl status radicale --no-pager
```

## 3. 建日历集合并自测

```bash
# 建一个名为 office 的日历（Radicale 支持 MKCALENDAR）
curl -i -u safeoffice:你的密码 -X MKCALENDAR \
  http://127.0.0.1:5232/safeoffice/office/

# 应返回 201；再 PROPFIND 应 207
curl -i -u safeoffice:你的密码 -X PROPFIND -H 'Depth: 0' \
  http://127.0.0.1:5232/safeoffice/office/

# 从本机测一次真实写入（把示例 .ics 换成任意事件）
curl -i -u safeoffice:你的密码 -X PUT \
  -H 'Content-Type: text/calendar; charset=utf-8' \
  -H 'If-None-Match: *' \
  --data-binary @meeting.ics \
  http://127.0.0.1:5232/safeoffice/office/test-event.ics
```

## 4. 推荐：只监听 127.0.0.1 + SSH 隧道（不暴露公网）

把配置里的 `hosts` 改成 `127.0.0.1:5232`（默认推荐），然后在 Windows 本机开一条隧道：

```powershell
ssh -L 5232:127.0.0.1:5232 root@101.132.160.81
# 保持这个窗口开着；隧道会把本机 5232 转发到服务器回环
```

控制台配置就用 `http://127.0.0.1:5232/safeoffice/office/`：
链路全程在 SSH 加密里，**不需要开放云安全组的 5232 端口**，Basic 凭据也不会明文过公网。

> 手机 DAVx⁵ 不能用这条隧道；手机同步要另配 HTTPS（nginx/caddy 反代 + 证书），
> 或临时用局域网方案。演示"写入服务器日历"用隧道就够了。

## 5. 控制台配置

```bash
# prototype/config.env（不要提交）
SAFE_OFFICE_CALDAV_URL=http://101.132.160.81:5232/safeoffice/office/
SAFE_OFFICE_CALDAV_USER=safeoffice
SAFE_OFFICE_CALDAV_PASS=<长随机密码>
# 可选：同时留一份本地 .ics 作为演示证据
SAFE_OFFICE_CALENDAR_DIR=<prototype>/data/calendar
```

配置后执行一次"预约周三项目对齐会"，控制台应返回 `mode: caldav`，审计出现"日历写入"。

## 6. 安全说明（必须写进材料）

- **当前方案是 HTTP + Basic 认证**：凭据在链路上是 base64，不是加密。仅适合内网/演示。
  生产必须套 HTTPS（有域名可用 certbot；没有域名可用 Caddy 自动证书，或用内网自签 + 客户端信任）。
- 端口 5232 只对需要的来源开放（云安全组限制 IP 更稳）。
- 密码用长随机值，`htpasswd -B`（bcrypt）；不要复用其他服务密码。
- Radicale 的 `owner_only` 权限：每个用户只能访问自己的集合。

## 7. 边界

- 只证明 CalDAV 服务器接受了事件（HTTP 2xx），**不证明手机已同步、不证明参会人收到通知**。
- 手机端是否显示取决于 DAVx⁵ 的同步周期与账户配置，演示前先手动"立即同步"。
- 没有 CalDAV 账号时，控制台仍可用本地 `.ics`（原行为不变）。

## 8. 验收清单

- [ ] `systemctl status radicale` active
- [ ] `MKCALENDAR` 返回 201，`PROPFIND` 返回 207
- [ ] curl PUT 一个 .ics 返回 201
- [ ] 控制台预约后返回 `mode: caldav`
- [ ] DAVx⁵ 手动同步后手机日历出现该事件 —— **未完成**：2026-11-04 实测服务器已收到 DAVx⁵ 的 `REPORT` 207，但鸿蒙机（PSD-AL00）上 DAVx⁵ 的本地日历存储返回 `-1`，事件无法入库；需真 Android 复测（见 §9）

## 9. 实际部署记录（2026-11-04，Alibaba Cloud Linux 3）

目标机 `iZuf6gazxhxfrkqtror68qZ`（101.132.160.81），与往思同机。与上文步骤的差异：

- 系统是 RHEL 系（Alibaba Cloud Linux 3）：`dnf` 代替 `apt`，`apache2-utils` → `httpd-tools`。
- 自带 Python 3.6.8 不满足 Radicale 3.9（需 ≥3.9）：另装 `python3.11`，独立 venv 不污染系统 Python。
- RHEL 版 `htpasswd` 必须加 `-b` 才能在命令行传密码。
- **Radicale 只监听 `127.0.0.1:5232`，不映射公网**；对外统一走 nginx 默认站的 `/radicale/`（80 端口原本已开放，无需改云安全组，也无需 SSH 隧道）。
- Radicale 配置加 `script_name = /radicale`；nginx 用 `proxy_pass http://127.0.0.1:5232;`（**不带结尾斜杠**——保留前缀，由 Radicale 自己剥；带斜杠会双剥导致 404）。

实际安装命令：

```bash
dnf install -y python3.11 python3.11-pip httpd-tools
useradd -r -s /usr/sbin/nologin radicale
mkdir -p /opt/radicale /var/lib/radicale/collections /etc/radicale
chown -R radicale:radicale /var/lib/radicale
python3.11 -m venv /opt/radicale/venv
/opt/radicale/venv/bin/pip install 'radicale[bcrypt]'   # 3.9.0
htpasswd -b -B -c /etc/radicale/users safeoffice '<密码>'
chown root:radicale /etc/radicale/users && chmod 640 /etc/radicale/users
```

落地的文件：

| 文件 | 作用 |
| --- | --- |
| `/etc/radicale/config` | `script_name = /radicale`，`hosts = 127.0.0.1:5232`，htpasswd + bcrypt，`owner_only` |
| `/etc/systemd/system/radicale.service` | `enabled` + `active`，`Restart=on-failure` |
| `/etc/nginx/default.d/radicale.conf` | `/radicale/` → `http://127.0.0.1:5232`，透传 `X-Forwarded-For` |

访问地址（控制台 / 手机 DAVx⁵ 都用这个）：

```text
http://101.132.160.81/radicale/safeoffice/office/
账号 safeoffice，密码在本机 prototype/config.env 的 SAFE_OFFICE_CALDAV_PASS（不入库、不写进文档）
```

验收结果（2026-11-04）：

- [x] `systemctl status radicale` active，且 `enable` 开机自启
- [x] 回环：`MKCALENDAR` 201 / `PROPFIND` 207 / `PUT` 201
- [x] 公网经 nginx：`PROPFIND` 207 / `PUT` 201
- [x] 控制台适配器 `createCalendarWriterFromEnv` 真实预约 → `{"mode":"caldav","status":201}`，带回 ETag
- [x] 同一 UID 重写：412 → GET 取 ETag → `If-Match` PUT → 204（更新分支成立）
- [x] 手机浏览器读取（鸿蒙 PSD-AL00）：`PROPFIND /radicale/` 401→207、`PROPFIND /radicale/safeoffice/` 207，页面列出 2 条事件
- [ ] DAVx⁵ 手机同步：**服务端已通、端上未入库**。2026-11-04 用 DAVx⁵ 4.5.21-ose（F-Droid 官方签名）连接，服务器记录 `PROPFIND /radicale/` 207、`REPORT /radicale/safeoffice/office/` 207；但 DAVx⁵ 的「本地项目数量」显示 `-1`（读不到系统日历存储），华为日历不显示事件——鸿蒙兼容层限制，需真 Android（vivo V2458A）复测。**边界：不能写成「手机日历已同步」**

**边界**：仍是 HTTP + Basic，凭据在链路上是 base64；只适合演示/内网。生产要 HTTPS（域名 + certbot，或 Caddy）。
**备份**：整个 `/var/lib/radicale/collections` 目录；恢复时装回同一路径并重启服务。
