# MCP 真实联调（v0.27）

> 之前只有 client 骨架和 JSON-RPC 形状，没有真实 server。这一轮在仓库内起一个
> **最小 MCP HTTP server**，用现有 `McpClient` 走完 initialize → tools/list → tools/call，
> 并注册进 `ToolRegistry` 执行；**不是**生产 MCP 实现。

## 1. server

```bash
cd prototype
node mcp-server.cjs --port=7820
# 可选 token：SAFE_OFFICE_MCP_TOKEN=... 请求头 x-mcp-token 必须匹配
```

- 端点：`POST /mcp`（JSON-RPC 2.0）
- 内置只读工具：`wordCount(text)`、`echo(text)`
- 支持 `initialize` / `tools/list` / `tools/call`；通知返回 202
- 无 SSE/stdio/OAuth/持久 session

## 2. client 联调

`test/mcp-server.test.cjs` 3 项：

1. 真实 HTTP：initialize → tools/list → call `wordCount`，校验返回文本
2. 注册：`registerMcpTools` → `ToolRegistry`，**必须显式 sandbox + role policy**，executor 可调用
3. token：错误 token 401；正确 token 可 list

全仓 **297 项全绿**。

## 3. 安全边界（沿用 v0.13）

- MCP 工具**默认拒绝**：没有显式 `sandbox` / 角色策略就不能注册（fail-closed）
- 注册表只做目录叠加，不持久化；server 重启后要重新注册
- token 只做最简单的共享密钥，不是 OAuth
- 没有做 console UI 的 MCP 接入表单；要用真实 MCP 工具需在代码/启动时显式注册并给策略
- 没有对外部 MCP server 做 SSRF/域名限制（只应连可信内网地址）
