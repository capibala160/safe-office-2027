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
const fs = require('node:fs');
const { join, resolve } = require('node:path');
const { loadConfigFile } = require('../src/load-config.cjs');
const { CASES, CORPUS_VERSION } = require('./corpus.cjs');
const { runAll, TIERS } = require('./harness.cjs');
const { aggregateMatrix } = require('./metrics.cjs');
const { makeLLMFactory } = require('./llm-eval.cjs');
const { ABLATION_IDS, parseAblationList, runAblations } = require('./ablation.cjs');
const { printConsole, writeEvalReport, writeEvalJson, buildMeta } = require('./report.cjs');

function parseArgs(argv) {
  const opts = { llm: 'mock', repeat: 1, tiers: TIERS.slice(), split: 'all', resume: false, ablate: null, out: join(__dirname, '..', 'out', 'eval') };
  for (const arg of argv.slice(2)) {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (!m) {
      if (arg === '--help' || arg === '-h') opts.help = true;
      else if (arg === '--resume') opts.resume = true;
      else if (arg === '--ablate') opts.ablate = 'all';
      else throw new Error(`无法识别的参数：${arg}`);
      continue;
    }
    const [, key, value] = m;
    if (key === 'llm') opts.llm = value;
    else if (key === 'repeat') opts.repeat = Math.max(1, Number.parseInt(value, 10) || 1);
    else if (key === 'tiers') opts.tiers = value.split(',').map((s) => s.trim()).filter(Boolean);
    else if (key === 'split') opts.split = value;
    else if (key === 'ablate') opts.ablate = value || 'all';
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
  --split=all|dev|validation  数据集（默认 all；消融跑分同样按此筛选）
  --ablate[=all|id,id]   追加单层消融：完整网关分别关掉一层再跑
                         可选：${ABLATION_IDS.join('/')}
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

  // 消融必须有完整网关基线；没选 full 就自动补上（只多跑一遍基线，不改变其它档位）
  const ablationLayers = opts.ablate ? parseAblationList(opts.ablate) : [];
  const tiers = ablationLayers.length > 0 && !opts.tiers.includes('full')
    ? ['full', ...opts.tiers]
    : opts.tiers;

  // 真实模型：与 server.cjs 一致，先读 prototype/config.env（已存在的环境变量优先）
  if (opts.llm === 'http') loadConfigFile(join(__dirname, '..', 'config.env'));

  const { kind, factory, modelName } = makeLLMFactory({ kind: opts.llm });
  const meta = buildMeta({
    llmKind: kind, modelName, repeats: opts.repeat, corpusVersion: CORPUS_VERSION, cases, split: opts.split,
  });
  meta.fingerprint = experimentFingerprint({
    modelName, llmKind: kind, corpusVersion: CORPUS_VERSION, split: opts.split,
    tiers, repeats: opts.repeat,
  });
  // 逐条落盘：真实模型一轮几十分钟，断电/崩溃时 partial 文件仍可用
  const partialPath = join(opts.out, 'eval-partial.json');
  // 断点续跑：复用上一次 partial 里"已完成且无故障"的样本；repeat>1 时不做（分不清第几轮）
  const priorRuns = new Map();
  if (opts.resume && opts.repeat === 1 && fs.existsSync(partialPath)) {
    try {
      const prior = JSON.parse(fs.readFileSync(partialPath, 'utf8'));
      if (!prior.meta || prior.meta.fingerprint !== meta.fingerprint) {
        console.log('  续跑：配置指纹不一致（模型/提示词/语料/档位/轮数变了），忽略旧样本');
      } else {
        for (const row of prior.runs || []) {
          if (!row.modelFault) priorRuns.set(`${row.tier}|${row.caseId}|0`, row);
        }
        console.log(`  续跑：复用已完成样本 ${priorRuns.size} 条（故障样本重跑）`);
      }
    } catch { /* partial 坏了就当没有 */ }
  }
  const runs = await runAll({
    llmForTier: factory,
    cases,
    tiers,
    repeats: opts.repeat,
    priorRuns,
    onRun: (acc) => writeEvalJson(partialPath, { runs: acc, matrix: aggregateMatrix(acc), meta }),
  });
  const matrix = aggregateMatrix(runs);

  // —— 单层消融：每个变体 = full − 一层；模型/语料与主跑分相同 ——
  let ablationRuns = null;
  if (ablationLayers.length > 0) {
    console.log(`  单层消融：${ablationLayers.map((l) => l.label).join('、')}（每层 × ${cases.length} 条 × ${opts.repeat} 轮）`);
    const ablationIds = ablationLayers.map((l) => l.id);
    const ablationMeta = {
      ...meta,
      ablation: ablationIds,
      fingerprint: experimentFingerprint({
        modelName, llmKind: kind, corpusVersion: CORPUS_VERSION, split: opts.split,
        tiers: ['full'], repeats: opts.repeat, ablation: ablationIds,
      }),
    };
    const ablationPartialPath = join(opts.out, 'ablation-partial.json');
    // 续跑：只复用“同轮数、同层、无故障”的样本
    const ablationPrior = new Map();
    if (opts.resume && fs.existsSync(ablationPartialPath)) {
      try {
        const prior = JSON.parse(fs.readFileSync(ablationPartialPath, 'utf8'));
        if (prior.meta && prior.meta.fingerprint === ablationMeta.fingerprint) {
          for (const row of prior.runs || []) {
            if (row.modelFault || !Array.isArray(row.ablation) || row.ablation.length !== 1) continue;
            ablationPrior.set(`${row.ablation[0]}|${row.caseId}|${row.repeatIndex ?? 0}`, row);
          }
          if (ablationPrior.size > 0) console.log(`  消融续跑：复用 ${ablationPrior.size} 条`);
        }
      } catch { /* partial 坏了就当没有 */ }
    }
    ablationRuns = await runAblations({
      llm: factory('full'),
      cases,
      layers: ablationLayers,
      repeats: opts.repeat,
      priorRuns: ablationPrior,
      onRun: (acc) => writeEvalJson(ablationPartialPath, { runs: acc, matrix: aggregateMatrix(acc), meta: ablationMeta }),
    });
  }

  const htmlPath = writeEvalReport(join(opts.out, 'eval-report.html'), { runs, matrix, meta, ablationRuns });
  const jsonPath = writeEvalJson(join(opts.out, 'eval-results.json'), { runs, matrix, meta });

  if (ablationRuns) {
    // 基线 full 一并落盘，便于事后复算 Δ（不依赖 eval-results.json 是否存在）
    const combined = [...runs.filter((r) => r.tier === 'full'), ...ablationRuns];
    const ablationPath = writeEvalJson(join(opts.out, 'ablation-results.json'), {
      runs: combined,
      matrix: aggregateMatrix(combined),
      meta: { ...meta, ablation: ablationLayers.map((l) => l.id) },
    });
    console.log(`  消融 JSON：${ablationPath}`);
  }

  printConsole({ matrix, runs, meta, ablationRuns });
  console.log(`  HTML：${htmlPath}`);
  console.log(`  JSON：${jsonPath}`);
  console.log('');
})().catch((err) => {
  console.error(`\n评测失败：${err.message}\n`);
  process.exitCode = 1;
});
