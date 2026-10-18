# 工具注册表与 MCP 适配器（v0.13）

更新：2026-10-18。范围：Node 原型内的工具目录扩展层 + MCP client 骨架。**不修改内置静态表**，默认行为与 v0.12 一致；自定义/MCP 工具默认拒绝，必须显式给沙箱、风险、角色策略。

> 目标：把"工具目录"从 5 张 require-time 静态表，升级为**可注册的叠加层**，让通用 Agent 的工具调用能接入现有五道闸、沙箱、冻结确认与审计；不是把项目改成通用 Agent。

---

## 1. 为什么

v0.12 之前，新增一个工具要同时改：`TOOL_META`、`SANDBOX_PROFILES`、`KNOWN_TOOLS/REQUIRED_ARGS`、`HIGH_RISK/OUTBOUND`、`ROLE_TOOLS`、runtime 执行链。这些表都是加载时快照，无法接 MCP 或任意 Agent。

v0.13 的边界：

- **静态表仍是内置工具的事实源**；`TOOL_META`/`CAPABILITIES`/`SANDBOX_PROFILES`/`KNOWN_TOOLS`/`ROLE_TOOLS` 导出和内容不变。
- `ToolRegistry` 只做**叠加**：内置 13 个工具从静态表种子化；自定义/MCP 工具通过 `register` 进入。
- 默认不注入 registry 时，planner/sandbox/runtime/agents/console 行为与 v0.12 完全一致（173 项测试验证）。

## 2. 文件

| 文件 | 作用 |
|---|---|
| `prototype/src/tool-registry.cjs`（新） | `ToolRegistry`、内置种子、注册/校验/策略/角色工具/沙箱/高危/deferred |
| `prototype/src/mcp-adapter.cjs`（新） | `McpClient`、HTTP JSON-RPC 骨架、`mcpToolToDefinition`、`registerMcpTools` |
| `prototype/src/sandbox.cjs` | `checkSandbox` 增加可选第 4 个 profile 参数 |
| `prototype/src/guard.cjs` | `checkDataBoundary` 增加可选 `outbound/outboundArg`（自定义出站工具复用同一规则） |
| `prototype/src/planner.cjs` | `validatePlan`/`GuardedPlanner` 可注入 registry；2 参调用不变 |
| `prototype/src/agents.cjs` | `defineAgent`/`verifyAgentManifest`/`issueToken` 可注入 `{registry, policy}`；旧调用不变 |
| `prototype/src/runtime.cjs` | `toolRegistry`/`toolExecutors`；动态高危/出站/沙箱；自定义执行器分支 |
| `prototype/src/console-service.cjs` | 控制台使用 registry；bootstrap/策略矩阵/令牌/转办动态化 |
| `prototype/public/views.js` | 治理页策略矩阵动态列 + "工具注册表"表 |
| `prototype/test/tool-registry.test.cjs`（新） | 16 项测试 |

## 3. 工具定义 schema

```js
{
  name: 'lookupRoom',              // /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
  capability: '会议预约',           // 能力名（可自定义）
  level: 'L1',                     // L1–L4
  requiredArgs: ['room'],          // 非空字符串数组
  sandbox: { local: true },        // 必须且只能一种：local/fsRead/fsWrite/net/physical
  outbound: false,                 // 出站动作
  outboundArg: null,               // outbound=true 时必须显式（to/url）
  irreversible: false,
  highRisk: false,                 // 自定义工具会被 outbound/irreversible/deferred/L4 提升
  deferred: false,                 // 是否走冻结操作 + WS63 确认
  protocolAction: null,            // deferred=true 时必须是 1–4
  policies: [{ role: '员工', decision: 'allow' }],
  executor: async ({ args, ctx }) => '结果',
  source: 'custom',                // builtin/custom/mcp
  description: '查询会议室',
}
```

校验（注册前，fail-closed）：

- 重名（含内置）→ 抛错；
- 缺 `sandbox`、`sandbox` 声明多种资源、`fsRead/fsWrite` 缺 scope/arg → 抛错；
- 非法 level、非法 requiredArgs、非法 policy decision → 抛错；
- `deferred=true` 缺 `protocolAction` 1–4 → 抛错；
- `outbound=true` 缺 `outboundArg` → 抛错；
- 自定义 `highRisk` 不能降级：`outbound || irreversible || deferred || level==='L4'` 自动提升为高危。

## 4. 注册示例

```js
const { ToolRegistry } = require('./src/tool-registry.cjs');
const { ConsoleService } = require('./src/console-service.cjs');

const registry = new ToolRegistry();
const service = new ConsoleService({ toolRegistry: registry });

registry.register({
  name: 'lookupRoom',
  capability: '会议预约',
  level: 'L1',
  requiredArgs: ['room'],
  sandbox: { local: true },
  policies: [{ role: '员工', decision: 'allow' }],
  executor: async ({ args }) => `会议室 ${args.room} 空闲`,
}, { policy: service.policy });
```

默认策略是 **deny**：不传 `policies`/`policy` 时，工具会出现在注册表里，但 `PolicyEngine.decide(role, name)` 返回 `deny`，`toolsForRole` 不包含它。

`reset()` 复用同一 registry（自定义工具不丢），`_initWorkspace()` 会把定义里的 policies 重新应用到新的 `PolicyEngine`。

## 5. 接缝

### planner

- `validatePlan(raw, { ..., registry })` 用 `registry.has` / `registry.requiredArgs`；不传 registry 时用模块私有 `BUILTIN_REGISTRY`（只含内置），2 参调用行为不变。
- `GuardedPlanner({ llm, audit, risk, registry })`。
- 自定义出站工具的"目标必须在用户指令中可溯源"仍由 runtime 的目标授权兜底；planner 的通用溯源不扩展（避免改现有错误文案）。

### sandbox

`checkSandbox(tool, args, sandbox, profile)`：第 4 个参数可传 registry 的 profile；`undefined` 回退静态，显式 `null` fail-closed。

### runtime

- `toolRegistry`：动态判断高危/出站、沙箱 profile、未注册工具拒绝。
- `toolExecutors`：可选的 ad-hoc 执行器 Map；否则用 registry 定义里的 `executor`。
- 自定义执行器分支位于内置执行链之后、审计 `执行` 之前；无执行器 → `⛔ 未注册执行器`。
- 自定义工具仍受策略、令牌、资源授权、目标授权、沙箱、闸3/5、风险冻结、闸4/转办约束。

### agents

`defineAgent`/`verifyAgentManifest`/`issueToken` 可传 `{ registry, policy }`；未传时用静态 `ROLE_TOOLS`。runtime 的 `verifyAgentManifest` 会传 `{registry, policy}`，避免动态 Agent 清单被静态口径拒绝。

### console

- `bootstrap.tools` = `registry.publicList()`；`roleTools` 每角色动态计算。
- `_issueAgentAndToken` 用动态角色工具 + registry。
- `deferActions` = `registry.deferredNames()`（自定义 deferred 工具进入冻结闭环）。
- `_freezeDeferred` 用 `registry.protocolAction(action)`（1–4）。
- 治理页策略矩阵按 `policy` 的 key 动态生成列；新增"工具注册表"表（名称/能力/级别/高危/转交/来源）。

## 6. MCP 适配器

```js
const { McpClient, createHttpTransport, registerMcpTools } = require('./src/mcp-adapter.cjs');

const transport = createHttpTransport({ url: 'http://127.0.0.1:3000/mcp' });
const client = new McpClient({ transport });
const { registered } = await registerMcpTools({
  registry: service.toolRegistry,
  client,
  policy: service.policy,
  defaults: {
    capability: 'MCP 外部工具',
    level: 'L2',
    sandbox: { local: true },
    policies: [{ role: '员工', decision: 'confirm' }],
  },
});
```

- `McpClient`：`initialize` → `notifications/initialized` → `tools/list` / `tools/call`。
- `createHttpTransport`：JSON-RPC 2.0 POST；只处理 `application/json`；记录 `mcp-session-id` 做最小透传。
- `mcpToolToDefinition`：`inputSchema.required` → `requiredArgs`；**必须显式 sandbox**；默认策略空（全 deny）。
- `registerMcpTools`：两阶段（先全部 validate + 查重，再统一 register），避免半注册；executor 调 `client.callTool`，拼接 `content[].type==='text'`，截断 4000 字符。
- **不支持**：SSE、stdio、OAuth、持久 session、重连、真实服务联调；HTTP 骨架只覆盖最小 JSON-RPC。

## 7. 测试

```bash
cd prototype
node --test                              # 173 项全绿
node --test test/tool-registry.test.cjs  # 16 项
```

覆盖：内置种子与静态表一致、重名/reset、非法定义 fail-closed、默认拒绝、策略声明/applyPolicies、动态角色工具与静态一致、planner 动态目录、GuardedPlanner 注入、沙箱第 4 参数、运行时自定义执行器端到端、无执行器/未注册 fail-closed、自定义出站目标校验、Agent 动态校验、MCP 映射/fake client/批内重名、HTTP JSON-RPC 骨架、Console 集成/reset。

## 8. 边界

- 注册表是**本地内存叠加层**，不持久化；内置表仍是静态事实源。
- 自定义工具默认拒绝；沙箱/风险/协议号/角色策略必须显式声明。
- MCP 适配器是骨架：HTTP JSON-RPC 最小实现，无 SSE/stdio/OAuth/重连；真实服务未联调。
- 不把项目变成通用 Agent；这是"通用 Agent 安全底座"的目录/执行接口。
- 自定义工具的真实执行仍受五道闸、沙箱、审计约束；MCP 元数据不能替代安全审计。
- 自定义 outbound 工具必须用 `docId` 走闸3，且 `outboundArg` 目标必须在用户指令中；planner 的通用溯源未扩展。
- 自定义 deferred 工具只复用现有 4 类协议动作（1 外发/2 删除/3 打印/4 设备）。

## 9. 下一步

1. MCP 真实服务联调（stdio/SSE、会话、错误重试）与工具目录签名。
2. `HttpLLM` 提示词动态化：从 registry 生成工具目录（当前只支持调用方提供计划）。
3. 工具级参数类型系统（当前只校验非空字符串）。
4. 注册表持久化/审批流（谁能注册什么工具）。
5. 自定义工具评测样例与消融。
