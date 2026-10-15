'use strict';
// ============================================================
// 带护栏的规划器：不信任模型输出
//   1) 上下文装配：外部文档先过闸1 → 以 <DOC> 数据块进提示词（指令/数据边界）
//   2) 调模型出计划（可插拔：MockLLM / HttpLLM）
//   3) 计划校验：结构校验 + 来源溯源
//      —— 收件人只出现在外部材料、与用户指令无关 = 注入诱导 → 移除并记录证据
// ============================================================
const { sanitizeInput } = require('./guard.cjs');
const { TOOL_META } = require('./capabilities.cjs');

// 工具目录与必需参数：从能力分级表（单一事实源）派生
const KNOWN_TOOLS = new Set(Object.keys(TOOL_META));
const REQUIRED_ARGS = Object.fromEntries(
  Object.entries(TOOL_META).map(([tool, meta]) => [tool, meta.requiredArgs || []]),
);

function validatePlan(rawSteps, { command = '', docs = [] } = {}) {
  const steps = [];
  const findings = [];
  const externalText = docs.map((d) => d.body).join('\n');

  for (const s of Array.isArray(rawSteps) ? rawSteps : []) {
    // 结构校验：动作必须在工具目录内
    if (!s || typeof s.action !== 'string' || !KNOWN_TOOLS.has(s.action)) {
      findings.push({ level: 'block', reason: `非法动作「${(s && s.action) || '(空)'}」不在工具目录内，已移除`, step: s });
      continue;
    }
    // 结构校验：必需参数齐全
    const missing = (REQUIRED_ARGS[s.action] || []).filter(
      (k) => !s.args || s.args[k] === undefined || s.args[k] === '',
    );
    if (missing.length > 0) {
      findings.push({ level: 'block', reason: `步骤 ${s.action} 缺少必需参数 [${missing.join(', ')}]，已移除`, step: s });
      continue;
    }
    // 身份治理：代发他人身份（以X名义 / 代发）需持委托令牌，当前任务未签发 → 默认拒绝
    if ((s.action === 'sendInternalEmail' || s.action === 'sendExternalEmail') &&
        /(以|用).{1,10}名义|代为?(发送|群发|发信)/.test(command)) {
      findings.push({
        level: 'block',
        reason: `代发语义（以他人名义发送）且未持委托令牌 → 默认拒绝（身份治理）`,
        step: s,
      });
      continue;
    }
    // 来源溯源：出站目标（收件人 / 上传地址）的出处检查
    if (s.action === 'sendExternalEmail' && s.args && s.args.to) {
      const fromCommand = command.includes(s.args.to);
      const fromExternal = externalText.includes(s.args.to);
      if (fromExternal && !fromCommand) {
        findings.push({
          level: 'block',
          reason: `收件人「${s.args.to}」仅出现于外部材料、与用户指令无关（疑似注入诱导），已移除该步骤`,
          step: s,
        });
        continue;
      }
    }
    if (s.action === 'uploadToCloud' && s.args && s.args.url) {
      const fromCommand = command.includes(s.args.url);
      const fromExternal = externalText.includes(s.args.url);
      if (fromExternal && !fromCommand) {
        findings.push({
          level: 'block',
          reason: `上传地址「${s.args.url}」仅出现于外部材料、与用户指令无关（疑似注入诱导），已移除该步骤`,
          step: s,
        });
        continue;
      }
    }
    steps.push(s);
  }
  return { steps, findings };
}

class GuardedPlanner {
  constructor({ llm, audit, risk }) {
    this.llm = llm;
    this.audit = audit;
    this.risk = risk;
  }

  async makePlan(command, { docs = [], modelLocation = 'local' } = {}) {
    // 1) 上下文装配（闸1 前置：进模型前先消毒）
    //    —— 模型边界（答题要求 #3 数据流向）：云端模型只收非机密正文；
    //       机密文档按分级分流（正文不送云），如需其参与规划 → 走本地模型或人工
    const contextBlocks = docs.map((d) => {
      const san = sanitizeInput(d.body);
      const withheld = modelLocation === 'cloud' && d.level === '机密';
      return {
        id: d.id, title: d.title, level: d.level, sanitized: san.safe,
        withheld,
        text: withheld ? '【已按数据分级策略拦截：机密正文不送云侧模型，仅可本地处理】' : san.cleaned,
      };
    });
    const contextInfo = {
      modelLocation,
      sent: contextBlocks.filter((b) => !b.withheld).map((b) => b.id),
      withheld: contextBlocks.filter((b) => b.withheld).map((b) => b.id),
    };
    this.audit.append('规划上下文', { docs: contextBlocks.map((b) => ({ id: b.id, sanitized: b.sanitized })) });
    this.audit.append('数据流向', {
      model: modelLocation === 'cloud' ? '云侧模型' : '本地模型',
      sentDocs: contextInfo.sent,
      withheldDocs: contextInfo.withheld,
    });

    // 2) 模型出计划
    const raw = await this.llm.plan(command, contextBlocks);

    // 3) 计划校验（出模型后的第一道保险）
    const { steps, findings } = validatePlan(raw, { command, docs });
    for (const f of findings) {
      this.audit.append('计划校验', { level: f.level, reason: f.reason, step: f.step });
      this.risk.add(f.level === 'block' ? 25 : 5, `计划校验${f.level === 'block' ? '拦截' : '提示'}：${f.reason}`);
    }
    if (findings.length > 0) {
      this.audit.append('计划校正', { before: Array.isArray(raw) ? raw.length : 0, after: steps.length });
    }
    return { steps, findings, contextInfo };
  }
}

module.exports = { GuardedPlanner, validatePlan, KNOWN_TOOLS };
