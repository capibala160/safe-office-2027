'use strict';
// 审计快照外部存储：导出、清单校验、篡改检测、路径隔离
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ConsoleService } = require('../src/console-service.cjs');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-export-'));
  const auditFile = path.join(dir, 'data', 'audit.jsonl');
  const archiveDir = path.join(dir, 'data', 'audit-archive');
  const externalDir = path.join(dir, 'external');
  const service = new ConsoleService({ auditFile, auditArchiveDir: archiveDir, auditExternalDir: externalDir });
  service.audit.append('测试事件', { n: 1 });
  service.audit.append('测试事件', { n: 2 });
  t.after(() => {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, auditFile, archiveDir, externalDir, service };
}

test('导出：生成带 manifest 的快照，默认校验通过', (t) => {
  const { externalDir, service } = setup(t);
  const exported = service.exportAuditSnapshot({ by: 'admin' });
  assert.equal(exported.ok, true);
  assert.ok(fs.existsSync(path.join(exported.dir, 'manifest.json')));
  assert.ok(fs.existsSync(path.join(exported.dir, 'active', 'audit.jsonl')));
  assert.ok(exported.files.some((f) => f.path === 'active/audit.jsonl'));
  assert.ok(exported.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256)));

  const verified = service.verifyAuditExport();
  assert.equal(verified.ok, true);
  assert.equal(verified.checked, verified.files);
  assert.equal(verified.missing.length, 0);
  assert.equal(verified.mismatches.length, 0);

  const status = service.getAuditExternalStatus();
  assert.equal(status.configured, true);
  assert.equal(status.snapshots, 1);
  assert.equal(status.latest.by, 'admin');
  assert.ok(status.latest.at);
  assert.ok(fs.existsSync(externalDir));
});

test('校验：副本被改动/删除时如实报告', (t) => {
  const { service } = setup(t);
  const exported = service.exportAuditSnapshot();
  const target = path.join(exported.dir, 'active', 'audit.jsonl');
  fs.appendFileSync(target, '{"tampered":true}\n');
  let verified = service.verifyAuditExport();
  assert.equal(verified.ok, false);
  assert.equal(verified.mismatches.length, 1);
  assert.equal(verified.mismatches[0].reason, '大小不一致');

  fs.rmSync(target);
  verified = service.verifyAuditExport();
  assert.equal(verified.ok, false);
  assert.deepEqual(verified.missing, ['active/audit.jsonl']);
});

test('外部目录与本地归档互相包含时拒绝导出', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-export-nested-'));
  const archiveDir = path.join(dir, 'data', 'audit-archive');
  const service = new ConsoleService({
    auditFile: path.join(dir, 'data', 'audit.jsonl'),
    auditArchiveDir: archiveDir,
    auditExternalDir: path.join(archiveDir, 'external'),
  });
  t.after(() => {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  service.audit.append('测试', {});
  assert.throws(() => service.exportAuditSnapshot(), /不能与本地归档目录互相包含/);
});

test('未配置外部目录：状态如实、导出报错', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-export-none-'));
  const service = new ConsoleService({ auditFile: path.join(dir, 'audit.jsonl') });
  t.after(() => {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(service.getAuditExternalStatus().configured, false);
  assert.throws(() => service.exportAuditSnapshot(), /SAFE_OFFICE_AUDIT_EXTERNAL_DIR/);
});
