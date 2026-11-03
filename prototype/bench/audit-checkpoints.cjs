#!/usr/bin/env node
'use strict';
// 租户检查点增量 vs 全量派生（v0.46.2）
//   旧实现：每条审计都调用 tenantCheckpoints()，对全部条目 × 全部租户重算链。
//   新实现：每条审计只更新当前 actor 的链头，O(1)。
// 这里用大日志量对比“全量扫描一次”与“增量更新一条”的成本。
const { AuditLog } = require('../src/governance.cjs');
const { ConsoleService } = require('../src/console-service.cjs');

const entries = Number(process.argv.find((a) => a.startsWith('--entries='))?.split('=')[1] || 5000);
const tenants = Number(process.argv.find((a) => a.startsWith('--tenants='))?.split('=')[1] || 10);
const samples = Number(process.argv.find((a) => a.startsWith('--samples='))?.split('=')[1] || 20);
const actors = Array.from({ length: tenants }, (_, i) => `user-${i}`);

// 1) 构造大日志（内存）：每条都有 actor，模拟多租户
const log = new AuditLog();
for (let i = 0; i < entries; i += 1) {
  log.actor = actors[i % tenants];
  log.append('性能样本', { i });
}
log.actor = null;

// 2) 旧实现成本：一次 tenantCheckpoints() 就是一次全量扫描
const fullStart = process.hrtime.bigint();
for (let i = 0; i < samples; i += 1) log.tenantCheckpoints();
const fullMs = Number(process.hrtime.bigint() - fullStart) / 1e6 / samples;

// 3) 新实现成本：ConsoleService 每条审计只更新一个租户的链头
const service = new ConsoleService({ auditFile: null });
const incStart = process.hrtime.bigint();
for (let i = 0; i < entries; i += 1) {
  service.audit.actor = actors[i % tenants];
  service.audit.append('性能样本', { i });
}
service.audit.actor = null;
const incTotalMs = Number(process.hrtime.bigint() - incStart) / 1e6;

// 4) 正确性：增量缓存必须与全量派生一致
const derived = service.audit.tenantCheckpoints();
let consistent = derived.length === service._tenantChainState.size;
for (const t of derived) {
  const cached = service._tenantChainState.get(t.tenant);
  if (!cached || cached.count !== t.count || cached.head !== t.head) consistent = false;
}
service.close();

console.log(`条目 ${entries} / 租户 ${tenants}`);
console.log(`旧实现：tenantCheckpoints() 单次全量扫描 ${fullMs.toFixed(2)} ms（${samples} 次均值）`);
console.log(`  若每条审计都做一次，${entries} 条预计 ${(fullMs * entries).toFixed(0)} ms`);
console.log(`新实现：${entries} 条增量追加合计 ${incTotalMs.toFixed(2)} ms（含审计哈希链本身）`);
console.log(`  单条增量约 ${(incTotalMs / entries * 1000).toFixed(1)} µs`);
console.log(`增量缓存与全量派生一致：${consistent ? '是' : '否'}`);
if (!consistent) process.exitCode = 1;
