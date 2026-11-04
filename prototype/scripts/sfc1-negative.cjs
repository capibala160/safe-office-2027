'use strict';
// SFC1 板端负向测试（M3 异常项验收，见 docs/57 §6.5）。
//
// 与 serial-confirm.cjs 的区别：这里直接构造 SFC1 帧发给板子，用来触发板端的拒绝分支。
// 关键技巧：挑战帧自己指定 2~3 秒 TTL，板端到期会消费 nonce 并清 pending，
// 所以全程不需要按 KEY2，也不会把板子占住 600 秒。
//
// 用法（先关掉 serial-confirm / 串口助手）：
//   node scripts/sfc1-negative.cjs --port COM11 --demo-key --case mac
//   node scripts/sfc1-negative.cjs --port COM11 --demo-key --case busy
//   node scripts/sfc1-negative.cjs --port COM11 --demo-key --case expire
//   node scripts/sfc1-negative.cjs --port COM11 --demo-key --case replay
//   node scripts/sfc1-negative.cjs --port COM11 --demo-key --case persist-arm
//   node scripts/sfc1-negative.cjs --port COM11 --demo-key --case persist-check   # 断电重上电之后
//   node scripts/sfc1-negative.cjs --port COM11 --demo-key --case all --json
//   node scripts/sfc1-negative.cjs --port COM11 --demo-key --case all --wait-free 60
//
// 开工前会先发一个 1 秒 TTL 的探针帧确认板子空闲；若板上有未决确认（BUSY），
// 默认直接报错让你按键/断电清除，也可以用 --wait-free <秒> 等它自己过期。
//
// 退出码：0 全部断言通过；1 有失败（含板端 BUSY）；2 参数错误。
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openSerialPort } = require('../src/serial-transport.cjs');
const { encodeChallenge } = require('../src/ws63-protocol.cjs');

const { DEMO_KEY, resolveDeviceKey } = require('../src/device-keys.cjs');
const CASES = ['mac', 'busy', 'expire', 'replay', 'persist-arm', 'persist-check'];
const ALL_CASES = ['mac', 'busy', 'replay'];
const ACCEPT_MARK = 'SFC1 challenge:';
const EXPIRE_MARK = 'SFC1 pending expired';
const REJECT_PREFIX = 'SFC1 challenge rejected:';

function arg(name, fallback) {
  const argv = process.argv.slice(2);
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  if (index !== -1 && index + 1 < argv.length && !argv[index + 1].startsWith('--')) {
    return argv[index + 1];
  }
  return fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 只翻 MAC 的最后一个字节：帧头/负载都不动，确保命中的是 MAC 分支
function tamperMac(frameBytes) {
  const out = Buffer.from(frameBytes);
  out[out.length - 1] ^= 0x01;
  return out;
}

// 构造一个短 TTL 的挑战帧（ttlSec 直接进 expires_at - issued_at）
function buildChallenge({ ttlSec, summary = 'NEG-TEST', action = 1, key }) {
  const nonce = randomBytes(16);
  const issuedAt = Math.floor(Date.now() / 1000);
  return {
    nonce,
    frame: encodeChallenge({
      taskId: randomBytes(8),
      nonce,
      action,
      operationHash: randomBytes(32),
      issuedAt,
      expiresAt: issuedAt + ttlSec,
      summary,
    }, key),
  };
}

// 钥匙来源：--demo-key（仅非生产）> --key > SAFE_OFFICE_SFC1_KEY > 设备表（--device 标签）
function loadKey(values) {
  return resolveDeviceKey({
    label: values.device,
    production: process.env.SAFE_OFFICE_PRODUCTION === '1',
    demoKey: values.demoKey,
    keyHex: values.key || '',
  });
}

// 收串口文本并在其中找标志
function createCapture(port) {
  let text = '';
  const onData = (chunk) => {
    text += Buffer.from(chunk).toString('latin1');
    if (text.length > 65536) text = text.slice(-32768);
  };
  port.on('data', onData);
  return {
    text: () => text,
    clear: () => { text = ''; },
    stop: () => port.removeListener('data', onData),
  };
}

async function waitFor(capture, marker, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (capture.text().includes(marker)) return true;
    await sleep(20);
  }
  return false;
}

function send(port, buf) {
  return new Promise((resolve) => port.write(buf, () => resolve()));
}

function assert(ok, name, detail) {
  return { name, ok, detail };
}

function tail(capture) {
  return capture.text().slice(-80).replace(/\s+/g, ' ');
}

async function caseMac(port, capture, key) {
  const { frame } = buildChallenge({ ttlSec: 3, key });
  capture.clear();
  await send(port, tamperMac(frame));
  const ok = await waitFor(capture, `${REJECT_PREFIX} MAC`, 3000);
  return [assert(ok, 'MAC：篡改 MAC 被拒', ok ? '收到 rejected: MAC' : `未收到，串口尾部=${tail(capture)}`)];
}

async function caseBusy(port, capture, key) {
  const { frame } = buildChallenge({ ttlSec: 3, summary: 'BUSY-TEST', key });
  capture.clear();
  await send(port, frame);
  const accepted = await waitFor(capture, ACCEPT_MARK, 3000);
  await send(port, frame);
  const busy = await waitFor(capture, `${REJECT_PREFIX} BUSY`, 3000);
  // 等它自己过期，别把 pending 留给后面的用例
  const expired = await waitFor(capture, EXPIRE_MARK, 8000);
  return [
    assert(accepted, 'BUSY：第一帧被接受', accepted ? '收到 challenge' : '未收到 challenge'),
    assert(busy, 'BUSY：未决期间第二帧被拒', busy ? '收到 rejected: BUSY' : `未收到，尾部=${tail(capture)}`),
    assert(expired, 'BUSY：到期自动清 pending', expired ? '收到 pending expired' : '未收到 expired'),
  ];
}

async function caseExpire(port, capture, key, withReplay) {
  const { frame } = buildChallenge({ ttlSec: 2, summary: withReplay ? 'REPLAY-TEST' : 'TTL-TEST', key });
  capture.clear();
  await send(port, frame);
  const accepted = await waitFor(capture, ACCEPT_MARK, 3000);
  const expired = await waitFor(capture, EXPIRE_MARK, 8000);
  const results = [
    assert(accepted, 'EXPIRE：挑战被接受', accepted ? '收到 challenge' : '未收到 challenge'),
    assert(expired, 'EXPIRE：短 TTL 到期自动清理', expired ? '收到 pending expired' : `未收到，尾部=${tail(capture)}`),
  ];
  if (withReplay) {
    // 过期已消费 nonce，重发同一帧应命中 REPLAY
    await send(port, frame);
    const replay = await waitFor(capture, `${REJECT_PREFIX} REPLAY`, 3000);
    results.push(assert(replay, 'REPLAY：过期后重发同一帧被拒', replay ? '收到 rejected: REPLAY' : `未收到，尾部=${tail(capture)}`));
  }
  return results;
}

// 开工前确认板子空闲：发一个 1 秒 TTL 的探针帧。
// 被接受 ⇒ 空闲（探针会把 pending 占 1 秒，等它过期再开始）；返回 BUSY ⇒ 有未决确认。
async function ensureFree(port, capture, key, waitSec) {
  const deadline = Date.now() + waitSec * 1000;
  for (;;) {
    const { frame } = buildChallenge({ ttlSec: 1, summary: 'PROBE', key });
    capture.clear();
    await send(port, frame);
    if (await waitFor(capture, ACCEPT_MARK, 2000)) {
      await waitFor(capture, EXPIRE_MARK, 4000);
      return true;
    }
    if (capture.text().includes(`${REJECT_PREFIX} BUSY`)) {
      if (Date.now() >= deadline) return false;
      await sleep(2000);
      continue;
    }
    return false;
  }
}

// M1 掉电保存：先让一个 nonce 过期（板端消费并落 NV），保存原始帧；
// 断电重上电后用 persist-check 重发同一帧，应命中 REPLAY。
async function casePersistArm(port, capture, key, frameFile) {
  const { frame } = buildChallenge({ ttlSec: 2, summary: 'PERSIST', key });
  fs.writeFileSync(frameFile, frame);
  capture.clear();
  await send(port, frame);
  const accepted = await waitFor(capture, ACCEPT_MARK, 3000);
  const expired = await waitFor(capture, EXPIRE_MARK, 8000);
  await sleep(800); // 给 NV 写留出时间
  return [
    assert(accepted, 'ARM：挑战被接受', accepted ? '收到 challenge' : '未收到 challenge'),
    assert(expired, 'ARM：2s 后过期并落 NV', expired ? '收到 pending expired' : `未收到，尾部=${tail(capture)}`),
    assert(true, 'ARM：帧已保存', `${frameFile}（请断电重上电后跑 --case persist-check）`),
  ];
}

async function casePersistCheck(port, capture, frameFile) {
  if (!fs.existsSync(frameFile)) {
    return [assert(false, 'CHECK：找不到帧文件', `${frameFile} 不存在，先跑 --case persist-arm`)];
  }
  const frame = fs.readFileSync(frameFile);
  capture.clear();
  await send(port, frame);
  // 通过 = 先看到 REPLAY；失败 = 又被接受（说明 NV 没恢复）
  const deadline = Date.now() + 5000;
  let replay = false;
  let accepted = false;
  while (Date.now() < deadline) {
    if (capture.text().includes(`${REJECT_PREFIX} REPLAY`)) { replay = true; break; }
    if (capture.text().includes(ACCEPT_MARK)) { accepted = true; break; }
    await sleep(20);
  }
  return [
    assert(replay, 'CHECK：重启后旧 nonce 被拒（NV 生效）',
      replay ? '收到 rejected: REPLAY' : accepted ? '又被接受了 → NV 未恢复' : `无响应，尾部=${tail(capture)}`),
  ];
}

async function runCase(name, port, capture, key, frameFile) {
  if (name === 'mac') return caseMac(port, capture, key);
  if (name === 'busy') return caseBusy(port, capture, key);
  if (name === 'expire') return caseExpire(port, capture, key, false);
  if (name === 'persist-arm') return casePersistArm(port, capture, key, frameFile);
  if (name === 'persist-check') return casePersistCheck(port, capture, frameFile);
  return caseExpire(port, capture, key, true);
}

async function main() {
  const asJson = process.argv.includes('--json');
  const portPath = String(arg('port', '')).trim();
  const caseName = String(arg('case', 'all')).trim();
  if (!portPath) throw Object.assign(new Error('缺少 --port（例如 COM11）'), { code: 'ARG' });
  if (caseName !== 'all' && CASES.indexOf(caseName) === -1) {
    throw Object.assign(new Error(`未知 --case：${caseName}（可选 ${CASES.join(' / ')} / all）`), { code: 'ARG' });
  }
  const { key, source } = loadKey({
    device: String(arg('device', 'ws63-A')),
    demoKey: process.argv.includes('--demo-key'),
    key: arg('key', ''),
  });
  const runCases = caseName === 'all' ? ALL_CASES : [caseName];
  const frameFile = String(arg('frame-file', path.join(os.tmpdir(), 'sfc1-persist-frame.bin')));
  const waitFreeSec = Number(arg('wait-free', '0'));
  if (!Number.isFinite(waitFreeSec) || waitFreeSec < 0 || waitFreeSec > 900) {
    throw Object.assign(new Error('--wait-free 必须在 0~900 秒之间'), { code: 'ARG' });
  }

  let port = null;
  try {
    port = await openSerialPort({ path: portPath, baudRate: 115200 });
    const capture = createCapture(port);
    if (!await ensureFree(port, capture, key, waitFreeSec)) {
      capture.stop();
      throw Object.assign(new Error(
        '板端有未决的确认（BUSY）：按一次 KEY2 或拨 S1 断电清除；也可用 --wait-free <秒> 等它自己过期'),
      { code: 'BUSY' });
    }
    const results = [];
    for (const name of runCases) {
      results.push(...await runCase(name, port, capture, key, frameFile));
    }
    capture.stop();
    const failed = results.filter((r) => !r.ok);
    if (asJson) {
      console.log(JSON.stringify({ ok: failed.length === 0, port: portPath, keySource: source, results }, null, 2));
    } else {
      for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  ${r.detail}`);
      console.log(failed.length === 0 ? '全部通过' : `${failed.length} 项失败`);
    }
    return failed.length === 0 ? 0 : 1;
  } finally {
    if (port && port.isOpen !== false) {
      await new Promise((resolve) => {
        try { port.close(() => resolve()); } catch { resolve(); }
        setTimeout(resolve, 1500).unref?.();
      });
    }
  }
}

if (require.main === module) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
      console.error(err && err.message ? err.message : String(err));
      process.exitCode = err && err.code === 'ARG' ? 2 : 1;
    });
}

module.exports = { tamperMac, buildChallenge, DEMO_KEY, CASES, ALL_CASES };
