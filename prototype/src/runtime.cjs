'use strict';
// ============================================================
// L1 Agent 运行时（编排层）
//   指令 → 带护栏规划器出计划（含计划校验）→ 每步过
//   【闸1 输入消毒 / 闸2 权限令牌 / 策略矩阵 / 闸3 数据边界
//     / 闸4 高危确认 / 闸5 输出检测】+ 能力专项约束（打印/共享密级）
// 平台无关实现——上板时平移 ArkTS，规划器侧换真实 LLM（机制不变）
// ============================================================
const {
  sanitizeInput,
  checkToolCall,
  checkTokenActive,
  checkDataBoundary,
  checkAgentOutput,
  OUTBOUND_ACTIONS,
  HIGH_RISK_ACTIONS,
  requestHumanConfirm,
  redact,
} = require('./guard.cjs');
const { CONTACTS, AUDIOS, IMAGES, allDocuments, getDocumentById } = require('./scenario.cjs');
const { PerfMeter } = require('./perf.cjs');
const { DEFAULT_SANDBOX, checkSandbox } = require('./sandbox.cjs');
const { prepareModelInput } = require('./model-boundary.cjs');
const { ConfirmationService, digest } = require('./confirmation.cjs');
const { classifyModelFault, asModelFault } = require('./faults.cjs');
const { verifyAgentManifest } = require('./agents.cjs');

class AgentRuntime {
  // disabledLayers：仅评测消融用（如 ['gate2','gate4']）。默认空集合，行为与之前完全一致。
  constructor({
    policy, audit, risk, planner, perf, toolRegistry = null, toolExecutors = null,
    disabledLayers = [], calendarWriter = null,
    // 真实 ASR（v0.51）：上传的录音 + 腾讯云一句话识别客户端；null = 只用样例模拟
    audioStore = null, asr = null,
    // 闸4 的确认接缝（docs/59）：null = 保持现状（requestHumanConfirm 模拟）。
    // 注入函数签名：({ step, operation, challenge, ctx }) => { approved, method, proof? }
    humanConfirm = null,
  }) {
    this.disabledLayers = new Set(disabledLayers);
    this.policy = policy;
    this.audit = audit;
    this.risk = risk;
    this.planner = planner; // GuardedPlanner：模型输出先过计划校验，才轮到本运行时执行
    this.perf = perf || new PerfMeter(); // 时延度量（可选共享实例，跨场景累计）
    this.toolRegistry = toolRegistry || null; // v0.13：可选工具注册表；null 时退回静态表
    this.toolExecutors = toolExecutors instanceof Map
      ? toolExecutors
      : new Map(Object.entries(toolExecutors || {}));
    this.outbox = [];       // 已发送邮件（模拟副作用）
    this.uploads = [];      // 已上传外部的内容（模拟副作用）
    this.knowledge = {};    // 已读入的文档/转写稿（含消毒结果）
    this.snapshots = [];    // 高危执行前的状态快照（L2 闸4：可一键回滚）
    this.confirmations = new ConfirmationService();
    this.tasks = new Map(); // 幂等键：taskId → 任务执行记录（防超时重试重复执行）
    // v0.37：会议预约的真实副作用（写 .ics）；null = 保持模拟
    this.calendarWriter = typeof calendarWriter === 'function' ? calendarWriter : null;
    this.humanConfirm = typeof humanConfirm === 'function' ? humanConfirm : null;
    this.audioStore = audioStore instanceof Map ? audioStore : null;
    this.asr = asr || null;
  }

  _ablate(layer) {
    return this.disabledLayers.has(layer);
  }

  _isHighRisk(action) {
    return this.toolRegistry ? this.toolRegistry.isHighRisk(action) : HIGH_RISK_ACTIONS.has(action);
  }

  _isOutbound(action) {
    return this.toolRegistry ? this.toolRegistry.isOutbound(action) : OUTBOUND_ACTIONS.has(action);
  }

  _sandboxProfile(action) {
    return this.toolRegistry ? this.toolRegistry.sandboxProfile(action) : undefined;
  }

  // 闸1 消毒入口：消融关停时原样放行（仅评测用），并保留计时口径
  _sanitize(text) {
    if (this._ablate('gate1')) return { safe: true, cleaned: String(text), reasons: [] };
    return this.perf.measure('闸1 输入消毒', () => sanitizeInput(text));
  }

  // 真实 ASR 的转写稿入库：与模拟分支同口径——文本一律按不可信输入过闸1
  ingestTranscript({ id, title = '', level = '公开', text = '', owner = '', provider = '外部 ASR', requestId = null } = {}) {
    const san = this._sanitize(String(text || ''));
    const transcriptId = `tr_${id}`;
    this.knowledge[transcriptId] = {
      id: transcriptId, title: `${title || id}（转写稿）`, level,
      body: san.cleaned, cleaned: san.cleaned, sourceIds: [id],
      tainted: !san.safe, transcript: true, owner, provider,
    };
    if (!san.safe) {
      this.risk.add(25, `转写文本检出注入并隔离：${san.reasons.join('、')}`);
      this.audit.append('闸1触发', { source: `转写 ${id}`, level, reasons: san.reasons, provider, requestId });
    } else {
      this.audit.append('转写', { audioId: id, level, provider, requestId });
    }
    return { id: transcriptId, text: san.cleaned, tainted: !san.safe, reasons: san.reasons };
  }

  _outboundArg(action) {
    if (this.toolRegistry) return this.toolRegistry.outboundArg(action);
    return action === 'uploadToCloud' ? 'url' : 'to';
  }

  // —— 快照：执行高危动作前的完整状态（knowledge + outbox + uploads），支撑"误操作可回滚" ——
  takeSnapshot(label) {
    const snap = {
      seq: this.snapshots.length + 1,
      label,
      ts: new Date().toISOString(),
      knowledge: JSON.parse(JSON.stringify(this.knowledge)),
      outbox: JSON.parse(JSON.stringify(this.outbox)),
      uploads: JSON.parse(JSON.stringify(this.uploads)),
    };
    this.snapshots.push(snap);
    this.audit.append('快照', { seq: snap.seq, label });
    return snap;
  }

  // —— 回滚：恢复到最近一次快照（或指定 seq），该快照起的状态一并作废 ——
  rollback(seq) {
    const idx = seq
      ? this.snapshots.findIndex((s) => s.seq === seq)
      : this.snapshots.length - 1;
    const snap = this.snapshots[idx];
    if (!snap) return null;
    const before = { outbox: this.outbox.length, uploads: this.uploads.length, knowledge: Object.keys(this.knowledge).length };
    this.knowledge = JSON.parse(JSON.stringify(snap.knowledge));
    // 外发记录是已发生的副作用，回滚不得伪造撤回。
    this.snapshots.splice(idx); // 快照一次性使用，防重复回滚造成状态困惑
    this.audit.append('快照回滚', { seq: snap.seq, label: snap.label, before, after: { outbox: this.outbox.length, uploads: this.uploads.length, knowledge: Object.keys(this.knowledge).length } });
    return snap;
  }

  async runCommand(command, { role: requestedRole, agent, token, nearfieldOnline = false, scene = '', modelLocation, commandLevel = '内部', sandbox, taskId = null, autoRevoke = true, delegation = null, delegationVerifier = null, deferActions = null, onDeferred = null, onStage = null, shouldAbort = null, operator = null } = {}) {
    let role = requestedRole || '员工';
    // —— Agent 身份校验（v0.9）：清单可信 → 角色一致 → 令牌绑定该 Agent ——
    if (agent) {
      const check = verifyAgentManifest(agent, { registry: this.toolRegistry, policy: this.policy });
      if (!check.ok) {
        this.audit.append('Agent拒绝', { agentId: agent && agent.agentId, reason: check.reason });
        return [`指令：「${command}」`, `  ⛔ Agent 拒绝：${check.reason}`];
      }
      if (requestedRole && requestedRole !== agent.role) {
        const reason = `角色声明不一致（调用方=${requestedRole}，清单=${agent.role}）`;
        this.audit.append('Agent拒绝', { agentId: agent.agentId, reason });
        return [`指令：「${command}」`, `  ⛔ Agent 拒绝：${reason}`];
      }
      role = agent.role;
      if (modelLocation !== undefined && modelLocation !== agent.modelLocation) {
        const reason = `模型位置声明不一致（调用方=${modelLocation}，清单=${agent.modelLocation}）`;
        this.audit.append('Agent拒绝', { agentId: agent.agentId, reason });
        return [`指令：「${command}」`, `  ⛔ Agent 拒绝：${reason}`];
      }
      modelLocation = agent.modelLocation;
      if (token && (!token.agentId || token.agentId !== agent.agentId || token.role !== agent.role)) {
        this.audit.append('Agent拒绝', { agentId: agent.agentId, reason: '令牌与 Agent 身份不匹配' });
        return [`指令：「${command}」`, '  ⛔ Agent 拒绝：令牌未绑定该 Agent 身份或角色'];
      }
      this.audit.append('Agent身份', { agentId: agent.agentId, role: agent.role, manifestHash: agent.manifestHash, modelLocation: agent.modelLocation });
    }
    this.audit.append('用户指令', { role, command, scene, taskId, agentId: agent ? agent.agentId : undefined });
    const lines = [`指令：「${command}」（角色：${role}）`];

    // —— 幂等键（v0.7）：同一 taskId 只执行一次。模型超时等故障的重试
    //    直接复用首次结果，绝不重复执行——从源头掐死"重试双发"。
    //    任何终态（含失败）都复用；要真正重试请换新 taskId（标准幂等契约）。
    if (taskId) {
      const prior = this.tasks.get(taskId);
      if (prior && prior.state === 'running') {
        this.audit.append('幂等拒绝', { taskId, reason: '任务执行中，拒绝并发重复调用' });
        return [...lines, `  ⛔ 幂等拒绝：任务「${taskId}」正在执行中，本次调用未执行`];
      }
      if (prior && (prior.command !== command || prior.role !== role)) {
        this.audit.append('幂等冲突', { taskId, reason: '同一 taskId 绑定不同指令或角色' });
        return [...lines, `  ⛔ 幂等冲突：taskId「${taskId}」已绑定其它指令/角色，默认拒绝`];
      }
      if (prior) {
        this.audit.append('幂等复用', { taskId, outcome: prior.outcome });
        return [...lines, `  〔幂等复用〕taskId「${taskId}」已完成（结果与首次一致），本次未重复执行`, ...prior.lines.slice(1)];
      }
    }

    let started = false;
    try {
      const tokenState = checkTokenActive(token);
      if (!tokenState.allow) {
        this.audit.append('规划拒绝', { reason: tokenState.reason });
        return [...lines, `  ⛔ 规划拒绝：${tokenState.reason}`];
      }
      started = true;
      if (taskId) this.tasks.set(taskId, { state: 'running', command, role, outcome: null, lines: null });
      const settle = (outcome) => {
        if (!taskId) return;
        const rec = this.tasks.get(taskId);
        rec.state = 'done';
        rec.outcome = outcome;
        rec.lines = [...lines];
      };

      // 出计划（模型 → 计划校验）。模型故障统一 fail-closed：不执行任何步骤、
      // 审计记录类别与原始原因、结果对用户可见——绝不半程执行、绝不崩溃。
      let plan;
      try {
        if (onStage) onStage('规划', { command });
        plan = await this.perf.measureAsync('规划+计划校验', () =>
          this.planner.makePlan(command, {
            docs: Object.values(allDocuments()).filter(d => token?.documentIds.includes(d.id) && this.policy.decide(role, 'readDoc') === 'allow'),
            modelLocation,
            commandLevel,
            delegation,
            delegationVerifier,
            // 把"本次实际授权"告诉模型（只作提示，执行期仍按令牌校验）
            authorizedTools: token ? [...token.tools] : null,
            authorizedDocs: token ? token.documentIds.slice() : null,
            // 媒体清单：模型只知道"这段录音"时，需要看到可转写的 id 与标题
            authorizedAudios: token
              ? Object.values(AUDIOS).filter((a) => token.documentIds.includes(a.id)).map((a) => `${a.id}（${a.title}）`)
              : null,
            authorizedImages: token
              ? Object.values(IMAGES).filter((i) => token.documentIds.includes(i.id)).map((i) => `${i.id}（${i.title}）`)
              : null,
          }),
        );
      } catch (err) {
        const fault = classifyModelFault(err);
        this.audit.append('规划失败', { class: fault.class, reason: fault.reason, executed: false });
        lines.push(`  〔规划失败〕⛔ ${fault.class}：${fault.reason}`);
        lines.push('  〔fail-closed〕未执行任何步骤（无副作用）');
        settle('planning-failed');
        return lines;
      }
      const { steps, findings, notes, contextInfo } = plan;
      if (contextInfo && (contextInfo.modelLocation === 'cloud' || contextInfo.withheld.length > 0)) {
        lines.push(`  〔模型边界〕规划走云侧模型：送入 [${contextInfo.sent.join(', ') || '无'}]，` +
          `机密 ${contextInfo.withheld.length} 篇正文已分流（不送云，仅本地处理）——数据流向已入审计`);
      }
      for (const f of findings) {
        lines.push(`  〔计划校验〕⛔ ${f.reason}`);
      }
      for (const n of notes || []) {
        lines.push(`  〔计划校验〕✓ ${n.reason}`);
      }
      if (findings.length > 0) {
        lines.push(`  〔计划〕模型输出 ${findings.length + steps.length} 步 → 校验后 ${steps.length} 步`);
      }

      // 执行：任一步骤抛出模型故障（如生成阶段超时）→ 立即中止剩余步骤（fail-closed）
      for (let i = 0; i < steps.length; i++) {
        // 取消入口：在步骤之间生效；已执行的步骤保留（副作用不可撤回，只停止后续）
        if (shouldAbort && shouldAbort()) {
          const notExecuted = steps.length - i;
          this.audit.append('任务取消', { atStep: i + 1, executed: i, notExecuted });
          lines.push(`  ⛔ 任务取消：第 ${i + 1} 步前停止，其后 ${notExecuted} 步未执行；已执行的 ${i} 步保留记录`);
          settle('cancelled');
          return lines;
        }
        try {
          if (onStage) onStage('执行', { step: i + 1, total: steps.length });
          lines.push(await this.execStep(steps[i], i + 1, { role, token, nearfieldOnline, sandbox, command, modelLocation, commandLevel, deferActions, onDeferred, operator, taskId }));
        } catch (err) {
          const fault = classifyModelFault(err);
          const notExecuted = steps.length - i - 1;
          this.audit.append('任务中止', { class: fault.class, reason: fault.reason, atStep: i + 1, action: steps[i].action, notExecuted });
          lines.push(`  ⛔ 任务中止（${fault.class}）：${fault.reason}`);
          lines.push(`  〔fail-closed〕第 ${i + 1} 步模型故障，其后 ${notExecuted} 步未执行`);
          settle('aborted');
          return lines;
        }
      }
      settle('ok');
      return lines;
    } finally {
      // 任务结束（成功/失败/异常）→ 任务令牌自动吊销，防止跨任务复用
      // （autoRevoke:false 可显式关闭——仅限确实需要跨命令共享令牌的调用方）
      if (started && token && autoRevoke && !token.revoked) {
        token.revoked = true;
        this.audit.append('令牌吊销', { issuedFor: token.issuedFor, reason: '任务结束自动吊销' });
      }
    }
  }

  async execStep(step, n, ctx) {
    const { action, args } = step;
    // 租户可见性：管理员/审计员跨租户；其余只看自己的知识条目（无 owner 的旧条目视为共享）
    const tenantVisible = (doc) => !doc.owner
      || doc.owner === ctx.operator
      || ['管理员', '审计员'].includes(ctx.role);
    this.audit.append('计划步骤', { n, action, args, fromDoc: step.fromDoc || null });
    if (this.toolRegistry && !this.toolRegistry.has(action)) {
      this.risk.add(15, `工具未注册 ${action}`);
      this.risk.observe({ kind: 'blocked', action });
      this.audit.append('工具拒绝', { n, action, reason: '未注册工具' });
      return `  [${n}] ${action} ⛔ 工具拒绝：未在工具注册表中登记（fail-closed）`;
    }
    const decision = this._ablate('policy')
      ? 'allow'
      : this.perf.measure('策略矩阵', () => this.policy.decide(ctx.role, action));
    if (!['allow', 'confirm'].includes(decision)) {
      this.risk.add(30, `策略禁止 ${action}`);
      this.risk.observe({ kind: 'blocked', action });
      this.audit.append('策略拒绝', { n, role: ctx.role, action });
      return `  [${n}] ${action} ⛔ 策略拒绝：角色「${ctx.role}」不允许该动作`;
    }

    // —— 闸2：权限令牌（工具白名单 × 域名白名单 × 次数）——
    //    消融关停时连"文档授权 / 源文档授权 / 出站目标授权"一起关（它们同属令牌约束）。
    const gate2Off = this._ablate('gate2');
    const t = gate2Off
      ? { allow: true }
      : this.perf.measure('闸2 权限令牌', () => checkToolCall(ctx.token, action, args));
    if (!t.allow) {
      this.risk.add(15, `闸2 拦截 ${action}：${t.reason}`);
      this.risk.observe({ kind: 'blocked', action });
      this.audit.append('闸2拒绝', { n, action, args, reason: t.reason });
      return `  [${n}] ${action} ⛔ 闸2拒绝：${t.reason}`;
    }
    const resourceId = ['readDoc', 'recognizeImage', 'transcribeAudio', 'deleteDoc', 'printDoc'].includes(action)
      ? args.id : null;
    if (!gate2Off && resourceId && !ctx.token.documentIds.includes(resourceId)) {
      this.audit.append('数据访问拒绝', { action, id: args.id });
      return `  [${n}] ${action} ⛔ 数据访问拒绝：资源未授权`;
    }
    const sourceId = action === 'summarize' ? args.of : action === 'printDoc' ? args.id : args.docId;
    if (!gate2Off && sourceId) {
      const sources = this.knowledge[sourceId]?.sourceIds || [sourceId];
      if (!sources.every(id => ctx.token.documentIds.includes(id))) {
        this.audit.append('数据访问拒绝', { action, sourceId });
        return `  [${n}] ${action} ⛔ 数据访问拒绝：源资源未授权`;
      }
    }
    if (!gate2Off && this._isOutbound(action)) {
      const target = args[this._outboundArg(action)];
      const targets = String(ctx.command || '').match(/https:\/\/[^\s，。；）)]+|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || [];
      if (!targets.includes(target)) {
        this.audit.append('目标授权拒绝', { action, target });
        return `  [${n}] ${action} ⛔ 出站目标未获用户明确授权`;
      }
    }

    // —— 沙箱：执行环境独立一锁（令牌放行 ≠ 环境放行）——
    const sb = this._ablate('sandbox')
      ? { allow: true }
      : this.perf.measure('沙箱校验', () =>
        checkSandbox(action, args, ctx.sandbox || DEFAULT_SANDBOX, this._sandboxProfile(action)));
    if (!sb.allow) {
      this.risk.add(20, `沙箱拦截 ${action}：${sb.reason}`);
      this.risk.observe({ kind: 'blocked', action });
      this.audit.append('沙箱拒绝', { n, action, args, reason: sb.reason, sandbox: (ctx.sandbox || DEFAULT_SANDBOX).name });
      return `  [${n}] ${action} ⛔ 沙箱拒绝：${sb.reason}`;
    }

    // —— 读文档：先过闸1（输入消毒，注入内容隔离为"仅数据"）——
    if (action === 'readDoc') {
      const doc = getDocumentById(args.id);
      if (!doc) return `  [${n}] readDoc(${args.id}) ⛔ 文档不存在`;
      const san = this._sanitize(doc.body);
      this.knowledge[doc.id] = { ...doc, owner: ctx.operator || '', cleaned: san.cleaned, tainted: !san.safe };
      // 读入事实先入审计（即使内容被隔离，调用链也要有"读过什么"的证据）
      this.audit.append('读入文档', { docId: doc.id, level: doc.level, tainted: !san.safe });
      if (!san.safe) {
        this.risk.add(25, `文档「${doc.title}」检出注入并隔离：${san.reasons.join('、')}`);
        this.audit.append('闸1触发', { docId: doc.id, level: doc.level, reasons: san.reasons });
        return `  [${n}] readDoc(${doc.id}) ⚠️ 检出注入并隔离（${san.reasons.join('、')}）→ 内容仅作数据展示`;
      }
      return `  [${n}] readDoc(${doc.id}) ✓（密级=${doc.level}）`;
    }

    // —— 图片识别：OCR 文本 = 外部内容 → 强制过闸1（图内注入同权隔离）——
    if (action === 'recognizeImage') {
      const img = IMAGES[args.id];
      if (!img) return `  [${n}] recognizeImage(${args.id}) ⛔ 图片不存在`;
      const san = this._sanitize(img.ocrText);
      this.knowledge[`img_${img.id}`] = { id: `img_${img.id}`, title: `${img.title}（识别稿）`, level: img.level, body: san.cleaned, cleaned: san.cleaned, sourceIds: [img.id], tainted: !san.safe, ocr: true, owner: ctx.operator || '' };
      // 识别事实先入审计（即使文本被隔离）
      this.audit.append('图片识别', { n, imageId: img.id, level: img.level, tainted: !san.safe });
      if (!san.safe) {
        this.risk.add(25, `图片「${img.title}」识别文本检出注入并隔离：${san.reasons.join('、')}`);
        this.audit.append('闸1触发', { n, source: `图片 ${img.id}`, level: img.level, reasons: san.reasons });
        return `  [${n}] recognizeImage(${img.id}) ⚠️ 图内文字检出注入并隔离（${san.reasons.join('、')}）→ 仅作数据展示`;
      }
      return `  [${n}] recognizeImage(${img.id}) ✓（密级=${img.level}，识别文本已过闸1）`;
    }

    // —— 策略矩阵（角色 × 动作）——

    // —— 能力专项约束（分级表落地）：打印/共享 的密级前置检查 ——
    if (action === 'printDoc') {
      const doc = this.knowledge[args.id];
      if (!doc) {
        this.audit.append('打印拒绝', { n, reason: `文档 ${args.id} 未读入` });
        return `  [${n}] printDoc(${args.id}) ⛔ 拒绝：文档未读入，禁止打印`;
      }
      if (doc.level === '机密') {
        this.risk.add(20, `禁止打印机密文档「${doc.title}」`);
        this.audit.append('打印拒绝', { n, docId: doc.id, level: doc.level, reason: '机密级禁止打印' });
        return `  [${n}] printDoc(${doc.id}) ⛔ 拒绝：机密级文档禁止打印（分级表·打印控制约束）`;
      }
    }
    if (action === 'shareScreen') {
      const conf = Object.values(this.knowledge).find((d) => d.level === '机密' && tenantVisible(d));
      if (conf) {
        this.risk.add(20, `禁止共享：知识库存在机密材料「${conf.title}」`);
        this.audit.append('共享拒绝', { n, conflicting: conf.id, reason: '知识库存在机密材料' });
        return `  [${n}] shareScreen ⛔ 拒绝：知识库存在机密材料「${conf.title}」，禁止共享（防连带泄露）`;
      }
    }

    // —— 闸3：数据边界（出站动作：密级 + 脱敏）——
    let payload = null;
    if (this._isOutbound(action)) {
      const doc = this.knowledge[args.docId];
      if (!doc) {
        this.audit.append('闸3拒绝', { n, reason: `文档 ${args.docId} 未读入` });
        return `  [${n}] ${action} ⛔ 闸3拒绝：文档 ${args.docId} 未读入，禁止出站`;
      }
      if (this._ablate('gate3')) {
        // 消融：跳过分级判定与脱敏，正文原样出站（仅评测用）
        payload = doc.body;
      } else {
        const b = this.perf.measure('闸3 数据边界', () =>
          checkDataBoundary(doc, action, { outbound: true, outboundArg: this._outboundArg(action) }));
        if (!b.allow) {
          this.risk.add(25, `闸3 拦截外发：${b.reason}`);
          this.risk.observe({ kind: 'blocked', action });
          this.audit.append('闸3拒绝', { n, action, docId: doc.id, reason: b.reason });
          return `  [${n}] ${action} ⛔ 闸3拒绝：${b.reason}`;
        }
        payload = b.content;
        if (this._isOutbound(action) && action !== 'sendInternalEmail') {
          this.audit.append('闸3脱敏', { n, docId: doc.id, action });
        }
      }
    }

    // —— 闸5：输出检测（出站内容→机密碎片比对 / 不合规话术 / PII 兜底）——
    if (payload !== null && !this._ablate('gate5')) {
      const confDocs = Object.values(this.knowledge).filter((d) => d.level === '机密' && tenantVisible(d));
      const oc = this.perf.measure('闸5 输出检测', () =>
        checkAgentOutput(payload, {
          level: '外发', confidentialDocs: confDocs,
          external: action !== 'sendInternalEmail' && this._isOutbound(action),
        }),
      );
      if (!oc.allowed) {
        this.risk.add(20, `闸5 拦截出站内容：${oc.reasons.join('、')}`);
        this.risk.observe({ kind: 'blocked', action });
        this.audit.append('闸5拒绝', { n, action, reasons: oc.reasons });
        return `  [${n}] ${action} ⛔ 闸5拒绝：${oc.reasons.join('、')}`;
      }
      if (oc.action === 'redact') {
        payload = oc.content;
        this.audit.append('闸5脱敏', { n, action });
      }
    }

    // —— L3 冻结：风险分超阈值后，高危动作一律转人工（近场确认亦不放行）——
    if (this._isHighRisk(action) && this.risk.frozen && !this._ablate('freeze')) {
      this.audit.append('冻结拦截', { n, action, score: this.risk.score, threshold: this.risk.threshold });
      return `  [${n}] ${action} ⛔ 风险冻结拦截：风险分 ${this.risk.score} ≥ 阈值 ${this.risk.threshold}，高危动作已转人工复核（近场确认亦不放行）`;
    }

    // —— v0.12 转交确认缝（默认关闭）——
    //    位置：规划/令牌/沙箱/边界/输出/风险冻结检查之后，闸4之前。
    //    命中 deferActions 的动作不再执行运行时模拟闸4/模拟副作用，
    //    而是把已过闸的参数交给上层（控制台）创建冻结操作，再走 WS63 确认。
    const deferredSet = ctx.deferActions instanceof Set
      ? ctx.deferActions
      : new Set(ctx.deferActions || []);
    if (deferredSet.has(action)) {
      // 转交前落快照：副作用会在确认后由上层执行，回滚仍可恢复到确认前
      if (this._isHighRisk(action)) this.takeSnapshot(`转交前快照：${action}`);
      const doc = this.knowledge[args.docId] || this.knowledge[args.id] || null;
      const descriptor = {
        stepNumber: n,
        action,
        args: structuredClone(args),
        payload,
        decision,
        role: ctx.role,
        command: ctx.command,
        docId: args.docId || args.id || null,
        docTitle: doc ? doc.title : '',
        docLevel: doc ? doc.level : '内部',
        sourceDocIds: doc ? (doc.sourceIds || [doc.id]) : [],
      };
      this.audit.append('转交确认闭环', {
        n,
        action,
        decision,
        requiresNearfield: this._isHighRisk(action),
        docId: descriptor.docId,
        docTitle: descriptor.docTitle,
      });
      if (typeof ctx.onDeferred === 'function') {
        try {
          ctx.onDeferred(descriptor);
        } catch (err) {
          this.audit.append('转交失败', { n, action, reason: err.message });
          return `  [${n}] ${action} ⛔ 转交确认闭环失败：${err.message}（未执行）`;
        }
      }
      return `  [${n}] ${action} ⇥ 已转交确认执行闭环（${this._isHighRisk(action) ? '需近场确认' : '策略自动确认'}）`;
    }

    // —— 闸4：高危二次确认（策略 confirm 或高危动作清单）——
    let confirmNote = '';
    if (!this._ablate('gate4') && (decision === 'confirm' || this._isHighRisk(action))) {
      const operation = { role: ctx.role, action, args: structuredClone(args), contentHash: digest(payload) };
      const challenge = this.confirmations.challenge(operation);
      let c;
      try {
        c = await this.perf.measureAsync('闸4 高危确认', () =>
          this.humanConfirm
            ? this.humanConfirm({ step, operation, challenge, ctx })
            : requestHumanConfirm(step, { nearfieldOnline: ctx.nearfieldOnline }),
        );
      } catch (err) {
        // 确认端异常一律拒绝（fail-closed）：不能因为适配器抛错就放行
        c = { approved: false, method: `确认端异常：${err && err.message ? err.message : err}` };
      }
      const response = c.approved ? this.confirmations.simulateResponse(challenge) : null;
      const currentOperation = { role: ctx.role, action, args: structuredClone(args), contentHash: digest(payload) };
      if (!c.approved || !this.confirmations.consume(response, currentOperation)) {
        this.confirmations.pending.delete(challenge.nonce);
        this.risk.add(10, `闸4 未确认：${c.method}`);
        this.risk.observe({ kind: 'blocked', action });
        this.audit.append('闸4拒绝', { n, action, method: c.method });
        return `  [${n}] ${action} ⛔ 闸4拒绝：${c.method}`;
      }
      confirmNote = `（${c.method}）`;
      this.audit.append('闸4确认', {
        n, action, method: c.method,
        operationHash: challenge.operationHash, nonce: challenge.nonce, expiresAt: challenge.expiresAt,
        ...(c.proof ? {
          confirmationId: c.proof.confirmationId || null,
          deviceLabel: c.proof.deviceLabel || null,
          decidedAt: c.proof.decidedAt || null,
        } : {}),
      });
    }

    // —— 快照：高危动作执行前落盘，误操作可一键回滚 ——
    if (this._isHighRisk(action)) {
      this.takeSnapshot(`执行前快照：${action}`);
      this.risk.observe({ kind: 'executed-high-risk', action }); // 行为因子观测（频次/时段）
    }

    // —— 执行（模拟副作用）——
    let effect = '';
    if (action === 'summarize') {
      const doc = this.knowledge[args.of];
      if (!doc) {
        effect = `生成摘要（源 ${args.of} 未读入，空）`;
      } else {
        const prepared = prepareModelInput(this.planner.llm, ctx.command || '整理正式纪要',
          [{ ...doc, body: doc.cleaned || doc.body }], ctx);
        if (prepared.blocks.some(b => b.withheld)) {
          this.audit.append('生成拒绝', { docId: doc.id, reason: '机密或未知密级不能在云侧生成' });
          return `  [${n}] summarize ⛔ 机密内容仅可由本地模型处理`;
        }
        this.audit.append('生成数据流向', { model: prepared.location, docId: doc.id });
        // 生成阶段的模型故障：归类并抛出 → 由 runCommand 统一中止剩余步骤（fail-closed）
        let draft;
        try {
          draft = await this.planner.llm.generate(prepared.command, prepared.blocks);
        } catch (err) {
          const fault = asModelFault(err);
          this.audit.append('生成失败', { n, docId: doc.id, class: fault.faultClass, reason: fault.faultReason });
          throw fault;
        }
        const oc = this._ablate('gate5')
          ? { allowed: true, content: draft }
          : this.perf.measure('闸5 输出检测', () => checkAgentOutput(draft, { level: doc.level }));
        if (!oc.allowed) {
          this.risk.add(20, `闸5 拦截生成内容：${oc.reasons.join('、')}`);
          this.audit.append('闸5拒绝', { n, action, reasons: oc.reasons });
          effect = `生成内容未通过输出检测（${oc.reasons.join('、')}）→ 已拦截，不输出`;
        } else {
          const id = `draft_${doc.id}`;
          this.knowledge[id] = { id, title: `${doc.title}（正式稿）`, level: doc.level,
            body: oc.content, cleaned: oc.content, sourceIds: doc.sourceIds || [doc.id], generated: true, owner: ctx.operator || '' };
          this.audit.append('生成稿', { id, sourceIds: this.knowledge[id].sourceIds, level: doc.level });
          effect = `生成正式稿 ${id}《${doc.title}》`;
        }
      }
    } else if (action === 'sendInternalEmail' || action === 'sendExternalEmail') {
      this.outbox.push({ to: args.to, docId: args.docId, content: payload });
      effect = `邮件 → ${args.to} 已发送${action === 'sendExternalEmail' ? '（内容已脱敏）' : ''}`;
      if (action === 'sendExternalEmail') this.risk.add(5, '高危动作经人工确认后放行');
    } else if (action === 'deleteDoc') {
      const doc = this.knowledge[args.id];
      delete this.knowledge[args.id];
      effect = `文档「${doc ? doc.title : args.id}」已删除（可回滚）`;
    } else if (action === 'scheduleMeeting') {
      // v0.37：配置了日历目录就真写 .ics；未配置明确标模拟，不冒充
      if (this.calendarWriter) {
        try {
          const written = await this.calendarWriter({
            title: args.title,
            at: args.at,
            id: `${ctx.taskId || 'task'}-${n}`,
            description: '由安全智慧办公 Agent 预约（已经过策略与沙箱检查）',
          });
          if (written && written.mode === 'written') {
            effect = `会议「${args.title}」已预约（${args.at}）→ .ics 已写入 ${written.file}`;
            this.audit.append('日历写入', { n, file: written.file, uid: written.uid });
          } else {
            effect = `会议「${args.title}」已预约（${args.at}）〔模拟：未配置日历目录〕`;
          }
        } catch (err) {
          this.risk.add(10, '日历写入失败');
          this.audit.append('执行失败', { n, action, reason: err.message });
          effect = `会议预约失败：${err.message}（未伪造成功）`;
        }
      } else {
        effect = `会议「${args.title}」已预约（${args.at}）`;
      }
    } else if (action === 'readContact') {
      const c = CONTACTS[args.name];
      if (!c) {
        effect = `未找到联系人「${args.name}」（无结果可返回）`;
      } else {
        effect = `联系人「${c.name}」（${c.title}）：${redact(c.phone)} / ${redact(c.email)}〔最小暴露：默认脱敏〕`;
      }
    } else if (action === 'printDoc') {
      const doc = this.knowledge[args.id];
      effect = doc && doc.level === '内部'
        ? `已打印《${doc.title}》（内部级：输出含水印与操作人标识）`
        : `已打印《${doc ? doc.title : args.id}》`;
    } else if (action === 'transcribeAudio') {
      const uploaded = this.audioStore ? this.audioStore.get(args.id) : null;
      const a = uploaded || AUDIOS[args.id];
      if (!a) {
        effect = `录音 ${args.id} 不存在`;
      } else {
        let text = a.body;
        let provider = '模拟 ASR';
        let requestId = null;
        if (uploaded) {
          if (!this.asr) {
            effect = `录音 ${args.id} 需要真实 ASR，但未配置（设 SAFE_OFFICE_ASR=1）`;
          } else {
            try {
              const result = await this.asr.transcribeFile(uploaded.filePath);
              text = result.text;
              provider = `腾讯云 ASR（${result.engine}）`;
              requestId = result.requestId;
            } catch (err) {
              effect = `转写失败（腾讯云 ASR）：${err.message}`;
            }
          }
        }
        if (!effect) {
          const san = this._sanitize(text);
          this.knowledge[`tr_${a.id}`] = { id: `tr_${a.id}`, title: `${a.title}（转写稿）`, level: a.level, body: san.cleaned, cleaned: san.cleaned, sourceIds: [a.id], tainted: !san.safe, transcript: true, owner: ctx.operator || '', provider };
          if (!san.safe) {
            this.risk.add(25, `转写文本检出注入并隔离：${san.reasons.join('、')}`);
            this.audit.append('闸1触发', { n, source: `转写 ${a.id}`, level: a.level, reasons: san.reasons, provider, requestId });
            effect = `转写完成（${provider}）⚠️ 文本含注入内容已隔离（${san.reasons.join('、')}）→ 仅作数据展示`;
          } else {
            this.audit.append('转写', { n, audioId: a.id, level: a.level, provider, requestId });
            effect = `转写完成（${provider}，${a.title}）→ 结果按不可信输入过闸1后入知识库`;
          }
        }
      }
    } else if (action === 'shareScreen') {
      effect = `屏幕共享已下发：目标 ${args.id} —— 请在控制台「设备 → 屏幕共享」点选窗口，服务端记录开始/结束（画面不上传）`;
    } else if (action === 'deviceControl') {
      effect = `设备指令已下发：${args.device} → ${args.op}（物理动作，执行前已落快照）`;
    } else if (action === 'uploadToCloud') {
      this.uploads.push({ url: args.url, docId: args.docId, content: payload });
      effect = `已上传 → ${args.url}（内容已脱敏）`;
    }

    // —— v0.13 自定义工具执行器（注册表 / 注入 Map）——
    //    内置动作全部命中原链；只有注册表里的自定义工具会走到这里。
    if (!effect) {
      let executor = this.toolExecutors.get(action);
      if (!executor && this.toolRegistry) {
        const def = this.toolRegistry.get(action);
        if (def && typeof def.executor === 'function') executor = def.executor;
      }
      if (typeof executor === 'function') {
        try {
          const result = await executor({
            action, args: structuredClone(args), step, n, ctx, payload, decision, runtime: this,
          });
          effect = typeof result === 'string' && result.trim()
            ? result
            : JSON.stringify(result === undefined ? { ok: true } : result);
        } catch (err) {
          this.risk.add(15, `自定义工具执行失败 ${action}`);
          this.risk.observe({ kind: 'blocked', action });
          this.audit.append('执行失败', { n, action, reason: err.message });
          return `  [${n}] ${action} ⛔ 执行失败：${err.message}（未伪造成功）`;
        }
      } else {
        this.audit.append('执行拒绝', { n, action, reason: '未注册执行器' });
        return `  [${n}] ${action} ⛔ 拒绝：未注册执行器（fail-closed）`;
      }
    }

    // args 一并入审计：调用链审计需要"对谁/对什么"的完整证据（评测 harness 也据此计分）
    this.audit.append('执行', { n, action, args, outcome: effect });
    return `  [${n}] ${action} ✓ ${effect}${confirmNote}`;
  }
}

module.exports = { AgentRuntime };
