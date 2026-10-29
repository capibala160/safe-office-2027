#!/usr/bin/env node
'use strict';
// ============================================================
// 评测入口
//   node eval/run.cjs [--llm=mock|http] [--repeat=N]
//                     [--tiers=none,prompt,full] [--split=all|dev|validation]
//                     [--out=out/eval]
// 示例：
//   node eval/run.cjs                          # 离线机制验证（Mock，默认）
//   node eval/run.cjs --llm=http --repeat=3    # 真实模型（需 env 配置）
// ============================================================
const { join, resolve } = require('node:path');
const { loadConfigFile } = require('../src/load-config.cjs');
const { CASES, CORPUS_VERSION } = require('./corpus.cjs');
const { runAll, TIERS } = require('./harness.cjs');
const { aggregateMatrix } = require('./metrics.cjs');
const { makeLLMFactory } = require('./llm-eval.cjs');
const { printConsole, writeEvalReport, writeEvalJson, buildMeta } = require('./report.cjs');

function parseArgs(argv) {
  const opts = { llm: 'mock', repeat: 1, tiers: TIERS.slice(), split: 'all', out: join(__dirname, '..', 'out', 'eval') };
  for (const arg of argv.slice(2)) {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (!m) {
      if (arg === '--help' || arg === '-h') opts.help = true;
      else throw new Error(`无法识别的参数：${arg}`);
      continue;
    }
    const [, key, value] = m;
    if (key === 'llm') opts.llm = value;
    else if (key === 'repeat') opts.repeat = Math.max(1, Number.parseInt(value, 10) || 1);
    else if (key === 'tiers') opts.tiers = value.split(',').map((s) => s.trim()).filter(Boolean);
    else if (key === 'split') opts.split = value;
    else if (key === 'out') opts.out = resolve(value);
    else throw new Error(`无法识别的参数：--${key}`);
  }
  if (opts.tiers.length === 0) throw new Error('--tiers 不能为空');
  for (const tier of opts.tiers) {
    if (!TIERS.includes(tier)) throw new Error(`未知档位：${tier}（可选 ${TIERS.join('/')}）`);
  }
  if (!['all', 'dev', 'validation'].includes(opts.split)) throw new Error(`未知数据集：${opts.split}`);
  return opts;
}

const HELP = `
安全智慧办公 · 评测 harness

  --llm=mock|http        模型：mock=离线确定性对抗模拟（默认）；http=真实 OpenAI 兼容服务
  --repeat=N             每条用例重复轮数（真实模型建议 ≥3，默认 1）
  --tiers=a,b,c          档位：none / prompt / full（默认全部）
  --split=all|dev|validation  数据集（默认 all）
  --out=DIR              输出目录（默认 prototype/out/eval）

真实模型需设置环境变量：
  SAFE_OFFICE_LLM_ENDPOINT / SAFE_OFFICE_LLM_KEY / SAFE_OFFICE_LLM_MODEL
`;

(async () => {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    console.log(HELP);
    return;
  }

  const cases = opts.split === 'all' ? CASES : CASES.filter((c) => c.split === opts.split);
  if (cases.length === 0) throw new Error('筛选后没有可用用例');

  // 真实模型：与 server.cjs 一致，先读 prototype/config.env（已存在的环境变量优先）
  if (opts.llm === 'http') loadConfigFile(join(__dirname, '..', 'config.env'));

  const { kind, factory, modelName } = makeLLMFactory({ kind: opts.llm });
  const runs = await runAll({ llmForTier: factory, cases, tiers: opts.tiers, repeats: opts.repeat });
  const matrix = aggregateMatrix(runs);
  const meta = buildMeta({
    llmKind: kind, modelName, repeats: opts.repeat, corpusVersion: CORPUS_VERSION, cases, split: opts.split,
  });

  const htmlPath = writeEvalReport(join(opts.out, 'eval-report.html'), { runs, matrix, meta });
  const jsonPath = writeEvalJson(join(opts.out, 'eval-results.json'), { runs, matrix, meta });

  printConsole({ matrix, runs, meta });
  console.log(`  HTML：${htmlPath}`);
  console.log(`  JSON：${jsonPath}`);
  console.log('');
})().catch((err) => {
  console.error(`\n评测失败：${err.message}\n`);
  process.exitCode = 1;
});
