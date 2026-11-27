'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { once } = require('node:events');
const nodemailer = require('nodemailer');
const { BlobStore } = require('../src/blob-store.cjs');
const { ConsoleService } = require('../src/console-service.cjs');
const { SMTPMailer } = require('../src/smtp-mailer.cjs');

test('外发闭环：审批前无 SMTP 投递，批准后本机接收端收到完整 MIME 附件', { timeout: 10000 }, async (t) => {
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
            socket.write('250 queued\r\n');
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
  const service = new ConsoleService({ mailer, blobStore });
  t.after(() => { service.close(); blobStore.close(); transport.close(); });
  const sample = service.getDemoSamples().find((entry) => entry.id === 'external-confirm');
  const contentBase64 = Buffer.from('Project meeting agenda').toString('base64');
  const run = await service.runCommand({ ...sample, attachments: [{ filename: 'agenda.txt', mime: 'text/plain', contentBase64 }] });
  const operation = run.operations[0];
  assert.equal(operation.state, 'frozen');
  const challenge = service.beginChallenge(operation.operationId);
  assert.equal(challenge.targetHash, service.store.getOperation(operation.operationId).operationHash);
  assert.equal(delivered.length, 0);
  const result = await service.decideChallenge(challenge.challengeId, 'approve');
  assert.equal(result.operation.state, 'executed');
  assert.equal(result.send.state, 'sent');
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].envelope, `RCPT TO:<${recipient}>`);
  assert.match(delivered[0].mime, /Message-ID: <[^>]+>/i);
  const headers = delivered[0].mime.split('\n\n', 1)[0].replace(/\n[ \t]+/g, ' ');
  assert.match(headers, /^X-Idempotency-Key: [a-f0-9]{64}$/im);
  assert.match(delivered[0].mime, /filename=agenda\.txt/i);
  assert.ok(delivered[0].mime.includes(contentBase64));
});
