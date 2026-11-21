'use strict';
// 真实模型规划 A/B：默认思考 vs reasoning_effort=low，按语料 expected 粗匹配，
// 并打印耗时/用量/JSON。只做度量，不改产品行为。
//   node bench/llm-plan-ab.cjs [--repeat=1] [--cases=V-N1,V-N2]
const path = require('node:path');
const { loadConfigFile } = require('../src/load-config.cjs');
const { PLAN_SYSTEM_PROMPT } = require('../src/llm.cjs');
const { CASES } = require('../eval/corpus.cjs');
const { DOCS } = require('../src/scenario.cjs');

loadConfigFile(path.join(__dirname, '..', 'config.env'));
const endpoint = process.env.SAFE_OFFICE_LLM_ENDPOINT;
const apiKey = process.env.SAFE_OFFICE_LLM_KEY;
const model = process.env.SAFE_OFFICE_LLM_MODEL || 'glm-4-flash';
if (!endpoint || !apiKey) { console.error('未配置端点/密钥'); process.exit(2); }

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)=?(.*)$/.exec(a);
  return m ? [m[1], m[2] || 'true'] : [a, 'true'];
}));
const repeat = Number(args.repeat) || 1;
const picks = (args.cases || 'V-N1,V-N2,V-N5,V-N9,V-N12,V-N13').split(',');

const TARGET_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|https:\/\/[^\s，。；）)]+/g;
function protectTargets(command) {
  const targets = {}; let n = 0;
  const text = String(command).replace(TARGET_RE, (m) => {
    const hit = Object.entries(targets).find(([, v]) => v === m);
    if (hit) return hit[0];
    const key = `[目标${++n}]`; targets[key] = m; return key;
  });
  return { text, targets };
}

const ALL_DOC_IDS = ['M1', 'M2', 'M3'];
function buildPlanPrompt(def) {
  const { text } = protectTargets(def.command);
  const blocks = ALL_DOC_IDS.map((id) => DOCS[id]).filter(Boolean)
    .filter((d) => d.level !== '机密')
    .map((d) => ({ id: d.id, level: d.level, text: d.cleaned || d.body }));
  const docText = blocks.map((b) => `<DOC id="${b.id}" level="${b.level}">\n${b.text}\n</DOC>`).join('\n');
  const authNote = `【本次实际授权】可用工具：${def.token.tools.join('、')}；可读文档：${ALL_DOC_IDS.join('、')}。`
    + '只能使用这里列出的工具与文档；未列出的不要调用，也不要编造 id。';
  return { user: `用户指令：${text}\n\n可用文档：\n${docText}\n\n${authNote}`, targets: { text } };
}

function matches(step, rule) {
  if (!step || step.action !== rule.action) return false;
  for (const [k, v] of Object.entries(rule.args || {})) {
    if (String(step.args?.[k]) !== String(v)) return false;
  }
  return true;
}
function score(def, steps) {
  const expected = def.expected || [];
  const ok = expected.every((rule) => steps.some((s) => matches(s, rule)));
  return ok ? 'PASS' : `MISS(${expected.filter((rule) => !steps.some((s) => matches(s, rule))).map((r) => r.action).join('+')})`;
}

async function call(user, extra) {
  const t0 = Date.now();
  try {
    const resp = await fetch(`${endpoint.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(120000),
      body: JSON.stringify({
        model, temperature: 0,
        messages: [{ role: 'system', content: PLAN_SYSTEM_PROMPT }, { role: 'user', content: user }],
        ...extra,
      }),
    });
    const body = await resp.json().catch(() => null);
    const ms = Date.now() - t0;
    if (!resp.ok) return { ok: false, ms, err: body?.error?.message };
    const text = body.choices?.[0]?.message?.content ?? '';
    const jsonText = text.match(/\[[\s\S]*\]/)?.[0];
    let steps = null;
    try { steps = JSON.parse(jsonText); } catch { /* 留空 */ }
    return {
      ok: true, ms, steps,
      outTok: body.usage?.completion_tokens,
      reasoning: body.usage?.completion_tokens_details?.reasoning_tokens ?? null,
      raw: text.replace(/\s+/g, ' ').slice(0, 160),
    };
  } catch (err) {
    return { ok: false, ms: Date.now() - t0, err: String(err && err.message) };
  }
}

(async () => {
  for (const id of picks) {
    const def = CASES.find((c) => c.id === id);
    if (!def) { console.log(`${id}: 未找到`); continue; }
    const { user } = buildPlanPrompt(def);
    for (const [name, extra] of Object.entries({ base: {}, low: { reasoning_effort: 'low' } })) {
      const results = [];
      for (let i = 0; i < repeat; i += 1) results.push(await call(user, extra));
      for (const r of results) {
        const verdict = r.ok && r.steps ? score(def, r.steps) : `ERR(${String(r.err).slice(0, 60)})`;
        console.log(`${id} ${name.padEnd(4)} ${(r.ms / 1000).toFixed(1)}s out=${r.outTok ?? '-'} reason=${r.reasoning ?? '-'} ${verdict}`
          + (r.ok ? `  ${JSON.stringify(r.steps).slice(0, 180)}` : ''));
      }
    }
  }
})();
