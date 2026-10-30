'use strict';
const { sanitizeInput, redact } = require('./guard.cjs');

// ---------- 出站目标占位符（v0.7 · 04 报告 F-05 整改） ----------
// 云侧指令里的收件地址/上传链接 → [目标N] 占位符；真实值只留在端侧 targets 表。
// 模型计划中的占位符由 resolveTargets 换回真值——授权校验仍锚定用户指令原文，
// 即：模型能发送的目标 ⊆ 用户明确输入过的目标。未登记占位符/编造地址一律
// 换不回来 → 被计划校验按「来源未授权」移除（fail-closed）。
// 匹配式与 plan 校验层的溯源式保持一致（邮箱 + https 链接）。
const TARGET_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+|https:\/\/[^\s，。；）)]+/g;

function protectTargets(command) {
  const targets = {};
  let n = 0;
  const text = String(command).replace(TARGET_RE, (m) => {
    const hit = Object.entries(targets).find(([, v]) => v === m);
    if (hit) return hit[0]; // 同一目标复用同一占位符，保持指令内引用一致
    const key = `[目标${++n}]`;
    targets[key] = m;
    return key;
  });
  return { text, targets };
}

// 严格整值匹配：只换回端侧登记过的占位符；其余原样保留交计划校验处置
function resolveTargets(rawSteps, targets = {}) {
  if (!Array.isArray(rawSteps) || Object.keys(targets).length === 0) return rawSteps;
  return rawSteps.map((s) => {
    if (!s || typeof s !== 'object' || !s.args || typeof s.args !== 'object') return s;
    const args = { ...s.args };
    for (const field of ['to', 'url']) {
      if (typeof args[field] === 'string' && Object.prototype.hasOwnProperty.call(targets, args[field])) {
        args[field] = targets[args[field]];
      }
    }
    return { ...s, args };
  });
}

// local 必须由受信任的适配器声明；调用参数只能收紧，不能放宽。
function prepareModelInput(llm, command, docs, { modelLocation, commandLevel = '内部', sanitize = true } = {}) {
  const location = llm.deployment === 'local' && modelLocation !== 'cloud' ? 'local' : 'cloud';
  let targets = {};
  if (location === 'cloud') {
    if (!['公开', '内部'].includes(commandLevel)) throw new Error('模型边界拒绝：机密或未知密级指令不能送云');
    const fragments = docs.filter(d => d.level === '机密').flatMap(d =>
      String(d.body).split(/[。！？；\n]/).map(s => s.trim()).filter(s => s.length >= 10));
    if (fragments.some(f => command.includes(f))) throw new Error('模型边界拒绝：用户指令包含已知机密片段');
    const protectedCommand = protectTargets(command);
    command = redact(protectedCommand.text); // 占位符不落在脱敏规则上；手机号等仍脱敏
    targets = protectedCommand.targets;
  }
  const blocks = docs.map(d => {
    const withheld = location === 'cloud' && !['公开', '内部'].includes(d.level);
    // sanitize=false 仅用于消融实验：原样把外部资料送进提示词，不隔离注入内容。
    const san = sanitize ? sanitizeInput(d.body) : null;
    const body = san ? san.cleaned : d.body;
    return {
      id: d.id, level: d.level, withheld,
      sanitized: san ? san.safe : null,
      text: withheld ? '【正文已分流，不送云】' : (location === 'cloud' ? redact(body) : body),
    };
  });
  return { command, blocks, location, targets };
}
module.exports = { prepareModelInput, protectTargets, resolveTargets };
