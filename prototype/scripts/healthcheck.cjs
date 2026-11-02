'use strict';
// 控制台健康巡检：HTTP /api/health + 本地磁盘余量。
// 用法：node scripts/healthcheck.cjs [--url=http://127.0.0.1:7812] [--min-free-mb=1024] [--json]
const fs = require('node:fs');

function arg(name, fallback) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

async function main() {
  const url = String(arg('url', process.env.SAFE_OFFICE_HEALTH_URL || 'http://127.0.0.1:7812')).replace(/\/+$/, '');
  const minFreeMb = Number(arg('min-free-mb', process.env.SAFE_OFFICE_MIN_FREE_MB || 1024));
  const timeoutMs = Number(arg('timeout', 5000));
  const asJson = process.argv.includes('--json');

  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });

  let health = null;
  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    check('http', res.ok, `HTTP ${res.status}`);
    if (res.ok) {
      health = await res.json();
      check('service', health.ok === true && health.service === 'safe-office-console', health.service || '(missing)');
      check('version', typeof health.version === 'string' && health.version.length > 0, health.version || '(missing)');
      check('uptime', Number.isFinite(Number(health.uptimeSec)), `${health.uptimeSec}s`);
    }
  } catch (err) {
    check('http', false, err.message);
  }

  let freeMb = null;
  try {
    const st = fs.statfsSync(process.cwd());
    freeMb = Math.round((Number(st.bavail) * Number(st.bsize)) / 1024 / 1024);
    check('disk', freeMb >= minFreeMb, `free=${freeMb}MB min=${minFreeMb}MB`);
  } catch (err) {
    check('disk', true, `statfs 不可用（跳过）：${err.message}`);
  }

  const ok = checks.every((c) => c.ok);
  if (asJson) {
    console.log(JSON.stringify({ ok, url, health, freeMb, checks }, null, 2));
  } else {
    for (const c of checks) console.log(`${c.ok ? '✔' : '✖'} ${c.name}: ${c.detail}`);
    console.log(ok ? 'healthcheck OK' : 'healthcheck 失败');
  }
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(`healthcheck 异常：${err.message}`);
  process.exit(1);
});
