#!/usr/bin/env node
'use strict';
// 生成审计检查点的 Ed25519 密钥对（v0.46）
//   node scripts/audit-keygen.cjs [--out=目录]
// 私钥只给服务端；公钥可公开，交给 verify-audit.cjs 做第三方校验。
const fs = require('node:fs');
const path = require('node:path');
const { generateAuditKeyPair } = require('../src/audit-sign.cjs');

function argValue(name, fallback = null) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const outDir = argValue('out');
const pair = generateAuditKeyPair();

if (outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const privateFile = path.join(outDir, 'audit-ed25519-private.pem');
  const publicFile = path.join(outDir, 'audit-ed25519-public.pem');
  fs.writeFileSync(privateFile, pair.privateKeyPem, { encoding: 'utf8', mode: 0o600 });
  fs.writeFileSync(publicFile, pair.publicKeyPem, { encoding: 'utf8', mode: 0o644 });
  console.log(`私钥：${privateFile}（0600，勿提交/外发）`);
  console.log(`公钥：${publicFile}（可公开）`);
} else {
  console.log('--- PRIVATE KEY（只给服务端，勿外发）---');
  console.log(pair.privateKeyPem);
  console.log('--- PUBLIC KEY（可公开）---');
  console.log(pair.publicKeyPem);
}
console.log(`keyId：${pair.keyId}`);
console.log('');
console.log('服务端启用：');
console.log('  SAFE_OFFICE_AUDIT_ED25519_PRIVATE_KEY_FILE=<私钥文件>');
console.log('第三方校验：');
console.log('  npm run verify:audit -- --audit=data/audit.jsonl --checkpoint=data/audit.jsonl.head --public-key=<公钥文件>');
