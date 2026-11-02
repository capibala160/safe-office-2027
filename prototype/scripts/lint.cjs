'use strict';
// 轻量 lint：语法检查（node --check）+ 源码危险模式扫描。
// 纯 CJS 项目，不做 TypeScript 类型检查；类型约束由 JSDoc 与测试兜底。
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['src', 'eval', 'test', 'public', 'scripts'];
const SCAN_FILES = ['server.cjs', 'demo.cjs', 'demo-nearfield.cjs', 'import-doc.cjs'];
const EXT = new Set(['.js', '.cjs']);
const FORBIDDEN = [
  { re: /\beval\s*\(/, label: 'eval()' },
  { re: /new\s+Function\s*\(/, label: 'new Function()' },
];

function walk(dir, out) {
  if (!fs.existsSync(dir)) return;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, out);
    else if (EXT.has(path.extname(ent.name))) out.push(full);
  }
}

const files = [];
for (const d of SCAN_DIRS) walk(path.join(ROOT, d), files);
for (const f of SCAN_FILES) {
  const full = path.join(ROOT, f);
  if (fs.existsSync(full)) files.push(full);
}

let failed = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    failed += 1;
    console.error(`✖ 语法错误：${path.relative(ROOT, file)}`);
    console.error(String(err.stderr || err.message).trim().split('\n').slice(0, 4).join('\n'));
  }
}

// 只扫描运行时代码；测试里允许构造攻击样例
const runtimeFiles = files.filter((f) => {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  return rel.startsWith('src/') || rel.startsWith('eval/') || rel === 'server.cjs';
});
for (const file of runtimeFiles) {
  const text = fs.readFileSync(file, 'utf8');
  for (const rule of FORBIDDEN) {
    if (rule.re.test(text)) {
      failed += 1;
      console.error(`✖ 危险模式 ${rule.label}：${path.relative(ROOT, file)}`);
    }
  }
}

if (failed) {
  console.error(`lint 失败：${failed} 项`);
  process.exit(1);
}
console.log(`lint OK：${files.length} 个文件语法通过，未发现 eval()/new Function()`);
