'use strict';
// 企业邮件审批（v0.61）：已读回执 / 会签与或签 / 转交 / 超时升级。
const test = require('node:test');
const assert = require('node:assert/strict');
const { ConsoleService } = require('../src/console-service.cjs');

const USERS = {
  author: { role: '员工', disabled: false },
  reviewer: { role: '管理员', disabled: false },
  second: { role: '管理员', disabled: false },
  backup: { role: '管理员', disabled: false },
  outsider: { role: '管理员', disabled: false },
  '停用管理员': { role: '管理员', disabled: true },
};

function setup(t, options = {}) {
  let clock = Date.parse('2026-11-28T10:00:00+08:00');
  const users = options.users || USERS;
  const service = new ConsoleService({
    storeFile: ':memory:',
    now: () => clock,
    mailApprovers: options.mailApprovers || ['reviewer'],
    mailApprovalMode: options.mailApprovalMode || 'any',
    mailEscalationApprover: options.mailEscalationApprover || null,
    mailApprovalSlaMs: options.mailApprovalSlaMs || 30 * 60 * 1000,
    operationTtlMs: 4 * 60 * 60 * 1000,
    mailUserInfo: (username) => users[username] || null,
  });
  t.after(() => service.close());
  return { service, advance: (ms) => { clock += ms; } };
}

async function draft(service, operator = 'author') {
  const sample = service.getDemoSamples().find((entry) => entry.id === 'external-confirm');
  const run = await service.runCommand({ ...sample, operator });
  return run.operations[0];
}

test('企业邮件：审批人打开详情记为已读且只记一次', async (t) => {
  const { service } = setup(t);
  const op = await draft(service);
  assert.equal(op.state, 'frozen');

  const byAuthor = service.getOperation(op.operationId, { actor: 'author', role: '员工' });
  assert.deepEqual(byAuthor.operation.mailApproval.readBy, {}, '发起人查看不算审批人已读');

  const byReviewer = service.getOperation(op.operationId, { actor: 'reviewer', role: '管理员' });
  assert.ok(byReviewer.operation.mailApproval.readBy.reviewer, '审批人打开详情应记录已读');
  assert.equal(byReviewer.operation.mailApproval.status, 'read');

  service.getOperation(op.operationId, { actor: 'reviewer', role: '管理员' });
  const reads = service.audit.entries.filter((entry) => entry.kind === '企业邮件审批已读');
  assert.equal(reads.length, 1, '重复打开不重复记审计');
});

test('企业邮件：或签模式下任一审批人批准即发送，其他人不能再批', async (t) => {
  const { service } = setup(t, { mailApprovers: ['reviewer', 'second'] });
  const op = await draft(service);
  const hash = service.store.getOperation(op.operationId).operationHash;
  const sent = await service.approveEnterpriseMail(op.operationId, { actor: 'second', role: '管理员', operationHash: hash });
  assert.equal(sent.send.state, 'sent');
  assert.equal(service.mailer.calls.length, 1);
  await assert.rejects(
    service.approveEnterpriseMail(op.operationId, { actor: 'reviewer', role: '管理员', operationHash: hash }),
    /已处理/,
  );
  assert.equal(service.mailer.calls.length, 1);
});

test('企业邮件：会签模式需全部审批人批准后才发送', async (t) => {
  const { service } = setup(t, { mailApprovers: ['reviewer', 'second'], mailApprovalMode: 'all' });
  const op = await draft(service);
  const hash = service.store.getOperation(op.operationId).operationHash;
  const first = await service.approveEnterpriseMail(op.operationId, { actor: 'reviewer', role: '管理员', operationHash: hash });
  assert.equal(first.pending, true);
  assert.equal(first.operation.state, 'frozen');
  assert.equal(first.operation.mailApproval.status, 'partial');
  assert.deepEqual(first.operation.mailApproval.approvedBy, ['reviewer']);
  assert.equal(service.mailer.calls.length, 0, '会签未完成不发送');

  await assert.rejects(
    service.approveEnterpriseMail(op.operationId, { actor: 'reviewer', role: '管理员', operationHash: hash }),
    /你已批准/,
  );
  const secondApproval = await service.approveEnterpriseMail(op.operationId, { actor: 'second', role: '管理员', operationHash: hash });
  assert.equal(secondApproval.send.state, 'sent');
  assert.equal(service.mailer.calls.length, 1);
});

test('企业邮件：待审批人可转交，转交后原审批人失效', async (t) => {
  const { service } = setup(t, { mailApprovers: ['reviewer'] });
  const op = await draft(service);
  const hash = service.store.getOperation(op.operationId).operationHash;

  const transferred = service.transferEnterpriseMail(op.operationId, {
    actor: 'reviewer', role: '管理员', to: 'second', operationHash: hash,
  });
  assert.deepEqual(transferred.operation.mailApproval.required, ['second']);
  assert.deepEqual(transferred.operation.mailApproval.pendingBy, ['second']);
  assert.ok(service.audit.entries.some((entry) => entry.kind === '企业邮件审批转交'));

  await assert.rejects(
    service.approveEnterpriseMail(op.operationId, { actor: 'reviewer', role: '管理员', operationHash: hash }),
    /指定审批人/,
  );
  const sent = await service.approveEnterpriseMail(op.operationId, { actor: 'second', role: '管理员', operationHash: hash });
  assert.equal(sent.send.state, 'sent');
  assert.equal(service.mailer.calls.length, 1);

  assert.throws(
    () => service.transferEnterpriseMail(op.operationId, { actor: 'second', role: '管理员', to: 'backup', operationHash: hash }),
    /已处理|过期/,
  );
});

test('企业邮件：转交对象必须是启用的管理员且不能是发起人', async (t) => {
  const { service } = setup(t);
  const op = await draft(service);
  const hash = service.store.getOperation(op.operationId).operationHash;
  assert.throws(() => service.transferEnterpriseMail(op.operationId, {
    actor: 'reviewer', role: '管理员', to: 'author', operationHash: hash,
  }), /发起人/);
  assert.throws(() => service.transferEnterpriseMail(op.operationId, {
    actor: 'reviewer', role: '管理员', to: '停用管理员', operationHash: hash,
  }), /启用的管理员/);
  assert.throws(() => service.transferEnterpriseMail(op.operationId, {
    actor: 'outsider', role: '管理员', to: 'second', operationHash: hash,
  }), /待审批/);
});

test('企业邮件：审批人停用后自动转交升级审批人，未配置升级时记阻塞', async (t) => {
  const users = {
    author: { role: '员工', disabled: false },
    reviewer: { role: '管理员', disabled: false },
    backup: { role: '管理员', disabled: false },
  };
  const { service } = setup(t, { users, mailEscalationApprover: 'backup' });
  const op = await draft(service);
  users.reviewer.disabled = true;
  service.sweepEnterpriseMailApprovals();
  const view = service.getOperation(op.operationId, { actor: 'backup', role: '管理员' }).operation;
  assert.deepEqual(view.mailApproval.required, ['backup'], '停用审批人的票应转给升级审批人');
  assert.ok(service.audit.entries.some((entry) => entry.kind === '企业邮件审批人停用转交'));
  const hash = service.store.getOperation(op.operationId).operationHash;
  const sent = await service.approveEnterpriseMail(op.operationId, { actor: 'backup', role: '管理员', operationHash: hash });
  assert.equal(sent.send.state, 'sent');
});

test('企业邮件：审批人停用且无升级审批人时只记阻塞，不投递', async (t) => {
  const users = {
    author: { role: '员工', disabled: false },
    reviewer: { role: '管理员', disabled: false },
  };
  const { service } = setup(t, { users });
  const op = await draft(service);
  users.reviewer.disabled = true;
  service.sweepEnterpriseMailApprovals();
  service.sweepEnterpriseMailApprovals();
  const blocked = service.audit.entries.filter((entry) => entry.kind === '企业邮件审批阻塞：审批人已停用');
  assert.equal(blocked.length, 1, '阻塞审计只记一次');
  assert.equal(service.store.getOperation(op.operationId).state, 'frozen');
  assert.equal(service.mailer.calls.length, 0);
});

test('企业邮件：超过 SLA 催办并升级给备用审批人', async (t) => {
  const { service, advance } = setup(t, {
    mailApprovalSlaMs: 10 * 60 * 1000,
    mailEscalationApprover: 'backup',
  });
  const op = await draft(service);
  advance(6 * 60 * 1000);
  service.sweepEnterpriseMailApprovals();
  assert.ok(service.audit.entries.some((entry) => entry.kind === '企业邮件审批催办'), '过半 SLA 应催办');

  advance(5 * 60 * 1000);
  service.sweepEnterpriseMailApprovals();
  const view = service.getOperation(op.operationId, { actor: 'backup', role: '管理员' }).operation;
  assert.deepEqual(view.mailApproval.required, ['reviewer', 'backup']);
  assert.ok(view.mailApproval.escalatedAt);
  assert.equal(view.mailApproval.status, 'overdue');
  assert.ok(service.audit.entries.some((entry) => entry.kind === '企业邮件审批超时升级'));

  const hash = service.store.getOperation(op.operationId).operationHash;
  const sent = await service.approveEnterpriseMail(op.operationId, { actor: 'backup', role: '管理员', operationHash: hash });
  assert.equal(sent.send.state, 'sent');
  assert.equal(service.mailer.calls.length, 1);
});
