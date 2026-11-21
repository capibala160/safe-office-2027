'use strict';
// ============================================================
// 硬件证据一键跑（docs/85 §3.2）
//   目标：把「10 次批准 + 5 次取消 + 5 次超时 + 3 次断链 + 3 次篡改 + 3 次重放
//   + 20 次时延采样」跑成一份可回放的证据包（rounds.jsonl / summary.json / summary.md）。
//
// 拓扑（2026-11-20 双板）：
//   --port         执行端 A 的串口（挑战经 SLE 中继到 B，确认后用 A 的钥匙发执行帧）
//   --confirm-port 确认端 B 的串口（篡改/重放直接打 B；省略时与 --port 相同）
//
// 用法：
//   node scripts/evidence-run.cjs --plan
//   node scripts/evidence-run.cjs --port COM12 --confirm-port COM11 \
//     --device ws63-B --actuator-device ws63-A --pin 12
//
// 交互：批准短按 KEY2（<600ms）、取消长按 KEY2、超时不要按键、断链在提示后按 B 板 KEY1。
// 不接真实锁/继电器时也能跑（只验证确认与 ACK，不宣称开锁）。
// ============================================================
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const ROOT = path.join(__dirname, '..');
const PHASES = ['approve', 'cancel', 'timeout', 'tamper', 'replay', 'disconnect'];
const DEFAULT_COUNTS = { approve: 20, cancel: 5, timeout: 5, tamper: 3, replay: 3, disconnect: 3 };
const APPROVE_FOR_METRIC = 10;

function arg(name, def) {
  const argv = process.argv.slice(2);
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith('--')) return argv[i + 1];
  return def;
}

function hasFlag(name) {
  return process.argv.slice(2).includes(`--${name}`);
}

/** @param {Record<string, number>} [counts] */
function buildMatrix(counts = DEFAULT_COUNTS) {
  const matrix = [];
  for (const phase of PHASES) {
    const n = Number(counts[phase]);
    for (let i = 1; i <= (Number.isInteger(n) && n > 0 ? n : 0); i++) matrix.push({ phase, index: i });
  }
  return matrix;
}

/** @param {number[]} values */
function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

function parseSerialConfirmOutput(text) {
  const decision = text.match(/确认结果：decision=(\d+)/);
  const actuator = text.match(/执行结果：status=(-?\d+) pin=(\d+) level=(\d+)/);
  const failure = text.match(/确认失败：([A-Z_]+)\s*(.*)/);
  return {
    decision: decision ? Number(decision[1]) : null,
    actuator: actuator
      ? { status: Number(actuator[1]), pin: Number(actuator[2]), level: Number(actuator[3]) }
      : null,
    failCode: failure ? failure[1] : null,
    failMessage: failure ? failure[2].trim() : null,
  };
}

/** @param {string} phase @param {{code: number|null, killed?: boolean}} proc @param {ReturnType<typeof parseSerialConfirmOutput>} parsed */
function judgeSerialRound(phase, proc, parsed) {
  if (phase === 'approve') {
    const ok = proc.code === 0 && parsed.decision === 1 && parsed.actuator?.status === 0 && parsed.actuator?.level === 1;
    return { ok, expected: 'decision=1 + actuator status=0 level=1', actual: parsed };
  }
  if (phase === 'cancel') {
    const ok = proc.code === 1 && parsed.failCode === 'DECISION' && !parsed.actuator;
    return { ok, expected: 'DECISION（用户取消，不执行）', actual: parsed };
  }
  if (phase === 'timeout' || phase === 'disconnect') {
    const ok = proc.code === 1 && parsed.failCode === 'TIMEOUT' && !parsed.actuator;
    return { ok, expected: 'TIMEOUT（fail-closed，不执行）', actual: parsed };
  }
  return { ok: false, expected: '未知阶段', actual: parsed };
}

/** 从 sfc1-negative --json 输出中取最后一个完整 JSON 对象（容忍前面的日志行） */
function parseNegativeJson(text) {
  const starts = [];
  for (let i = text.indexOf('{'); i >= 0; i = text.indexOf('{', i + 1)) starts.push(i);
  for (let k = starts.length - 1; k >= 0; k--) {
    try {
      const parsed = JSON.parse(text.slice(starts[k]).trim());
      if (parsed && typeof parsed === 'object') return parsed;
    } catch { /* 继续尝试更靠前的起点 */ }
  }
  return null;
}

// ------------------------------------------------------------
// 子进程
// ------------------------------------------------------------
/**
 * @param {string} script
 * @param {string[]} args
 * @param {{onChunk?: (text: string) => void, timeoutMs?: number}} [options]
 */
function runChild(script, args, { onChunk, timeoutMs = 180000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: ROOT, windowsHide: true });
    let out = '';
    let err = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try { child.kill(); } catch { /* ignore */ }
    }, timeoutMs);
    child.stdout.on('data', (data) => {
      const text = data.toString();
      out += text;
      if (onChunk) onChunk(out);
    });
    child.stderr.on('data', (data) => { err += data.toString(); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err, killed });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: null, out, err: err + String(e), killed });
    });
  });
}

/**
 * 跑一轮确认（批准/取消/超时/断链）
 * @param {string} phase
 * @param {number} index
 * @param {{port: string, device: string, actuatorDevice: string, pin: number, log: (line: string) => void}} opts
 */
async function runConfirmRound(phase, index, opts) {
  const ttl = phase === 'timeout' ? 5 : phase === 'disconnect' ? 30 : 90;
  const timeout = phase === 'timeout' ? 8000 : phase === 'disconnect' ? 20000 : 75000;
  const args = [
    'serial-confirm.cjs',
    '--port', opts.port,
    '--device', opts.device,
    '--to', 'evidence@partner-example.com',
    '--subject', `evidence-${phase}-${index}`,
    '--ttl', String(ttl),
    '--timeout', String(timeout),
    '--actuator-device', opts.actuatorDevice,
    '--actuator-pin', String(opts.pin),
    '--actuator-level', '1',
  ];
  const instructions = {
    approve: `第 ${index} 轮：请在 90 秒内【短按】B 板 KEY2（<600ms）= 批准`,
    cancel: `第 ${index} 轮：请在 90 秒内【长按】B 板 KEY2（≥600ms）= 取消`,
    timeout: `第 ${index} 轮：请【不要按键】，等待超时（5s TTL / 8s 超时）`,
    disconnect: `第 ${index} 轮：挑战发出后请按 B 板【KEY1 复位】制造断链`,
  };
  opts.log(instructions[phase] || phase);
  const startedAt = Date.now();
  let openedAt = null;
  let resetPrompted = false;
  const { code, out, err, killed } = await runChild('serial-confirm.cjs', args.slice(1), {
    timeoutMs: timeout + 20000,
    onChunk: (text) => {
      if (openedAt === null && /已打开.*等待板端确认/.test(text)) openedAt = Date.now();
      if (phase === 'disconnect' && openedAt && !resetPrompted) {
        resetPrompted = true;
        opts.log('→ 现在按 B 板 KEY1 复位（断链后 PC 应超时且不执行）');
      }
    },
  });
  const endedAt = Date.now();
  // 批准结果走 stdout；取消/超时的“确认失败”走 stderr——两路都解析
  const parsed = parseSerialConfirmOutput(`${out}\n${err}`);
  const judged = judgeSerialRound(phase, { code, killed }, parsed);
  const round = {
    phase,
    index,
    ok: judged.ok,
    expected: judged.expected,
    exitCode: code,
    killed,
    timings: {
      processMs: endedAt - startedAt,
      sinceChallengeOpenMs: openedAt === null ? null : endedAt - openedAt,
    },
    actual: parsed,
    outputTail: out.slice(-800),
    ...(err ? { stderrTail: err.slice(-400) } : {}),
  };
  // 批准/超时后都把执行引脚复位，避免继电器/锁体长期通电
  if (parsed.actuator) {
    round.reset = await resetActuator(opts);
  }
  return round;
}

/** @param {{port: string, actuatorDevice: string, pin: number, log: (line: string) => void}} opts */
async function resetActuator(opts) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { code } = await runChild('scripts/actuator-probe.cjs', [
      '--port', opts.port,
      '--device', opts.actuatorDevice,
      '--pin', String(opts.pin),
      '--level', '0',
    ], { timeoutMs: 15000 });
    if (code === 0) return { ok: true, attempt };
    if (attempt < 3) await new Promise((r) => setTimeout(r, 300));
  }
  opts.log('⚠ 复位 level=0 失败：请手动断电/复位，避免继电器长期吸合');
  return { ok: false, attempt: 3 };
}

/**
 * 跑一轮篡改/重放（直接打确认端 B 的串口）
 * @param {'tamper'|'replay'} kind
 * @param {number} index
 * @param {{confirmPort: string, device: string, log: (line: string) => void}} opts
 */
async function runNegativeRound(kind, index, opts) {
  const caseName = kind === 'tamper' ? 'mac' : 'replay';
  opts.log(`第 ${index} 轮：${kind === 'tamper' ? '篡改 MAC 帧' : '重放过期帧'}（自动，无需按键）`);
  const startedAt = Date.now();
  const { code, out, err } = await runChild('scripts/sfc1-negative.cjs', [
    '--port', opts.confirmPort,
    '--device', opts.device,
    '--case', caseName,
    '--json',
  ], { timeoutMs: 120000 });
  const json = parseNegativeJson(out);
  const ok = code === 0 && json?.ok === true;
  return {
    phase: kind,
    index,
    ok,
    expected: kind === 'tamper' ? '篡改帧被拒（BAD_MAC）' : '重放帧被拒（REPLAY）',
    exitCode: code,
    timings: { processMs: Date.now() - startedAt },
    actual: json ? { ok: json.ok, results: json.results } : null,
    outputTail: out.slice(-800),
    ...(err ? { stderrTail: err.slice(-400) } : {}),
  };
}

/** @param {Array<{phase: string, ok: boolean, timings?: {sinceChallengeOpenMs?: number|null, processMs?: number}}>} rounds */
function summarize(rounds) {
  const byPhase = {};
  for (const phase of PHASES) {
    const items = rounds.filter((r) => r.phase === phase);
    const passed = items.filter((r) => r.ok).length;
    byPhase[phase] = { attempts: items.length, passed, rate: items.length ? passed / items.length : null };
  }
  const approve = rounds.filter((r) => r.phase === 'approve');
  const latencies = approve.map((r) => r.timings?.sinceChallengeOpenMs).filter((v) => Number.isFinite(v));
  const processLatencies = approve.map((r) => r.timings?.processMs).filter((v) => Number.isFinite(v));
  return {
    generatedAt: new Date().toISOString(),
    byPhase,
    approveMetric: {
      counted: Math.min(approve.length, APPROVE_FOR_METRIC),
      passed: approve.slice(0, APPROVE_FOR_METRIC).filter((r) => r.ok).length,
    },
    latency: {
      samples: latencies.length,
      p50SinceOpenMs: percentile(latencies, 0.5),
      p95SinceOpenMs: percentile(latencies, 0.95),
      p50ProcessMs: percentile(processLatencies, 0.5),
      p95ProcessMs: percentile(processLatencies, 0.95),
    },
    overallOk: rounds.every((r) => r.ok),
  };
}

function renderSummaryMarkdown(summary, meta) {
  const lines = [];
  lines.push(`# 硬件证据运行 ${meta.startedAt}`);
  lines.push('');
  lines.push(`- 串口（执行端）：${meta.port}`);
  lines.push(`- 串口（确认端）：${meta.confirmPort}`);
  lines.push(`- 确认设备：${meta.device}；执行设备：${meta.actuatorDevice}；引脚：IO${meta.pin}`);
  lines.push('');
  lines.push('| 项 | 通过/尝试 | 成功率 |');
  lines.push('|---|---:|---:|');
  const labels = {
    approve: '正常批准 → ACK', cancel: '取消 → 不执行', timeout: '超时 → fail-closed',
    disconnect: 'SLE 断链 → fail-closed', tamper: '篡改帧 → 拒绝', replay: '重放帧 → 拒绝',
  };
  for (const phase of PHASES) {
    const s = summary.byPhase[phase];
    lines.push(`| ${labels[phase]} | ${s.passed}/${s.attempts} | ${s.rate === null ? '—' : `${(s.rate * 100).toFixed(1)}%`} |`);
  }
  lines.push('');
  lines.push(`- 批准口径：前 ${summary.approveMetric.counted} 轮中 ${summary.approveMetric.passed} 轮通过`);
  lines.push(`- 时延（挑战发出→ACK，含人工反应）：样本 ${summary.latency.samples}，` +
    `P50 ${summary.latency.p50SinceOpenMs} ms，P95 ${summary.latency.p95SinceOpenMs} ms`);
  lines.push('- 边界：ACK≠开锁；未装续流二极管；锁体按板载 5V 演示；不宣称门禁认证/距离证明。');
  return lines.join('\n');
}

/**
 * 运行整包矩阵。runner 可注入（单测用假 runner）。
 * @param {{matrix: any[], log: (line: string) => void, runner: (item: any) => Promise<any>, onRound?: (round: any) => void}} options
 */
async function runMatrix({ matrix, log, runner, onRound }) {
  const rounds = [];
  for (const item of matrix) {
    const round = await runner(item);
    rounds.push(round);
    log(`${round.ok ? 'PASS' : 'FAIL'}  ${round.phase} #${round.index}`);
    if (onRound) onRound(round);
  }
  return rounds;
}

async function main() {
  const planOnly = hasFlag('plan');
  const yes = hasFlag('yes');
  const port = String(arg('port', '')).trim();
  const confirmPort = String(arg('confirm-port', port)).trim();
  const device = String(arg('device', 'ws63-B')).trim();
  const actuatorDevice = String(arg('actuator-device', 'ws63-A')).trim();
  const pin = Number(arg('pin', '12'));
  const only = String(arg('only', '')).split(',').map((s) => s.trim()).filter(Boolean);
  const counts = { ...DEFAULT_COUNTS };
  for (const phase of PHASES) {
    const v = arg(phase, '');
    if (v !== '') counts[phase] = Number(v);
  }
  const matrix = buildMatrix(counts).filter((item) => only.length === 0 || only.includes(item.phase));

  if (planOnly) {
    console.log(JSON.stringify({ matrix, counts, port, confirmPort, device, actuatorDevice, pin }, null, 2));
    return 0;
  }
  if (!port) throw Object.assign(new Error('缺少 --port（执行端 A 的串口，例如 COM12）'), { code: 'ARG' });
  if (!Number.isInteger(pin) || pin < 0 || pin > 31) throw Object.assign(new Error('--pin 必须是 0–31'), { code: 'ARG' });

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  const append = hasFlag('append');
  const outDir = path.resolve(arg('out', '') || path.join(ROOT, 'out', `hardware-evidence-${stamp}`));
  fs.mkdirSync(outDir, { recursive: true });
  const logFile = path.join(outDir, 'transcript.log');
  const roundsFile = path.join(outDir, 'rounds.jsonl');
  let priorRounds = [];
  if (append && fs.existsSync(roundsFile)) {
    priorRounds = fs.readFileSync(roundsFile, 'utf8').split(/\r?\n/).filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } else {
    fs.writeFileSync(roundsFile, '');
  }
  const log = (line) => {
    const stamped = `[${new Date().toISOString()}] ${line}`;
    console.log(line);
    fs.appendFileSync(logFile, `${stamped}\n`);
  };

  log(`硬件证据运行：本轮 ${matrix.length} 轮；已有 ${priorRounds.length} 轮；执行端 ${port}；确认端 ${confirmPort}；确认设备 ${device}；执行设备 ${actuatorDevice}；IO${pin}`);
  log(`输出目录：${outDir}`);
  log('口径：短按 KEY2=批准，长按 KEY2=取消；超时/断链必须不执行；每轮批准后自动补发 level=0。');

  if (!yes) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    await new Promise((resolve) => rl.question('准备好后按回车开始（Ctrl+C 退出）…', () => { rl.close(); resolve(); }));
  }

  const runner = async (item) => {
    const base = { port, confirmPort, device, actuatorDevice, pin, log };
    if (item.phase === 'tamper' || item.phase === 'replay') return runNegativeRound(item.phase, item.index, base);
    return runConfirmRound(item.phase, item.index, base);
  };

  const rounds = await runMatrix({
    matrix,
    log,
    runner,
    onRound: (round) => fs.appendFileSync(roundsFile, `${JSON.stringify(round)}\n`),
  });

  const allRounds = [...priorRounds, ...rounds];
  const summary = summarize(allRounds);
  const meta = { startedAt: new Date().toISOString(), port, confirmPort, device, actuatorDevice, pin, appended: priorRounds.length };
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({ meta, summary, rounds: allRounds }, null, 2));
  fs.writeFileSync(path.join(outDir, 'summary.md'), `${renderSummaryMarkdown(summary, meta)}\n`);

  console.log('');
  for (const phase of PHASES) {
    const s = summary.byPhase[phase];
    if (s.attempts > 0) console.log(`${phase}: ${s.passed}/${s.attempts}${s.rate === null ? '' : ` (${(s.rate * 100).toFixed(1)}%)`}`);
  }
  console.log(`时延（含人工）：P50 ${summary.latency.p50SinceOpenMs} ms / P95 ${summary.latency.p95SinceOpenMs} ms（n=${summary.latency.samples}）`);
  console.log(`证据：${outDir}`);
  return summary.overallOk ? 0 : 1;
}

if (require.main === module) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
      console.error(err && err.message ? err.message : String(err));
      process.exitCode = err && err.code === 'ARG' ? 2 : 1;
    });
}

module.exports = {
  PHASES, DEFAULT_COUNTS, APPROVE_FOR_METRIC,
  buildMatrix, percentile, parseSerialConfirmOutput, judgeSerialRound,
  parseNegativeJson, summarize, renderSummaryMarkdown, runMatrix,
};
