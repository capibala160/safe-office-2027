#!/usr/bin/env node
'use strict';
// 全量数据恢复
//   npm run restore -- --from="D:/backup/safe-office/backup-..." --force
//   先校验 manifest（缺失/大小/哈希/路径越界），通过后才复制；
//   默认拒绝覆盖，--force 时把现有文件改名为 *.pre-restore-<时间> 留档。
//   服务运行时拒绝执行（可用 --force 跳过端口探测，但 SQLite 可能仍被占用）。
const path = require('node:path');
const { restoreBackup, DATA_DIR } = require('../src/backup.cjs');
const { probePort } = require('../src/preflight.cjs');

function argValue(name) {
  const hit = process.argv.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : null;
}

async function main() {
  const from = argValue('--from');
  if (!from) throw new Error('必须指定 --from=<备份目录>');
  const force = process.argv.includes('--force');
  if (!force) {
    const inUse = await probePort(Number(process.env.PORT) || 7812);
    if (inUse) throw new Error('控制台端口仍被占用；先停止服务，或加 --force 跳过探测');
  }
  const result = restoreBackup({
    backupDir: path.resolve(from),
    dataDir: argValue('--data-dir') ? path.resolve(argValue('--data-dir')) : DATA_DIR,
    force,
  });
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    console.log(`恢复完成：${result.restored} 个文件 → ${result.dir}`);
    if (result.movedAside.length > 0) {
      console.log(`  旧文件已改名留档：${result.movedAside.length} 个（*.pre-restore-*）`);
    }
    console.log('  建议重启服务并跑 npm run demo:preflight');
  }
}

main().catch((err) => {
  console.error(`恢复失败：${err && err.message ? err.message : err}`);
  process.exitCode = 1;
});
