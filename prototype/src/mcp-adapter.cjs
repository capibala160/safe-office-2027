'use strict';
// ============================================================
// MCP 适配器骨架（v0.13）
//   只做 client 侧：initialize / tools/list / tools/call
//   transport 是可插拔的 JSON-RPC 传输；HTTP 版只处理 application/json
//   边界：不支持 SSE/stdio/OAuth/持久 session/重连；真实服务未联调
//   MCP 工具默认 deny；必须显式给 sandbox/role policy，注册表仍会做风险提升
// ============================================================
const MCP_VERSION = '0.13.0';

class McpClient {
  constructor({
    transport,
    protocolVersion = '2024-11-05',
    clientInfo = { name: 'safe-office', version: MCP_VERSION },
  } = {}) {
    if (!transport || typeof transport.request !== 'function') {
      throw new TypeError('McpClient 需要 transport.request(method, params)');
    }
    this.transport = transport;
    this.protocolVersion = protocolVersion;
    this.clientInfo = clientInfo;
    this.initialized = false;
    this.serverInfo = null;
  }

  async initialize() {
    const result = await this.transport.request('initialize', {
      protocolVersion: this.protocolVersion,
      capabilities: {},
      clientInfo: this.clientInfo,
    });
    this.serverInfo = result && result.serverInfo ? result.serverInfo : null;
    this.initialized = true;
    if (typeof this.transport.notify === 'function') {
      try {
        await this.transport.notify('notifications/initialized', {});
      } catch {
        // 通知是 best-effort；初始化本身已成功
      }
    }
    return result;
  }

  async ensureInitialized() {
    if (!this.initialized) await this.initialize();
  }

  async listTools() {
    await this.ensureInitialized();
    const result = await this.transport.request('tools/list', {});
    if (Array.isArray(result)) return result;
    if (result && Array.isArray(result.tools)) return result.tools;
    throw new Error('MCP tools/list 返回结构非法');
  }

  async callTool(name, args = {}) {
    await this.ensureInitialized();
    if (typeof name !== 'string' || !name.trim()) throw new TypeError('callTool 需要工具名');
    return this.transport.request('tools/call', { name, arguments: args || {} });
  }
}

// 最小 HTTP JSON-RPC 传输：POST application/json；不做 SSE
function createHttpTransport({
  url,
  headers = {},
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000,
} = {}) {
  if (typeof url !== 'string' || !url.trim()) throw new TypeError('createHttpTransport 需要 url');
  if (typeof fetchImpl !== 'function') throw new TypeError('createHttpTransport 需要 fetch');
  let id = 0;
  let sessionId = null;

  const requestHeaders = () => ({
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    ...headers,
  });

  return {
    async request(method, params = {}) {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: requestHeaders(),
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`MCP HTTP ${res.status} ${res.statusText || ''}`.trim());
      const sid = res.headers && typeof res.headers.get === 'function' ? res.headers.get('mcp-session-id') : null;
      if (sid) sessionId = sid;
      const data = await res.json();
      if (data && data.error) {
        throw new Error(`MCP 错误 ${data.error.code || ''}: ${data.error.message || '未知错误'}`.trim());
      }
      return data ? data.result : undefined;
    },
    async notify(method, params = {}) {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: requestHeaders(),
        body: JSON.stringify({ jsonrpc: '2.0', method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`MCP HTTP ${res.status} ${res.statusText || ''}`.trim());
    },
  };
}

function formatMcpResult(result) {
  if (result === undefined || result === null) return '';
  if (Array.isArray(result.content)) {
    const text = result.content
      .filter((item) => item && item.type === 'text' && typeof item.text === 'string')
      .map((item) => item.text)
      .join('\n');
    if (text) return text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
  }
  const json = JSON.stringify(result);
  return json.length > 4000 ? `${json.slice(0, 4000)}…` : json;
}

// 把 MCP tools/list 的单个工具映射成注册表定义（不含 executor）
function mcpToolToDefinition(tool, { defaults = {}, overrides = {} } = {}) {
  if (!tool || typeof tool.name !== 'string' || !tool.name.trim()) {
    throw new TypeError('MCP 工具缺少 name');
  }
  const meta = { ...defaults, ...overrides };
  if (!meta.sandbox) {
    throw new TypeError(`MCP 工具「${tool.name}」缺少显式 sandbox 档案（fail-closed）`);
  }
  const requiredArgs = Array.isArray(meta.requiredArgs)
    ? meta.requiredArgs
    : (tool.inputSchema && Array.isArray(tool.inputSchema.required)
      ? tool.inputSchema.required.filter((x) => typeof x === 'string')
      : []);
  return {
    name: `${meta.namePrefix || ''}${tool.name}`,
    capability: meta.capability || '外部 MCP 工具',
    level: meta.level || 'L3',
    requiredArgs,
    sandbox: meta.sandbox,
    outbound: meta.outbound === true,
    outboundArg: meta.outboundArg || null,
    irreversible: meta.irreversible === true,
    highRisk: meta.highRisk === true,
    deferred: meta.deferred === true,
    protocolAction: meta.protocolAction === undefined ? null : meta.protocolAction,
    policies: Array.isArray(meta.policies) ? meta.policies : [],
    description: tool.description || '',
    inputSchema: tool.inputSchema || null,
    mcpName: tool.name,
    source: 'mcp',
  };
}

async function registerMcpTools({
  registry,
  client,
  policy = null,
  defaults = {},
  overrides = {},
  include = null,
  source = 'mcp',
} = {}) {
  if (!registry || typeof registry.register !== 'function' || typeof registry.validate !== 'function') {
    throw new TypeError('registerMcpTools 需要 ToolRegistry');
  }
  if (!client || typeof client.listTools !== 'function' || typeof client.callTool !== 'function') {
    throw new TypeError('registerMcpTools 需要 McpClient');
  }

  const listed = await client.listTools();
  const all = Array.isArray(listed) ? listed : (listed && listed.tools);
  if (!Array.isArray(all)) throw new Error('MCP tools/list 返回结构非法');
  // v0.36：控制台按勾选注册；include 为空 = 全部（保持旧行为）
  let tools = all;
  if (Array.isArray(include)) {
    const wanted = new Set(include.map((x) => String(x)));
    tools = all.filter((t) => t && wanted.has(t.name));
    if (tools.length === 0) throw new Error('勾选的工具在服务端不存在');
    if (tools.length !== wanted.size) {
      const found = new Set(tools.map((t) => t.name));
      const missing = [...wanted].filter((name) => !found.has(name));
      throw new Error(`服务端缺少工具：${missing.join(', ')}`);
    }
  }

  const definitions = tools.map((tool) => {
    const def = mcpToolToDefinition(tool, { defaults, overrides: overrides[tool.name] || {} });
    return {
      ...def,
      executor: async ({ args }) => {
        const result = await client.callTool(tool.name, args || {});
        if (result && result.isError) throw new Error(`MCP 工具 ${tool.name} 返回错误`);
        return formatMcpResult(result);
      },
    };
  });

  // 两阶段：先全部校验 + 批内/注册表查重，再统一注册，避免半注册
  const seen = new Set();
  for (const def of definitions) {
    const normalized = registry.validate(def, { source });
    if (seen.has(normalized.name)) throw new Error(`MCP 工具名重复：${normalized.name}`);
    seen.add(normalized.name);
  }
  const registered = [];
  const executors = new Map();
  for (const def of definitions) {
    const normalized = registry.register(def, { policy, source });
    registered.push(normalized.name);
    executors.set(normalized.name, def.executor);
  }
  return { registered, executors, definitions };
}

module.exports = {
  McpClient,
  createHttpTransport,
  mcpToolToDefinition,
  registerMcpTools,
  formatMcpResult,
};
