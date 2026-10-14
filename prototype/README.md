# 核心机制原型（v0.3 · 平台无关）

> 「Agent 安全运行机制」的可运行原型——**零依赖、纯 Node**，上板前即可跑通全部机制逻辑。
> 上板路径：本目录逻辑**平移 ArkTS**（行为不变）→ 闸4 的 `nearfieldOnline` 换成 WS63 真实 SLE 握手 → 规划器换成真实 LLM 调用。

## 跑起来

```bash
node demo.cjs        # 攻防演示（答辩预演脚本：正常流 / 注入 / 越权 / 冻结闭环 / 近场 / 回滚 / 回溯）
npm test             # 自动化测试（19 项，全绿）
```

## 结构

```
prototype/
├── demo.cjs                攻防演示：正常流 / 注入 / 越权 / 治理闭环（冻结·复核·解冻）/ 近场（拒绝·放行）/ 快照回滚 / 治理回溯
├── src/
│   ├── llm.cjs             可插拔 LLM：MockLLM（对抗性模拟）/ HttpLLM（OpenAI 兼容骨架，密钥走 env，带超时）
│   ├── planner.cjs         带护栏规划器：上下文消毒 → 计划校验（工具目录 + 必需参数 + 来源溯源）
│   ├── guard.cjs           L2 安全网关：闸1 消毒 · 闸2 权限令牌 · 闸3 数据边界 · 闸4 高危确认
│   ├── governance.cjs      L3 治理中心：策略矩阵（fail-closed）· 审计哈希链 · 风险计量（超阈值自动冻结 / 人工复核解冻）
│   ├── runtime.cjs         L1 Agent 运行时：规划 → 每步过闸 → 执行 → 全程审计；高危执行前快照、支持一键回滚
│   └── scenario.cjs        场景数据：办公文档库 + 外部材料注入样本（计划逻辑在 llm.cjs）
└── test/engine.test.cjs    闸级 + 计划校验 + 冻结闭环 + 快照回滚 + 端到端（19 项）
```

## 与设计骨架的对应

| 骨架（docs/00） | 本原型 |
|---|---|
| L2 闸1 输入消毒 | `sanitizeInput`（可疑句整句隔离为"仅数据"；中英模式库） |
| L2 闸2 权限令牌 | `CapabilityToken`（工具白名单 × 域名白名单 × 次数；被拒调用不耗配额） |
| L2 闸3 数据边界 | `checkDataBoundary`（机密禁出站 + 外发脱敏） |
| L2 闸4 执行管控 | `requestHumanConfirm`（近场确认接口，上板换真实 SLE）+ **执行前快照 / 一键回滚** |
| L3 策略中心 | `PolicyEngine`（未声明=拒绝） |
| L3 审计 | `AuditLog`（哈希链，篡改即断裂） |
| L3 风险评分 | `RiskMeter`（超阈值**自动冻结高危通道** → 人工复核：clear 解冻清零 / escalate 保持冻结） |
| 规划器（骨架 §4 L1） | `llm.cjs`：MockLLM 对抗性模拟 / HttpLLM 真实接入骨架 |
| 计划校验（不信任模型输出） | `planner.cjs`：工具目录 + 必需参数 + 来源溯源（外部内容注入的动作 → 移除） |

## 可插拔 LLM（怎么接真模型）

- 默认 `MockLLM`：离线确定性，且**故意模拟"被注入带偏的模型"**——让"模型之外的护栏"始终处于被测试状态
- 接真实模型：`HttpLLM`（OpenAI 兼容 `/chat/completions`，15s 超时），配置环境变量：
  `SAFE_OFFICE_LLM_ENDPOINT` / `SAFE_OFFICE_LLM_KEY` / `SAFE_OFFICE_LLM_MODEL`（密钥只走环境变量，绝不入库）
- 铁律：**不信任模型输出**——进模型前的上下文先过闸1；出模型的计划先过校验；执行再走四道闸

## 演示素材说明

文档库与剧本为自建演示数据（虚构公司/邮箱）；`engineering-master` 仅借鉴思路，未复用其任何内容。当前场景线=**会议纪要**（整理 → 派发 → 对外同步，2026-10-14 拍板）。
