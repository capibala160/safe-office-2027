'use strict';
// ============================================================
// 审计检查点签名 / 外部可验证（v0.46）
//   - 新增 Ed25519：私钥只在服务端，公钥可公开；任何持有公钥的人都能验证
//   - 保留 HMAC-SHA256 旧格式读取/校验，便于平滑迁移
//   - CLI 见 verify-audit.cjs：只读审计文件 + 检查点 + 公钥，输出 JSON
//
//   签名对象仍是 { count, head }（与 HMAC 相同），不含日志正文；
//   验证时必须同时验证哈希链本身与检查点前缀。
// 边界：Ed25519 证明"检查点由私钥持有者签发"，不证明签发时间；
//       需要时间证明时，另把检查点哈希交给可信时间戳/透明日志（未实现）。
// ============================================================
const crypto = require('node:crypto');
const fs = require('node:fs');
const { AuditLog } = require('./governance.cjs');

const ALG_ED25519 = 'Ed25519';
const ALG_HMAC = 'HMAC-SHA256';

function normalizePem(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\\n/g, '\n').trim();
}

function loadPrivateKey(pem, label = 'Ed25519 私钥') {
  const key = crypto.createPrivateKey({ key: normalizePem(pem), format: 'pem' });
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error(`${label} 不是 Ed25519 私钥（实际：${key.asymmetricKeyType}）`);
  }
  return key;
}

function loadPublicKey(pem, label = 'Ed25519 公钥') {
  const key = crypto.createPublicKey({ key: normalizePem(pem), format: 'pem' });
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error(`${label} 不是 Ed25519 公钥（实际：${key.asymmetricKeyType}）`);
  }
  return key;
}

function publicKeyPemFromPrivate(privateKey) {
  return crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
}

function keyIdOf(publicKey) {
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex').slice(0, 16);
}

function checkpointBody(checkpoint) {
  return Buffer.from(JSON.stringify({ count: checkpoint.count, head: checkpoint.head }), 'utf8');
}

function generateAuditKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  return { privateKeyPem, publicKeyPem, keyId: keyIdOf(publicKey) };
}

// signer 同时支持 Ed25519 / HMAC；未配置任何密钥时保持旧行为（不签名）
function createAuditSigner({ hmacKey = null, privateKeyPem = null, publicKeyPem = null } = {}) {
  const privateKey = privateKeyPem ? loadPrivateKey(privateKeyPem) : null;
  const publicKey = privateKey
    ? crypto.createPublicKey(privateKey)
    : (publicKeyPem ? loadPublicKey(publicKeyPem) : null);
  const keyId = publicKey ? keyIdOf(publicKey) : null;

  return {
    algorithm: privateKey ? ALG_ED25519 : (hmacKey ? ALG_HMAC : null),
    keyId,
    publicKeyPem: publicKey ? publicKey.export({ type: 'spki', format: 'pem' }) : null,
    canSign: !!(privateKey || hmacKey),
    canVerify: !!(publicKey || hmacKey),

    sign(checkpoint) {
      if (privateKey) {
        const sig = crypto.sign(null, checkpointBody(checkpoint), privateKey).toString('base64');
        return { ...checkpoint, alg: ALG_ED25519, sig, keyId };
      }
      if (hmacKey) {
        const mac = crypto.createHmac('sha256', hmacKey).update(checkpointBody(checkpoint)).digest('hex');
        return { ...checkpoint, alg: ALG_HMAC, mac };
      }
      return checkpoint;
    },

    verify(checkpoint) {
      if (!checkpoint || typeof checkpoint !== 'object') return false;
      if (checkpoint.alg === ALG_ED25519) {
        if (!publicKey || typeof checkpoint.sig !== 'string') return false;
        if (checkpoint.keyId && checkpoint.keyId !== keyId) return false;
        try {
          return crypto.verify(
            null,
            checkpointBody(checkpoint),
            publicKey,
            Buffer.from(checkpoint.sig, 'base64'),
          );
        } catch {
          return false;
        }
      }
      if (checkpoint.alg === ALG_HMAC) {
        if (!hmacKey || typeof checkpoint.mac !== 'string') return false;
        const expected = Buffer.from(
          crypto.createHmac('sha256', hmacKey).update(checkpointBody(checkpoint)).digest('hex'),
          'hex',
        );
        const actual = Buffer.from(checkpoint.mac, 'hex');
        return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
      }
      // 未签名检查点：只有完全没配置校验密钥时才接受（兼容既有演示）
      return !publicKey && !hmacKey;
    },
  };
}

// 检查点必须能对上日志的前缀（允许保存后又追加了新条目）
function checkpointMatches(checkpoint, entries) {
  if (!checkpoint || !Number.isInteger(checkpoint.count) || checkpoint.count < 0) return false;
  if (checkpoint.count > entries.length) return false;
  const head = checkpoint.count === 0 ? 'GENESIS' : entries[checkpoint.count - 1].hash;
  return checkpoint.head === head;
}

// 只读校验：日志链 + 检查点前缀 + 检查点签名
function verifyAuditFiles({
  auditFile, checkpointFile, publicKeyPem = null, hmacKey = null,
} = {}) {
  if (!auditFile || !checkpointFile) throw new TypeError('需要 auditFile 与 checkpointFile');
  const entries = AuditLog.readFile(auditFile);
  let checkpoint;
  try {
    checkpoint = JSON.parse(fs.readFileSync(checkpointFile, 'utf8'));
  } catch (err) {
    return { ok: false, reason: `检查点读取失败：${err.message}`, entries: entries.length };
  }

  const log = new AuditLog();
  log.entries = entries;
  // 从文件加载时没有内存里的 prevHash，必须显式给本文件自己的检查点
  const ownHead = entries.length ? entries[entries.length - 1].hash : 'GENESIS';
  const chainOk = log.verify({ count: entries.length, head: ownHead });
  const checkpointOk = checkpointMatches(checkpoint, entries);
  const signer = createAuditSigner({ hmacKey, publicKeyPem });
  const signatureOk = signer.verify(checkpoint);

  return {
    ok: chainOk && checkpointOk && signatureOk,
    entries: entries.length,
    chainOk,
    checkpointOk,
    signatureOk,
    alg: checkpoint.alg || null,
    keyId: checkpoint.keyId || null,
    checkpoint: { count: checkpoint.count, head: checkpoint.head },
    reason: !chainOk ? '哈希链校验失败'
      : !checkpointOk ? '检查点与日志前缀不一致'
        : !signatureOk ? '检查点签名无效'
          : 'ok',
  };
}

module.exports = {
  ALG_ED25519,
  ALG_HMAC,
  createAuditSigner,
  generateAuditKeyPair,
  publicKeyPemFromPrivate,
  keyIdOf,
  checkpointMatches,
  verifyAuditFiles,
  normalizePem,
};
