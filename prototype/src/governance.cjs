'use strict';
// ============================================================
// L3 治理中心：策略矩阵 / 审计日志（哈希链）/ 风险计量
// 平台无关实现——上板时平移 ArkTS（哈希可用 HUKS/标准库）
// ============================================================
const crypto = require('node:crypto');
const fs = require('node:fs');

// ---------- 策略矩阵：角色 × 动作 → allow | confirm | deny ----------
// 规则：未声明的动作 = 默认拒绝（fail-closed）
const DEFAULT_POLICIES = [
  // 文件访问
  { role: '员工', action: 'readDoc', decision: 'allow' },
  { role: '员工', action: 'recognizeImage', decision: 'allow' },
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
  // —— Agent 角色分级（v0.9）：未声明动作 = 拒绝 ——
  // 实习生：只读（公开/内部），不得发送/预约/写入/物理动作
  { role: '实习生', action: 'readDoc', decision: 'allow' },
  { role: '实习生', action: 'recognizeImage', decision: 'allow' },
  { role: '实习生', action: 'summarize', decision: 'allow' },
  { role: '实习生', action: 'transcribeAudio', decision: 'allow' },
  { role: '实习生', action: 'readContact', decision: 'allow' },
  { role: '实习生', action: 'sendInternalEmail', decision: 'deny' },
  { role: '实习生', action: 'sendExternalEmail', decision: 'deny' },
  { role: '实习生', action: 'scheduleMeeting', decision: 'deny' },
  { role: '实习生', action: 'deleteDoc', decision: 'deny' },
  { role: '实习生', action: 'printDoc', decision: 'deny' },
  { role: '实习生', action: 'shareScreen', decision: 'deny' },
  { role: '实习生', action: 'deviceControl', decision: 'deny' },
  { role: '实习生', action: 'uploadToCloud', decision: 'deny' },
  // 审计员：只读全部文档 + 治理数据；不执行业务动作
  { role: '审计员', action: 'readDoc', decision: 'allow' },
  { role: '审计员', action: 'recognizeImage', decision: 'allow' },
  { role: '审计员', action: 'summarize', decision: 'allow' },
  { role: '审计员', action: 'transcribeAudio', decision: 'allow' },
  // 设备助手：只做设备联动（物理动作需确认 + 近场）
  { role: '设备助手', action: 'deviceControl', decision: 'confirm' },
  // 管理员：不声明任何业务动作（策略管理走 PolicyEngine.update，不在业务链路）
  // 访客：不声明任何动作（用于验证"策略拒绝先于工具执行"）
];

class PolicyEngine {
  constructor(policies = DEFAULT_POLICIES) {
    this.policies = structuredClone(policies);
    this.changes = []; // 策略热更新的变更记录（由调用方写入审计链）
  }
  decide(role, action) {
    const hit = this.policies.find((p) => p.role === role && p.action === action);
    return hit ? hit.decision : 'deny'; // 未声明 = 默认拒绝
  }
  // 策略热更新：不重启即可调整「角色 × 动作」决策；变更必须留痕（返回记录供落审计）
  update(role, action, decision, { by = '安全管理员', reason = '' } = {}) {
    if (!['allow', 'confirm', 'deny'].includes(decision)) throw new Error('非法策略决策');
    const rec = { role, action, decision, by, reason, ts: new Date().toISOString() };
    const hit = this.policies.find((p) => p.role === role && p.action === action);
    rec.before = hit ? hit.decision : '(未声明)';
    if (hit) hit.decision = decision;
    else this.policies.push({ role, action, decision });
    this.changes.push(rec);
    return rec;
  }
}

// ---------- 审计日志：哈希链（prevHash 串联，防篡改） ----------
class AuditLog {
  // onAppend：每次写入后的回调（控制台用它落盘；抛错不影响审计本身）
  constructor({ onAppend = null } = {}) {
    this.entries = [];
    this.prevHash = 'GENESIS';
    this.onAppend = onAppend;
    this.actor = null; // 兼容旧调用；控制台用 actorProvider 读请求级上下文
    this.actorProvider = null; // 异步上下文（AsyncLocalStorage）优先，避免并发串号
  }
  append(kind, detail) {
    const rec = {
      seq: this.entries.length + 1,
      kind,
      detail,
      ts: new Date().toISOString(),
      prevHash: this.prevHash,
    };
    rec.detail = structuredClone(detail);
    const actor = this.actorProvider ? this.actorProvider() : this.actor;
    if (actor) rec.actor = String(actor);
    rec.hash = crypto.createHash('sha256').update(JSON.stringify(rec)).digest('hex');
    this.prevHash = rec.hash;
    this.entries.push(rec);
    if (this.onAppend) {
      try { this.onAppend(rec); } catch { /* 落盘失败不打断审计链 */ }
    }
    return rec;
  }
  // 全链校验：任何一条被改动 / 顺序被换 → false
  checkpoint() { return { count: this.entries.length, head: this.prevHash }; }

  // ---------- 租户分链（v0.33 租户 = 登录用户名） ----------
  // 从全局链派生：只取该 actor 的条目，独立重算哈希，配合独立签名检查点。
  // 派生链不替代全局链；全局链仍然覆盖所有条目。
  tenantEntries(tenant) {
    const t = String(tenant || '');
    return this.entries.filter((e) => String(e.actor || '') === t);
  }

  tenantChain(tenant) {
    const t = String(tenant || '');
    const src = this.tenantEntries(t);
    let prev = 'GENESIS';
    const chain = [];
    for (const e of src) {
      const payload = {
        tenant: t, seq: chain.length + 1, sourceSeq: e.seq,
        kind: e.kind, detail: e.detail, ts: e.ts, prevHash: prev,
      };
      const hash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
      chain.push({ seq: chain.length + 1, sourceSeq: e.seq, kind: e.kind, ts: e.ts, prevHash: prev, hash });
      prev = hash;
    }
    return { tenant: t, entries: chain, checkpoint: { count: chain.length, head: prev } };
  }

  tenantCheckpoint(tenant) { return this.tenantChain(tenant).checkpoint; }

  // 校验前缀：可信检查点可以落后于当前链（之后又追加了新条目），
  // 但必须能对上当时保存的 count/head；这样追加不会把旧检查点判成篡改。
  verifyTenant(tenant, checkpoint) {
    if (!checkpoint || !Number.isInteger(checkpoint.count) || checkpoint.count < 0) return false;
    const chain = this.tenantChain(tenant).entries;
    if (checkpoint.count > chain.length) return false;
    const head = checkpoint.count === 0 ? 'GENESIS' : chain[checkpoint.count - 1].hash;
    return checkpoint.head === head;
  }

  tenantCheckpoints() {
    const tenants = [...new Set(this.entries.map((e) => e.actor).filter(Boolean).map(String))].sort();
    return tenants.map((tenant) => ({ tenant, ...this.tenantCheckpoint(tenant) }));
  }

  // 检查点签名：key 配置后，改 count/head 但没有 key 就无法伪造
  static signCheckpoint(checkpoint, key) {
    if (!key) return checkpoint;
    const body = JSON.stringify({ count: checkpoint.count, head: checkpoint.head });
    const mac = crypto.createHmac('sha256', key).update(body).digest('hex');
    return { ...checkpoint, alg: 'HMAC-SHA256', mac };
  }

  static verifyCheckpoint(checkpoint, key) {
    if (!key) return !!checkpoint;
    if (!checkpoint || checkpoint.alg !== 'HMAC-SHA256' || typeof checkpoint.mac !== 'string') return false;
    const body = JSON.stringify({ count: checkpoint.count, head: checkpoint.head });
    const expected = Buffer.from(crypto.createHmac('sha256', key).update(body).digest('hex'), 'hex');
    const actual = Buffer.from(checkpoint.mac, 'hex');
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  }
  // checkpoint 必须由调用者独立保存或签名；与日志放在一起不能抵抗整链替换。
  save(file) {
    if (!this.verify()) throw new Error('拒绝持久化损坏的审计链');
    const checkpoint = this.checkpoint();
    fs.writeFileSync(file, JSON.stringify({ entries: this.entries, checkpoint }), { encoding: 'utf8', mode: 0o600 });
    return checkpoint;
  }
  // 读取审计文件：兼容旧的整体 JSON 与新的 JSONL（一行一条）
  static readFile(file) {
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (!raw) return [];
    // JSONL 每条也以 '{' 开头，不能靠首字符判断；多行 = JSONL
    if (raw.includes('\n')) {
      return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    }
    const data = JSON.parse(raw);
    if (data && Array.isArray(data.entries)) return data.entries; // 旧格式
    return [data]; // 只有一条记录的 JSONL
  }

  static isJsonlFile(file) {
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (!raw || raw.includes('\n')) return true;
    try {
      const data = JSON.parse(raw);
      return !(data && Array.isArray(data.entries));
    } catch {
      return true;
    }
  }

  // 增量落盘：一行一条，append 是 O(1)，不再每次重写全量
  static appendLine(file, rec) {
    fs.appendFileSync(file, `${JSON.stringify(rec)}\n`, { encoding: 'utf8', mode: 0o600 });
  }

  // 全量重写（迁移旧格式 / reset 清盘用）
  static writeLines(file, entries) {
    const body = entries.length > 0 ? `${entries.map((e) => JSON.stringify(e)).join('\n')}\n` : '';
    fs.writeFileSync(file, body, { encoding: 'utf8', mode: 0o600 });
  }

  static load(file, trustedCheckpoint) {
    if (!trustedCheckpoint) throw new Error('恢复审计需要独立可信检查点');
    const log = new AuditLog();
    log.entries = AuditLog.readFile(file);
    log.prevHash = trustedCheckpoint.head;
    if (!log.verify(trustedCheckpoint)) throw new Error('审计恢复校验失败');
    return log;
  }
  verify(checkpoint = this.checkpoint()) {
    let prev = 'GENESIS';
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i];
      if (e.seq !== i + 1) return false;
      if (e.prevHash !== prev) return false;
      const payload = { seq: e.seq, kind: e.kind, detail: e.detail, ts: e.ts, prevHash: e.prevHash };
      if (e.actor) payload.actor = e.actor; // v0.33 起才有；旧条目无此字段，哈希保持兼容
      const h = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
      if (e.hash !== h) return false;
      prev = e.hash;
    }
    return checkpoint.count === this.entries.length && checkpoint.head === prev;
  }
}

// ---------- 风险计量：拦截/高危行为累计打分，超阈值自动冻结高危通道 ----------
// 冻结语义：风险分跨过阈值 → 高危动作一律转人工（近场确认亦不放行）；
//   人工复核 outcome=clear  → 判定无恶意 → 解冻并清零
//   人工复核 outcome=escalate → 保持冻结（升级处置）
// 评分 = 拦截事件（客观阻力点） + 行为因子（设计骨架 §4 L3：高危频次/异常时段/持续越权）
class RiskMeter {
  constructor(threshold = 60, { onEvent, behavioral = true, windowMs = 10 * 60 * 1000 } = {}) {
    this.score = 0;
    this.threshold = threshold;
    this.events = [];
    this.frozen = false;     // true = 高危通道已冻结
    this.freezeCount = 0;
    this.reviews = [];
    this.onEvent = typeof onEvent === 'function' ? onEvent : () => {};
    // —— 行为因子（可解释、确定性：时间戳由调用方给出，便于测试复现）——
    this.behavioral = behavioral;
    this.windowMs = windowMs;
    this._obs = new Map();       // 观测窗口：key → 时间戳数组（滑窗裁剪）
    this._offHourFired = null;   // 异常时段因子：每小时最多触发一次
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

  // 行为观测：kind = 'executed-high-risk'（高危动作真实执行） | 'blocked'（动作被拦）
  // 因子规则（原型固定阈值，参数化作为 P1 项）：
  //   ① 高频：10 分钟窗口内高危动作执行次数达到 3 的整数倍 → 每次 +8
  //   ② 凌晨：00:00–06:00 执行高危动作 → 每小时内 +6（一次性）
  //   ③ 持续越权：同一动作 10 分钟内被拦 3 次 → +10
  observe({ kind, action = '', ts = Date.now() } = {}) {
    if (!this.behavioral) return this.score;
    if (kind === 'executed-high-risk') {
      const n = this._pushObs('exec', ts);
      if (n % 3 === 0) this.add(8, `行为因子 · 高频：高危动作 10 分钟内已执行 ${n} 次`);
      const hour = new Date(ts).getHours();
      if (hour < 6 && this._offHourFired !== hour) {
        this._offHourFired = hour;
        this.add(6, `行为因子 · 异常时段：${String(hour).padStart(2, '0')}:xx 凌晨执行高危动作`);
      }
    } else if (kind === 'blocked') {
      const n = this._pushObs(`block:${action}`, ts);
      if (n === 3) this.add(10, `行为因子 · 持续越权：「${action}」10 分钟内被拦 3 次`);
    }
    return this.score;
  }

  _pushObs(key, ts) {
    const arr = (this._obs.get(key) || []).filter((t) => ts - t < this.windowMs);
    arr.push(ts);
    this._obs.set(key, arr);
    return arr.length;
  }

  get alerting() {
    return this.score >= this.threshold;
  }
  review({ by = '安全管理员', outcome = 'clear', note = '' } = {}) {
    const scoreBefore = this.score;
    if (outcome === 'clear') {
      this.frozen = false;
      this.score = 0;
      this._obs.clear();        // 复核判定无恶意 → 行为观测窗口一并清零
      this._offHourFired = null;
    }
    const rec = { by, outcome, note, scoreBefore, scoreAfter: this.score, frozen: this.frozen, ts: new Date().toISOString() };
    this.reviews.push(rec);
    this.onEvent('人工复核', rec);
    return rec;
  }
}

module.exports = {
  signCheckpoint: AuditLog.signCheckpoint,
  verifyCheckpoint: AuditLog.verifyCheckpoint, PolicyEngine, AuditLog, RiskMeter, DEFAULT_POLICIES };
