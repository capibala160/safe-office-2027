'use strict';
// ============================================================
// 带护栏的规划器：不信任模型输出
//   1) 上下文装配：外部文档先过闸1 → 以 <DOC> 数据块进提示词（指令/数据边界）
//   2) 调模型出计划（可插拔：MockLLM / HttpLLM）
//   3) 计划校验：结构校验 + 来源溯源
//      —— 收件人只出现在外部材料、与用户指令无关 = 注入诱导 → 移除并记录证据
// ============================================================
const { TOOL_META } = require('./capabilities.cjs');
const { prepareModelInput, resolveTargets } = require('./model-boundary.cjs');
const { createRegistry } = require('./tool-registry.cjs');

// 工具目录与必需参数：从能力分级表（单一事实源）派生
const KNOWN_TOOLS = new Set(Object.keys(TOOL_META));
const REQUIRED_ARGS = Object.fromEntries(
  Object.entries(TOOL_META).map(([tool, meta]) => [tool, meta.requiredArgs || []]),
);
// 私有内置注册表：2 参调用不受全局 defaultRegistry 污染
const BUILTIN_REGISTRY = createRegistry();

function validatePlan(rawSteps, { command = '', docs = [], delegation = null, delegationVerifier = null, registry = BUILTIN_REGISTRY } = {}) {
  const reg = registry || null;
  const hasTool = (name) => (reg ? reg.has(name) : KNOWN_TOOLS.has(name));
  const requiredOf = (name) => (reg ? reg.requiredArgs(name) : (REQUIRED_ARGS[name] || []));
  const steps = [];
  const findings = [];
  const notes = [];
  const externalText = docs.map((d) => d.body).join('\n');
  const delegationIntent = /(以|用).{1,10}名义|代为?(发送|群发|发信)/.test(command);
  // 生成稿绑定：同一计划里总结过 X，就必须发 draft_X——不能让模型把源文档直接发出去
  const summarizedSources = new Set();
  for (const s of Array.isArray(rawSteps) ? rawSteps : []) {
    if (s && s.action === 'summarize' && s.args && typeof s.args.of === 'string') summarizedSources.add(s.args.of);
  }
  if (!Array.isArray(rawSteps) || rawSteps.length > 64) {
    return { steps: [], findings: [{ level: 'block', reason: '计划必须是至多 64 步的数组' }], notes: [] };
  }

  for (const s of Array.isArray(rawSteps) ? rawSteps : []) {
    // 结构校验：动作必须在工具目录内
    if (!s || typeof s.action !== 'string' || !hasTool(s.action)) {
      findings.push({ level: 'block', reason: `非法动作「${(s && s.action) || '(空)'}」不在工具目录内，已移除`, step: s });
      continue;
    }
    // 结构校验：必需参数齐全
    const missing = requiredOf(s.action).filter(
      (k) => !s.args || typeof s.args[k] !== 'string' || !s.args[k].trim() || s.args[k].length > 2048,
    );
    if (missing.length > 0) {
      findings.push({ level: 'block', reason: `步骤 ${s.action} 缺少必需参数 [${missing.join(', ')}]，已移除`, step: s });
      continue;
    }
    // 身份治理：代发他人身份（以X名义 / 代发）需持有效委托令牌；无令牌/令牌不匹配 → 默认拒绝
    // 注意：委托令牌只解除"身份治理"这一条；目标溯源等下游检查仍必须通过，
    // 因此放行记录要等所有检查结束后再写（避免"已放行但步骤仍被移除"的假审计）。
    let delegationAllowed = false;
    if ((s.action === 'sendInternalEmail' || s.action === 'sendExternalEmail') && delegationIntent) {
      const verdict = typeof delegationVerifier === 'function'
        ? delegationVerifier(delegation, { to: s.args && s.args.to, action: s.action })
        : { allow: false, reason: '未持委托令牌' };
      if (!verdict.allow) {
        findings.push({
          level: 'block',
          reason: `代发语义（以他人名义发送）且${verdict.reason} → 默认拒绝（身份治理）`,
          step: s,
        });
        continue;
      }
      delegationAllowed = true;
    }
    // 来源溯源：出站目标（收件人 / 上传地址）的出处检查
    if (['sendInternalEmail', 'sendExternalEmail'].includes(s.action) && s.args && s.args.to) {
      const fromCommand = (command.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) || []).includes(s.args.to);
      const fromExternal = externalText.includes(s.args.to);
      if (!fromCommand) {
        findings.push({
          level: 'block',
          reason: `收件人「${s.args.to}」${fromExternal ? '仅出现于外部材料' : '来源未授权'}，已移除该步骤`,
          step: s,
        });
        continue;
      }
    }
    if (s.action === 'uploadToCloud' && s.args && s.args.url) {
      const fromCommand = (command.match(/https:\/\/[^\s，。；）)]+/g) || []).includes(s.args.url);
      const fromExternal = externalText.includes(s.args.url);
      if (!fromCommand) {
        findings.push({
          level: 'block',
          reason: `上传地址「${s.args.url}」${fromExternal ? '仅出现于外部材料' : '来源未授权'}，已移除该步骤`,
          step: s,
        });
        continue;
      }
    }
    // 生成稿绑定：本计划已生成 draft_X，却直接发送源文档 X → 移除（不许拿原件外发）
    // 放在溯源检查之后：收件人本身未授权时，先报"收件人来源"这一条更准确
    if (['sendInternalEmail', 'sendExternalEmail'].includes(s.action) && s.args && s.args.docId
      && summarizedSources.has(s.args.docId)) {
      findings.push({
        level: 'block',
        reason: `步骤 ${s.action} 直接发送源文档「${s.args.docId}」；本计划已生成 draft_${s.args.docId}，必须发送生成稿`,
        step: s,
      });
      continue;
    }
    if (delegationAllowed) {
      notes.push({
        level: 'info',
        reason: `委托令牌放行：${s.action} → ${(s.args && s.args.to) || '(未指定)'}`,
      });
    }
    steps.push(s);
  }
  return { steps, findings, notes };
}

class GuardedPlanner {
  constructor({ llm, audit, risk, registry = BUILTIN_REGISTRY }) {
    this.llm = llm;
    this.audit = audit;
    this.risk = risk;
    this.registry = registry;
  }

  async makePlan(command, { docs = [], modelLocation, commandLevel, delegation = null, delegationVerifier = null } = {}) {
    const prepared = prepareModelInput(this.llm, command, docs, { modelLocation, commandLevel });
    modelLocation = prepared.location;
    const contextBlocks = prepared.blocks;
    const contextInfo = {
      modelLocation,
      sent: contextBlocks.filter((b) => !b.withheld).map((b) => b.id),
      withheld: contextBlocks.filter((b) => b.withheld).map((b) => b.id),
    };
    this.audit.append('规划上下文', { docs: contextBlocks.map((b) => ({ id: b.id, sanitized: b.sanitized })) });
    const targetPlaceholders = Object.keys(prepared.targets || {});
    this.audit.append('数据流向', {
      model: modelLocation === 'cloud' ? '云侧模型' : '本地模型',
      sentDocs: contextInfo.sent,
      withheldDocs: contextInfo.withheld,
      // 云侧只见 [目标N] 占位符；真实目标留在端侧（F-05）
      targetPlaceholders: targetPlaceholders.length > 0 ? targetPlaceholders : undefined,
    });

    // 2) 模型出计划
    const raw = await this.llm.plan(prepared.command, contextBlocks);

    // 2.5) 目标占位符回填：规划层用真值做溯源，模型本身从未见过真值（F-05）
    const resolved = resolveTargets(raw, prepared.targets);

    // 3) 计划校验（出模型后的第一道保险）
    const { steps, findings, notes } = validatePlan(resolved, {
      command, docs, delegation, delegationVerifier, registry: this.registry,
    });
    for (const f of findings) {
      this.audit.append('计划校验', { level: f.level, reason: f.reason, step: f.step });
      this.risk.add(f.level === 'block' ? 25 : 5, `计划校验${f.level === 'block' ? '拦截' : '提示'}：${f.reason}`);
    }
    for (const n of notes || []) {
      this.audit.append('委托放行', { reason: n.reason });
    }
    if (findings.length > 0) {
      this.audit.append('计划校正', { before: Array.isArray(resolved) ? resolved.length : 0, after: steps.length });
    }
    return { steps, findings, notes, contextInfo };
  }
}

module.exports = { GuardedPlanner, validatePlan, KNOWN_TOOLS };
