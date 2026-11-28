'use strict';
// 企业试点隔离演示用的本地 SMTP 收件端：只接收、落盘、不转发。
// 用法：node server.cjs（容器内 /sink/server.cjs），监听 0.0.0.0:2525。
// 邮件保存为 /sink/mail/<时间戳>-<序号>.eml；日志写 stdout。
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.SMTP_SINK_PORT || 2525);
const DIR = process.env.SMTP_SINK_DIR || '/sink/mail';
fs.mkdirSync(DIR, { recursive: true });
let seq = 0;

net.createServer((socket) => {
  let dataMode = false;
  let buf = '';
  let envelope = { from: '', to: [], raw: '' };
  socket.setEncoding('utf8');
  socket.write('220 smtp-sink ESMTP\r\n');
  socket.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      if (dataMode) {
        if (line === '.') {
          dataMode = false;
          seq += 1;
          const file = path.join(DIR, `${Date.now()}-${seq}.eml`);
          fs.writeFileSync(file, envelope.raw);
          console.log(`[smtp-sink] saved ${path.basename(file)} to=${envelope.to.join(',')} bytes=${envelope.raw.length}`);
          socket.write('250 2.0.0 queued\r\n');
          envelope = { from: '', to: [], raw: '' };
        } else {
          envelope.raw += (line.startsWith('..') ? line.slice(1) : line) + '\r\n';
        }
        continue;
      }
      const upper = line.toUpperCase();
      if (upper.startsWith('EHLO') || upper.startsWith('HELO')) socket.write('250-smtp-sink\r\n250 OK\r\n');
      else if (upper.startsWith('MAIL FROM:')) { envelope.from = line.slice(10).trim(); socket.write('250 OK\r\n'); }
      else if (upper.startsWith('RCPT TO:')) { envelope.to.push(line.slice(8).trim()); socket.write('250 OK\r\n'); }
      else if (upper === 'DATA') { dataMode = true; envelope.raw = ''; socket.write('354 End data with <CR><LF>.<CR><LF>\r\n'); }
      else if (upper === 'RSET') { envelope = { from: '', to: [], raw: '' }; socket.write('250 OK\r\n'); }
      else if (upper === 'NOOP') socket.write('250 OK\r\n');
      else if (upper === 'QUIT') { socket.write('221 Bye\r\n'); socket.end(); }
      else socket.write('250 OK\r\n');
    }
  });
  socket.on('error', () => { /* 客户端断开 */ });
}).listen(PORT, '0.0.0.0', () => console.log(`[smtp-sink] listening on :${PORT}, dir=${DIR}`));
