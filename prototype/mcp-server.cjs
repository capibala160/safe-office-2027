#!/usr/bin/env node
'use strict';
// ============================================================
// 最小 MCP server（v0.27）——用于验证 MCP 适配器不是空骨架
//   POST /mcp，JSON-RPC 2.0：initialize / tools/list / tools/call
//   内置两个只读演示工具：wordCount(text)、echo(text)
//   可选：SAFE_OFFICE_MCP_TOKEN（请求头 x-mcp-token 必须匹配）
// 边界：无 SSE/stdio/OAuth/持久 session；不是生产 MCP 实现。
// ============================================================
const http = require('node:http');
const crypto = require('node:crypto');

const TOOLS = [
  {
    name: 'wordCount',
    description: '统计一段文本的字符数与行数（只读）',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: '待统计文本' } },
      required: ['text'],
    },
  },
  {
    name: 'echo',
    description: '原样返回输入文本（用于连通性验证）',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
];

function callTool(name, args = {}) {
  if (name === 'wordCount') {
    const text = String(args.text || '');
    return {
      content: [{ type: 'text', text: `字符数=${[...text].length} 行数=${text ? text.split('\n').length : 0}` }],
    };
  }
  if (name === 'echo') {
    return { content: [{ type: 'text', text: String(args.text || '') }] };
  }
  return { isError: true, content: [{ type: 'text', text: `未知工具：${name}` }] };
}

function startMcpServer({ port = 0, host = '127.0.0.1', token = process.env.SAFE_OFFICE_MCP_TOKEN || null } = {}) {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/mcp') {
      res.statusCode = 404;
      return res.end('Not Found');
    }
    if (token) {
      const got = String(req.headers['x-mcp-token'] || '');
      const a = Buffer.from(got);
      const b = Buffer.from(token);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        res.statusCode = 401;
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ error: 'unauthorized' }));
      }
    }
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let msg;
      try { msg = JSON.parse(raw); } catch {
        res.statusCode = 400;
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
      }
      // 通知没有 id：202 即可
      if (msg.id === undefined || msg.id === null) {
        res.statusCode = 202;
        return res.end();
      }
      const reply = (result) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
      };
      if (msg.method === 'initialize') {
        return reply({
          protocolVersion: msg.params && msg.params.protocolVersion ? msg.params.protocolVersion : '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'safe-office-minimal-mcp', version: '0.1.0' },
        });
      }
      if (msg.method === 'tools/list') return reply({ tools: TOOLS });
      if (msg.method === 'tools/call') {
        const params = msg.params || {};
        return reply(callTool(params.name, params.arguments || {}));
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } }));
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      const actual = typeof address === 'object' && address ? address.port : port;
      resolve({
        server,
        port: actual,
        url: `http://${host}:${actual}/mcp`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

if (require.main === module) {
  const portArg = process.argv.find((a) => a.startsWith('--port='));
  const port = Number(portArg ? portArg.slice('--port='.length) : process.env.PORT || 7820);
  startMcpServer({ port }).then(({ url }) => {
    console.log(`最小 MCP server：${url}`);
    console.log('工具：wordCount(text) / echo(text)');
  }).catch((err) => {
    console.error(`MCP server 启动失败：${err.message}`);
    process.exit(1);
  });
}

module.exports = { startMcpServer, TOOLS };
