'use strict';
// 审计轮转/归档/保留：旧链可取证、新链可校验、旧归档可修剪
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ConsoleService } = require('../src/console-service.cjs');

test('审计轮转：旧链归档保留，新链可校验并记录 previous 检查点', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-office-audit-rotate-'));
  let now = Date.parse('2026-11-02T12:00:00Z');
  const auditFile = path.join(dir, 'audit.jsonl');
  const archiveDir = path.join(dir, 'audit-archive');
  const service = new ConsoleService({ auditFile, auditArchiveDir: archiveDir, now: () => now });
  try {
    service._withAuditActor('alice', () => {
      service.audit.append('旧事件', { n: 1 });
      service.audit.append('旧事件', { n: 2 });
    });
    const oldCheckpoint = service.audit.checkpoint();
    const rotated = service.rotateAudit({ reason: 'test', by: 'alice' });
    assert.equal(rotated.rotated, true);
    assert.ok(fs.existsSync(rotated.archive.audit), '旧审计必须归档');
    assert.ok(fs.readFileSync(rotated.archive.audit, 'utf8').includes('旧事件'));

    assert.equal(service.audit.entries.length, 1);
    assert.equal(service.audit.entries[0].kind, '审计轮转');
    assert.deepEqual(service.audit.entries[0].detail.previous, oldCheckpoint);
    assert.equal(service.audit.verify(), true, '新链必须自洽');

    now += 60_000;
    service.audit.append('新事件', { n: 3 });
    const second = service.rotateAudit({ reason: 'test-2' });
    assert.ok(fs.existsSync(second.archive.audit));
    const pruned = service.pruneAuditArchives({ keep: 1 });
    assert.equal(pruned.kept, 1, '只保留最近一份归档');
    const remaining = fs.readdirSync(archiveDir).filter((f) => /^audit-.*\.jsonl$/.test(f));
    assert.equal(remaining.length, 1);
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('审计自动轮转：超过保留天数才轮转；空链不轮转', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-office-audit-auto-'));
  let now = Date.parse('2026-11-02T12:00:00Z');
  const auditFile = path.join(dir, 'audit.jsonl');
  const service = new ConsoleService({ auditFile, auditRetentionDays: 30, now: () => now });
  try {
    assert.equal(service.autoRotateAuditIfDue().rotated, false, '空链不轮转');
    service.audit.append('旧事件', { n: 1 });
    fs.utimesSync(auditFile, new Date(now - 31 * 24 * 3600 * 1000), new Date(now - 31 * 24 * 3600 * 1000));
    const result = service.autoRotateAuditIfDue();
    assert.equal(result.rotated, true);
    assert.ok(fs.existsSync(result.archive.audit));
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
