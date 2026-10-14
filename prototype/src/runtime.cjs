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
  checkDataBoundary,
  checkAgentOutput,
  OUTBOUND_ACTIONS,
  HIGH_RISK_ACTIONS,
  requestHumanConfirm,
  redact,
} = require('./guard.cjs');
const { DOCS, CONTACTS, AUDIOS } = require('./scenario.cjs');
const { PerfMeter } = require('./perf.cjs');

class AgentRuntime {
  constructor({ policy, audit, risk, planner, perf }) {
    this.policy = policy;
    this.audit = audit;
    this.risk = risk;
    this.planner = planner; // GuardedPlanner：模型输出先过计划校验，才轮到本运行时执行
    this.perf = perf || new PerfMeter(); // 时延度量（可选共享实例，跨场景累计）
    this.outbox = [];       // 已发送邮件（模拟副作用）
    this.uploads = [];      // 已上传外部的内容（模拟副作用）
    this.knowledge = {};    // 已读入的文档/转写稿（含消毒结果）
    this.snapshots = [];    // 高危执行前的状态快照（L2 闸4：可一键回滚）
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
    this.outbox = JSON.parse(JSON.stringify(snap.outbox));
    this.uploads = JSON.parse(JSON.stringify(snap.uploads));
    this.snapshots.splice(idx); // 快照一次性使用，防重复回滚造成状态困惑
    this.audit.append('快照回滚', { seq: snap.seq, label: snap.label, before, after: { outbox: this.outbox.length, uploads: this.uploads.length, knowledge: Object.keys(this.knowledge).length } });
    return snap;
  }

  async runCommand(command, { role = '员工', token, nearfieldOnline = false, scene = '' } = {}) {
    this.audit.append('用户指令', { role, command, scene });
    const lines = [`指令：「${command}」（角色：${role}）`];

    // 出计划（模型 → 计划校验），校验发现直接展示
    const { steps, findings } = await this.perf.measureAsync('规划+计划校验', () =>
      this.planner.makePlan(command, { docs: Object.values(DOCS) }),
    );
    for (const f of findings) {
      lines.push(`  〔计划校验〕⛔ ${f.reason}`);
    }
    if (findings.length > 0) {
      lines.push(`  〔计划〕模型输出 ${findings.length + steps.length} 步 → 校验后 ${steps.length} 步`);
    }

    for (let i = 0; i < steps.length; i++) {
      lines.push(await this.execStep(steps[i], i + 1, { role, token, nearfieldOnline }));
    }
    return lines;
  }

  async execStep(step, n, ctx) {
    const { action, args } = step;
    this.audit.append('计划步骤', { n, action, args, fromDoc: step.fromDoc || null });

    // —— 闸2：权限令牌（工具白名单 × 域名白名单 × 次数）——
    const t = this.perf.measure('闸2 权限令牌', () => checkToolCall(ctx.token, action, args));
    if (!t.allow) {
      this.risk.add(15, `闸2 拦截 ${action}：${t.reason}`);
      this.audit.append('闸2拒绝', { n, action, args, reason: t.reason });
      return `  [${n}] ${action} ⛔ 闸2拒绝：${t.reason}`;
    }

    // —— 读文档：先过闸1（输入消毒，注入内容隔离为"仅数据"）——
    if (action === 'readDoc') {
      const doc = DOCS[args.id];
      if (!doc) return `  [${n}] readDoc(${args.id}) ⛔ 文档不存在`;
      const san = this.perf.measure('闸1 输入消毒', () => sanitizeInput(doc.body));
      this.knowledge[doc.id] = { ...doc, cleaned: san.cleaned, tainted: !san.safe };
      if (!san.safe) {
        this.risk.add(25, `文档「${doc.title}」检出注入并隔离：${san.reasons.join('、')}`);
        this.audit.append('闸1触发', { docId: doc.id, level: doc.level, reasons: san.reasons });
        return `  [${n}] readDoc(${doc.id}) ⚠️ 检出注入并隔离（${san.reasons.join('、')}）→ 内容仅作数据展示`;
      }
      this.audit.append('读入文档', { docId: doc.id, level: doc.level });
      return `  [${n}] readDoc(${doc.id}) ✓（密级=${doc.level}）`;
    }

    // —— 策略矩阵（角色 × 动作）——
    const decision = this.perf.measure('策略矩阵', () => this.policy.decide(ctx.role, action));
    if (decision === 'deny') {
      this.risk.add(30, `策略禁止 ${action}`);
      this.audit.append('策略拒绝', { n, role: ctx.role, action });
      return `  [${n}] ${action} ⛔ 策略拒绝：角色「${ctx.role}」不允许该动作`;
    }

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
      const conf = Object.values(this.knowledge).find((d) => d.level === '机密');
      if (conf) {
        this.risk.add(20, `禁止共享：知识库存在机密材料「${conf.title}」`);
        this.audit.append('共享拒绝', { n, conflicting: conf.id, reason: '知识库存在机密材料' });
        return `  [${n}] shareScreen ⛔ 拒绝：知识库存在机密材料「${conf.title}」，禁止共享（防连带泄露）`;
      }
    }

    // —— 闸3：数据边界（出站动作：密级 + 脱敏）——
    let payload = null;
    if (OUTBOUND_ACTIONS.has(action)) {
      const doc = this.knowledge[args.docId];
      if (!doc) {
        this.audit.append('闸3拒绝', { n, reason: `文档 ${args.docId} 未读入` });
        return `  [${n}] ${action} ⛔ 闸3拒绝：文档 ${args.docId} 未读入，禁止出站`;
      }
      const b = this.perf.measure('闸3 数据边界', () => checkDataBoundary(doc, action));
      if (!b.allow) {
        this.risk.add(25, `闸3 拦截外发：${b.reason}`);
        this.audit.append('闸3拒绝', { n, action, docId: doc.id, reason: b.reason });
        return `  [${n}] ${action} ⛔ 闸3拒绝：${b.reason}`;
      }
      payload = b.content;
      if (action === 'sendExternalEmail' || action === 'uploadToCloud') {
        this.audit.append('闸3脱敏', { n, docId: doc.id, action });
      }
    }

    // —— 闸5：输出检测（出站内容→机密碎片比对 / 不合规话术 / PII 兜底）——
    if (payload !== null) {
      const confDocs = Object.values(this.knowledge).filter((d) => d.level === '机密');
      const oc = this.perf.measure('闸5 输出检测', () =>
        checkAgentOutput(payload, { level: '外发', confidentialDocs: confDocs, external: action === 'sendExternalEmail' || action === 'uploadToCloud' }),
      );
      if (!oc.allowed) {
        this.risk.add(20, `闸5 拦截出站内容：${oc.reasons.join('、')}`);
        this.audit.append('闸5拒绝', { n, action, reasons: oc.reasons });
        return `  [${n}] ${action} ⛔ 闸5拒绝：${oc.reasons.join('、')}`;
      }
      if (oc.action === 'redact') {
        payload = oc.content;
        this.audit.append('闸5脱敏', { n, action });
      }
    }

    // —— L3 冻结：风险分超阈值后，高危动作一律转人工（近场确认亦不放行）——
    if (HIGH_RISK_ACTIONS.has(action) && this.risk.frozen) {
      this.audit.append('冻结拦截', { n, action, score: this.risk.score, threshold: this.risk.threshold });
      return `  [${n}] ${action} ⛔ 风险冻结拦截：风险分 ${this.risk.score} ≥ 阈值 ${this.risk.threshold}，高危动作已转人工复核（近场确认亦不放行）`;
    }

    // —— 闸4：高危二次确认（策略 confirm 或高危动作清单）——
    let confirmNote = '';
    if (decision === 'confirm' || HIGH_RISK_ACTIONS.has(action)) {
      const c = await this.perf.measureAsync('闸4 高危确认', () =>
        requestHumanConfirm(step, { nearfieldOnline: ctx.nearfieldOnline }),
      );
      if (!c.approved) {
        this.risk.add(10, `闸4 未确认：${c.method}`);
        this.audit.append('闸4拒绝', { n, action, method: c.method });
        return `  [${n}] ${action} ⛔ 闸4拒绝：${c.method}`;
      }
      confirmNote = `（${c.method}）`;
      this.audit.append('闸4确认', { n, action, method: c.method });
    }

    // —— 快照：高危动作执行前落盘，误操作可一键回滚 ——
    if (HIGH_RISK_ACTIONS.has(action)) {
      this.takeSnapshot(`执行前快照：${action}`);
    }

    // —— 执行（模拟副作用）——
    let effect = '';
    if (action === 'summarize') {
      const doc = this.knowledge[args.of];
      if (!doc) {
        effect = `生成摘要（源 ${args.of} 未读入，空）`;
      } else {
        const draft = `《${doc.title}》摘要：${doc.cleaned || doc.body}`;
        const oc = this.perf.measure('闸5 输出检测', () => checkAgentOutput(draft, { level: doc.level }));
        if (!oc.allowed) {
          this.risk.add(20, `闸5 拦截生成内容：${oc.reasons.join('、')}`);
          this.audit.append('闸5拒绝', { n, action, reasons: oc.reasons });
          effect = `生成内容未通过输出检测（${oc.reasons.join('、')}）→ 已拦截，不输出`;
        } else {
          effect = `生成摘要《${doc.title}》`;
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
      effect = `会议「${args.title}」已预约（${args.at}）`;
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
      const a = AUDIOS[args.id];
      if (!a) {
        effect = `录音 ${args.id} 不存在`;
      } else {
        const san = this.perf.measure('闸1 输入消毒', () => sanitizeInput(a.body));
        this.knowledge[`tr_${a.id}`] = { id: `tr_${a.id}`, title: `${a.title}（转写稿）`, level: a.level, cleaned: san.cleaned, tainted: !san.safe, transcript: true };
        if (!san.safe) {
          this.risk.add(25, `转写文本检出注入并隔离：${san.reasons.join('、')}`);
          this.audit.append('闸1触发', { n, source: `转写 ${a.id}`, level: a.level, reasons: san.reasons });
          effect = `转写完成 ⚠️ 文本含注入内容已隔离（${san.reasons.join('、')}）→ 仅作数据展示`;
        } else {
          this.audit.append('转写', { n, audioId: a.id, level: a.level });
          effect = `转写完成（${a.title}）→ 结果按不可信输入过闸1后入知识库`;
        }
      }
    } else if (action === 'shareScreen') {
      effect = `屏幕共享已开启（目标：${args.id}）`;
    } else if (action === 'deviceControl') {
      effect = `设备指令已下发：${args.device} → ${args.op}（物理动作，执行前已落快照）`;
    } else if (action === 'uploadToCloud') {
      this.uploads.push({ url: args.url, docId: args.docId, content: payload });
      effect = `已上传 → ${args.url}（内容已脱敏）`;
    }
    this.audit.append('执行', { n, action, outcome: effect });
    return `  [${n}] ${action} ✓ ${effect}${confirmNote}`;
  }
}

module.exports = { AgentRuntime };
