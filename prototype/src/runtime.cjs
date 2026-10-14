'use strict';
// ============================================================
// L1 Agent 运行时（编排层）
//   指令 → 带护栏规划器出计划（含计划校验）→ 每步过
//   【闸1 输入消毒 / 闸2 权限令牌 / 策略矩阵 / 闸3 数据边界 / 闸4 高危确认】
// 平台无关实现——上板时平移 ArkTS，规划器侧换真实 LLM（机制不变）
// ============================================================
const {
  sanitizeInput,
  checkToolCall,
  checkDataBoundary,
  OUTBOUND_ACTIONS,
  HIGH_RISK_ACTIONS,
  requestHumanConfirm,
} = require('./guard.cjs');
const { DOCS } = require('./scenario.cjs');

class AgentRuntime {
  constructor({ policy, audit, risk, planner }) {
    this.policy = policy;
    this.audit = audit;
    this.risk = risk;
    this.planner = planner; // GuardedPlanner：模型输出先过计划校验，才轮到本运行时执行
    this.outbox = [];       // 已发送邮件（模拟副作用）
    this.knowledge = {};    // 已读入的文档（含消毒结果）
    this.snapshots = [];    // 高危执行前的状态快照（L2 闸4：可一键回滚）
  }

  // —— 快照：执行高危动作前的完整状态（knowledge + outbox），支撑"误操作可回滚" ——
  takeSnapshot(label) {
    const snap = {
      seq: this.snapshots.length + 1,
      label,
      ts: new Date().toISOString(),
      knowledge: JSON.parse(JSON.stringify(this.knowledge)),
      outbox: JSON.parse(JSON.stringify(this.outbox)),
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
    const before = { outbox: this.outbox.length, knowledge: Object.keys(this.knowledge).length };
    this.knowledge = JSON.parse(JSON.stringify(snap.knowledge));
    this.outbox = JSON.parse(JSON.stringify(snap.outbox));
    this.snapshots.splice(idx); // 快照一次性使用，防重复回滚造成状态困惑
    this.audit.append('快照回滚', { seq: snap.seq, label: snap.label, before, after: { outbox: this.outbox.length, knowledge: Object.keys(this.knowledge).length } });
    return snap;
  }

  async runCommand(command, { role = '员工', token, nearfieldOnline = false, scene = '' } = {}) {
    this.audit.append('用户指令', { role, command, scene });
    const lines = [`指令：「${command}」（角色：${role}）`];

    // 出计划（模型 → 计划校验），校验发现直接展示
    const { steps, findings } = await this.planner.makePlan(command, { docs: Object.values(DOCS) });
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
    const t = checkToolCall(ctx.token, action, args);
    if (!t.allow) {
      this.risk.add(15, `闸2 拦截 ${action}：${t.reason}`);
      this.audit.append('闸2拒绝', { n, action, args, reason: t.reason });
      return `  [${n}] ${action} ⛔ 闸2拒绝：${t.reason}`;
    }

    // —— 读文档：先过闸1（输入消毒，注入内容隔离为"仅数据"）——
    if (action === 'readDoc') {
      const doc = DOCS[args.id];
      if (!doc) return `  [${n}] readDoc(${args.id}) ⛔ 文档不存在`;
      const san = sanitizeInput(doc.body);
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
    const decision = this.policy.decide(ctx.role, action);
    if (decision === 'deny') {
      this.risk.add(30, `策略禁止 ${action}`);
      this.audit.append('策略拒绝', { n, role: ctx.role, action });
      return `  [${n}] ${action} ⛔ 策略拒绝：角色「${ctx.role}」不允许该动作`;
    }

    // —— 闸3：数据边界（出站动作：密级 + 脱敏）——
    let payload = null;
    if (OUTBOUND_ACTIONS.has(action)) {
      const doc = this.knowledge[args.docId];
      if (!doc) {
        this.audit.append('闸3拒绝', { n, reason: `文档 ${args.docId} 未读入` });
        return `  [${n}] ${action} ⛔ 闸3拒绝：文档 ${args.docId} 未读入，禁止出站`;
      }
      const b = checkDataBoundary(doc, action);
      if (!b.allow) {
        this.risk.add(25, `闸3 拦截外发：${b.reason}`);
        this.audit.append('闸3拒绝', { n, action, docId: doc.id, reason: b.reason });
        return `  [${n}] ${action} ⛔ 闸3拒绝：${b.reason}`;
      }
      payload = b.content;
      if (action === 'sendExternalEmail') {
        this.audit.append('闸3脱敏', { n, docId: doc.id });
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
      const c = await requestHumanConfirm(step, { nearfieldOnline: ctx.nearfieldOnline });
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
      effect = `生成摘要《${doc ? doc.title : args.of}》`;
    } else if (action === 'sendInternalEmail' || action === 'sendExternalEmail') {
      this.outbox.push({ to: args.to, docId: args.docId, content: payload });
      effect = `邮件 → ${args.to} 已发送${action === 'sendExternalEmail' ? '（内容已脱敏）' : ''}`;
      if (action === 'sendExternalEmail') this.risk.add(5, '高危动作经人工确认后放行');
    } else if (action === 'deleteDoc') {
      const doc = this.knowledge[args.id];
      delete this.knowledge[args.id];
      effect = `文档「${doc ? doc.title : args.id}」已删除（可回滚）`;
    }
    this.audit.append('执行', { n, action, outcome: effect });
    return `  [${n}] ${action} ✓ ${effect}${confirmNote}`;
  }
}

module.exports = { AgentRuntime };
