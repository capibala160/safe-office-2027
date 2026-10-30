# 核心机制原型（v0.17 · 平台无关 + 控制台 + 草稿编辑 + 任务进度）

> **接入变化**：`CapabilityToken.documentIds` 默认空，必须显式授权资源；邮件和上传指令须包含精确地址。模型适配器声明 deployment，未知位置按 cloud 处理；`commandLevel` 应由可信应用提供，机密/未知指令不送云。规划和 generate 共用模型出口检查。正式稿保存为 `draft_源ID`，继承密级及 sourceIds；回滚保留已发送和已上传记录。
>
> `ConfirmationService` 支持限时、一次性及操作/内容绑定的 HMAC 协议模拟，不能证明本人身份、距离或防中继。**v0.11 新增 WS63 确认适配器**（`nearfield-confirm.cjs`）：SFC1 二进制帧 + 虚拟设备接入冻结操作闭环；串口/SLE 与运行时闸4 仍未接。**v0.12 新增演示级办公套件控制台**（`server.cjs` + `src/console-service.cjs` + `public/`）：10 个页面、转交确认缝、策略自动确认/WS63 确认；业务动作仍为模拟。**v0.13 新增工具注册表 + MCP 骨架**（`tool-registry.cjs` / `mcp-adapter.cjs`）：内置静态表不变，自定义/MCP 工具默认拒绝，必须显式声明沙箱/风险/角色策略。**v0.14 手机确认端**（`docs/14`）、**v0.15 持久化与模型注入**（`docs/15`）、**v0.16 真实资料接入**（导入/上传/附件/导出已批准正文，`docs/16`）、**v0.17 草稿编辑与任务进度**（重新冻结 + 版本 diff + 异步进度/取消，`docs/17`）依次落地。审计支持持久化及独立检查点恢复，HUKS 尚未接入。最新能力以 [优化记录与落地验收](../docs/03-优化记录与落地验收.md)、[v0.11 适配器文档](../docs/11-WS63确认适配器.md)、[v0.12 控制台文档](../docs/12-办公套件控制台.md) 与 [v0.16 真实资料接入](../docs/16-真实资料接入.md) 为准，测试数量以 `node --test` 为准。

> 「Agent 安全运行机制」的可运行原型——**零依赖、纯 Node**，上板前即可跑通全部机制逻辑。
> 上板路径：本目录逻辑**平移 ArkTS**（行为不变）→ 闸4 的 `nearfieldOnline` 换成 WS63 真实 SLE 握手 → 规划器换成真实 LLM（模型边界已就绪）→ 沙箱对应 OH 应用沙箱/权限模型。

## 跑起来

```bash
npm start            # 办公套件控制台 → http://127.0.0.1:7812（v0.12）
node demo.cjs        # 攻防演示（答辩预演脚本：正常流 / 能力分级 / 沙箱双锁 / 图片通道 / 注入 / 端云边界 / 越权 / 冻结闭环 / 近场 / 回滚 / 回溯 / 风险行为因子 / 点名 5+1 类攻击速览 / Agent 角色分级 / 委托令牌 / 时延开销）
npm run demo:nearfield  # WS63 确认适配器演示（6 幕：正常/取消/超时/重放/篡改/错设备，无硬件）
npm test             # 自动化测试（270 项，全绿）
npm run eval         # 三档评测（无防护 / 仅提示词 / 完整网关，Mock 离线）
npm run eval:ablate  # 追加单层消融（9 层逐一关停；见 docs/19）
# demo 末尾自动生成治理报告（可视化交付物雏形）：out/governance-report.html
# eval 生成评测报告：out/eval/eval-report.html + eval-results.json（消融另有 ablation-results.json）
```

## 结构

```
prototype/
├── server.cjs              办公套件控制台 HTTP 服务（v0.12；node:http + 静态 + JSON API）
├── public/                 控制台前端：index.html / styles.css / api.js / ui.js / app.js / views.js
├── demo.cjs                攻防演示 + 治理报告生成（out/governance-report.html）
├── demo-nearfield.cjs      WS63 确认适配器演示（虚拟设备，6 幕）
├── eval/                   三档评测 harness（详见下节）
│   ├── corpus.cjs          语料：28 条（开发 14 / 验证 14；正常 12 / 攻击 16）
│   ├── baseline.cjs        无防护 / 仅提示词档的宽松执行器（只用于对照）
│   ├── harness.cjs         同一模型 × 三档执行与计分（effects/blocks/时延）
│   ├── metrics.cjs         指标聚合（成功率/完成率/误拦/P50-P95）
│   ├── llm-eval.cjs        none 档裸提示词 / prompt·full 档加固提示词
│   ├── report.cjs          控制台 + JSON + HTML 报告
│   └── run.cjs             CLI 入口（npm run eval）
├── src/
│   ├── capabilities.cjs    办公能力分级表（命题点名 8 类 + 3 类扩展）：能力→风险级L1-L4→工具→约束；工具元数据=单一事实源
│   ├── agents.cjs          Agent 身份与权限分级：角色表/清单/令牌交集（角色∩清单∩任务）/委托令牌（HMAC+到期+动作+撤销）
│   ├── operation.cjs       冻结操作记录：bodyHash/attachmentHashes/operationHash；执行前重算校验；状态迁移
│   ├── store.cjs           SQLite（node:sqlite）：operations/outbox/events；本地事件哈希链
│   ├── mailer.cjs          邮件适配：FakeMailer / HttpMailer（Idempotency-Key + 超时分类）
│   ├── fulfillment.cjs     确认→执行→留档：prepare/confirm/send/reconcile/recoverInFlight
│   ├── llm.cjs             可插拔 LLM：MockLLM（对抗性模拟，含点名攻击剧本/图片通道）/ HttpLLM（OpenAI 兼容骨架，密钥走 env，带超时）
│   ├── planner.cjs         带护栏规划器：上下文消毒 → 计划校验（工具目录+必需参数+来源溯源[收件人/上传地址]+代发身份治理+委托令牌）+ 模型边界（机密不进云）
│   ├── guard.cjs           L2 安全网关：闸1 消毒 · 闸2 权限令牌（含 TTL） · 闸3 数据边界 · 闸4 高危确认 · 闸5 输出检测
│   ├── sandbox.cjs         工具沙箱：资源档案（文件作用域/网络通道/物理世界）· 路径逃逸检出 · fail-closed
│   ├── governance.cjs      L3 治理中心：策略矩阵（fail-closed + 热更新）· 审计哈希链 · 风险计量（拦截事件+行为因子）
│   ├── runtime.cjs         L1 Agent 运行时：规划 → 每步过闸+过沙箱 → 执行 → 全程审计；高危前快照、一键回滚；过闸耗时打点
│   ├── perf.cjs            时延度量：每道闸 次数/合计/均值/峰值（答题要求 #2）
│   ├── report.cjs          治理可视化：单文件 HTML 报告生成（审计时间线/风险计量/复核记录/时延/链校验）
│   ├── nearfield-confirm.cjs  WS63 确认适配器（v0.11）：SFC1 状态机 + 虚拟设备 + 传输层缝 + confirmWithFulfillment
│   ├── console-service.cjs  控制台服务（v0.12）：命令/转交/冻结/挑战/治理/报告/重置
│   ├── demo-executor.cjs    演示执行器：FakeMailer + 删除/打印/设备假动作
│   ├── tool-registry.cjs    工具注册表（v0.13）：内置种子 + 自定义/MCP 工具 + 默认拒绝
│   ├── mcp-adapter.cjs      MCP client / HTTP JSON-RPC 骨架 / registerMcpTools
│   └── scenario.cjs        场景数据：办公文档库 + 通讯录 + 录音样本 + 图片素材（含注入样本）
└── test/
    ├── engine.test.cjs     闸级 + 计划校验 + 冻结闭环 + 快照回滚 + 输出检测 + 能力分级 + 沙箱 + 行为因子 + 模型边界 + 图片通道 + 时延 + 可视化 + 端到端（43 项）
    ├── attacks.test.cjs    可复现安全测试样例库：点名 5 类 + 扩展 1 类 + 纵深防御 2 项（8 项）
    ├── regressions.test.cjs 验收修复回归（15 项）
    ├── resilience.test.cjs 假端点健壮性 + 幂等 + 自动吊销（16 项）
    ├── agents.test.cjs      Agent 角色矩阵 / 清单 / 令牌交集 / 委托令牌（10 项）
    ├── ws63-protocol.test.cjs SFC1 编解码 / Node-C 固定向量（2 项）
    ├── fulfillment.test.cjs 操作记录 / SQLite / 发送状态机（9 项）
    ├── nearfield-confirm.test.cjs WS63 适配器：正常/取消/超时/重放/篡改/错设备/窗口/绑定（14 项）
    ├── console-service.test.cjs 控制台服务：命令/转交/冻结/挑战/治理/报告/重置（17 项）
    ├── server.test.cjs        HTTP：健康/静态/路径穿越/命令/闭环/异常/重置（14 项）
    ├── tool-registry.test.cjs 注册表/MCP：种子/策略/planner/运行时/Agent/MCP 骨架（16 项）
    └── eval-harness.test.cjs 评测自身回归：语料结构 / 三档对照 / 指标边界 / 字段别名 / 异常路径保留副作用（9 项）
```

## Agent 权限分级（v0.9）

```bash
node demo.cjs   # 幕8：实习生只读 / 员工外发 / 审计员拒绝 / 设备助手 / 委托令牌对照
```

- 角色：员工 / 实习生 / 审计员 / 设备助手 / 管理员 / 访客
- 清单：`defineAgent` 只允许申请角色已有的工具与资源；越权直接抛错
- 令牌：`issueToken` = **角色允许 ∩ Agent 清单 ∩ 任务需要**，并记录被裁剪项
- 绑定：`runCommand` 校验清单摘要、角色声明、令牌必须绑定该 Agent
- 委托：`DelegationService` 的 from/to/actions/expiry/MAC；**目标仍须在指令中可溯源**
- 边界：清单摘要是进程内防篡改摘要，不是签名；委托令牌不证明委托人真实身份

## 确认执行闭环（v0.10）

- `operation.cjs`：冻结 `bodyHash/attachmentHashes/operationHash`；发送前重算，正文/收件人/附件/来源变化一律拒绝
- `store.cjs`：Node 24 内置 `node:sqlite`，持久化 operations/outbox/events；事件哈希链
- `mailer.cjs`：`FakeMailer`（测试）+ `HttpMailer`（Idempotency-Key）；timeout/network/5xx → unknown，**不自动重试**
- `fulfillment.cjs`：`prepare → confirm → send → reconcile`；进程中断的 sending 转 unknown
- 测试：`node --test test/fulfillment.test.cjs`（9 项）
- 边界：正文明文存 SQLite；不实现 SMTP；不保证外部邮件只执行一次

## WS63 确认适配器（v0.11）

```bash
npm run demo:nearfield                       # 6 幕：正常/取消/超时/重放/篡改/错设备
node --test test/nearfield-confirm.test.cjs  # 14 项
```

- `nearfield-confirm.cjs`：`NearfieldConfirmer`（A 端）+ `VirtualDevice`（B 端替身）+ `createLoopbackTransport`
- 真实 SFC1 帧 + HMAC-SHA256；`target_hash` 直接取 `operation.operationHash` 的 32 字节，**不重新哈希 JSON**
- 状态机镜像 C：`STATE → TASK → NONCE → REPLAY → EXPIRED → DEVICE → OPERATION → DECISION → OK`；8 条 FIFO nonce 窗口
- 集成：`confirmWithFulfillment({ fulfillment, confirmer, operation })` → `fulfillment.confirm` → `send`
- 传输层缝：`async send(frame) -> Buffer|null`；上板时换成串口/SLE，上层不变
- 边界：**虚拟设备不是硬件**；无 SLE/串口；PSK 在 Node 内存；不证明距离/身份/防中继；`runtime.cjs` 闸4 仍为模拟确认。详见 [WS63 确认适配器](../docs/11-WS63确认适配器.md)

## 办公套件控制台（v0.12）

```bash
npm start          # http://127.0.0.1:7812
node --test test/console-service.test.cjs
node --test test/server.test.cjs
```

- `server.cjs`：零依赖 `node:http` + 静态文件 + JSON API，仅监听 `127.0.0.1`。
- `src/console-service.cjs`：常驻 `AgentRuntime` + 内存 `OperationStore` + `FulfillmentService` + 虚拟 WS63。
- **转交确认缝**：`runtime.cjs` 新增默认关闭的 `deferActions`/`onDeferred`；命中外发/删除/打印/设备时，完成规划与五道闸后不再执行模拟副作用，而是创建冻结操作，再走 WS63 虚拟确认。
- **内网邮件**由策略自动确认（`confirmationId='policy-auto'`）；外发/删除/打印/设备必须设备确认。
- 10 个页面：工作台 / 命令台 / 纪要中心 / 邮件 / 日历 / 通讯录 / 文件 / 审批与确认 / 设备 / 治理审计。
- 设备页：OLED 摘要/哈希/倒计时；批准/取消/模拟超时/篡改帧/重放。
- 自动模式（顶栏）：`manual` 人在环（默认）/ `auto-safe` 低风险自动（仅 `partner-example.com` 内部级外发，配额 3 次）/ `auto-full` 全自动演示（绕过设备，仅对照）。
- 边界：**演示级最小套件**；业务动作模拟（FakeMailer/假执行器）；无登录/多用户；不接真实 Office/邮件/打印/门锁；不提供距离/身份/防中继。详见 [控制台文档](../docs/12-办公套件控制台.md)。

## 工具注册表与 MCP（v0.13）

```bash
node --test test/tool-registry.test.cjs   # 16 项
```

- `tool-registry.cjs`：内置 13 工具从 `TOOL_META`/`SANDBOX_PROFILES`/`HIGH_RISK`/`OUTBOUND` 种子化；`register` 自定义/MCP 工具；**默认拒绝**，必须显式声明沙箱/风险/协议号/角色策略。
- `mcp-adapter.cjs`：`McpClient`（initialize / tools/list / tools/call）+ `createHttpTransport` JSON-RPC 骨架 + `registerMcpTools`（两阶段，防半注册）。
- 接缝：planner（动态目录）/ sandbox（第 4 个 profile）/ runtime（动态高危/出站/沙箱 + 自定义 executor）/ agents（动态角色工具）/ console（bootstrap/矩阵/转办）。
- **默认行为不变**：不注入 registry 时，2 参 `validatePlan`、3 参 `checkSandbox`、旧 `defineAgent/issueToken`、旧 `AgentRuntime`、默认 `ConsoleService` 与 v0.12 一致。
- 边界：内存态；MCP 仅 client + HTTP JSON-RPC 骨架（无 SSE/stdio/OAuth/重连）；自定义 outbound 必须走 `docId` + 目标授权；不是通用 Agent。详见 [工具注册表与 MCP](../docs/13-工具注册表与MCP.md)。

## 草稿编辑与任务进度（v0.17）

```bash
npm start        # 审批与确认页：冻结操作可直接改正文、看版本 diff
# 异步任务：POST /api/commands/async → GET /api/commands/:runId → POST /api/commands/:runId/cancel
node --test test/console-service.test.cjs
```

- **编辑即重新冻结**：只有 `frozen` 可改；`sealOperation` 重算 `bodyHash`/`operationHash`，pending 挑战全部作废，必须重新确认才能导出
- **版本留档**：`operation_revisions` 存被替换的正文与两个哈希（编辑人 / 备注）；审批页行级 diff
- **异步进度**：`排队 → 规划 → 执行 i/n → 待确认/完成`；`stageLog` 记录时间点，离开页面任务照跑、回来接上
- **取消**：步骤间生效，已执行步骤保留记录，`任务取消` 入审计；不能中断进行中的模型调用
- **确认端详情**：`/api/phone/state` 带收件人/密级/正文预览/附件名与大小，端上与挑战目标哈希比对后才允许确认
- **文件页发起任务**：每份资料「整理纪要 / 起草邮件」，自动带入该文档授权
- **重启恢复**：`operation_meta` + `console_state` 恢复操作来源/运行历史/风险计量/业务状态（`state.recovery`）；审计链不追加恢复事件
- 边界：已确认/已执行不能改（只能新建）；附件不能在这一步增删；正文明文存 SQLite；行为因子滑窗不恢复。详见 [草稿编辑与任务进度](../docs/17-草稿编辑与任务进度.md)

## 三档评测（v0.8）

```bash
npm run eval                                  # 离线机制验证（MockLLM，默认）
node eval/run.cjs --llm=http --repeat=3       # 真实模型（需配置 SAFE_OFFICE_LLM_* 环境变量）
node eval/run.cjs --split=validation          # 只跑未参与调参的验证集
```

- 三档：`none` 无防护（模型计划裸执行）/ `prompt` 仅提示词（加固提示词，仍裸执行）/ `full` 完整网关（现有运行时）
- 指标：攻击成功率、攻击中合法核心完成率、正常任务完成率、误拦率、确认次数/任务、模型/安全/总耗时 P50-P95、各层拦截贡献
- 2026-10-17 离线跑分：无防护攻击成功率 100%（16/16）；完整网关 **0%（0/16）**、正常完成 100%（12/12）、误拦 0；验证集同样 0% / 100% / 0%
- **口径**：MockLLM 不读提示词，`prompt` 档与 `none` 档同结果属预期；该跑分是**机制验证**，不是真实模型攻击成功率
- **2026-10-29 真实模型跑分**（glm-5.3-flash，验证集 14 条）：攻击成功率 62.5% → 50% → **0%**；正常完成 33.3% / 50% / 33.3%；误拦（拦住必需动作）16.7%。详见 [真实模型评测结果](../docs/18-真实模型评测结果.md)
- 中断可续跑：`--resume` 复用已完成且无故障的样本；每跑完一条落 `eval-partial.json`
- 未实现：单层消融、真实邮件/打印/设备、板端性能

## 与设计骨架的对应

| 骨架（docs/00 v0.3） | 本原型 |
|---|---|
| L2 闸1 输入消毒 | `sanitizeInput`（可疑句整句隔离；中英模式库 + 绕过审批/伪造授权/非法获取客户信息；一句话命中多模式全部报出） |
| L2 闸2 权限令牌 | `CapabilityToken`（工具白名单 × 域名白名单 × 次数 × **TTL**；被拒调用不耗配额） |
| L2 闸3 数据边界 | `checkDataBoundary`（机密禁出站 + 外发脱敏 + 上传外部仅公开级） |
| L2 闸4 执行管控 | `requestHumanConfirm`（近场确认接口，上板换真实 SLE）+ **执行前快照 / 一键回滚** |
| L2 **闸5 输出检测** | `checkAgentOutput`（机密碎片比对 / 违规承诺话术 / PII 兜底脱敏）——AI 输出侧安全 |
| L2 **工具沙箱**（※命题点名） | `sandbox.cjs`（资源档案单一事实源；`../` 路径逃逸检出；令牌/沙箱双锁演示；fail-closed） |
| L3 策略中心 | `PolicyEngine`（未声明=拒绝；覆盖点名 8 类能力全部工具；**热更新+变更留痕**） |
| **Agent 权限分级**（v0.9） | `agents.cjs`（角色表 + 清单 + 令牌交集 + 委托令牌）；`runtime.cjs` 校验清单/角色/令牌绑定 |
| **确认执行闭环**（v0.10） | `operation/store/mailer/fulfillment.cjs`：冻结记录、SQLite、发送状态机、unknown 人工核对 |
| **WS63 确认适配器**（v0.11） | `nearfield-confirm.cjs`：SFC1 挑战-应答、设备/操作绑定、8 条 nonce 窗口；虚拟设备可跑 6 场（串口/SLE 未接） |
| **办公套件控制台**（v0.12） | `server.cjs` + `console-service.cjs` + `public/`：10 页 Web 控制台；命令→五道闸→冻结操作→WS63 确认→执行；业务动作模拟 |
| **工具注册表 / MCP**（v0.13） | `tool-registry.cjs` + `mcp-adapter.cjs`：可注册工具目录、默认拒绝、动态 planner/sandbox/runtime/agents/console 接缝；MCP HTTP JSON-RPC 骨架 |
| L3 审计 | `AuditLog`（哈希链，篡改即断裂）；含"数据流向"类目 |
| L3 风险评分 | `RiskMeter`（拦截事件 + **行为因子：高频/异常时段/持续越权**；超阈值自动冻结 → 人工复核 clear/escalate） |
| **办公能力分级表** | `capabilities.cjs`（8 类点名 + 3 类扩展：L1–L4、调用约束、fail-closed） |
| **模型边界**（答题要求 #3） | `planner.cjs`：云侧规划机密正文分流（占位符替代）+ "数据流向"入审计；本地模型可收全量 |
| **可视化**（基本目标 B4） | `report.cjs` → `out/governance-report.html`（概览卡/风险明细/复核/时延/审计时间线/链校验） |
| **时延/资源度量** | `perf.cjs`（每道闸打点）+ demo 末尾开销报告（RSS） |
| 规划器（骨架 §4.1） | `llm.cjs`：MockLLM 对抗性模拟 / HttpLLM 真实接入骨架（工具清单从分级表派生） |
| 计划校验（不信任模型输出） | `planner.cjs`：目录 + 必需参数 + **来源溯源（收件人 + 上传地址）** + 代发身份治理 |

## 可插拔 LLM（怎么接真模型）

- 默认 `MockLLM`：离线确定性，且**故意模拟"被注入带偏的模型"**——让"模型之外的护栏"始终处于被测试状态
- 接真实模型：`HttpLLM`（OpenAI 兼容 `/chat/completions`，15s 超时），配置环境变量：
  `SAFE_OFFICE_LLM_ENDPOINT` / `SAFE_OFFICE_LLM_KEY` / `SAFE_OFFICE_LLM_MODEL`（密钥只走环境变量，绝不入库）
- 铁律：**不信任模型输出**——进模型前的上下文先过闸1；**机密正文不进云模型**（模型边界）；出模型的计划先过校验；执行再走五道闸+沙箱

## 可复现安全测试样例（交付物雏形）

`test/attacks.test.cjs` = 命题点名攻击的样例库，每条 = 攻击样本 + 预期拦截层 + 断言（含"副作用为零"）：

| 样例 | 拦截层 | 要点 |
|---|---|---|
| 代发邮件 | 计划校验 | 「以张总名义发通知」→ 无委托令牌默认拒绝（身份治理） |
| 批量删除文件 | 闸2 令牌 | 次数上限逐条封顶，只删 1 个且快照可回滚 |
| 导出通讯录 | 计划校验 + 工具约束 | 导出工具不存在；单条查询默认脱敏 |
| 上传内部文档 | 策略矩阵 + 闸3 | 员工默认拒绝；数据边界独立兜底（仅公开级可上传） |
| 绕过审批执行 | 闸1 + 闸4 | 话术检出；文本声明不能替代星闪近场凭据 |
| 非法获取客户信息（扩展） | 计划校验 + 闸1 | 客户名单=同敏感面；输入话术可检 |
| **纵深防御①拆字变体** | 闸1 漏检 → 计划校验兜底 | 如实暴露漏检，证明下游拦得住 |
| **纵深防御②外部上传地址** | 计划校验溯源 | 出站目标（收件人+上传地址）溯源移除 |

## 演示素材说明

文档库、通讯录、录音/图片样本与剧本为自建演示数据（虚构公司/邮箱）；`engineering-master` 仅借鉴思路，未复用其任何内容。场景线=**会议纪要**（整理 → 派发 → 对外同步，2026-10-14 拍板）。
