#!/usr/bin/env node
'use strict';
// ============================================================
// 性能 / 资源度量 harness（v0.46）
//   - 起一个真实 HTTP 服务（内存库），按并发跑读请求 / 命令请求 / 混合
//   - 统计 p50/p95/p99、吞吐、错误数、RSS 前后变化
//   - 结果同时写 out/bench/bench-<时间>.json（out 已 gitignore）
// 边界：本机单进程、MockLLM、内存 SQLite；数字只代表这套环境，不是生产容量承诺。
// ============================================================
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('../server.cjs');

const COMMAND = {
  command: '把周例会纪要整理一下，发到部门内网邮箱 team@corp.internal',
  role: '员工',
  tools: ['readDoc', 'summarize', 'sendInternalEmail'],
  documentIds: ['M2'],
};

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)));
  return sorted[idx];
}

function mb(bytes) {
  return Math.round((bytes / 1024 / 1024) * 10) / 10;
}

async function runBench({
  concurrency = 10,
  requests = 100,
  scenario = 'mixed',
  store = 'memory',
  durationSec = 0,
  timeoutMs = 120000,
} = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new TypeError('concurrency 必须是正整数');
  if (!Number.isInteger(requests) || requests < 1) throw new TypeError('requests 必须是正整数');
  if (!['read', 'command', 'mixed'].includes(scenario)) throw new TypeError('scenario 只能是 read/command/mixed');
  if (!['memory', 'file'].includes(store)) throw new TypeError('store 只能是 memory/file');
  if (!Number.isFinite(durationSec) || durationSec < 0) throw new TypeError('durationSec 必须是非负数');

  const startedAt = new Date().toISOString();
  const rssBefore = process.memoryUsage().rss;
  const t0 = process.hrtime.bigint();
  // file 模式：真实 SQLite + 审计落盘（临时目录，跑完删除）
  const tmpDir = store === 'file' ? fs.mkdtempSync(path.join(os.tmpdir(), 'safe-office-bench-')) : null;
  const storeFile = tmpDir ? path.join(tmpDir, 'ops.db') : ':memory:';
  const auditFile = tmpDir ? path.join(tmpDir, 'audit.jsonl') : null;
  const server = await startServer({ port: 0, storeFile, auditFile });
  const latencies = [];
  const errors = [];
  const rssSamples = [rssBefore];
  const sampler = setInterval(() => rssSamples.push(process.memoryUsage().rss), 1000);
  if (typeof sampler.unref === 'function') sampler.unref();
  const deadline = durationSec > 0 ? Date.now() + durationSec * 1000 : Infinity;
  const target = durationSec > 0 ? Infinity : requests;
  let completed = 0;
  let next = 0;

  const readMix = scenario === 'read' ? 1 : scenario === 'command' ? 0 : 0.7;
  const one = async (isRead) => {
    const res = isRead
      ? await fetch(`${server.url}/api/state`)
      : await fetch(`${server.url}/api/commands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(COMMAND),
      });
    if (!res.ok) {
      errors.push(`HTTP ${res.status}`);
      await res.text().catch(() => '');
      return;
    }
    await res.arrayBuffer();
  };

  const worker = async () => {
    for (;;) {
      if (completed >= target || Date.now() >= deadline) return;
      completed += 1;
      const index = next;
      next += 1;
      const start = process.hrtime.bigint();
      try {
        await one(index % 10 < readMix * 10);
      } catch (err) {
        errors.push(err && err.message ? err.message : String(err));
      }
      latencies.push(Number(process.hrtime.bigint() - start) / 1e6);
    }
  };

  try {
    const workers = Array.from({ length: concurrency }, () => worker());
    await Promise.race([
      Promise.all(workers),
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error(`压测超时（${timeoutMs}ms）`)), timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
      }),
    ]);
  } finally {
    clearInterval(sampler);
    await server.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  const durationMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const rssAfter = process.memoryUsage().rss;
  rssSamples.push(rssAfter);
  const rssMax = Math.max(...rssSamples);
  const sorted = [...latencies].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, n) => acc + n, 0);
  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    scenario,
    store,
    concurrency,
    durationSec: durationSec > 0 ? durationSec : null,
    requested: durationSec > 0 ? null : requests,
    requests: completed,
    ok: completed - errors.length,
    errors: errors.length,
    errorSamples: errors.slice(0, 5),
    durationMs: Math.round(durationMs * 10) / 10,
    rps: Math.round((completed / (durationMs / 1000)) * 10) / 10,
    latencyMs: {
      mean: sorted.length ? Math.round((sum / sorted.length) * 100) / 100 : 0,
      p50: Math.round(percentile(sorted, 0.5) * 100) / 100,
      p95: Math.round(percentile(sorted, 0.95) * 100) / 100,
      p99: Math.round(percentile(sorted, 0.99) * 100) / 100,
      max: sorted.length ? Math.round(sorted[sorted.length - 1] * 100) / 100 : 0,
    },
    rssMb: {
      before: mb(rssBefore),
      after: mb(rssAfter),
      max: mb(rssMax),
      delta: Math.round((mb(rssAfter) - mb(rssBefore)) * 10) / 10,
      samples: rssSamples.length,
    },
  };
}

function parseArgs(argv) {
  const opts = {};
  for (const arg of argv) {
    const m = /^--([a-zA-Z]+)=(.*)$/.exec(arg);
    if (!m) continue;
    const [, key, value] = m;
    if (['concurrency', 'requests', 'timeoutMs', 'duration', 'durationSec'].includes(key)) opts[key] = Number(value);
    else opts[key] = value;
  }
  return opts;
}

function printResult(result) {
  console.log(`场景 ${result.scenario} · 存储 ${result.store} · 并发 ${result.concurrency} · ${result.durationSec ? `时长 ${result.durationSec}s` : `目标 ${result.requested} 请求`}`);
  console.log(`  完成 ${result.requests} · 成功 ${result.ok} / 失败 ${result.errors}`);
  console.log(`  吞吐 ${result.rps} req/s · 总耗时 ${result.durationMs} ms`);
  console.log(`  时延 p50 ${result.latencyMs.p50} / p95 ${result.latencyMs.p95} / p99 ${result.latencyMs.p99} / max ${result.latencyMs.max} ms`);
  console.log(`  RSS ${result.rssMb.before} → ${result.rssMb.after}（峰值 ${result.rssMb.max}）MB（Δ ${result.rssMb.delta}）`);
  if (result.errorSamples.length) console.log(`  错误样例：${result.errorSamples.join(' | ')}`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const result = await runBench({
    concurrency: opts.concurrency || 10,
    requests: opts.requests || 100,
    scenario: opts.scenario || 'mixed',
    store: opts.store || 'memory',
    durationSec: opts.duration || opts.durationSec || 0,
    timeoutMs: opts.timeoutMs || Math.max(120000, (opts.duration || 0) * 1000 + 60000),
  });
  if (opts.json === '1' || opts.json === 'true') {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printResult(result);
  }
  if (opts.write !== '0') {
    const dir = path.join(__dirname, '..', 'out', 'bench');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `bench-${result.startedAt.replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(file, JSON.stringify(result, null, 2));
    console.log(`  结果文件：${file}`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`压测失败：${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { runBench, COMMAND };
