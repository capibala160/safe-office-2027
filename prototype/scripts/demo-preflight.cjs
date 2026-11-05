#!/usr/bin/env node
'use strict';
// 演示前自检 CLI
//   npm run demo:preflight
//   npm run demo:preflight -- --json
//   npm run demo:preflight -- --data-dir="data/demo" --port=7812
// 退出码：0 = 无阻塞项；1 = 有 fail 项
const path = require('node:path');
const { runPreflight, formatPreflight, DATA_DIR } = require('../src/preflight.cjs');
const { loadConfigFile } = require('../src/load-config.cjs');

// 与 server.cjs 一致：CLI 自检也必须读 config.env，否则会把已配置的
// SMTP/IMAP/CalDAV/打印机误报成「模拟」（2026-11-05 修正）。
loadConfigFile(path.join(__dirname, '..', 'config.env'));

function argValue(name) {
  const hit = process.argv.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : null;
}

async function main() {
  const dataDir = argValue('--data-dir')
    ? path.resolve(argValue('--data-dir'))
    : DATA_DIR;
  const port = Number(argValue('--port') || process.env.PORT || 7812);
  const result = await runPreflight({
    env: process.env, dataDir, port, checkPort: !process.argv.includes('--no-port'),
  });
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    console.log(formatPreflight(result));
  }
  process.exitCode = result.ok ? 0 : 1;
}

main().catch((err) => {
  console.error(`自检失败：${err && err.message ? err.message : err}`);
  process.exitCode = 1;
});
