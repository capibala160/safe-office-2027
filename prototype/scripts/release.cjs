'use strict';
// 发布打包（2026-11-17）：生成可交付的 tar.gz + sha256 + MANIFEST。
//
// 用法：npm run release   →  dist/safe-office-<version>-<date>.tar.gz(.sha256)
//
// 包含：README/Dockerfile/compose、docs/、ws63/、prototype/（源码与测试）、.github/
// 排除：node_modules、.git、data/（含钥匙/设备表）、out/、dist/、config.env 等私有件。
// 说明：用系统 tar（Windows 10+/Linux/macOS 自带），不引入额外依赖。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const PKG = require('../package.json');
const REPO = path.resolve(__dirname, '..', '..');
const DIST = path.join(REPO, 'dist');
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const name = `safe-office-${PKG.version}-${stamp}`;
const tarName = `${name}.tar.gz`;

const EXCLUDE_NAMES = new Set([
  '.git', 'node_modules', 'data', 'out', 'dist', '.cache', '.claude',
  'config.env', 'devices.json', 'initial-users.txt', '.env',
]);

/** @param {string} src @returns {boolean} */
function keep(src) {
  const base = path.basename(src);
  if (EXCLUDE_NAMES.has(base)) return false;
  if (base.endsWith('.log') && base !== 'README.md') return false;
  return true;
}

/** @param {string} dir @returns {number} */
function countFiles(dir) {
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) n += countFiles(full);
    else n += 1;
  }
  return n;
}

function main() {
  fs.mkdirSync(DIST, { recursive: true });
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'so-release-'));
  try {
    const roots = [
      'README.md', 'Dockerfile', 'docker-compose.yml', '.github', '.gitignore', '.dockerignore',
      'docs', 'ws63', 'prototype',
    ];
    for (const rel of roots) {
      const src = path.join(REPO, rel);
      if (!fs.existsSync(src)) continue;
      fs.cpSync(src, path.join(stage, rel), { recursive: true, filter: keep });
    }

    const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' });
    const manifest = {
      name,
      version: PKG.version,
      commit: commit.status === 0 ? commit.stdout.trim() : 'unknown',
      createdAt: new Date().toISOString(),
      files: countFiles(stage),
      note: '不含 node_modules/data/out/config.env；依赖用 npm ci 安装',
    };
    fs.writeFileSync(path.join(stage, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);

    const outFile = path.join(DIST, tarName);
    /* Windows 的 GNU tar 对 "C:\" 路径与中文路径都不稳：先在临时目录生成 ASCII 文件名，
     * 再复制到 dist。tar 的 cwd 放在临时目录，输出用 "../<ascii>.tar.gz" 相对路径。 */
    const tmpTar = path.join(path.dirname(stage), `${name}.tar.gz`);
    const tar = spawnSync('tar', ['-czf', path.join('..', `${name}.tar.gz`), '.'], { cwd: stage, encoding: 'utf8' });
    if (tar.status !== 0) throw new Error(`tar 失败：${tar.stderr || tar.error || 'unknown'}`);
    fs.copyFileSync(tmpTar, outFile);
    fs.rmSync(tmpTar, { force: true });

    const hash = crypto.createHash('sha256').update(fs.readFileSync(outFile)).digest('hex');
    fs.writeFileSync(`${outFile}.sha256`, `${hash}  ${tarName}\n`);
    const size = fs.statSync(outFile).size;
    console.log(`发布包：${outFile}`);
    console.log(`大小：${(size / 1024 / 1024).toFixed(2)} MB，文件数：${manifest.files}，commit：${manifest.commit.slice(0, 12)}`);
    console.log(`sha256：${hash}`);
    return 0;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (err) {
    console.error(`发布打包失败：${err && err.message ? err.message : err}`);
    process.exitCode = 1;
  }
}

module.exports = { main };
