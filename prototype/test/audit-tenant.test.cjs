'use strict';
// 审计按租户分链：隔离、独立校验、篡改可检出
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AuditLog } = require('../src/governance.cjs');
const { ConsoleService } = require('../src/console-service.cjs');

test('租户分链：只含该 actor 的条目，独立检查点可校验', () => {
  const log = new AuditLog();
  log.actor = 'alice';
  log.append('命令执行', { action: 'readDoc', n: 1 });
  log.actor = 'bob';
  log.append('命令执行', { action: 'sendEmail', n: 2 });
  log.actor = 'alice';
  log.append('命令执行', { action: 'summarize', n: 3 });

  const alice = log.tenantChain('alice');
  const bob = log.tenantChain('bob');
  assert.equal(alice.checkpoint.count, 2);
  assert.equal(bob.checkpoint.count, 1);
  assert.equal(alice.entries[0].sourceSeq, 1);
  assert.equal(alice.entries[1].sourceSeq, 3);
  assert.ok(log.verifyTenant('alice', alice.checkpoint));
  assert.ok(log.verifyTenant('bob', bob.checkpoint));
  assert.deepEqual(log.tenantCheckpoints().map((t) => t.tenant), ['alice', 'bob']);
});

test('租户分链：篡改条目后检查点失效；无 actor 的全局条目不计入', () => {
  const log = new AuditLog();
  log.actor = 'alice';
  log.append('命令执行', { action: 'readDoc' });
  log.actor = null;
  log.append('全局事件', { note: 'system' });
  const alice = log.tenantChain('alice');
  assert.equal(alice.checkpoint.count, 1, '无 actor 的条目不计入租户链');

  log.entries[0].detail.action = 'deleteDoc';
  assert.equal(log.verifyTenant('alice', alice.checkpoint), false);
  assert.equal(log.verify(), false, '全局链同样断开');
});

test('租户检查点支持前缀：追加新条目不会把旧检查点判成篡改', () => {
  const log = new AuditLog();
  log.actor = 'alice';
  log.append('命令执行', { action: 'readDoc' });
  const checkpoint = log.tenantCheckpoint('alice');
  log.append('命令执行', { action: 'summarize' });
  assert.equal(log.verifyTenant('alice', checkpoint), true, '前缀仍可信');
  log.entries[0].detail.action = 'deleteDoc';
  assert.equal(log.verifyTenant('alice', checkpoint), false, '前缀内篡改必须失败');
});

test('租户接口：没有独立可信检查点不报通过；篡改后全局/租户都失败', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-office-tenant-audit-'));
  const auditFile = path.join(dir, 'audit.jsonl');
  const tenantFile = path.join(dir, 'audit.tenants.json');
  const service = new ConsoleService({ auditFile, auditTenantCheckpointFile: tenantFile });
  try {
    assert.equal(service.getTenantAudit('alice').verified, false, '首次写入前没有可信检查点');

    service.audit.actor = 'alice';
    service.audit.append('命令执行', { action: 'readDoc' });
    const ok = service.getTenantAudit('alice');
    assert.equal(ok.verified, true, '写入后应有可信检查点');
    assert.equal(ok.trusted, true);

    const entry = service.audit.entries.find((e) => e.kind === '命令执行' && e.actor === 'alice');
    entry.detail.action = 'deleteDoc';
    const bad = service.getTenantAudit('alice');
    assert.equal(bad.globalVerified, false);
    assert.equal(bad.verified, false, '篡改后不能报通过');
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
