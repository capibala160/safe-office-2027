'use strict';
// 审计恢复失败：保留错误状态、隔离原文件、关闭后不覆盖取证材料
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AuditLog } = require('../src/governance.cjs');
const { ConsoleService } = require('../src/console-service.cjs');

test('审计恢复失败：restoreError 保留、原文件移入 .corrupt-*、关闭后仍可取证', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-office-audit-restore-'));
  const auditFile = path.join(dir, 'audit.jsonl');
  const checkpointFile = path.join(dir, 'audit.head');
  const tenantFile = path.join(dir, 'audit.tenants');
  let service = null;
  try {
    const log = new AuditLog();
    log.append('原始事件', { action: 'readDoc', x: 1 });
    log.append('原始事件', { action: 'summarize', x: 2 });
    fs.writeFileSync(auditFile, `${log.entries.map((e) => JSON.stringify(e)).join('\n')}\n`);
    fs.writeFileSync(checkpointFile, JSON.stringify(log.checkpoint()));

    // 篡改第一条：全局链校验必然失败
    const lines = fs.readFileSync(auditFile, 'utf8').trim().split('\n');
    const first = JSON.parse(lines[0]);
    first.detail.x = 999;
    lines[0] = JSON.stringify(first);
    fs.writeFileSync(auditFile, `${lines.join('\n')}\n`);

    service = new ConsoleService({
      auditFile,
      auditCheckpointFile: checkpointFile,
      auditTenantCheckpointFile: tenantFile,
    });
    const state = service.getState();
    assert.ok(state.audit.restoreError, 'restoreError 不能为 null');
    assert.equal(state.audit.verified, false, '恢复失败后不能报 verified:true');
    assert.equal(state.audit.persistBlocked, false);

    const corrupt = fs.readdirSync(dir).find((f) => f.startsWith('audit.jsonl.corrupt-'));
    assert.ok(corrupt, '原审计文件应被隔离');
    const evidence = fs.readFileSync(path.join(dir, corrupt), 'utf8');
    assert.ok(evidence.includes('999'), '隔离副本必须保留篡改证据');

    service.audit.append('新事件', { action: 'deleteDoc' });
    service.close();
    service = null;

    const after = fs.readFileSync(auditFile, 'utf8');
    assert.ok(!after.includes('999'), '关闭后新链不能覆盖/混入旧异常内容');
    assert.ok(after.includes('新事件'), '新链仍应落盘');
    const evidenceAfter = fs.readFileSync(path.join(dir, corrupt), 'utf8');
    assert.ok(evidenceAfter.includes('999'), '取证副本关闭后仍在');
  } finally {
    if (service) { try { service.close(); } catch { /* ignore */ } }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
