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

function validatePlan(rawSteps, {
  command = '', docs = [], delegation = null, delegationVerifier = null, registry = BUILTIN_REGISTRY,
  authorizedTools = null, enforceToolAuthorization = false,
} = {}) {
  const reg = registry || null;
  const hasTool = (name) => (reg ? reg.has(name) : KNOWN_TOOLS.has(name));
  const requiredOf = (name) => (reg ? reg.requiredArgs(name) : (REQUIRED_ARGS[name] || []));
  const steps = [];
  const findings = [];
  const notes = [];
  const externalText = docs.map((d) => d.body).join('\n');
  const authorizedDocIds = new Set((docs || []).map((d) => d.id));
  const readIds = new Set();        // 计划中已读入的文档（按执行顺序）
  const summarizedSoFar = new Set(); // 计划中已生成过的源文档（按执行顺序）
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
    // —— 工具授权（计划层预检）——
    // 令牌不允许的工具在运行时也会被闸2拒绝；这里提前给出 finding，
    // 让云侧“计划修正”有机会改对（例如令牌没有 summarize 时不要生成摘要）。
    if (enforceToolAuthorization && Array.isArray(authorizedTools) && !authorizedTools.includes(s.action)) {
      findings.push({
        level: 'block',
        reason: `动作「${s.action}」不在本次授权工具内，已移除`,
        step: s,
      });
      continue;
    }

    // —— 步骤依赖（按执行顺序）——
    // 需要"先读入"的动作若缺少前置 readDoc：仅在文档已授权时自动补一步；
    // 未授权的文档不补，直接移除并记 finding（不能靠补步骤绕过授权）。
    // 调用方没传 docs（纯结构校验）时跳过依赖检查，保持 validatePlan 的旧契约。
    const needRead = authorizedDocIds.size > 0 ? [] : null;
    if (needRead) {
    if (s.action === 'summarize' && s.args && s.args.of) needRead.push(s.args.of);
    if ((s.action === 'printDoc' || s.action === 'deleteDoc') && s.args && s.args.id) needRead.push(s.args.id);
    if (['sendInternalEmail', 'sendExternalEmail'].includes(s.action) && s.args && s.args.docId
      && !String(s.args.docId).startsWith('draft_')) needRead.push(s.args.docId);
    const canRead = !Array.isArray(authorizedTools) || authorizedTools.includes('readDoc');
    for (const id of needRead) {
      if (!canRead || readIds.has(id) || !authorizedDocIds.has(id)) continue;
      steps.push({ action: 'readDoc', args: { id }, reason: '自动补前置读取' });
      readIds.add(id);
      notes.push({ level: 'info', reason: `已补前置 readDoc(${id})` });
    }
    // 发送生成稿：必须在本计划中先 summarize 过源文档（按执行顺序）
    if (['sendInternalEmail', 'sendExternalEmail'].includes(s.action) && s.args && s.args.docId
      && String(s.args.docId).startsWith('draft_')) {
      const source = String(s.args.docId).slice('draft_'.length);
      if (!summarizedSoFar.has(source)) {
        findings.push({
          level: 'block',
          reason: `步骤 ${s.action} 发送 draft_${source} 前缺少 summarize(${source})，已移除`,
          step: s,
        });
        continue;
      }
    }
    }
    if (delegationAllowed) {
      notes.push({
        level: 'info',
        reason: `委托令牌放行：${s.action} → ${(s.args && s.args.to) || '(未指定)'}`,
      });
    }
    steps.push(s);
    if (s.action === 'readDoc' && s.args && s.args.id) readIds.add(s.args.id);
    if (s.action === 'summarize' && s.args && s.args.of) summarizedSoFar.add(s.args.of);
  }
  return { steps, findings, notes };
}

class GuardedPlanner {
  // disabledLayers：仅评测消融用（如 ['plan']）。默认空集合，行为与之前完全一致。
  // maxPlanRepairs：模型计划被校验拦下后，最多让模型修正几次。只对云侧真实模型生效，
  //   且修正过程不改变授权边界（令牌、收件人溯源、目标回填全部按原指令重跑）。
  constructor({ llm, audit, risk, registry = BUILTIN_REGISTRY, disabledLayers = [], maxPlanRepairs = 1 }) {
    this.llm = llm;
    this.audit = audit;
    this.risk = risk;
    this.registry = registry;
    this.disabledLayers = new Set(disabledLayers);
    this.maxPlanRepairs = Math.max(0, Number(maxPlanRepairs) || 0);
  }

  _ablate(layer) {
    return this.disabledLayers.has(layer);
  }

  async makePlan(command, {
    docs = [], modelLocation, commandLevel, delegation = null, delegationVerifier = null,
    authorizedTools = null, authorizedDocs = null,
    authorizedAudios = null, authorizedImages = null,
  } = {}) {
    // gate1 关停：外部资料不经消毒直接进提示词（消融实验专用）
    const prepared = prepareModelInput(this.llm, command, docs, {
      modelLocation, commandLevel, sanitize: !this._ablate('gate1'),
    });
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

    // 2) 本次实际授权：只作提示词上下文，执行期仍按令牌/溯源/闸门校验
    const hasAuth = Array.isArray(authorizedTools);
    const media = [
      (authorizedAudios || []).length ? `可转写录音：${authorizedAudios.join('、')}` : '',
      (authorizedImages || []).length ? `可识别图片：${authorizedImages.join('、')}` : '',
    ].filter(Boolean).join('；');
    const authNote = hasAuth
      ? `【本次实际授权】可用工具：${authorizedTools.join('、') || '无'}；可读文档：${(authorizedDocs || []).join('、') || '无'}。`
        + (media ? `\n本次可处理的媒体：${media}。` : '')
        + '只能使用这里列出的工具与文档；未列出的不要调用，也不要编造 id。'
      : '';
    if (hasAuth) {
      this.audit.append('规划授权', { tools: authorizedTools, docs: authorizedDocs || [] });
    }

    // 2.5) 模型出计划
    const raw = await this.llm.plan(prepared.command, contextBlocks, { authNote });

    // 2.6) 目标占位符回填：规划层用真值做溯源，模型本身从未见过真值（F-05）
    let resolved = resolveTargets(raw, prepared.targets);

    // 2.9) 消融：计划校验整层关停（结构/溯源/委托/生成稿绑定全部不生效）
    //      仅评测用；默认不走到这里。
    if (this._ablate('plan')) {
      this.audit.append('消融', { layer: 'plan', reason: '计划校验关闭（评测消融）' });
      return {
        steps: Array.isArray(resolved) ? resolved : [],
        findings: [], notes: [], contextInfo, ablated: ['plan'],
      };
    }

    // 3) 计划校验（出模型后的第一道保险）
    const validate = (stepsIn) => validatePlan(stepsIn, {
      command, docs, delegation, delegationVerifier, registry: this.registry, authorizedTools,
      enforceToolAuthorization: prepared.location === 'cloud',
    });
    let outcome = validate(resolved);
    const blockCount = (r) => r.findings.filter((f) => f.level === 'block').length;

    // 3.5) 有限次计划修正：仅云侧真实模型；修正不扩大授权（仍按原指令/原令牌重验）
    //      只对“有计划步骤被拦”触发。空计划不触发——实测（v0.19 开发集）5 次空计划修正
    //      全部仍为空、0 次采纳，还带来一次 180s 超时；空计划更适合靠授权/媒体清单解决。
    //      Mock 是 local，不触发；修正失败或没变好就保留第一次的校验结果。
    if (blockCount(outcome) > 0 && this.maxPlanRepairs > 0 && prepared.location === 'cloud') {
      const before = blockCount(outcome);
      this.audit.append('计划修正请求', {
        attempt: 1,
        reason: 'blocked-steps',
        blockFindings: outcome.findings.filter((f) => f.level === 'block').map((f) => f.reason),
      });
      try {
        const feedback = [
          `上一次计划有 ${before} 个步骤被校验拦下：`,
          ...outcome.findings.filter((f) => f.level === 'block').map((f) => `- ${f.reason}`),
          '请只输出修正后的完整 JSON 数组；不要新增未授权工具、收件人或链接，不要解释。',
        ].join('\n');
        const raw2 = await this.llm.plan(prepared.command, contextBlocks, { authNote, feedback });
        const resolved2 = resolveTargets(raw2, prepared.targets);
        const second = validate(resolved2);
        const after = blockCount(second);
        // 空计划不是“修正”，是模型放弃：不采纳，避免把可用步骤一起丢掉。
        const adopted = after < before && second.steps.length > 0;
        if (adopted) {
          outcome = second;
          resolved = resolved2;
        }
        this.audit.append('计划修正结果', { before, after, adopted, steps: adopted ? resolved2.length : resolved.length });
      } catch (err) {
        // 修正失败不回滚第一次的校验结果：已有的坏步骤已经被移除，执行是安全的
        this.audit.append('计划修正失败', { reason: err && err.message ? err.message : String(err) });
      }
    }

    const { steps, findings, notes } = outcome;
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
