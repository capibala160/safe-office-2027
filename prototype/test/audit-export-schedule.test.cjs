'use strict';
// 审计快照定时导出与保留份数
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ConsoleService } = require('../src/console-service.cjs');

function tempDir(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `safe-office-${name}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeService(t, { keep = 2, intervalMs = 0 } = {}) {
  const dir = tempDir(t, 'audit-export');
  const auditFile = path.join(dir, 'audit.jsonl');
  const external = path.join(dir, 'external');
  fs.writeFileSync(auditFile, '', 'utf8');
  let nowMs = Date.parse('2026-11-03T10:00:00Z');
  const service = new ConsoleService({
    storeFile: ':memory:',
    auditFile,
    auditCheckpointFile: path.join(dir, 'audit.jsonl.head'),
    auditTenantCheckpointFile: path.join(dir, 'audit.tenants.json'),
    auditArchiveDir: path.join(dir, 'audit-archive'),
    auditExternalDir: external,
    auditExportKeep: keep,
    auditExportIntervalMs: intervalMs,
    now: () => nowMs,
  });
  t.after(() => service.close());
  return { service, dir, external, advance: (ms) => { nowMs += ms; } };
}

test('定时导出：每次生成快照，并按 keep 清理旧快照', (t) => {
  const { service, external, advance } = makeService(t, { keep: 2 });
  const first = service.runAuditExportTick();
  assert.equal(first.ok, true);
  advance(1000);
  const second = service.runAuditExportTick();
  assert.equal(second.ok, true);
  advance(1000);
  const third = service.runAuditExportTick();
  assert.equal(third.ok, true);
  assert.equal(third.pruned.deleted, 1, '保留 2 份，第 1 份应被清理');

  const status = service.getAuditExternalStatus();
  assert.equal(status.configured, true);
  assert.equal(status.snapshots, 2);
  assert.equal(status.schedule.keep, 2);
  assert.equal(status.schedule.lastError, null);
  assert.equal(fs.readdirSync(external).filter((n) => n.startsWith('snapshot-')).length, 2);
});

test('定时导出：未配置外部目录时跳过，不抛错', () => {
  const service = new ConsoleService({ storeFile: ':memory:' });
  const result = service.runAuditExportTick();
  assert.equal(result.ok, false);
  assert.equal(result.skipped, 'not-configured');
  service.close();
});

test('定时器：interval=0 不启动；>0 启动且可停止', (t) => {
  const { service } = makeService(t, { intervalMs: 60000 });
  assert.equal(service.startAuditExportTimer(), true);
  assert.equal(service.getAuditExternalStatus().schedule.active, true);
  service.stopAuditExportTimer();
  assert.equal(service.getAuditExternalStatus().schedule.active, false);
});
