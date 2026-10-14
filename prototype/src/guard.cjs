'use strict';
// ============================================================
// L2 安全网关：四道闸
//   闸1 输入消毒（防注入）       sanitizeInput
//   闸2 权限令牌（工具白名单）    CapabilityToken / checkToolCall
//   闸3 数据边界（密级/脱敏）     checkDataBoundary / redact
//   闸4 执行管控（高危二次确认）  HIGH_RISK_ACTIONS / requestHumanConfirm
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
];

// 把外部内容按"句子"过筛：命中可疑模式的句子 → 隔离，不再当指令看待
function sanitizeInput(text) {
  const sentences = String(text).split(/(?<=[。！？\n])/);
  const reasons = new Set();
  const cleaned = sentences
    .map((s) => {
      const hit = INJECTION_PATTERNS.find((p) => p.re.test(s));
      if (hit) {
        reasons.add(hit.label);
        return '【⚠ 已隔离：疑似注入指令，仅作数据展示】';
      }
      return s;
    })
    .join('');
  return { safe: reasons.size === 0, reasons: [...reasons], cleaned };
}

// ---------- 闸2 · 权限令牌（任务级最小权限） ----------
class CapabilityToken {
  constructor({ tools = [], allowedExternalDomains = [], maxCalls = Infinity, issuedFor = '' } = {}) {
    this.tools = tools;                          // 本任务允许调用的工具白名单
    this.allowedExternalDomains = allowedExternalDomains; // 外发邮件域名白名单
    this.maxCalls = maxCalls;                    // 调用次数上限
    this.issuedFor = issuedFor;                  // 任务描述（审计用）
    this.used = 0;
  }
}

// 注意：配额只计「放行的调用」——被拒绝的调用不消耗授权次数，
// 否则攻击者可用垃圾调用耗干令牌，让正常步骤全部饿死。
function checkToolCall(token, tool, args = {}) {
  if (!token.tools.includes(tool)) {
    return { allow: false, reason: `工具「${tool}」不在本任务授权清单内` };
  }
  if (tool === 'sendExternalEmail') {
    const domain = String(args.to || '').split('@')[1] || '';
    if (!token.allowedExternalDomains.includes(domain)) {
      return { allow: false, reason: `外部域名「${domain || '(缺失)'}」不在白名单` };
    }
  }
  if (token.used + 1 > token.maxCalls) {
    return { allow: false, reason: `令牌调用次数超限（>${token.maxCalls}）` };
  }
  token.used += 1;
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

const OUTBOUND_ACTIONS = new Set(['sendInternalEmail', 'sendExternalEmail']);

// 出站数据检查：机密级一律禁止外发；外发自动脱敏
function checkDataBoundary(doc, action) {
  if (!OUTBOUND_ACTIONS.has(action)) {
    return { allow: true, reason: '非出站动作', content: doc.body };
  }
  if (doc.level === '机密') {
    return { allow: false, reason: `文档「${doc.title}」密级=机密，禁止经 ${action} 外发` };
  }
  const content = action === 'sendExternalEmail' ? redact(doc.body) : doc.body;
  return { allow: true, reason: action === 'sendExternalEmail' ? '已按外发规则脱敏' : '内网可原样发送', content };
}

// ---------- 闸4 · 执行管控（高危二次确认 / HITL） ----------
const HIGH_RISK_ACTIONS = new Set(['sendExternalEmail', 'deleteDoc']);

// 演示版：nearfieldOnline 模拟"手机/工牌是否在星闪近场"
// 上板后替换为真实 SLE 握手（WS63）
async function requestHumanConfirm(step, { nearfieldOnline } = {}) {
  if (nearfieldOnline) {
    return { approved: true, method: '星闪近场确认（SLE 握手成功，本人已到场）' };
  }
  return { approved: false, method: '未检测到近场设备 → 超时拒绝' };
}

module.exports = {
  sanitizeInput, INJECTION_PATTERNS,
  CapabilityToken, checkToolCall,
  redact, checkDataBoundary, OUTBOUND_ACTIONS,
  HIGH_RISK_ACTIONS, requestHumanConfirm,
};
