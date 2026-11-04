'use strict';
// ============================================================
// 工具注册表（v0.13）
//   静态表仍是内置工具的事实源；本模块只做"可注册叠加层"：
//   - 内置 13 个工具从 TOOL_META / SANDBOX_PROFILES / HIGH_RISK / OUTBOUND 种子化
//   - 自定义/MCP 工具显式注册；默认策略拒绝，必须显式给角色策略
//   - 不修改 TOOL_META / CAPABILITIES / SANDBOX_PROFILES / KNOWN_TOOLS / ROLE_TOOLS
//   纪律：重名、缺沙箱、非法级别、deferred 缺协议号、outbound 缺目标参数 → 注册前抛错
// ============================================================
const { TOOL_META } = require('./capabilities.cjs');
const { SANDBOX_PROFILES } = require('./sandbox.cjs');
const { HIGH_RISK_ACTIONS, OUTBOUND_ACTIONS } = require('./guard.cjs');

/**
 * @typedef {{
 *   local?: boolean,
 *   fsRead?: {scope: string, arg: string},
 *   fsWrite?: {scope: string, arg: string},
 *   net?: string,
 *   physical?: boolean,
 * }} SandboxSpec
 * @typedef {{role: string, decision: 'allow'|'confirm'|'deny'}} ToolPolicy
 * @typedef {{
 *   name?: string,
 *   capability?: string,
 *   level?: string,
 *   requiredArgs?: string[],
 *   sandbox?: SandboxSpec,
 *   outbound?: boolean,
 *   outboundArg?: string | null,
 *   irreversible?: boolean,
 *   highRisk?: boolean,
 *   deferred?: boolean,
 *   protocolAction?: number | string | null,
 *   policies?: ToolPolicy[],
 *   source?: string,
 *   description?: string,
 *   inputSchema?: unknown,
 *   mcpName?: string | null,
 *   executor?: Function,
 * }} ToolInput
 * @typedef {{
 *   name: string,
 *   capability: string,
 *   level: string,
 *   requiredArgs: string[],
 *   sandbox: SandboxSpec,
 *   outbound: boolean,
 *   outboundArg: string | null,
 *   irreversible: boolean,
 *   highRisk: boolean,
 *   deferred: boolean,
 *   protocolAction: number | null,
 *   policies: readonly ToolPolicy[],
 *   source: string,
 *   description: string,
 *   inputSchema: unknown,
 *   mcpName: string | null,
 *   executor: Function | null,
 * }} ToolDefinition
 * @typedef {{
 *   decide?: (role: string, tool: string) => string,
 *   update?: (role: string, tool: string, decision: string, meta: Record<string, any>) => void,
 * }} PolicyLike
 */

const BUILTIN_DEFERRED_ACTIONS = new Map([
  ['sendInternalEmail', 1],
  ['sendExternalEmail', 1],
  ['deleteDoc', 2],
  ['printDoc', 3],
  ['deviceControl', 4],
]);
const BUILTIN_ACTION_PROTOCOL = Object.fromEntries(BUILTIN_DEFERRED_ACTIONS);

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const LEVELS = new Set(['L1', 'L2', 'L3', 'L4']);
const DECISIONS = new Set(['allow', 'confirm', 'deny']);
const SANDBOX_KINDS = ['local', 'fsRead', 'fsWrite', 'net', 'physical'];

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {string[]}
 */
function normalizeStringList(value, name) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new TypeError(`${name} 必须是字符串数组`);
  /** @type {string[]} */
  const out = [];
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) throw new TypeError(`${name} 只能包含非空字符串`);
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

/**
 * @param {unknown} sandbox
 * @param {string} name
 * @returns {SandboxSpec}
 */
function normalizeSandbox(sandbox, name) {
  if (!isPlainObject(sandbox)) {
    throw new TypeError(`工具「${name}」必须显式声明 sandbox 档案（fail-closed）`);
  }
  const kinds = SANDBOX_KINDS.filter((k) => Object.prototype.hasOwnProperty.call(sandbox, k));
  if (kinds.length !== 1) {
    throw new TypeError(`工具「${name}」的 sandbox 必须且只能声明一种资源类型（local/fsRead/fsWrite/net/physical）`);
  }
  const kind = kinds[0];
  if (kind === 'local' || kind === 'physical') {
    if (sandbox[kind] !== true) throw new TypeError(`工具「${name}」的 sandbox.${kind} 必须是 true`);
    return { [kind]: true };
  }
  if (kind === 'net') {
    if (typeof sandbox.net !== 'string' || !sandbox.net.trim()) {
      throw new TypeError(`工具「${name}」的 sandbox.net 必须是非空通道名`);
    }
    return { net: sandbox.net };
  }
  const spec = sandbox[kind];
  if (!isPlainObject(spec) || typeof spec.scope !== 'string' || !spec.scope.trim() ||
      typeof spec.arg !== 'string' || !spec.arg.trim()) {
    throw new TypeError(`工具「${name}」的 sandbox.${kind} 必须是 {scope,arg}`);
  }
  return { [kind]: { scope: spec.scope, arg: spec.arg } };
}

/**
 * @param {unknown} policies
 * @returns {ToolPolicy[]}
 */
function normalizePolicies(policies) {
  if (!Array.isArray(policies)) throw new TypeError('policies 必须是数组');
  /** @type {ToolPolicy[]} */
  const out = [];
  for (const item of policies) {
    if (!isPlainObject(item) || typeof item.role !== 'string' || !item.role.trim()) {
      throw new TypeError('policies 每项必须包含 role');
    }
    if (!DECISIONS.has(item.decision)) {
      throw new TypeError(`policies 的 decision 必须是 allow/confirm/deny（收到 ${item.decision}）`);
    }
    out.push({ role: item.role, decision: item.decision });
  }
  return out;
}

/**
 * @param {ToolInput} input
 * @param {{source?: string, builtin?: boolean}} [options]
 * @returns {ToolDefinition}
 */
function normalizeDefinition(input, { source, builtin = false } = {}) {
  if (!isPlainObject(input)) throw new TypeError('工具定义必须是对象');
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!NAME_RE.test(name)) {
    throw new TypeError(`工具名非法「${name}」：只允许字母/数字/._-，1–64 字符`);
  }
  const capability = typeof input.capability === 'string' ? input.capability.trim() : '';
  if (!capability) throw new TypeError(`工具「${name}」缺少 capability`);
  const level = String(input.level ?? '');
  if (!LEVELS.has(level)) throw new TypeError(`工具「${name}」的 level 必须是 L1–L4`);
  const requiredArgs = normalizeStringList(input.requiredArgs, `工具「${name}」requiredArgs`);
  const sandbox = normalizeSandbox(input.sandbox, name);
  const outbound = input.outbound === true;
  const outboundArg = input.outboundArg === undefined || input.outboundArg === null
    ? null
    : String(input.outboundArg);
  if (outbound && !outboundArg) {
    throw new TypeError(`工具「${name}」声明 outbound=true 时必须显式给 outboundArg`);
  }
  if (!outbound && outboundArg) {
    throw new TypeError(`工具「${name}」未声明 outbound，不得带 outboundArg`);
  }
  const irreversible = input.irreversible === true;
  const deferred = input.deferred === true;
  const protocolAction = input.protocolAction === undefined || input.protocolAction === null
    ? null
    : Number(input.protocolAction);
  if (deferred) {
    if (protocolAction === null || !Number.isInteger(protocolAction) || protocolAction < 1 || protocolAction > 4) {
      throw new TypeError(`工具「${name}」deferred=true 时 protocolAction 必须是 1–4`);
    }
  } else if (protocolAction !== null) {
    throw new TypeError(`工具「${name}」非 deferred 不得带 protocolAction`);
  }
  let highRisk = input.highRisk === true;
  if (!builtin) {
    // 自定义工具不能把高危能力"降级"成低危
    highRisk = highRisk || outbound || irreversible || deferred || level === 'L4';
  }
  const policies = normalizePolicies(input.policies || []);
  if (input.executor !== undefined && input.executor !== null && typeof input.executor !== 'function') {
    throw new TypeError(`工具「${name}」executor 必须是函数`);
  }
  const finalSource = source || input.source || 'custom';
  return Object.freeze({
    name,
    capability,
    level,
    requiredArgs,
    sandbox: Object.freeze(sandbox),
    outbound,
    outboundArg,
    irreversible,
    highRisk,
    deferred,
    protocolAction,
    policies: Object.freeze(policies.map((p) => Object.freeze(p))),
    source: finalSource,
    description: typeof input.description === 'string' ? input.description : '',
    inputSchema: input.inputSchema || null,
    mcpName: input.mcpName || null,
    executor: typeof input.executor === 'function' ? input.executor : null,
  });
}

class ToolRegistry {
  /** @param {{seed?: boolean}} [options] */
  constructor({ seed = true } = {}) {
    this.tools = /** @type {Map<string, ToolDefinition>} */ (new Map());
    if (seed) this._seedBuiltins();
  }

  _seedBuiltins() {
    for (const [name, meta] of Object.entries(TOOL_META)) {
      const outbound = OUTBOUND_ACTIONS.has(name) || meta.outbound === true;
      const def = normalizeDefinition({
        name,
        capability: meta.capability,
        level: meta.level,
        requiredArgs: meta.requiredArgs || [],
        sandbox: SANDBOX_PROFILES[name],
        outbound,
        outboundArg: outbound ? (name === 'uploadToCloud' ? 'url' : 'to') : null,
        irreversible: meta.irreversible === true,
        highRisk: HIGH_RISK_ACTIONS.has(name),
        deferred: BUILTIN_DEFERRED_ACTIONS.has(name),
        protocolAction: BUILTIN_ACTION_PROTOCOL[name] ?? null,
        policies: [],
        description: `${meta.capability}（内置工具）`,
      }, { source: 'builtin', builtin: true });
      if (!this.tools.has(name)) this.tools.set(name, def);
    }
  }

  reset() {
    this.tools.clear();
    this._seedBuiltins();
  }

  /** @param {string} name */
  has(name) { return this.tools.has(name); }

  /** @param {string} name @returns {ToolDefinition | null} */
  get(name) { return this.tools.get(name) || null; }

  list() { return [...this.tools.values()]; }

  publicList() {
    return this.list().map((t) => ({
      name: t.name,
      capability: t.capability,
      level: t.level,
      requiredArgs: [...t.requiredArgs],
      outbound: t.outbound,
      irreversible: t.irreversible,
      highRisk: t.highRisk,
      deferred: t.deferred,
      protocolAction: t.protocolAction,
      source: t.source,
      description: t.description,
    }));
  }

  names() { return [...this.tools.keys()]; }

  /**
   * @param {ToolInput} def
   * @param {{source?: string}} [options]
   * @returns {ToolDefinition}
   */
  validate(def, { source = def && def.source ? def.source : 'custom' } = {}) {
    const normalized = normalizeDefinition(def, { source, builtin: false });
    if (this.tools.has(normalized.name)) {
      throw new Error(`工具「${normalized.name}」已注册（重名）`);
    }
    return normalized;
  }

  /**
   * @param {ToolInput} def
   * @param {{policy?: PolicyLike | null, source?: string}} [options]
   * @returns {ToolDefinition}
   */
  register(def, { policy = null, source = def && def.source ? def.source : 'custom' } = {}) {
    const normalized = this.validate(def, { source });
    this.tools.set(normalized.name, normalized);
    if (policy) this._applyDefinitionPolicies(normalized, policy);
    return normalized;
  }

  /** @param {string} name */
  isHighRisk(name) {
    const t = this.get(name);
    return !!(t && t.highRisk);
  }

  /** @param {string} name */
  isOutbound(name) {
    const t = this.get(name);
    return !!(t && t.outbound);
  }

  highRiskNames() { return new Set(this.list().filter((t) => t.highRisk).map((t) => t.name)); }

  outboundNames() { return new Set(this.list().filter((t) => t.outbound).map((t) => t.name)); }

  deferredNames() { return new Set(this.list().filter((t) => t.deferred).map((t) => t.name)); }

  /** @param {string} name @returns {number | null} */
  protocolAction(name) {
    const t = this.get(name);
    return t && t.deferred ? t.protocolAction : null;
  }

  /** @returns {Record<string, number | null>} */
  protocolMap() {
    /** @type {Record<string, number | null>} */
    const out = {};
    for (const t of this.list()) if (t.deferred) out[t.name] = t.protocolAction;
    return out;
  }

  /** @param {string} name @returns {SandboxSpec | null} */
  sandboxProfile(name) {
    const t = this.get(name);
    return t ? t.sandbox : null;
  }

  /** @param {string} name @returns {string[]} */
  requiredArgs(name) {
    const t = this.get(name);
    return t ? [...t.requiredArgs] : [];
  }

  /** @param {string} name @returns {string | null} */
  outboundArg(name) {
    const t = this.get(name);
    return t ? t.outboundArg : null;
  }

  /** @param {string} role @param {PolicyLike} policy @returns {string[]} */
  toolsForRole(role, policy) {
    if (!policy || typeof policy.decide !== 'function') {
      throw new TypeError('toolsForRole 需要 PolicyEngine');
    }
    // 保留 this 绑定：PolicyEngine.decide 依赖实例状态
    const decide = policy.decide.bind(policy);
    return this.list()
      .filter((t) => decide(role, t.name) !== 'deny')
      .map((t) => t.name);
  }

  /** @param {ToolDefinition} def @param {PolicyLike | null} policy */
  _applyDefinitionPolicies(def, policy) {
    if (!policy || typeof policy.update !== 'function') return;
    for (const item of def.policies) {
      policy.update(item.role, def.name, item.decision, {
        by: 'tool-registry',
        reason: `工具注册默认策略：${def.name}`,
      });
    }
  }

  /** @param {PolicyLike} policy */
  applyPolicies(policy) {
    for (const def of this.list()) this._applyDefinitionPolicies(def, policy);
    return this;
  }
}

const defaultRegistry = new ToolRegistry();

/** @param {{seed?: boolean}} [options] */
function createRegistry(options) {
  return new ToolRegistry(options);
}

module.exports = {
  ToolRegistry,
  defaultRegistry,
  createRegistry,
  BUILTIN_DEFERRED_ACTIONS,
  BUILTIN_ACTION_PROTOCOL,
};
