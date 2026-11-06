'use strict';
// ============================================================
// M3 固件同步/构建脚本（2026-11-04）
//   1) 把仓库里的板端源码同步进 SDK 样例目录（源码只留仓库一份）
//   2) 清理旧样例目标文件（切换样例后必须做）
//   3) 可选：调用 SDK build.py 编译 ws63-liteos-app
//
// 用法：
//   node ws63/firmware/build-m3.cjs            # 只同步
//   node ws63/firmware/build-m3.cjs --build    # 同步并编译
//   node ws63/firmware/build-m3.cjs --build --sdk=D:/fbb_ws63
// ============================================================
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const args = process.argv.slice(2);
const shouldBuild = args.includes('--build');
const sdkArg = args.find((a) => a.startsWith('--sdk='));
const SDK = sdkArg ? sdkArg.slice('--sdk='.length) : (process.env.WS63_SDK || 'D:/fbb_ws63');
const SAMPLE_DIR = path.join(SDK, 'src/application/samples/base_03_ssd1306');
const HERE = __dirname;
const REPO_WS63 = path.resolve(HERE, '..'); // ws63/

const FILES = [
  { from: path.join(HERE, 'board-confirm/board_confirm_m3.c'), to: 'board_confirm_m3.c' },
  { from: path.join(HERE, 'board-confirm/CMakeLists.txt'), to: 'CMakeLists.txt' },
  { from: path.join(HERE, 'board-confirm/sfc1_hmac.c'), to: 'sfc1_hmac.c' },
  { from: path.join(HERE, 'board-confirm/sfc1_hmac.h'), to: 'sfc1_hmac.h' },
  { from: path.join(HERE, 'board-confirm/sfc1_nv.c'), to: 'sfc1_nv.c' },
  { from: path.join(HERE, 'board-confirm/sfc1_nv.h'), to: 'sfc1_nv.h' },
  { from: path.join(HERE, 'board-confirm/sfc1_key_store.c'), to: 'sfc1_key_store.c' },
  { from: path.join(HERE, 'board-confirm/sfc1_key_store.h'), to: 'sfc1_key_store.h' },
  { from: path.join(HERE, 'board-confirm/sfc1_provision.c'), to: 'sfc1_provision.c' },
  { from: path.join(HERE, 'board-confirm/sfc1_provision.h'), to: 'sfc1_provision.h' },
  { from: path.join(HERE, 'board-confirm/efuse_probe.c'), to: 'efuse_probe.c' },
  { from: path.join(HERE, 'board-confirm/efuse_probe.h'), to: 'efuse_probe.h' },
  { from: path.join(HERE, 'board-confirm/efuse_kek.c'), to: 'efuse_kek.c' },
  { from: path.join(HERE, 'board-confirm/efuse_kek.h'), to: 'efuse_kek.h' },
  { from: path.join(REPO_WS63, 'protocol.c'), to: 'protocol.c' },
  { from: path.join(REPO_WS63, 'protocol.h'), to: 'protocol.h' },
];

function fail(message) {
  console.error(`[build-m3] ${message}`);
  process.exit(1);
}

if (!fs.existsSync(path.join(SDK, 'src/build.py'))) {
  fail(`找不到 SDK：${SDK}（用 --sdk= 或 WS63_SDK 指定）`);
}
if (!fs.existsSync(SAMPLE_DIR)) {
  fail(`找不到样例目录：${SAMPLE_DIR}`);
}

for (const file of FILES) {
  if (!fs.existsSync(file.from)) fail(`缺少源文件：${file.from}`);
  fs.copyFileSync(file.from, path.join(SAMPLE_DIR, file.to));
  console.log(`[build-m3] 同步 ${path.basename(file.to)}`);
}

// 旧样例源文件/目标文件必须清掉，否则 libsamples.a 仍链接旧对象
const oldSource = path.join(SAMPLE_DIR, 'base_ssd1306_demo.c');
if (fs.existsSync(oldSource)) {
  fs.rmSync(oldSource, { force: true });
  console.log('[build-m3] 移除旧样例源 base_ssd1306_demo.c');
}
const stale = [
  path.join(SDK, 'src/output/ws63/acore/ws63-liteos-app/application/samples/libsamples.a'),
  path.join(SDK, 'src/output/ws63/acore/ws63-liteos-app/application/samples/CMakeFiles/samples.dir/base_01_ledblink'),
  path.join(SDK, 'src/output/ws63/acore/ws63-liteos-app/application/samples/CMakeFiles/samples.dir/base_03_ssd1306'),
  path.join(SDK, 'src/output/ws63/application/samples/libsamples.a'),
];
for (const target of stale) {
  if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true });
    console.log(`[build-m3] 清理 ${target}`);
  }
}

if (!shouldBuild) {
  console.log('[build-m3] 同步完成（未编译；加 --build 编译）');
  process.exit(0);
}

const python = process.env.WS63_PYTHON || 'D:/Python311/python.exe';
const toolchainBin = process.env.WS63_TOOLCHAIN_BIN
  || 'D:/HiSparkToolchain/tools/Windows/cc_riscv32_musl_fp_win/bin';
const extraPaths = [
  toolchainBin,
  'D:/HiSparkToolchain/tools/Windows/ninja',
  'D:/HiSparkToolchain/tools/Windows/gn',
  'D:/HiSparkToolchain/tools/cfbb/thirdparty/ccache',
].filter((p) => fs.existsSync(p));

const env = { ...process.env };
env.PATH = [...extraPaths, env.PATH].join(path.delimiter);

console.log('[build-m3] 编译 ws63-liteos-app ...');
const result = spawnSync(python, ['build.py', 'ws63-liteos-app'], {
  cwd: path.join(SDK, 'src'),
  env,
  stdio: 'inherit',
});
if (result.error) fail(`启动 build.py 失败：${result.error.message}`);
if (result.status !== 0) fail(`编译失败（exit ${result.status}）`);

const fwpkg = path.join(SDK, 'src/output/ws63/fwpkg/ws63-liteos-app/ws63-liteos-app_all.fwpkg');
if (!fs.existsSync(fwpkg)) fail(`编译完成但找不到产物：${fwpkg}`);
const stat = fs.statSync(fwpkg);
console.log(`[build-m3] 产物 ${fwpkg}（${stat.size} 字节）`);
