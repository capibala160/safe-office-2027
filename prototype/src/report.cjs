'use strict';
// ============================================================
// 治理可视化：单文件 HTML 报告生成器（零依赖，浏览器直开）
//   命题「办公过程中的风险事件审计、记录与可视化展示」+ 答题要求「安全可视化」
//   输入：审计链 / 风险计量 / 时延度量 → 输出：out/governance-report.html
//   上板后升级路径：ArkTS 端侧治理面板（HAR 模块复用同一数据模型）
// ============================================================
const { mkdirSync, writeFileSync } = require('node:fs');
const { dirname } = require('node:path');

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function summarize(detail) {
  if (detail == null) return '';
  if (typeof detail !== 'object') return String(detail);
  const parts = [];
  for (const [k, v] of Object.entries(detail)) {
    if (v == null || (Array.isArray(v) && v.length === 0)) continue;
    let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (s.length > 72) s = `${s.slice(0, 70)}…`;
    parts.push(`${k}=${s}`);
  }
  return parts.join('  ');
}

// 事件配色：拦截=红 / 降级脱敏=黄 / 放行执行=绿 / 其余=灰蓝
function kindClass(kind, detail) {
  if (/拒绝|拦截/.test(kind)) return 'block';
  if (kind === '计划校验' && detail && detail.level === 'block') return 'block';
  if (/脱敏|隔离|冻结|触发/.test(kind)) return 'warn';
  if (/执行|批准|确认/.test(kind)) return 'ok';
  return 'info';
}

function buildReport({ title = '安全智慧办公 · 治理报告', meta = [], audit, risk, perf }) {
  const verifyOk = audit && typeof audit.verify === 'function' ? audit.verify() : false;
  const entries = (audit && audit.entries) || [];
  const blocks = entries.filter((e) => kindClass(e.kind, e.detail) === 'block').length;
  const spans = perf ? perf.report() : [];
  const events = (risk && risk.events) || [];
  const reviews = (risk && risk.reviews) || [];

  const cards = [
    ['审计条目', `${entries.length}`],
    ['拦截次数', `${blocks}`],
    ['风险分', risk ? `${risk.score} / ${risk.threshold}` : '—'],
    ['冻结次数', risk ? `${risk.freezeCount}` : '—'],
    ['人工复核', `${reviews.length}`],
    ['审计链完整性', verifyOk ? '✓ 未篡改' : '✗ 断裂'],
  ];

  const timeline = entries.map((e) => {
    const cls = kindClass(e.kind, e.detail);
    const time = String(e.ts || '').slice(11, 19);
    return `<tr class="row-${cls}"><td class="seq">${e.seq}</td><td class="time">${time}</td>` +
      `<td><span class="badge badge-${cls}">${esc(e.kind)}</span></td>` +
      `<td class="detail">${esc(summarize(e.detail))}</td><td class="hash">${esc((e.hash || '').slice(0, 8))}</td></tr>`;
  }).join('\n');

  const perfRows = spans.map((s) =>
    `<tr><td>${esc(s.label)}</td><td>${s.count}</td><td>${s.totalMs.toFixed(2)} ms</td><td>${s.avgMs.toFixed(3)} ms</td><td>${s.maxMs.toFixed(3)} ms</td></tr>`,
  ).join('\n');

  const riskRows = events.map((ev) =>
    `<tr><td class="pts">+${ev.points}</td><td>${esc(ev.reason)}</td><td>${ev.score}</td></tr>`,
  ).join('\n');

  const reviewRows = reviews.map((r) =>
    `<tr><td>${esc(r.by)}</td><td>${esc(r.outcome)}</td><td>${r.scoreBefore} → ${r.scoreAfter}</td><td>${esc(r.note)}</td></tr>`,
  ).join('\n');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<style>
  :root { --ink:#1a2028; --sub:#5b6b7c; --line:#e3e8ee; --bg:#f6f8fa; --card:#fff;
          --block:#c0392b; --warn:#b7791f; --ok:#1e7e46; --info:#345d9d; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink);
         font:14px/1.6 "Segoe UI","Microsoft YaHei",system-ui,sans-serif; }
  .wrap { max-width:1080px; margin:0 auto; padding:28px 20px 60px; }
  h1 { font-size:22px; margin:0 0 4px; }
  .sub { color:var(--sub); font-size:13px; margin-bottom:18px; }
  .meta { display:flex; gap:8px; flex-wrap:wrap; margin:10px 0 22px; }
  .meta span { background:#eef3f8; border:1px solid var(--line); border-radius:999px;
               padding:2px 10px; font-size:12px; color:var(--sub); }
  .cards { display:grid; grid-template-columns:repeat(6,1fr); gap:10px; margin-bottom:22px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px 14px; }
  .card b { display:block; font-size:20px; }
  .card i { font-style:normal; color:var(--sub); font-size:12px; }
  h2 { font-size:16px; margin:28px 0 10px; padding-left:10px; border-left:4px solid var(--info); }
  table { width:100%; border-collapse:collapse; background:var(--card);
          border:1px solid var(--line); border-radius:10px; overflow:hidden; font-size:13px; }
  th, td { text-align:left; padding:7px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { background:#eef3f8; font-weight:600; color:var(--sub); }
  tr:last-child td { border-bottom:none; }
  .seq, .time, .hash { color:var(--sub); font-family:Consolas,monospace; white-space:nowrap; }
  .detail { word-break:break-all; }
  .badge { display:inline-block; border-radius:6px; padding:1px 8px; font-size:12px; color:#fff; white-space:nowrap; }
  .badge-block { background:var(--block); } .badge-warn { background:var(--warn); }
  .badge-ok { background:var(--ok); } .badge-info { background:var(--info); }
  .row-block td { background:#fdf1f0; }
  .pts { color:var(--block); font-weight:700; font-family:Consolas,monospace; }
  .foot { margin-top:30px; color:var(--sub); font-size:12px; }
  @media print { body { background:#fff; } .cards { grid-template-columns:repeat(3,1fr); } }
</style>
</head>
<body><div class="wrap">
  <h1>${esc(title)}</h1>
  <div class="sub">本报告由原型运行时自动生成（审计链 = 唯一事实源；上板后同一数据模型渲染为端侧治理面板）</div>
  <div class="meta">${meta.map((m) => `<span>${esc(m)}</span>`).join('')}<span>生成时间 ${new Date().toISOString()}</span></div>

  <div class="cards">
    ${cards.map(([k, v]) => `<div class="card"><b>${esc(v)}</b><i>${esc(k)}</i></div>`).join('')}
  </div>

  <h2>风险计量（事件 + 行为因子）</h2>
  <table><tr><th>分值</th><th>事由</th><th>事件后总分</th></tr>${riskRows || '<tr><td colspan="3">（无风险事件）</td></tr>'}</table>

  <h2>人工复核记录</h2>
  <table><tr><th>复核人</th><th>结论</th><th>分数变化</th><th>备注</th></tr>${reviewRows || '<tr><td colspan="4">（无复核记录）</td></tr>'}</table>

  <h2>安全开销（每道闸打点）</h2>
  <table><tr><th>环节</th><th>次数</th><th>合计</th><th>均值</th><th>峰值</th></tr>${perfRows || '<tr><td colspan="5">（无打点）</td></tr>'}</table>

  <h2>审计链时间线（哈希链贯穿；篡改即断裂）</h2>
  <table><tr><th>#</th><th>时间</th><th>类型</th><th>详情</th><th>哈希</th></tr>${timeline || '<tr><td colspan="5">（无审计条目）</td></tr>'}</table>

  <div class="foot">
    链式完整性校验：<b>${verifyOk ? '✓ 通过（未被篡改）' : '✗ 校验失败'}</b> ·
    安全智慧办公 2027 · Agent 安全运行机制原型 · 可视化模块 v0.1
  </div>
</div></body></html>`;
}

function writeReport(filePath, data) {
  const html = buildReport(data);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, html, 'utf8');
  return filePath;
}

module.exports = { buildReport, writeReport, summarize };
