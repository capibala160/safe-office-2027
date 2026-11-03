'use strict';
// Ed25519 审计检查点：签名/验签、链校验、前缀检查点、ConsoleService 集成
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AuditLog } = require('../src/governance.cjs');
const {
  generateAuditKeyPair, createAuditSigner, verifyAuditFiles,
} = require('../src/audit-sign.cjs');
const { ConsoleService } = require('../src/console-service.cjs');

test('Ed25519：签名/验签、错公钥/改内容都拒绝', () => {
  const pair = generateAuditKeyPair();
  const signer = createAuditSigner({ privateKeyPem: pair.privateKeyPem });
  const cp = { count: 2, head: 'a'.repeat(64) };
  const signed = signer.sign(cp);
  assert.equal(signed.alg, 'Ed25519');
  assert.equal(signed.keyId, pair.keyId);
  assert.equal(typeof signed.sig, 'string');

  const verifier = createAuditSigner({ publicKeyPem: pair.publicKeyPem });
  assert.equal(verifier.verify(signed), true);
  assert.equal(verifier.verify({ ...signed, count: 3 }), false);
  assert.equal(verifier.verify({ ...signed, head: 'b'.repeat(64) }), false);

  const other = generateAuditKeyPair();
  assert.equal(createAuditSigner({ publicKeyPem: other.publicKeyPem }).verify(signed), false);
});

test('HMAC 兼容：旧检查点仍可验；未签名只在无密钥时接受', () => {
  const key = Buffer.alloc(32, 7);
  const signer = createAuditSigner({ hmacKey: key });
  const signed = signer.sign({ count: 0, head: 'GENESIS' });
  assert.equal(signed.alg, 'HMAC-SHA256');
  assert.equal(createAuditSigner({ hmacKey: key }).verify(signed), true);
  assert.equal(createAuditSigner({ hmacKey: Buffer.alloc(32, 8) }).verify(signed), false);
  assert.equal(createAuditSigner({}).verify({ count: 0, head: 'GENESIS' }), true);
  assert.equal(createAuditSigner({ publicKeyPem: generateAuditKeyPair().publicKeyPem })
    .verify({ count: 0, head: 'GENESIS' }), false);
});

function writeAudit(dir, entries) {
  const auditFile = path.join(dir, 'audit.jsonl');
  AuditLog.writeLines(auditFile, entries);
  return auditFile;
}

test('verifyAuditFiles：链 + 前缀检查点 + 签名三者都过才算通过', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-sign-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pair = generateAuditKeyPair();
  const log = new AuditLog();
  log.append('事件一', { n: 1 });
  const prefix = log.checkpoint();
  log.append('事件二', { n: 2 });

  const auditFile = writeAudit(dir, log.entries);
  const checkpointFile = path.join(dir, 'audit.jsonl.head');
  fs.writeFileSync(checkpointFile, JSON.stringify(createAuditSigner({ privateKeyPem: pair.privateKeyPem }).sign(prefix)));

  const ok = verifyAuditFiles({ auditFile, checkpointFile, publicKeyPem: pair.publicKeyPem });
  assert.equal(ok.ok, true, ok.reason);
  assert.equal(ok.chainOk, true);
  assert.equal(ok.checkpointOk, true);
  assert.equal(ok.signatureOk, true);
  assert.equal(ok.entries, 2);

  // 改日志正文 → 链失败
  const tampered = log.entries.map((e) => ({ ...e }));
  tampered[0].detail = { n: 999 };
  const tamperedFile = writeAudit(dir, tampered);
  const badChain = verifyAuditFiles({ auditFile: tamperedFile, checkpointFile, publicKeyPem: pair.publicKeyPem });
  assert.equal(badChain.ok, false);
  assert.equal(badChain.chainOk, false);

  // 改检查点但不重签 → 签名/前缀失败
  const cp = JSON.parse(fs.readFileSync(checkpointFile, 'utf8'));
  fs.writeFileSync(checkpointFile, JSON.stringify({ ...cp, count: 2 }));
  const badCp = verifyAuditFiles({ auditFile, checkpointFile, publicKeyPem: pair.publicKeyPem });
  assert.equal(badCp.ok, false);
  assert.equal(badCp.signatureOk, false);

  // 没有公钥 → 签名无法验证
  const noKey = verifyAuditFiles({ auditFile, checkpointFile: `${auditFile}.head` });
  assert.equal(noKey.ok, false);
});

test('租户链缓存：增量更新与全量派生结果一致（多租户/多条目）', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-tenant-cache-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pair = generateAuditKeyPair();
  const service = new ConsoleService({
    auditFile: path.join(dir, 'audit.jsonl'),
    auditPrivateKeyPem: pair.privateKeyPem,
  });
  t.after(() => service.close());

  const actors = ['alice', 'bob', 'carol'];
  for (let i = 0; i < 60; i += 1) {
    service._withAuditActor(actors[i % actors.length], () => {
      service.audit.append('测试事件', { i });
    });
  }

  const derived = service.audit.tenantCheckpoints();
  assert.equal(service._tenantChainState.size, derived.length);
  for (const item of derived) {
    assert.deepEqual(
      service._tenantChainState.get(item.tenant),
      { count: item.count, head: item.head },
      `租户 ${item.tenant} 的增量链头必须与全量派生一致`,
    );
  }
  // 可信检查点也必须覆盖所有租户且签名可验
  assert.equal(service._trustedTenantCheckpoints.size, derived.length);
  for (const cp of service._trustedTenantCheckpoints.values()) {
    assert.equal(service.auditSigner.verify(cp), true);
  }
});

test('ConsoleService：Ed25519 检查点落盘、重启可验、篡改被隔离', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-sign-svc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pair = generateAuditKeyPair();
  const auditFile = path.join(dir, 'audit.jsonl');

  const service = new ConsoleService({ auditFile, auditPrivateKeyPem: pair.privateKeyPem });
  service.audit.append('测试事件', { n: 1 });
  const checkpointFile = `${auditFile}.head`;
  const cp = JSON.parse(fs.readFileSync(checkpointFile, 'utf8'));
  assert.equal(cp.alg, 'Ed25519');
  assert.equal(cp.keyId, pair.keyId);
  service.close();

  const verified = verifyAuditFiles({ auditFile, checkpointFile, publicKeyPem: pair.publicKeyPem });
  assert.equal(verified.ok, true, verified.reason);

  // 重启可恢复
  const reopened = new ConsoleService({ auditFile, auditPrivateKeyPem: pair.privateKeyPem });
  assert.equal(reopened.audit.entries.length, 1);
  reopened.close();

  // 篡改检查点 → 恢复失败并隔离
  fs.writeFileSync(checkpointFile, JSON.stringify({ ...cp, head: 'f'.repeat(64) }));
  const broken = new ConsoleService({ auditFile, auditPrivateKeyPem: pair.privateKeyPem });
  // 旧链被隔离，新链只有一条「审计恢复失败」记录
  assert.equal(broken.audit.entries.length, 1);
  assert.equal(broken.audit.entries[0].kind, '审计恢复失败');
  assert.ok(broken.auditRestore && broken.auditRestore.error, '应记录恢复失败');
  broken.close();
});
