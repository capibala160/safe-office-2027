'use strict';
// ============================================================
// Agent 身份与权限分级（v0.9）
//   角色表 → Agent 清单（manifest）→ 任务令牌（两层取交集）
//   纪律：
//     · Agent 不能自己声明权限：清单只能申请角色已有的工具/文档
//     · 令牌 = 角色允许 ∩ Agent 清单 ∩ 任务需要（任何一层不给就不给）
//     · 清单摘要是进程内防篡改摘要，不是签名；上板后应由受信任配置/HUKS 签名
//     · 委托令牌只证明"调用方持有该令牌"，不证明委托人的真实身份
// 平台无关实现——上板时平移 ArkTS（清单来源换成受信任配置）
// ============================================================
const crypto = require('node:crypto');
const { CapabilityToken } = require('./guard.cjs');
const { PolicyEngine } = require('./governance.cjs');
const { TOOL_META } = require('./capabilities.cjs');
const { DOCS, IMAGES, AUDIOS } = require('./scenario.cjs');

// 角色定义：可读密级 / 外部域名策略 / 调用上限 / 令牌 TTL
const ROLE_DEFS = {
  '员工': { levels: ['公开', '内部', '机密'], external: 'task', maxCalls: Infinity, ttlMs: 5 * 60 * 1000, note: '标准办公角色' },
  '实习生': { levels: ['公开', '内部'], external: 'none', maxCalls: 8, ttlMs: 5 * 60 * 1000, note: '只读，不得发送/预约/写入/物理动作' },
  '审计员': { levels: ['公开', '内部', '机密'], external: 'none', maxCalls: 10, ttlMs: 5 * 60 * 1000, note: '只读全部文档与治理数据' },
  '设备助手': { levels: [], external: 'none', maxCalls: 2, ttlMs: 2 * 60 * 1000, note: '仅设备联动' },
  '管理员': { levels: [], external: 'none', maxCalls: 0, ttlMs: 60 * 1000, note: '不做业务动作，只管理策略' },
  '访客': { levels: [], external: 'none', maxCalls: 0, ttlMs: 60 * 1000, note: '无任何业务权限' },
};

const DEFAULT_POLICY = new PolicyEngine();

// 角色可用工具 = 策略矩阵中非 deny 的工具（单一事实源：策略矩阵）
const ROLE_TOOLS = Object.fromEntries(
  Object.keys(ROLE_DEFS).map((role) => [
    role,
    Object.keys(TOOL_META).filter((tool) => DEFAULT_POLICY.decide(role, tool) !== 'deny'),
  ]),
);

// 角色可读资源 = 按密级过滤文档/图片/录音
function idsByLevels(levels) {
  const ids = [];
  for (const d of Object.values(DOCS)) if (levels.includes(d.level)) ids.push(d.id);
  for (const i of Object.values(IMAGES)) if (levels.includes(i.level)) ids.push(i.id);
  for (const a of Object.values(AUDIOS)) if (levels.includes(a.level)) ids.push(a.id);
  return ids;
}
const ROLE_DOC_IDS = Object.fromEntries(
  Object.entries(ROLE_DEFS).map(([role, def]) => [role, idsByLevels(def.levels)]),
);

// v0.13：动态角色工具集；未注入 registry+policy 时回退静态 ROLE_TOOLS（旧行为不变）
function roleToolsFor(role, { registry = null, policy = null } = {}) {
  if (registry && policy) return registry.toolsForRole(role, policy);
  return ROLE_TOOLS[role] || [];
}

function uniqueStrings(list, name) {
  if (!Array.isArray(list)) throw new Error(`${name} 必须是数组`);
  const out = [];
  for (const v of list) {
    if (typeof v !== 'string' || !v.trim()) throw new Error(`${name} 只能包含非空字符串`);
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

function hashManifest(manifest) {
  const canonical = JSON.stringify({
    agentId: manifest.agentId,
    role: manifest.role,
    allowedTools: [...manifest.allowedTools].sort(),
    documentScopes: [...manifest.documentScopes].sort(),
    modelLocation: manifest.modelLocation,
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

// 定义 Agent 清单：越权申请直接抛错（fail-closed）
function defineAgent({ agentId, role, allowedTools = [], documentScopes = [], modelLocation = 'cloud' } = {}, { registry = null, policy = null } = {}) {
  if (typeof agentId !== 'string' || !agentId.trim()) throw new Error('Agent 清单缺少 agentId');
  if (!ROLE_DEFS[role]) throw new Error(`未知角色「${role}」`);
  if (!['local', 'cloud'].includes(modelLocation)) throw new Error('modelLocation 只能是 local/cloud');
  const tools = uniqueStrings(allowedTools, 'allowedTools');
  const docs = uniqueStrings(documentScopes, 'documentScopes');
  const roleTools = roleToolsFor(role, { registry, policy });
  const beyondTools = tools.filter((t) => !roleTools.includes(t));
  if (beyondTools.length > 0) {
    throw new Error(`Agent「${agentId}」申请了角色「${role}」不具备的工具：${beyondTools.join(', ')}`);
  }
  const beyondDocs = docs.filter((d) => !ROLE_DOC_IDS[role].includes(d));
  if (beyondDocs.length > 0) {
    throw new Error(`Agent「${agentId}」申请了角色「${role}」不可读的资源：${beyondDocs.join(', ')}`);
  }
  const manifest = { agentId, role, allowedTools: tools, documentScopes: docs, modelLocation };
  return Object.freeze({ ...manifest, manifestHash: hashManifest(manifest) });
}

// 校验清单：字段齐全 + 摘要匹配 + 不越角色
function verifyAgentManifest(agent, { registry = null, policy = null } = {}) {
  if (!agent || typeof agent !== 'object') return { ok: false, reason: '缺少 Agent 清单' };
  if (typeof agent.agentId !== 'string' || !agent.agentId.trim()) return { ok: false, reason: '清单缺少 agentId' };
  if (!ROLE_DEFS[agent.role]) return { ok: false, reason: `未知角色「${agent.role}」` };
  if (!Array.isArray(agent.allowedTools) || !Array.isArray(agent.documentScopes)) {
    return { ok: false, reason: '清单字段类型非法' };
  }
  if (!['local', 'cloud'].includes(agent.modelLocation)) return { ok: false, reason: 'modelLocation 非法' };
  if (agent.manifestHash !== hashManifest(agent)) return { ok: false, reason: '清单摘要不匹配（可能被篡改）' };
  const roleTools = roleToolsFor(agent.role, { registry, policy });
  const beyondTools = agent.allowedTools.filter((t) => !roleTools.includes(t));
  if (beyondTools.length > 0) return { ok: false, reason: `角色「${agent.role}」不具备工具：${beyondTools.join(', ')}` };
  const beyondDocs = agent.documentScopes.filter((d) => !ROLE_DOC_IDS[agent.role].includes(d));
  if (beyondDocs.length > 0) return { ok: false, reason: `角色「${agent.role}」不可读资源：${beyondDocs.join(', ')}` };
  return { ok: true, reason: 'ok' };
}

// 签发任务令牌：角色允许 ∩ Agent 清单 ∩ 任务需要
function issueToken(agent, task = {}, { audit, registry = null, policy = null } = {}) {
  const check = verifyAgentManifest(agent, { registry, policy });
  if (!check.ok) throw new Error(`Agent 清单无效：${check.reason}`);

  const role = agent.role;
  const def = ROLE_DEFS[role];
  const requestedTools = uniqueStrings(task.tools === undefined ? agent.allowedTools : task.tools, 'task.tools');
  const requestedDocs = uniqueStrings(task.documentIds === undefined ? agent.documentScopes : task.documentIds, 'task.documentIds');

  const roleTools = roleToolsFor(role, { registry, policy });
  const tools = requestedTools.filter((t) => agent.allowedTools.includes(t) && roleTools.includes(t));
  const documentIds = requestedDocs.filter((d) => agent.documentScopes.includes(d) && ROLE_DOC_IDS[role].includes(d));
  const deniedTools = requestedTools.filter((t) => !tools.includes(t));
  const deniedDocs = requestedDocs.filter((d) => !documentIds.includes(d));

  const domains = def.external === 'task'
    ? uniqueStrings(task.allowedExternalDomains || [], 'allowedExternalDomains')
    : [];
  const maxCalls = Math.min(task.maxCalls === undefined ? Infinity : task.maxCalls, def.maxCalls);
  // ttlMs=0 在令牌语义里表示"不过期"；角色上限必须压住它，不能让它绕过 TTL
  const requestedTtl = task.ttlMs === undefined || task.ttlMs <= 0 ? def.ttlMs : task.ttlMs;
  const ttlMs = Math.min(requestedTtl, def.ttlMs);

  const token = new CapabilityToken({
    tools,
    documentIds,
    allowedExternalDomains: domains,
    allowedInternalDomains: task.allowedInternalDomains || ['corp.internal'],
    maxCalls,
    issuedFor: task.issuedFor || '',
    ttlMs,
    agentId: agent.agentId,
    role,
  });

  if (audit) {
    audit.append('令牌签发', {
      agentId: agent.agentId, role, manifestHash: agent.manifestHash,
      tools, documentIds, domains,
      maxCalls: maxCalls === Infinity ? 'Infinity' : maxCalls,
      ttlMs, deniedTools, deniedDocs,
    });
  }
  return { token, deniedTools, deniedDocs, agent };
}

// ---------- 委托令牌（Agent 之间转授权） ----------
// 只证明"调用方持有该令牌"，不证明委托人真实身份；真实身份由受信任签发方保证。
class DelegationService {
  constructor({ key = crypto.randomBytes(32), now = Date.now } = {}) {
    this.key = key;
    this.now = now;
    this.revoked = new Set();
  }

  _mac(token) {
    const payload = JSON.stringify({
      id: token.id, from: token.from, to: token.to,
      actions: token.actions, expiresAt: token.expiresAt, scope: token.scope,
    });
    return crypto.createHmac('sha256', this.key).update(payload).digest('hex');
  }

  issue({ from, to, actions, ttlMs = 5 * 60 * 1000, scope = '' } = {}) {
    if (!from || !to) throw new Error('委托令牌缺少 from/to');
    const acts = uniqueStrings(actions, 'actions');
    if (acts.length === 0) throw new Error('委托令牌至少覆盖一个动作');
    const token = {
      id: crypto.randomBytes(12).toString('hex'),
      from, to, actions: acts,
      expiresAt: this.now() + ttlMs,
      scope,
    };
    token.mac = this._mac(token);
    return token;
  }

  verify(token, { to, action, now = this.now() } = {}) {
    if (!token || typeof token !== 'object') return { allow: false, reason: '缺少委托令牌' };
    if (this.revoked.has(token.id)) return { allow: false, reason: '委托令牌已撤销' };
    if (!token.expiresAt || token.expiresAt <= now) return { allow: false, reason: '委托令牌已过期' };
    if (token.to !== to) return { allow: false, reason: '委托令牌主体不匹配' };
    if (!Array.isArray(token.actions) || !token.actions.includes(action)) {
      return { allow: false, reason: `委托令牌不覆盖动作「${action}」` };
    }
    const expected = Buffer.from(this._mac(token), 'hex');
    const actual = Buffer.from(String(token.mac || ''), 'hex');
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
      return { allow: false, reason: '委托令牌签名无效' };
    }
    return { allow: true, reason: 'ok' };
  }

  revoke(id) {
    this.revoked.add(id);
  }
}

module.exports = {
  ROLE_DEFS, ROLE_TOOLS, ROLE_DOC_IDS, roleToolsFor,
  defineAgent, verifyAgentManifest, issueToken,
  DelegationService, hashManifest,
};
