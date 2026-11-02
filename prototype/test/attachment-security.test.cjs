'use strict';
// 附件安全：类型/魔数白名单、ClamAV required、AES-256-GCM 落盘加密
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { scanAttachment, detectKind } = require('../src/file-scan.cjs');
const { BlobStore } = require('../src/blob-store.cjs');
const { ConsoleService } = require('../src/console-service.cjs');

test('扫描：文本/PDF/ZIP 放行，可执行扩展名与 PE 魔数拒绝', () => {
  const text = Buffer.from('hello');
  assert.equal(scanAttachment(text, { filename: 'a.txt' }).ok, true);
  assert.equal(scanAttachment(Buffer.from('%PDF-1.7 ...'), { filename: 'a.pdf' }).ok, true);
  assert.equal(scanAttachment(Buffer.from([0x50, 0x4b, 3, 4]), { filename: 'a.docx' }).ok, true);

  const exe = scanAttachment(text, { filename: 'evil.exe' });
  assert.equal(exe.ok, false);
  assert.match(exe.reason, /不允许/);

  const pe = scanAttachment(Buffer.from('MZ\x90\x00payload'), { filename: 'fake.pdf' });
  assert.equal(pe.ok, false, '扩展名伪装也要按魔数拒绝');
  assert.match(pe.reason, /可执行/);
  assert.equal(detectKind(Buffer.from('%PDF-1.7')), 'pdf');
});

test('扫描：ClamAV required 但扫描器不可用 → 拒绝', () => {
  const result = scanAttachment(Buffer.from('hello'), {
    filename: 'a.txt', clamavMode: 'required', clamavCmd: 'definitely-not-a-clamav-binary',
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /ClamAV/);
});

test('加密：附件落盘为 AES-256-GCM，明文不出现；错误密钥解不开', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-office-blob-'));
  const file = path.join(dir, 'blobs.db');
  const key = crypto.randomBytes(32);
  const store = new BlobStore(file, { key });
  try {
    const secret = Buffer.from('SECRET-ATTACHMENT-CONTENT');
    const meta = store.put(secret, { name: 'a.txt', mime: 'text/plain' });
    const row = store.db.prepare('SELECT content FROM blobs WHERE sha256 = ?').get(meta.sha256);
    assert.ok(!Buffer.from(row.content).includes('SECRET'), '库里不能有明文');
    assert.equal(store.get(meta.sha256).content.toString(), 'SECRET-ATTACHMENT-CONTENT');

    const wrong = new BlobStore(file, { key: crypto.randomBytes(32) });
    assert.throws(() => wrong.get(meta.sha256), /authenticate|decrypt|Unsupported/i);
    wrong.close();
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('加密标记：未开启加密时，SFE1 开头的普通文件不能被误判为密文', () => {
  const store = new BlobStore(':memory:');
  try {
    const plain = Buffer.from('SFE1 this is just plain text, not encrypted');
    const meta = store.put(plain, { name: 'notes.txt', mime: 'text/plain' });
    const row = store.db.prepare('SELECT encrypted FROM blobs WHERE sha256 = ?').get(meta.sha256);
    assert.equal(Number(row.encrypted), 0);
    const got = store.get(meta.sha256);
    assert.equal(got.content.toString('utf8'), plain.toString('utf8'), '应按明文原样返回');
  } finally {
    store.close();
  }
});

test('加密标记：有 key 上传时 encrypted=1，按标记解密而不是靠魔数猜', () => {
  const store = new BlobStore(':memory:', { key: crypto.randomBytes(32) });
  try {
    const plain = Buffer.from('SFE1-looking plaintext');
    const meta = store.put(plain, { name: 'a.txt', mime: 'text/plain' });
    const row = store.db.prepare('SELECT encrypted, content FROM blobs WHERE sha256 = ?').get(meta.sha256);
    assert.equal(Number(row.encrypted), 1);
    assert.ok(Buffer.from(row.content).subarray(0, 4).equals(Buffer.from('SFE1')));
    assert.equal(store.get(meta.sha256).content.toString('utf8'), plain.toString('utf8'));
  } finally {
    store.close();
  }
});

// 真实 ClamAV：只有本机显式配置了 SAFE_OFFICE_CLAMAV_CMD / _DB 才跑；CI/无扫描器自动跳过
const CLAMAV_CMD = process.env.SAFE_OFFICE_CLAMAV_CMD || '';
const CLAMAV_DB = process.env.SAFE_OFFICE_CLAMAV_DB || '';
const HAS_CLAMAV = !!CLAMAV_CMD && fs.existsSync(CLAMAV_CMD) && !!CLAMAV_DB && fs.existsSync(CLAMAV_DB);

test('扫描：真实 ClamAV 检出 EICAR、放行干净文件（本机有扫描器时）', { skip: !HAS_CLAMAV }, () => {
  const bs = String.fromCharCode(92);
  const eicar = Buffer.from(
    'X5O!P%@AP[4' + bs + 'PZX54(P^)7CC)7}' + '$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!' + '$H+H*',
  );
  const clean = scanAttachment(Buffer.from('hello clean file'), {
    filename: 'a.txt', clamavMode: 'required', clamavCmd: CLAMAV_CMD, clamavDb: CLAMAV_DB,
  });
  assert.equal(clean.ok, true);
  assert.equal(clean.scanned, true, '必须真的扫过，而不是跳过');
  const infected = scanAttachment(eicar, {
    filename: 'a.txt', clamavMode: 'required', clamavCmd: CLAMAV_CMD, clamavDb: CLAMAV_DB,
  });
  assert.equal(infected.ok, false);
  assert.match(infected.reason, /恶意/);
});

test('控制台：附件上传时拒绝 .exe', () => {
  const service = new ConsoleService();
  try {
    assert.throws(
      () => service._parseAttachments([{
        filename: 'evil.exe', mime: 'application/octet-stream',
        contentBase64: Buffer.from('MZ').toString('base64'),
      }]),
      /不允许的附件类型/,
    );
  } finally {
    service.close();
  }
});
