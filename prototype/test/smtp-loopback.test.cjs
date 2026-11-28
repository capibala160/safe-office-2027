'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const nodemailer = require('nodemailer');
const { BlobStore } = require('../src/blob-store.cjs');
const { ConsoleService } = require('../src/console-service.cjs');
const { SMTPMailer } = require('../src/smtp-mailer.cjs');

async function checkLoopback(t, enterprise, loseReceipt = false) {
  const delivered = [];
  const recipient = 'partner@partner-example.com';
  const sockets = new Set();
  const listener = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    socket.setEncoding('utf8');
    socket.write('220 localhost SMTP\r\n');
    let pending = '';
    let envelope = '';
    let data = null;
    socket.on('data', (chunk) => {
      pending += chunk;
      let boundary;
      while ((boundary = pending.indexOf('\r\n')) !== -1) {
        const line = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        if (data !== null) {
          if (line === '.') {
            delivered.push({ envelope, mime: data.join('\n') });
            data = null;
            if (loseReceipt) socket.destroy();
            else socket.write('250 queued\r\n');
          } else data.push(line);
        } else if (line === 'DATA') {
          data = [];
          socket.write('354 end data with dot\r\n');
        } else if (line === 'QUIT') {
          socket.end('221 goodbye\r\n');
        } else if (/^(?:EHLO |HELO |MAIL FROM:|RCPT TO:)/.test(line)) {
          if (line.startsWith('RCPT TO:')) envelope = line;
          socket.write('250 localhost\r\n');
        } else socket.write('500 unsupported command\r\n');
      }
    });
  });
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  t.after(() => { for (const socket of sockets) socket.destroy(); listener.close(); });
  const transport = nodemailer.createTransport({ host: '127.0.0.1', port: listener.address().port, ignoreTLS: true });
  const blobStore = new BlobStore(':memory:');
  const mailer = new SMTPMailer({ from: 'office@example.test', allowTo: [recipient], transport });
  const reviewer = { actor: 'reviewer', role: '管理员' };
  const dataDir = loseReceipt ? fs.mkdtempSync(path.join(os.tmpdir(), 'safe-office-smtp-')) : null;
  const createService = () => new ConsoleService({ mailer, blobStore, storeFile: dataDir ? path.join(dataDir, 'operations.db') : ':memory:', ...(enterprise ? {
    mailApprover: reviewer.actor,
    mailUserInfo: (username) => ({ role: username === reviewer.actor ? reviewer.role : '员工', disabled: false }),
  } : {}) });
  let service = createService();
  t.after(() => { service.close(); blobStore.close(); transport.close(); if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true }); });
  const sample = service.getDemoSamples().find((entry) => entry.id === 'external-confirm');
  const contentBase64 = Buffer.from('Project meeting agenda').toString('base64');
  const run = await service.runCommand({ ...sample, operator: 'author', attachments: [{ filename: 'agenda.txt', mime: 'text/plain', contentBase64 }] });
  const operation = run.operations[0];
  assert.equal(operation.state, 'frozen');
  assert.equal(delivered.length, 0);
  let result;
  if (enterprise) {
    const approve = () => service.approveEnterpriseMail(operation.operationId, { ...reviewer, operationHash: operation.operationHash });
    service.setEnterpriseMailPause({ ...reviewer, paused: true, reason: '本地停发演练' });
    await assert.rejects(approve, /紧急停发/);
    assert.equal(service.store.getOperation(operation.operationId).state, 'frozen');
    assert.equal(service.store.getOutboxByOperation(operation.operationId), null);
    assert.equal(delivered.length, 0);
    service.setEnterpriseMailPause({ ...reviewer, paused: false, reason: '本地恢复演练' });
    assert.equal(service.store.getOperation(operation.operationId).state, 'frozen');
    assert.equal(delivered.length, 0);
    result = await approve();
    await assert.rejects(approve, /已处理/);
  } else {
    const challenge = service.beginChallenge(operation.operationId, reviewer);
    assert.equal(challenge.targetHash, service.store.getOperation(operation.operationId).operationHash);
    result = await service.decideChallenge(challenge.challengeId, 'approve', reviewer);
  }
  assert.equal(result.operation.state, loseReceipt ? 'executing' : 'executed');
  assert.equal(result.send.state, loseReceipt ? 'unknown' : 'sent');
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].envelope, `RCPT TO:<${recipient}>`);
  assert.match(delivered[0].mime, /Message-ID: <[^>]+>/i);
  const headers = delivered[0].mime.split('\n\n', 1)[0].replace(/\n[ \t]+/g, ' ');
  assert.match(headers, /^X-Idempotency-Key: [a-f0-9]{64}$/im);
  assert.match(delivered[0].mime, /filename=agenda\.txt/i);
  assert.ok(delivered[0].mime.includes(contentBase64));
  if (loseReceipt) {
    const pause = service.setEnterpriseMailPause({ ...reviewer, paused: true, reason: '回执待核对，重启演练' });
    service.close();
    service = createService();
    assert.deepEqual(service.enterpriseMailPause(), pause);
    const outbox = service.store.getOutboxByOperation(operation.operationId);
    assert.equal(outbox.state, 'unknown');
    assert.equal(service.store.getOperation(operation.operationId).state, 'executing');
    assert.equal(delivered.length, 1);
    const messageId = delivered[0].mime.match(/^Message-ID: (<[^>]+>)/im)[1];
    const evidence = { state: 'sent', messageId, note: '本地收信端确认已收录完整邮件' };
    assert.throws(() => service.reconcileOutbox(outbox.outboxId, { ...evidence, actor: 'author', role: '员工' }), /管理员或审计员/);
    assert.throws(() => service.reconcileOutbox(outbox.outboxId, { ...reviewer, ...evidence, messageId: 'manual-fake' }), /真实邮件追踪编号/);
    assert.equal(service.store.getOutboxByOperation(operation.operationId).state, 'unknown');
    const checked = service.reconcileOutbox(outbox.outboxId, { ...reviewer, ...evidence });
    assert.equal(checked.outbox.state, 'sent');
    assert.equal(checked.outbox.messageId, messageId);
    assert.equal(checked.operation.state, 'executed');
    assert.throws(() => service.reconcileOutbox(outbox.outboxId, { ...reviewer, ...evidence }), /只有结果未知/);
    assert.equal(delivered.length, 1);
  }
}

test('外发闭环：审批前无 SMTP 投递，批准后本机接收端收到完整 MIME 附件', { timeout: 10000 }, (t) => checkLoopback(t, false));
test('企业 SMTP：停发和恢复均不投递，重新批准后只投递一次', { timeout: 10000 }, (t) => checkLoopback(t, true));
test('企业 SMTP：回执丢失后重启保留停发和未知状态，核对不触发重发', { timeout: 10000 }, (t) => checkLoopback(t, true, true));
