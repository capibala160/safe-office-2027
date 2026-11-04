'use strict';
// CalDAV 写入适配器（docs/61）：mock 服务器覆盖创建/冲突更新/认证/错误/uid 安全。
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createCalDavWriter } = require('../src/caldav-writer.cjs');

const ICS = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:meeting-1', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
const AUTH = `Basic ${Buffer.from('alice:secret').toString('base64')}`;

function startMock() {
  const store = new Map();
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push({
      method: req.method,
      url: req.url,
      auth: req.headers.authorization,
      ifMatch: req.headers['if-match'],
      ifNone: req.headers['if-none-match'],
    });
    // eslint-disable-next-line security/detect-possible-timing-attacks
    if (req.headers.authorization !== AUTH) {
      res.writeHead(401);
      res.end();
      return;
    }
    if (req.method === 'PUT') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const existing = store.get(req.url);
        if (existing && req.headers['if-none-match'] === '*') {
          res.writeHead(412, { ETag: existing.etag });
          res.end();
          return;
        }
        if (existing && req.headers['if-match'] && req.headers['if-match'] !== existing.etag) {
          res.writeHead(412, { ETag: existing.etag });
          res.end();
          return;
        }
        const etag = `"v${store.size + 1}"`;
        store.set(req.url, { body, etag });
        res.writeHead(existing ? 204 : 201, { ETag: etag });
        res.end();
      });
      return;
    }
    if (req.method === 'GET') {
      const item = store.get(req.url);
      if (!item) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { ETag: item.etag, 'Content-Type': 'text/calendar' });
      res.end(item.body);
      return;
    }
    if (req.method === 'DELETE') {
      if (!store.has(req.url)) {
        res.writeHead(404);
        res.end();
        return;
      }
      store.delete(req.url);
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(405);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server, store, calls,
        url: `http://127.0.0.1:${server.address().port}/cal/`,
      });
    });
  });
}

const writerFor = (url) => createCalDavWriter({ url, username: 'alice', password: 'secret' });

test('创建事件：PUT + Basic 认证 + VCALENDAR 正文，返回 201/ETag', async (t) => {
  const mock = await startMock();
  t.after(() => mock.server.close());
  const result = await writerFor(mock.url).putEvent({ uid: 'meeting-1', ics: ICS });
  assert.equal(result.status, 201);
  assert.ok(result.etag);
  const put = mock.calls.find((c) => c.method === 'PUT');
  assert.equal(put.auth, AUTH);
  assert.equal(put.url, '/cal/meeting-1.ics');
  assert.match(mock.store.get('/cal/meeting-1.ics').body, /BEGIN:VCALENDAR/);
});

test('已存在：412 → GET 取 ETag → If-Match 更新（204）', async (t) => {
  const mock = await startMock();
  t.after(() => mock.server.close());
  const writer = writerFor(mock.url);
  await writer.putEvent({ uid: 'meeting-1', ics: ICS });
  const updated = ICS.replace('UID:meeting-1', 'UID:meeting-1\r\nSUMMARY:改期');
  const result = await writer.putEvent({ uid: 'meeting-1', ics: updated });
  assert.equal(result.status, 204);
  const methods = mock.calls.map((c) => c.method);
  assert.deepEqual(methods, ['PUT', 'PUT', 'GET', 'PUT']);
  assert.match(mock.store.get('/cal/meeting-1.ics').body, /SUMMARY:改期/);
});

test('认证失败：401 → 抛 CALDAV_HTTP 且带状态码', async (t) => {
  const mock = await startMock();
  t.after(() => mock.server.close());
  const writer = createCalDavWriter({ url: mock.url, username: 'alice', password: 'wrong' });
  await assert.rejects(
    () => writer.putEvent({ uid: 'meeting-1', ics: ICS }),
    (err) => err.code === 'CALDAV_HTTP' && err.status === 401,
  );
});

test('网络不可达：抛 CALDAV_NETWORK', async () => {
  const writer = createCalDavWriter({
    url: 'http://127.0.0.1:1/cal/', username: 'a', password: 'b', timeoutMs: 1000,
  });
  await assert.rejects(() => writer.putEvent({ uid: 'meeting-1', ics: ICS }), /CalDAV 请求失败/);
});

test('uid 安全：含斜杠/大写之外字符一律拒绝，不发请求', async (t) => {
  const mock = await startMock();
  t.after(() => mock.server.close());
  const writer = writerFor(mock.url);
  await assert.rejects(() => writer.putEvent({ uid: '../etc/passwd', ics: ICS }), /uid/);
  await assert.rejects(() => writer.putEvent({ uid: 'a/b', ics: ICS }), /uid/);
  assert.equal(mock.calls.length, 0);
});

test('body 必须是 VCALENDAR', async (t) => {
  const mock = await startMock();
  t.after(() => mock.server.close());
  const writer = writerFor(mock.url);
  await assert.rejects(() => writer.putEvent({ uid: 'meeting-1', ics: 'not-ics' }), /VCALENDAR/);
});

test('删除：存在 → 204；不存在 → missing=true', async (t) => {
  const mock = await startMock();
  t.after(() => mock.server.close());
  const writer = writerFor(mock.url);
  await writer.putEvent({ uid: 'meeting-1', ics: ICS });
  const first = await writer.deleteEvent('meeting-1');
  assert.equal(first.ok, true);
  assert.equal(first.missing, false);
  const second = await writer.deleteEvent('meeting-1');
  assert.equal(second.missing, true);
});

test('配置校验：URL 协议/用户名/密码', () => {
  assert.throws(() => createCalDavWriter({ url: 'ftp://x', username: 'a', password: 'b' }), /http/);
  assert.throws(() => createCalDavWriter({ url: 'http://x', username: '', password: 'b' }), /用户名/);
  assert.throws(() => createCalDavWriter({ url: 'http://x', username: 'a', password: '' }), /密码/);
});
