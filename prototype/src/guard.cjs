'use strict';
// ============================================================
// L2 安全网关：五道闸
//   闸1 输入消毒（防注入）       sanitizeInput
//   闸2 权限令牌（工具白名单）    CapabilityToken / checkToolCall
//   闸3 数据边界（密级/脱敏）     checkDataBoundary / redact
//   闸4 执行管控（高危二次确认）  HIGH_RISK_ACTIONS / requestHumanConfirm
//   闸5 输出检测（生成内容合规）  checkAgentOutput
// 平台无关实现——上板时平移 ArkTS；闸4 的 nearfieldOnline 换成真实 SLE 握手
// ============================================================

// ---------- 闸1 · 输入消毒 ----------
const INJECTION_PATTERNS = [
  { re: /忽略.{0,8}(以上|上面|之前).{0,8}(指令|要求|话)/, label: '指令覆盖' },
  { re: /(全文|内容|文件).{0,10}(转发|发送|发到|发给)/, label: '数据搬运指令' },
  { re: /不要(告诉|通知|提示)(用户|他|她|任何人)/, label: '隐蔽指令' },
  { re: /(越权|提权|管理员权限|最高权限).{0,10}(执行|操作|发送|访问)/, label: '提权诱导' },
  { re: /(新的?系统指令|系统提示词)[:：]/, label: '伪造系统指令' },
  { re: /ignore\s+(all\s+)?(previous|above)\s+instructions/i, label: 'instruction-override(en)' },
  { re: /disregard\s+(all\s+)?(previous|prior|above)/i, label: 'instruction-override(en)' },
  { re: /(无需|不用|不必|跳过|绕过).{0,6}(确认|审批|授权|复核|审核)/, label: '绕过审批话术' },
  { re: /(管理员|领导|上级|管理员权限).{0,4}(已|已经)?.{0,4}(批准|授权|同意|放行)/, label: '伪造授权' },
  { re: /(通讯录|客户(资料|名单|信息)|联系人(名单|列表)).{0,8}(发|给|导出|打包)|(导出|打包|批量).{0,8}(通讯录|联系人|客户(资料|名单|信息))/, label: '非法获取客户信息' },
];

// 把外部内容按"句子"过筛：命中可疑模式的句子 → 隔离，不再当指令看待
// 一句话可同时命中多个模式——收集全部命中（检测理由要写全，别只报第一条）
function sanitizeInput(text) {
  const sentences = String(text).split(/(?<=[。！？\n])/);
  const reasons = new Set();
  const cleaned = sentences
    .map((s) => {
      const hits = INJECTION_PATTERNS.filter((p) => p.re.test(s));
      if (hits.length > 0) {
        for (const h of hits) reasons.add(h.label);
        return '【⚠ 已隔离：疑似注入指令，仅作数据展示】';
      }
      return s;
    })
    .join('');
  return { safe: reasons.size === 0, reasons: [...reasons], cleaned };
}

// ---------- 闸2 · 权限令牌（任务级最小权限） ----------
class CapabilityToken {
  constructor({ tools = [], documentIds = [], allowedExternalDomains = [], allowedInternalDomains = ['corp.internal'], maxCalls = Infinity, issuedFor = '', ttlMs = 0, issuedAt = Date.now() } = {}) {
    this.documentIds = [...documentIds];
    this.tools = tools;                          // 本任务允许调用的工具白名单
    this.allowedExternalDomains = allowedExternalDomains; // 外发邮件域名白名单
    this.allowedInternalDomains = allowedInternalDomains; // 内部邮件域名白名单
    this.maxCalls = maxCalls;                    // 调用次数上限
    this.issuedFor = issuedFor;                  // 任务描述（审计用）
    this.issuedAt = issuedAt;                    // 签发时间
    this.expiresAt = ttlMs > 0 ? issuedAt + ttlMs : 0; // 0 = 不过期（任务内短期令牌）
    this.used = 0;
  }
}

// 注意：配额只计「放行的调用」——被拒绝的调用不消耗授权次数，
// 否则攻击者可用垃圾调用耗干令牌，让正常步骤全部饿死。
function checkToolCall(token, tool, args = {}, { now = Date.now() } = {}) {
  if (!token || token.revoked) return { allow: false, reason: '令牌缺失或已撤销' };
  if (token.expiresAt && now > token.expiresAt) {
      return { allow: false, reason: `令牌已过期（签发于 ${new Date(token.issuedAt).toISOString()}）` };
  }
  if (!token.tools.includes(tool)) {
    return { allow: false, reason: `工具「${tool}」不在本任务授权清单内` };
  }
  if (tool === 'sendExternalEmail' || tool === 'sendInternalEmail') {
    const domain = String(args.to || '').split('@')[1] || '';
    const allowed = tool === 'sendExternalEmail' ? token.allowedExternalDomains : token.allowedInternalDomains;
    if (!allowed.includes(domain)) {
      return { allow: false, reason: `${tool === 'sendExternalEmail' ? '外部' : '内部'}域名「${domain || '(缺失)'}」不在白名单` };
    }
  }
  if (token.used + 1 > token.maxCalls) {
    return { allow: false, reason: `令牌调用次数超限（>${token.maxCalls}）` };
  }
  token.used += 1;
  return { allow: true, reason: 'ok' };
}

function checkTokenActive(token, { now = Date.now() } = {}) {
  if (!token || token.revoked) return { allow: false, reason: '令牌缺失或已撤销' };
  if (token.expiresAt && now > token.expiresAt) {
    return { allow: false, reason: `令牌已过期（签发于 ${new Date(token.issuedAt).toISOString()}）` };
  }
  return { allow: true, reason: 'ok' };
}

// ---------- 闸3 · 数据边界（密级 + 脱敏） ----------
const REDACT_RULES = [
  { re: /1[3-9]\d{9}/g, to: '[手机号已脱敏]' },
  { re: /[\w.+-]+@[\w-]+(\.[\w-]+)+/g, to: '[邮箱已脱敏]' },
];

function redact(text) {
  let out = String(text);
  for (const r of REDACT_RULES) out = out.replace(r.re, r.to);
  return out;
}

const OUTBOUND_ACTIONS = new Set(['sendInternalEmail', 'sendExternalEmail', 'uploadToCloud']);

// 出站数据检查：机密级一律禁止外发；外发自动脱敏；上传外部只允许公开级
function checkDataBoundary(doc, action) {
  if (!OUTBOUND_ACTIONS.has(action)) {
    return { allow: true, reason: '非出站动作', content: doc.body };
  }
  if (!['公开', '内部', '机密'].includes(doc.level)) {
    return { allow: false, reason: `文档「${doc.title}」密级未知，禁止出站` };
  }
  if (doc.level === '机密') {
    return { allow: false, reason: `文档「${doc.title}」密级=机密，禁止经 ${action} 外发` };
  }
  if (action === 'uploadToCloud') {
    // 上传外部=离开本机信任域：比邮件更严——仅公开级材料可上传
    if (doc.level !== '公开') {
      return { allow: false, reason: `文档「${doc.title}」密级=${doc.level}，禁止上传外部（分级约束：仅公开级可上传）` };
    }
    return { allow: true, reason: '公开级材料可上传（出站已脱敏）', content: redact(doc.body) };
  }
  const content = action === 'sendExternalEmail' ? redact(doc.body) : doc.body;
  return { allow: true, reason: action === 'sendExternalEmail' ? '已按外发规则脱敏' : '内网可原样发送', content };
}

// ---------- 闸4 · 执行管控（高危二次确认 / HITL） ----------
// 高危清单 = 不可逆 / 出信任域 / 物理世界动作（对应能力分级表的 L2写入类~L4）
const HIGH_RISK_ACTIONS = new Set([
  'sendExternalEmail', 'deleteDoc',        // 出域 / 不可逆
  'printDoc', 'shareScreen',               // 纸面出域 / 屏幕暴露
  'deviceControl', 'uploadToCloud',        // 物理世界 / 外部上传
]);

// 演示版：nearfieldOnline 模拟"手机/工牌是否在星闪近场"
// 上板后替换为真实 SLE 握手（WS63）
async function requestHumanConfirm(step, { nearfieldOnline } = {}) {
  if (nearfieldOnline) {
    return { approved: true, method: '模拟确认（非真实 SLE 凭据，不证明本人或距离）' };
  }
  return { approved: false, method: '未检测到近场设备 → 超时拒绝' };
}

// ---------- 闸5 · 输出检测（AI 输出侧安全：生成内容合规） ----------
// 三道规则：
//   ① 机密碎片比对：生成内容包含机密文档整句原文 → 拦截（防"总结式泄密"）
//   ② 不合规话术：违规承诺 / 制度规避 / 诱导隐瞒 → 拦截
//   ③ PII 残留外发：仍含手机号/邮箱 → 自动脱敏（闸3 之后的第二道兜底）
const UNCOMPLIANT_OUTPUT_PATTERNS = [
  { re: /(保证|承诺|确保).{0,8}(通过|中标|过审|收益|录用)/, label: '违规承诺话术' },
  { re: /(绕过|规避|跳过).{0,8}(审批|合规|监管|审查)/, label: '制度规避表述' },
  { re: /(不要|无需|不必).{0,6}(外传|公开|上报|留痕)/, label: '诱导隐瞒' },
];

function checkAgentOutput(text, { level = '内部', confidentialDocs = [], external = false } = {}) {
  const out = { allowed: true, action: 'allow', reasons: [], content: String(text) };

  // ① 机密碎片比对（整句长度 ≥10 才算"原文片段"，避免误伤短词）
  for (const doc of confidentialDocs) {
    const frags = String(doc.body)
      .split(/(?<=[。！？；\n])/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 10);
    if (frags.some((f) => out.content.includes(f))) {
      out.allowed = false;
      out.action = 'block';
      out.reasons.push(`生成内容包含机密文档「${doc.title}」原文片段`);
    }
  }

  // ② 不合规话术
  for (const p of UNCOMPLIANT_OUTPUT_PATTERNS) {
    if (p.re.test(out.content)) {
      out.allowed = false;
      out.action = 'block';
      out.reasons.push(`不合规内容（${p.label}）`);
    }
  }

  // ③ PII 残留外发 → 自动脱敏兜底
  if (out.allowed && external) {
    const red = redact(out.content);
    if (red !== out.content) {
      out.action = 'redact';
      out.content = red;
      out.reasons.push('外发内容含个人信息，已自动脱敏');
    }
  }
  return out;
}

module.exports = {
  sanitizeInput, INJECTION_PATTERNS,
  CapabilityToken, checkToolCall, checkTokenActive,
  redact, checkDataBoundary, OUTBOUND_ACTIONS,
  HIGH_RISK_ACTIONS, requestHumanConfirm,
  checkAgentOutput, UNCOMPLIANT_OUTPUT_PATTERNS,
};
