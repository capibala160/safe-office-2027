#!/usr/bin/env node
'use strict';
// ============================================================
// 独立审计验证器（v0.46）
//   只读：审计日志 + 检查点 + 公钥 → 校验哈希链、检查点前缀、Ed25519 签名
//   不需要服务端私钥，适合把日志和公钥交给第三方复核。
//
//   npm run verify:audit -- --audit=data/audit.jsonl --checkpoint=data/audit.jsonl.head \
//     --public-key=audit-public.pem
// ============================================================
const fs = require('node:fs');
const path = require('node:path');
const { verifyAuditFiles } = require('./src/audit-sign.cjs');

function parseArgs(argv) {
  const opts = {};
  for (const arg of argv) {
    const m = /^--([a-zA-Z-]+)=(.*)$/.exec(arg);
    if (!m) continue;
    opts[m[1]] = m[2];
  }
  return opts;
}

function readMaybeFile(value) {
  if (!value) return null;
  if (fs.existsSync(value)) return fs.readFileSync(value, 'utf8');
  return String(value);
}

function parseHmacKey(value) {
  if (!value) return null;
  const text = String(value);
  return Buffer.from(text, /^[0-9a-fA-F]{64}$/.test(text) ? 'hex' : 'base64');
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dataDir = path.join(__dirname, 'data');
  const auditFile = opts.audit || path.join(dataDir, 'audit.jsonl');
  const checkpointFile = opts.checkpoint || `${auditFile}.head`;

  const publicKeyValue = opts['public-key']
    || process.env.SAFE_OFFICE_AUDIT_ED25519_PUBLIC_KEY
    || process.env.SAFE_OFFICE_AUDIT_ED25519_PUBLIC_KEY_FILE
    || null;
  const publicKeyPem = readMaybeFile(publicKeyValue);
  const hmacKey = parseHmacKey(opts['hmac-key'] || process.env.SAFE_OFFICE_AUDIT_KEY);

  let result;
  try {
    result = verifyAuditFiles({ auditFile, checkpointFile, publicKeyPem, hmacKey });
  } catch (err) {
    result = { ok: false, reason: err.message };
  }

  if (opts.json === '1' || opts.json === 'true') {
    console.log(JSON.stringify({
      auditFile, checkpointFile,
      publicKey: publicKeyPem ? 'provided' : 'missing',
      ...result,
    }, null, 2));
  } else {
    console.log(`审计文件：${auditFile}`);
    console.log(`检查点：${checkpointFile}`);
    console.log(`签名：${result.alg || '未签名'}${result.keyId ? `（keyId ${result.keyId}）` : ''}`);
    console.log(`条目：${result.entries ?? '-'} · 哈希链 ${result.chainOk ? '通过' : '失败'} · 检查点 ${result.checkpointOk ? '通过' : '失败'} · 签名 ${result.signatureOk ? '通过' : '失败'}`);
    console.log(result.ok ? '结果：通过' : `结果：失败（${result.reason}）`);
  }
  process.exitCode = result.ok ? 0 : 1;
}

if (require.main === module) main();

module.exports = { parseArgs, parseHmacKey };
