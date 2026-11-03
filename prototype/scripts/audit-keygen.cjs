#!/usr/bin/env node
'use strict';
// 生成审计检查点的 Ed25519 密钥对（v0.46）
//   node scripts/audit-keygen.cjs [--out=目录] [--force]
// 私钥只给服务端；公钥可公开，交给 verify-audit.cjs 做第三方校验。
//
// 默认拒绝覆盖已存在的密钥：旧审计检查点是用旧私钥签的，
// 覆盖后旧链/归档将无法再用新密钥验证。轮换请按输出里的步骤操作。
const fs = require('node:fs');
const path = require('node:path');
const { generateAuditKeyPair } = require('../src/audit-sign.cjs');

function argValue(name, fallback = null) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function printRotationHelp() {
  console.error('');
  console.error('正确轮换流程：');
  console.error('  1) 先用旧密钥轮转审计（治理页「轮转审计」或 POST /api/audit/rotate）');
  console.error('  2) 把新密钥生成到新目录（如 --out=data/keys-2026-11），不要覆盖旧目录');
  console.error('  3) 服务端切到新私钥；旧公钥保留，用于验证归档快照');
  console.error('  4) 确认旧快照验证通过后，再归档/下线旧私钥');
  console.error('');
  console.error('如确认要覆盖（例如旧密钥已泄露且旧链已废弃），加 --force。');
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('用法：node scripts/audit-keygen.cjs [--out=目录] [--force]');
  console.log('  --out=目录  写入 audit-ed25519-private.pem / audit-ed25519-public.pem');
  console.log('  --force     允许覆盖已存在的密钥（默认拒绝）');
  console.log('  不传 --out   直接打印到标准输出');
  process.exit(0);
}

const outDir = argValue('out');
const force = args.includes('--force');

if (outDir) {
  const privateFile = path.join(outDir, 'audit-ed25519-private.pem');
  const publicFile = path.join(outDir, 'audit-ed25519-public.pem');
  const existing = [privateFile, publicFile].filter((file) => fs.existsSync(file));
  if (existing.length > 0 && !force) {
    console.error('拒绝覆盖已存在的审计密钥：');
    for (const file of existing) console.error(`  ${file}`);
    console.error('');
    console.error('这些文件可能就是当前审计检查点的签发密钥；覆盖会让旧检查点/归档无法验证。');
    printRotationHelp();
    process.exit(1);
  }
  if (existing.length > 0 && force) {
    console.warn('⚠ --force：将覆盖已存在的密钥文件；旧检查点可能无法再验证。');
  }

  fs.mkdirSync(outDir, { recursive: true });
  const pair = generateAuditKeyPair();
  let createdPrivate = false;
  let createdPublic = false;
  try {
    fs.writeFileSync(privateFile, pair.privateKeyPem, {
      encoding: 'utf8', mode: 0o600, flag: force ? 'w' : 'wx',
    });
    createdPrivate = true;
    fs.writeFileSync(publicFile, pair.publicKeyPem, {
      encoding: 'utf8', mode: 0o644, flag: force ? 'w' : 'wx',
    });
    createdPublic = true;
  } catch (err) {
    // 非 force 模式：不能留下半套新密钥
    if (!force) {
      if (createdPrivate) { try { fs.rmSync(privateFile, { force: true }); } catch { /* ignore */ } }
      if (createdPublic) { try { fs.rmSync(publicFile, { force: true }); } catch { /* ignore */ } }
    }
    console.error(`写入失败：${err.message}`);
    process.exit(1);
  }
  console.log(`私钥：${privateFile}（0600，勿提交/外发）`);
  console.log(`公钥：${publicFile}（可公开）`);
  console.log(`keyId：${pair.keyId}`);
} else {
  const pair = generateAuditKeyPair();
  console.log('--- PRIVATE KEY（只给服务端，勿外发）---');
  console.log(pair.privateKeyPem);
  console.log('--- PUBLIC KEY（可公开）---');
  console.log(pair.publicKeyPem);
  console.log(`keyId：${pair.keyId}`);
}

console.log('');
console.log('服务端启用：');
console.log('  SAFE_OFFICE_AUDIT_ED25519_PRIVATE_KEY_FILE=<私钥文件>');
console.log('第三方校验：');
console.log('  npm run verify:audit -- --audit=data/audit.jsonl --checkpoint=data/audit.jsonl.head --public-key=<公钥文件>');
