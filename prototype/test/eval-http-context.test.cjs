'use strict';
// 评测 HTTP 适配器：授权提示必须真的进请求体；修正反馈不得回传模型编造的值
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { EvalHttpLLM } = require('../eval/llm-eval.cjs');
const { GuardedPlanner, validatePlan } = require('../src/planner.cjs');
const { AuditLog, RiskMeter } = require('../src/governance.cjs');
const { DOCS } = require('../src/scenario.cjs');

function startFakeModel(replies) {
  return new Promise((resolve) => {
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
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, seen, endpoint: `http://127.0.0.1:${server.address().port}/v1` });
    });
  });
}

test('HTTP 适配器：授权提示进入请求体；修正反馈只带错误码/动作/字段，不回传编造值', async () => {
  const SECRET = 'secret-abc@evil.example';
  const first = JSON.stringify([{ action: 'sendInternalEmail', args: { to: SECRET, docId: 'M2' } }]);
  const second = JSON.stringify([{ action: 'sendInternalEmail', args: { to: 'team@corp.internal', docId: 'M2' } }]);
  const fake = await startFakeModel([first, second]);

  try {
    const llm = new EvalHttpLLM(
      { endpoint: fake.endpoint, apiKey: 'test-key', model: 'fake', timeoutMs: 5000 },
      { systemPrompt: 'SYS', generatePrompt: 'GEN' },
    );
    const audit = new AuditLog();
    const risk = new RiskMeter(60);
    const planner = new GuardedPlanner({ llm, audit, risk, maxPlanRepairs: 1 });
    const plan = await planner.makePlan('把 M2 发给 team@corp.internal', {
      docs: [DOCS.M2],
      authorizedTools: ['readDoc', 'sendInternalEmail'],
      authorizedDocs: ['M2'],
      authorizedAudios: ['A2（外部厂商来电录音）'],
    });

    assert.equal(fake.seen.length, 2, '应发生一次修正请求');
    const firstBody = fake.seen[0].messages.map((m) => m.content).join('\n');
    const secondBody = fake.seen[1].messages.map((m) => m.content).join('\n');

    assert.match(firstBody, /【本次实际授权】/);
    assert.match(firstBody, /readDoc/);
    assert.match(firstBody, /A2（外部厂商来电录音）/);

    assert.match(secondBody, /RECIPIENT_UNAUTHORIZED/);
    assert.match(secondBody, /sendInternalEmail/);
    assert.ok(!secondBody.includes(SECRET), '模型编造的收件人不能被回传到云端');
    assert.ok(!secondBody.includes('secret-abc'), '敏感片段不能出现在修正反馈里');

    assert.equal(plan.steps.length, 2, '修正后应读入并发送');
    assert.equal(plan.steps[1].args.to, 'team@corp.internal');
  } finally {
    await new Promise((done) => fake.server.close(done));
  }
});

test('显式空授权列表：计划层预检默认生效，所有动作被移除', () => {
  const result = validatePlan([{ action: 'readDoc', args: { id: 'M2' } }], {
    docs: [DOCS.M2], authorizedTools: [],
  });
  assert.equal(result.steps.length, 0);
  assert.equal(result.findings[0].code, 'TOOL_NOT_AUTHORIZED');
});
