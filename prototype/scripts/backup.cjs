#!/usr/bin/env node
'use strict';
// 全量数据备份
//   npm run backup
//   npm run backup -- --out=D:/backup/safe-office
//   npm run backup -- --include-demo --json
// 建议先停止服务；运行中的 SQLite 可能处于 WAL 中间态。
const path = require('node:path');
const { createBackup, DATA_DIR, verifyBackup } = require('../src/backup.cjs');

function argValue(name) {
  const hit = process.argv.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : null;
}

try {
  const out = argValue('--out');
  const result = createBackup({
    dataDir: argValue('--data-dir') ? path.resolve(argValue('--data-dir')) : DATA_DIR,
    outDir: out ? path.resolve(out) : null,
    includeDemo: process.argv.includes('--include-demo'),
  });
  const check = verifyBackup(result.dir);
  if (!check.ok) throw new Error('备份写入后校验失败');
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ ...result, verify: check }, null, 2)}\n`);
  } else {
    console.log(`备份完成：${result.dir}`);
    console.log(`  ${result.files.length} 个文件 · ${(result.bytes / 1024 / 1024).toFixed(2)} MB`);
    if (result.excluded.length > 0) {
      console.log(`  未备份：${result.excluded.map((x) => `${x.path}（${x.reason}）`).join('、')}`);
    }
    console.log('  恢复：npm run restore -- --from="' + result.dir + '" --force');
  }
} catch (err) {
  console.error(`备份失败：${err && err.message ? err.message : err}`);
  process.exitCode = 1;
}
