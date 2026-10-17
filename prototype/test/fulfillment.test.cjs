'use strict';
// 操作记录 / SQLite / 发送状态机 的最小闭环测试（v0.10）
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { sealOperation, verifyOperation, transition } = require('../src/operation.cjs');
const { OperationStore } = require('../src/store.cjs');
const { FakeMailer, HttpMailer, MailerError } = require('../src/mailer.cjs');
const { FulfillmentService } = require('../src/fulfillment.cjs');

function makeInput(overrides = {}) {
  const now = Date.now();
  return {
    taskId: 'T-1',
    action: 'sendExternalEmail',
    protocolAction: 1,
    tool: 'sendExternalEmail',
    recipient: 'partner@example.com',
    subject: '评审纪要',
    body: '最终正文',
    attachments: [{ name: 'a.pdf', data: 'abc' }],
    sourceDocIds: ['M2'],
    level: '内部',
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    modelId: 'mock',
    planHash: 'plan-1',
    ...overrides,
  };
}

function newService(mailer, options = {}) {
  const store = new OperationStore(':memory:', options.storeOptions || {});
  const service = new FulfillmentService({ store, mailer, now: options.now });
  return { store, service };
}

function confirm(service, input = makeInput()) {
  const operation = service.prepare(input);
  return service.confirm(operation.operationId, {
    confirmationId: 'conf-1',
    deviceId: 'ws63-1',
    confirmedHash: operation.operationHash,
  });
}

test('操作记录：冻结/校验/篡改/状态迁移', () => {
  const op = sealOperation(makeInput());
  assert.equal(verifyOperation(op).ok, true);
  assert.equal(op.state, 'frozen');
  assert.equal(op.bodyHash.length, 64);
  assert.equal(op.operationHash.length, 64);
  assert.equal(op.attachmentHashes[0].sha256.length, 64);

  assert.equal(verifyOperation({ ...op, body: '被改' }).ok, false);
  assert.equal(verifyOperation({ ...op, recipient: 'evil@example.com' }).ok, false);
  assert.equal(verifyOperation({ ...op, attachmentHashes: [] }).ok, false);
  assert.equal(verifyOperation({ ...op, operationHash: '0'.repeat(64) }).ok, false);

  const confirmed = transition(op, 'confirmed');
  assert.equal(confirmed.state, 'confirmed');
  assert.equal(verifyOperation(confirmed).ok, true, '状态变化不影响 operationHash');
  assert.throws(() => transition(op, 'executed'), /非法状态迁移/);
  assert.throws(() => transition(confirmed, 'frozen'), /非法状态迁移/);
});

test('SQLite：冻结记录不可覆盖，事件链可校验', () => {
  const store = new OperationStore(':memory:');
  const op = sealOperation(makeInput());
  const saved = store.insertOperation(op);
  assert.equal(saved.operationHash, op.operationHash);
  assert.throws(() => store.insertOperation(op), /UNIQUE|PRIMARY|constraint/i);
  assert.throws(() => store.enqueueOutbox(op), /confirmed/);

  const confirmed = store.setOperationState(op.operationId, 'confirmed', { confirmationId: 'c1' });
  const outbox1 = store.enqueueOutbox(confirmed);
  const outbox2 = store.enqueueOutbox(confirmed);
  assert.equal(outbox1.outboxId, outbox2.outboxId, '同一 operationHash 只入队一次');
  assert.equal(store.listOutbox().length, 1);
  assert.equal(store.verifyEvents(), true);

  store.db.prepare('UPDATE events SET detail = ? WHERE seq = 1').run('{"tampered":true}');
  assert.equal(store.verifyEvents(), false);
  store.close();
});

test('闭环：确认哈希必须匹配，发送成功 → executed', async () => {
  const mailer = new FakeMailer();
  const { store, service } = newService(mailer);
  const operation = service.prepare(makeInput());
  assert.throws(() => service.confirm(operation.operationId, {
    confirmedHash: '0'.repeat(64),
  }), /确认哈希/);

  const { outbox } = service.confirm(operation.operationId, {
    confirmationId: 'c1', deviceId: 'ws63-1', confirmedHash: operation.operationHash,
  });
  assert.equal(outbox.state, 'pending');
  assert.equal(store.getOperation(operation.operationId).state, 'confirmed');

  const result = await service.send(outbox.outboxId);
  assert.equal(result.state, 'sent');
  assert.equal(result.messageId, 'fake-message-1-1');
  assert.equal(store.getOutbox(outbox.outboxId).state, 'sent');
  assert.equal(store.getOperation(operation.operationId).state, 'executed');
  assert.equal(mailer.calls.length, 1);

  const again = await service.send(outbox.outboxId);
  assert.equal(again.state, 'sent');
  assert.equal(again.duplicate, true);
  assert.equal(mailer.calls.length, 1, '已发送不重复调用');
  assert.equal(store.verifyEvents(), true);
  store.close();
});

test('执行前重校验：确认后改正文 → 拒绝发送', async () => {
  const mailer = new FakeMailer();
  const { store, service } = newService(mailer);
  const operation = service.prepare(makeInput());
  const { outbox } = service.confirm(operation.operationId, { confirmedHash: operation.operationHash });

  store.db.prepare('UPDATE operations SET body = ? WHERE operation_id = ?').run('被篡改的正文', operation.operationId);
  const result = await service.send(outbox.outboxId);
  assert.equal(result.state, 'failed');
  assert.match(result.error, /正文已变化|校验失败/);
  assert.equal(mailer.calls.length, 0, '校验失败不得调用邮件服务');
  assert.equal(store.getOutbox(outbox.outboxId).state, 'failed');
  store.close();
});

test('超时但可能已接收：unknown，禁止自动重试；人工核对后 executed', async () => {
  const mailer = new FakeMailer({ behavior: 'accepted-then-timeout' });
  const { store, service } = newService(mailer);
  const operation = service.prepare(makeInput());
  const { outbox } = service.confirm(operation.operationId, { confirmedHash: operation.operationHash });

  const first = await service.send(outbox.outboxId);
  assert.equal(first.state, 'unknown');
  assert.equal(mailer.calls.length, 1);
  assert.equal(mailer.delivered.length, 1, '模拟服务端已接收');

  const second = await service.send(outbox.outboxId);
  assert.equal(second.state, 'unknown');
  assert.equal(mailer.calls.length, 1, 'unknown 不得自动重试');

  const reconciled = service.reconcile(outbox.outboxId, { state: 'sent', messageId: 'provider-1' });
  assert.equal(reconciled.state, 'sent');
  assert.equal(store.getOperation(operation.operationId).state, 'executed');
  store.close();
});

test('明确拒绝：failed，不自动重试；同一记录不能复用', async () => {
  const mailer = new FakeMailer({ behavior: 'rejected' });
  const { store, service } = newService(mailer);
  const operation = service.prepare(makeInput());
  const { outbox } = service.confirm(operation.operationId, { confirmedHash: operation.operationHash });

  const result = await service.send(outbox.outboxId);
  assert.equal(result.state, 'failed');
  assert.equal(store.getOperation(operation.operationId).state, 'failed');
  const again = await service.send(outbox.outboxId);
  assert.equal(again.state, 'failed');
  assert.equal(mailer.calls.length, 1);

  assert.throws(() => store.setOutboxState(outbox.outboxId, 'pending'), /非法发送状态迁移/);
  store.close();
});

test('过期：确认阶段拒绝并标记 expired', () => {
  const fixedNow = Date.parse('2026-01-01T00:10:00.000Z');
  const { store, service } = newService(new FakeMailer(), { now: () => fixedNow });
  const operation = service.prepare(makeInput({
    createdAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-01T00:05:00.000Z',
  }));
  assert.throws(() => service.confirm(operation.operationId, {
    confirmedHash: operation.operationHash,
  }), /过期/);
  assert.equal(store.getOperation(operation.operationId).state, 'expired');
  store.close();
});

test('进程中断：sending → unknown，恢复后不自动发送', async () => {
  const mailer = new FakeMailer();
  const { store, service } = newService(mailer);
  const operation = service.prepare(makeInput());
  const { outbox } = service.confirm(operation.operationId, { confirmedHash: operation.operationHash });
  store.setOutboxState(outbox.outboxId, 'sending', { incrementAttempts: true });
  store.setOperationState(operation.operationId, 'executing');

  assert.equal(service.recoverInFlight(), 1);
  assert.equal(store.getOutbox(outbox.outboxId).state, 'unknown');
  const result = await service.send(outbox.outboxId);
  assert.equal(result.state, 'unknown');
  assert.equal(mailer.calls.length, 0, '恢复流程不得自动发送');
  store.close();
});

test('HttpMailer：成功 / 4xx 明确失败 / 5xx 结果未知 / 超时', async (t) => {
  const operations = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      operations.push({ headers: req.headers, body });
      if (req.url === '/ok') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'msg-1' }));
      } else if (req.url === '/bad') {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('bad recipient');
      } else if (req.url === '/err') {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('server error');
      } else if (req.url === '/slow') {
        setTimeout(() => {
          try { res.writeHead(200); res.end('{}'); } catch { /* client aborted */ }
        }, 200);
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const operation = {
    operationId: 'op-http', recipient: 'a@example.com', subject: 's', body: 'hello', attachments: [],
  };
  try {
    const ok = new HttpMailer({ endpoint: `${base}/ok`, timeoutMs: 1000 });
    const sent = await ok.send({ operation, idempotencyKey: 'key-1' });
    assert.equal(sent.messageId, 'msg-1');
    assert.equal(operations[0].headers['idempotency-key'], 'key-1');

    const bad = new HttpMailer({ endpoint: `${base}/bad`, timeoutMs: 1000 });
    await assert.rejects(() => bad.send({ operation, idempotencyKey: 'key-2' }), (err) => {
      assert.equal(err.kind, 'rejected');
      return true;
    });

    const err = new HttpMailer({ endpoint: `${base}/err`, timeoutMs: 1000 });
    await assert.rejects(() => err.send({ operation, idempotencyKey: 'key-3' }), (e) => {
      assert.equal(e.kind, 'unknown');
      return true;
    });

    const slow = new HttpMailer({ endpoint: `${base}/slow`, timeoutMs: 50 });
    await assert.rejects(() => slow.send({ operation, idempotencyKey: 'key-4' }), (e) => {
      assert.equal(e.kind, 'timeout');
      return true;
    });
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});
