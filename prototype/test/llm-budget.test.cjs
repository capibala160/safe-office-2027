'use strict';
// HttpLLM 尾延迟预算：默认不改变请求体；只在上限/思考档位显式配置时附加字段。
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { listenSafe } = require('./support/listen-safe.cjs');

const { HttpLLM, createLlmFromEnv } = require('../src/llm.cjs');

function startFakeModel(replies) {
  return new Promise((resolve, reject) => {
    const seen = [];
    let i = 0;
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        seen.push(JSON.parse(raw));
        const content = replies[Math.min(i++, replies.length - 1)];
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content } }] }));
      });
    });
    listenSafe(server).then((port) => {
      resolve({ server, seen, endpoint: `http://127.0.0.1:${port}/v1` });
    }).catch(reject);
  });
}

test('HttpLLM：默认请求体不带 max_tokens / reasoning_effort（行为与旧版一致）', async () => {
  const planJson = JSON.stringify([{ action: 'readDoc', args: { id: 'M2' } }]);
  const fake = await startFakeModel([planJson]);
  try {
    const llm = new HttpLLM({ endpoint: fake.endpoint, apiKey: 'test-key', model: 'fake', timeoutMs: 5000 });
    await llm.plan('读一下 M2', [{ id: 'M2', level: '内部', text: '正文' }]);
    const body = fake.seen[0];
    assert.ok(!('max_tokens' in body), '默认不得携带 max_tokens');
    assert.ok(!('reasoning_effort' in body), '默认不得携带 reasoning_effort');
    assert.equal(body.temperature, 0);
    assert.match(body.messages[1].content, /用户指令：读一下 M2/);
  } finally {
    fake.server.close();
  }
});

test('HttpLLM：配置上限/思考档位后，规划与生成各用各的上限', async () => {
  const planJson = JSON.stringify([{ action: 'readDoc', args: { id: 'M2' } }]);
  const fake = await startFakeModel([planJson, '正式纪要正文']);
  try {
    const llm = new HttpLLM({
      endpoint: fake.endpoint, apiKey: 'test-key', model: 'fake', timeoutMs: 5000,
      reasoningEffort: 'low', planMaxTokens: 800, generateMaxTokens: 600,
    });
    await llm.plan('整理 M2', [{ id: 'M2', level: '内部', text: '正文' }]);
    await llm.generate('整理 M2', [{ id: 'M2', level: '内部', text: '正文' }]);

    const [planBody, genBody] = fake.seen;
    assert.equal(planBody.max_tokens, 800);
    assert.equal(planBody.reasoning_effort, 'low');
    assert.equal(genBody.max_tokens, 600);
    assert.equal(genBody.reasoning_effort, 'low');
    // 生成的用户消息仍带数据边界标记：预算不改变任何安全约束
    assert.match(genBody.messages[1].content, /<DOC id="M2" level="内部">/);
  } finally {
    fake.server.close();
  }
});

test('HttpLLM：规划与生成可分别降档，生成覆盖全局档位', async () => {
  const planJson = JSON.stringify([{ action: 'readDoc', args: { id: 'M2' } }]);
  const fake = await startFakeModel([planJson, '正文']);
  try {
    const llm = new HttpLLM({
      endpoint: fake.endpoint, apiKey: 'test-key', model: 'fake', timeoutMs: 5000,
      reasoningEffort: 'low', generateReasoningEffort: 'high',
    });
    await llm.plan('整理 M2', [{ id: 'M2', level: '内部', text: '正文' }]);
    await llm.generate('整理 M2', [{ id: 'M2', level: '内部', text: '正文' }]);
    assert.equal(fake.seen[0].reasoning_effort, 'low');
    assert.equal(fake.seen[1].reasoning_effort, 'high');
  } finally {
    fake.server.close();
  }
});

test('createLlmFromEnv：预算只从环境变量读取，未配置时保持 0/null', () => {
  const configured = createLlmFromEnv({
    SAFE_OFFICE_LLM_ENDPOINT: 'http://127.0.0.1:1/v1',
    SAFE_OFFICE_LLM_KEY: 'k',
    SAFE_OFFICE_LLM_REASONING_EFFORT: 'low',
    SAFE_OFFICE_LLM_MAX_TOKENS_PLAN: '800',
    SAFE_OFFICE_LLM_MAX_TOKENS_GENERATE: '600',
  });
  assert.equal(configured.reasoningEffort, 'low');
  assert.equal(configured.planMaxTokens, 800);
  assert.equal(configured.generateMaxTokens, 600);

  const plain = createLlmFromEnv({ SAFE_OFFICE_LLM_ENDPOINT: 'http://127.0.0.1:1/v1', SAFE_OFFICE_LLM_KEY: 'k' });
  assert.equal(plain.reasoningEffort, null);
  assert.equal(plain.planMaxTokens, 0);
  assert.equal(plain.generateMaxTokens, 0);
});
