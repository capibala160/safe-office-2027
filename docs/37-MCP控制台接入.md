# MCP 控制台接入（v0.36）

> v0.13 有工具注册表、v0.27 有真实 HTTP MCP 联调，但控制台里**看不到也注册不了**——
> 这项"可扩展平台"能力一直藏在测试里。本轮把它做进治理页：管理员填地址 → 发现工具 →
> 勾选注册 → 立刻出现在工具注册表/策略矩阵，且默认拒绝、必须显式给角色策略。

## 1. 做了什么

**后端**

- `ConsoleService.discoverMcp({ url, token })`：真实 `initialize` + `tools/list`，
  返回服务端信息与工具清单；**只允许回环地址**（127.0.0.1 / localhost / ::1），
  防 SSRF；确需远程需 `SAFE_OFFICE_MCP_ALLOW_REMOTE=1`。
- `ConsoleService.registerMcp({ url, tools, roles, level })`：只注册勾选的工具，
  名称统一加 `mcp_` 前缀；**至少一个允许角色**（未声明 = 拒绝），级别 L1–L4，
  沙箱档案固定 `local`（MCP 服务按本机服务对待；跨网沙箱通道本轮未做）。
- `src/mcp-adapter.cjs` 的 `registerMcpTools` 新增 `include` 过滤：勾选的工具必须
  在服务端全部存在，否则整批拒绝（不半注册）。
- 错误口径：重名 → 409；工具不存在 → 400；连接/协议失败 → 502。
- 审计：`MCP 发现`（url / server / 工具名）与 `MCP 注册`（url / 已注册工具 / 角色 / 级别），
  都带操作者，进哈希链。
- 执行器注册进 `toolExecutors`，并保证 **reset 后不丢**（注册表与执行器都复用）。

**界面（仅管理员）**

- 治理页新增「接入 MCP 服务」卡片：服务地址、Token、工具级别、允许角色（多选，
  默认勾员工）、发现工具、注册所选。
- 发现后逐个工具显示描述与必填参数；注册成功后重渲染，工具注册表与策略矩阵立刻可见。

**HTTP**

- `POST /api/mcp/discover`、`POST /api/mcp/register`，均要求管理员。

## 2. 本地演示

```bash
cd prototype
node mcp-server.cjs          # 最小 MCP 服务，默认 127.0.0.1:7899
npm start                    # 控制台
# 管理员登录 → 治理页 → 接入 MCP 服务 → 发现工具 → 注册
```

仓库内 `mcp-server.cjs` 提供 `wordCount` / `echo` 两个工具，只用于联调演示。

## 3. 验证

```bash
npm test        # 340 项：339 通过 + 1 跳过（ClamAV 未配置时）
npm run e2e     # 6 项
```

新增 `test/mcp-console.test.cjs` 4 项：

- 发现 → 注册 → 策略矩阵（员工 allow / 审计员 deny）→ executor 真实 HTTP 调用；
- 未选角色、未选工具、未知角色、非回环地址、连接失败、重名、工具不存在逐条拒绝；
- `reset()` 后已注册工具、策略、执行器仍在；
- HTTP：员工 403，管理员发现/注册成功，治理数据里能看到 `mcp_` 工具。

E2E 新增 1 项（共 6 项）：管理员在治理页填地址 → 发现 2 个工具 → 注册 →
重渲染后页面出现 `mcp_wordCount` / `mcp_echo`。

## 4. 边界（别把它说大）

- 注册表与执行器都在**内存**：进程重启后 MCP 工具消失，需要重新注册；
  配置持久化（`data/mcp-servers.json`）未做。
- 沙箱档案固定 `local`；远程 MCP 的跨网通道授权、按工具细粒度沙箱未做——
  远程服务本身也只靠 `SAFE_OFFICE_MCP_ALLOW_REMOTE=1` 放行。
- 只支持 JSON-RPC over HTTP；SSE / stdio / OAuth / 断线重连未做。
- 工具参数仍走现有计划校验与沙箱；MCP 侧返回内容按不可信数据处理的口径
  依赖调用方（当前 executor 只把文本回给模型/界面，不自动入知识库）。
- 控制台只监听回环；"管理员"指登录角色，不是独立的 MCP 管理后台。
