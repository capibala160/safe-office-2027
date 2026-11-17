'use strict';
// 委托收窄（2026-11-17）：子委托只能继承父委托的子集——
// 动作不能新增、有效期不能延长、范围标签不能扩大、父令牌必须可用。
const test = require('node:test');
const assert = require('node:assert/strict');
const { DelegationService } = require('../src/agents.cjs');

function setup() {
  let now = 1_000_000;
  const service = new DelegationService({ key: Buffer.alloc(32, 7), now: () => now });
  const parent = service.issue({
    from: '管理员', to: '员工A',
    actions: ['readDoc', 'scheduleMeeting'],
    ttlMs: 60_000,
    scope: 'meeting, read',
  });
  return { service, parent, advance: (ms) => { now += ms; }, now: () => now };
}

test('子委托收窄：动作子集 + 更短有效期 + 范围子集 → 通过', () => {
  const { service, parent } = setup();
  const child = service.issue({
    from: '员工A', to: '设备助手',
    actions: ['readDoc'], ttlMs: 30_000, scope: 'read', parent,
  });
  assert.deepEqual(child.actions, ['readDoc']);
  assert.ok(child.expiresAt <= parent.expiresAt);
  assert.equal(service.verify(child, { to: '设备助手', action: 'readDoc' }).allow, true);
  assert.equal(service.verify(child, { to: '设备助手', action: 'scheduleMeeting' }).allow, false);
});

test('子委托不能新增动作', () => {
  const { service, parent } = setup();
  assert.throws(
    () => service.issue({
      from: '员工A', to: '设备助手',
      actions: ['readDoc', 'deleteDoc'], ttlMs: 10_000, parent,
    }),
    /不能扩大动作范围/,
  );
});

test('子委托不能延长有效期', () => {
  const { service, parent } = setup();
  assert.throws(
    () => service.issue({
      from: '员工A', to: '设备助手',
      actions: ['readDoc'], ttlMs: 120_000, parent,
    }),
    /不能延长有效期/,
  );
});

test('子委托范围：不能新增标签，也不能留空', () => {
  const { service, parent } = setup();
  assert.throws(
    () => service.issue({
      from: '员工A', to: '设备助手',
      actions: ['readDoc'], ttlMs: 10_000, scope: 'read, device', parent,
    }),
    /不能扩大范围/,
  );
  assert.throws(
    () => service.issue({
      from: '员工A', to: '设备助手',
      actions: ['readDoc'], ttlMs: 10_000, scope: '', parent,
    }),
    /必须显式给出更窄的范围/,
  );
});

test('父委托不可用：伪造/过期/撤销/主体不符都拒绝签发子委托', () => {
  const { service, parent, advance } = setup();

  const forged = { ...parent, scope: 'meeting, read, device' };
  assert.throws(
    () => service.issue({ from: '员工A', to: '设备助手', actions: ['readDoc'], ttlMs: 10_000, parent: forged }),
    /父委托不可用/,
  );

  assert.throws(
    () => service.issue({ from: '员工B', to: '设备助手', actions: ['readDoc'], ttlMs: 10_000, parent }),
    /父委托不可用/,
    '父令牌主体必须是子令牌的 from',
  );

  service.revoke(parent.id);
  assert.throws(
    () => service.issue({ from: '员工A', to: '设备助手', actions: ['readDoc'], ttlMs: 10_000, parent }),
    /已撤销/,
  );

  const fresh = setup();
  fresh.advance(61_000);
  assert.throws(
    () => fresh.service.issue({ from: '员工A', to: '设备助手', actions: ['readDoc'], ttlMs: 10_000, parent: fresh.parent }),
    /已过期/,
  );
  advance(0);
});

test('无父令牌时保持原有行为（可自由签发）', () => {
  const { service } = setup();
  const token = service.issue({ from: '管理员', to: '员工A', actions: ['printDoc'], ttlMs: 1000 });
  assert.equal(service.verify(token, { to: '员工A', action: 'printDoc' }).allow, true);
});
