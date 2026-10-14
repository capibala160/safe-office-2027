'use strict';
// ============================================================
// L3 治理中心：策略矩阵 / 审计日志（哈希链）/ 风险计量
// 平台无关实现——上板时平移 ArkTS（哈希可用 HUKS/标准库）
// ============================================================
const crypto = require('node:crypto');

// ---------- 策略矩阵：角色 × 动作 → allow | confirm | deny ----------
// 规则：未声明的动作 = 默认拒绝（fail-closed）
const DEFAULT_POLICIES = [
  // 文件访问
  { role: '员工', action: 'readDoc', decision: 'allow' },
  { role: '员工', action: 'summarize', decision: 'allow' },
  { role: '员工', action: 'deleteDoc', decision: 'confirm' },
  // 邮件发送
  { role: '员工', action: 'sendInternalEmail', decision: 'allow' },
  { role: '员工', action: 'sendExternalEmail', decision: 'confirm' }, // 高危 → 二次确认
  // 会议预约 / 通讯录读取 / 录音转写
  { role: '员工', action: 'scheduleMeeting', decision: 'allow' },
  { role: '员工', action: 'readContact', decision: 'allow' },        // 单条+脱敏由工具层保证
  { role: '员工', action: 'transcribeAudio', decision: 'allow' },    // 转写结果强制过闸1
  // 打印控制 / 屏幕共享 / 设备联动（打印机密禁止在工具层前置拦截）
  { role: '员工', action: 'printDoc', decision: 'confirm' },
  { role: '员工', action: 'shareScreen', decision: 'confirm' },
  { role: '员工', action: 'deviceControl', decision: 'confirm' },
  // 外部上传/云同步：默认拒绝（fail-closed 的最严一档，需专门授权）
  { role: '员工', action: 'uploadToCloud', decision: 'deny' },
  // 角色约束示例
  { role: '实习生', action: 'sendExternalEmail', decision: 'deny' },
  { role: '实习生', action: 'scheduleMeeting', decision: 'deny' },
];

class PolicyEngine {
  constructor(policies = DEFAULT_POLICIES) {
    this.policies = policies;
  }
  decide(role, action) {
    const hit = this.policies.find((p) => p.role === role && p.action === action);
    return hit ? hit.decision : 'deny'; // 未声明 = 默认拒绝
  }
}

// ---------- 审计日志：哈希链（prevHash 串联，防篡改） ----------
class AuditLog {
  constructor() {
    this.entries = [];
    this.prevHash = 'GENESIS';
  }
  append(kind, detail) {
    const rec = {
      seq: this.entries.length + 1,
      kind,
      detail,
      ts: new Date().toISOString(),
      prevHash: this.prevHash,
    };
    rec.hash = crypto.createHash('sha256').update(JSON.stringify(rec)).digest('hex').slice(0, 12);
    this.prevHash = rec.hash;
    this.entries.push(rec);
    return rec;
  }
  // 全链校验：任何一条被改动 / 顺序被换 → false
  verify() {
    let prev = 'GENESIS';
    for (const e of this.entries) {
      if (e.prevHash !== prev) return false;
      const payload = { seq: e.seq, kind: e.kind, detail: e.detail, ts: e.ts, prevHash: e.prevHash };
      const h = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 12);
      if (e.hash !== h) return false;
      prev = e.hash;
    }
    return true;
  }
}

// ---------- 风险计量：拦截/高危行为累计打分，超阈值自动冻结高危通道 ----------
// 冻结语义：风险分跨过阈值 → 高危动作一律转人工（近场确认亦不放行）；
//   人工复核 outcome=clear  → 判定无恶意 → 解冻并清零
//   人工复核 outcome=escalate → 保持冻结（升级处置）
class RiskMeter {
  constructor(threshold = 60, { onEvent } = {}) {
    this.score = 0;
    this.threshold = threshold;
    this.events = [];
    this.frozen = false;     // true = 高危通道已冻结
    this.freezeCount = 0;
    this.reviews = [];
    this.onEvent = typeof onEvent === 'function' ? onEvent : () => {};
  }
  add(points, reason) {
    this.score += points;
    this.events.push({ points, reason, score: this.score });
    if (!this.frozen && this.score >= this.threshold) {
      this.frozen = true;
      this.freezeCount += 1;
      this.onEvent('风险冻结', { score: this.score, threshold: this.threshold, freezeCount: this.freezeCount });
    }
    return this.score;
  }
  get alerting() {
    return this.score >= this.threshold;
  }
  review({ by = '安全管理员', outcome = 'clear', note = '' } = {}) {
    const scoreBefore = this.score;
    if (outcome === 'clear') {
      this.frozen = false;
      this.score = 0;
    }
    const rec = { by, outcome, note, scoreBefore, scoreAfter: this.score, frozen: this.frozen, ts: new Date().toISOString() };
    this.reviews.push(rec);
    this.onEvent('人工复核', rec);
    return rec;
  }
}

module.exports = { PolicyEngine, AuditLog, RiskMeter, DEFAULT_POLICIES };
