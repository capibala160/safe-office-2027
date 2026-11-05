'use strict';
// ============================================================
// 多幕演示连跑（M4 演示收口，docs/67）
//   一条命令跑完「软件多幕 → 设备执行 → 真板确认五幕」，全程抓串口原始输出：
//     幕1 软件多幕：node demo.cjs（攻防演示，可 --skip-software 跳过）
//     幕2 设备执行：确认后驱动 IO13 LED（亮/灭），ACK 绑定本次 nonce
//     幕3 打开 COM 口并开始全程监听（此后所有板端输出入库，用于"是否重启"判定）
//     幕4 批准：短按 KEY2          → decision=1
//     幕5 取消：长按 KEY2 ≥600ms   → decision=0（DECISION）
//     幕6 超时：不按键             → TIMEOUT，板端 pending 到期自清
//     幕7 篡改：MAC 末字节翻转      → board rejected: MAC
//     幕8 重放：过期后重发同一帧    → board rejected: REPLAY
//
//   结束：扫描整段串口文本里的启动标志（M3 SFC1 ready / Enter board confirm /
//   Create KeyTask / SFC1 KEY: / SFC1 NV: restored）——出现即视为本次连跑中重启。
//
// 用法：
//   node scripts/demo-runthrough.cjs --port COM11 [--device ws63-A]
//        [--skip-software] [--skip-hardware] [--out-dir out/demo-runthrough]
//
// 退出码：0 全过；1 有失败；2 参数错误。
// 边界：设备执行幕在打开监听端口之前完成（执行器要独占串口），所以"无重启"证据
//       覆盖的是幕3–幕8；取消/批准需要人在板上按键。
// ============================================================
const { spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { openSerialPort, SerialTransport } = require('../src/serial-transport.cjs');
const { NearfieldConfirmer, NearfieldError } = require('../src/nearfield-confirm.cjs');
const { sealOperation } = require('../src/operation.cjs');
const { resolveDeviceKey } = require('../src/device-keys.cjs');
const { createSerialActuator } = require('../src/device-actuator.cjs');
const { encodeChallenge } = require('../src/ws63-protocol.cjs');
const { VERSION } = require('../src/console-service.cjs');

const BOOT_MARKERS = [
  'Enter board confirm (M3)!',
  'M3 SFC1 ready:',
  'Create KeyTask is OK!',
  'SFC1 KEY: provisioned',
  'SFC1 KEY: DEMO',
  'SFC1 NV: restored',
  'SFC1 NV: empty replay window',
];
const PRESS_TIMEOUT_MS = 60000;

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
function flag(name) {
  return process.argv.slice(2).includes(`--${name}`);
}

const line = (s = '') => console.log(s);
function banner(title) {
  line();
  line('═'.repeat(72));
  line(`  ${title}`);
  line('═'.repeat(72));
}
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// 迟到的决定帧（上一幕的按键）会以 TASK/NONCE 不匹配出现：清掉本地 pending 重试，
// 不把它算作本幕失败，也不让它污染下一幕。
async function requestResilient(confirmer, operation, { retries = 4 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await confirmer.requestApproval(operation, { finalOperation: operation });
    } catch (err) {
      const stale = err instanceof NearfieldError && (err.code === 'TASK' || err.code === 'NONCE');
      if (stale && attempt <= retries) {
        confirmer.cancel();
        console.log(`  （忽略迟到的决定帧：${err.code}，重试 ${attempt}/${retries}）`);
        await sleep(150);
        continue;
      }
      throw err;
    }
  }
}

function makeOperation(tag, { action = 'sendExternalEmail', protocolAction = 1, ttlSec = 60 } = {}) {
  const now = Date.now();
  return sealOperation({
    taskId: `RUNTHROUGH-${now}-${tag}`,
    action,
    protocolAction,
    tool: action,
    recipient: 'partner@example.com',
    subject: `多幕连跑 ${tag}`,
    body: `多幕演示连跑（${tag}）`,
    attachments: [],
    sourceDocIds: [],
    level: '内部',
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + Math.max(600, ttlSec * 2) * 1000).toISOString(),
    modelId: 'runthrough',
    planHash: `plan-${now}-${tag}`,
  });
}

function buildChallenge({ key, ttlSec, summary }) {
  const nonce = randomBytes(16);
  const issuedAt = Math.floor(Date.now() / 1000);
  return {
    frame: encodeChallenge({
      taskId: randomBytes(8),
      nonce,
      action: 1,
      operationHash: randomBytes(32),
      issuedAt,
      expiresAt: issuedAt + ttlSec,
      summary,
    }, key),
  };
}

(async () => {
  const portPath = arg('port', '');
  const deviceLabel = arg('device', 'ws63-A');
  if (!portPath) {
    console.error('用法：node scripts/demo-runthrough.cjs --port COM11 [--device ws63-A] [--skip-software] [--skip-hardware]');
    process.exitCode = 2;
    return;
  }
  const skipSoftware = flag('skip-software');
  const skipHardware = flag('skip-hardware');
  const skipPress = flag('skip-press');
  const outRoot = path.resolve(__dirname, '..', arg('out-dir', path.join('out', 'demo-runthrough')));
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  const outDir = path.join(outRoot, stamp);
  fs.mkdirSync(outDir, { recursive: true });

  const startedAt = new Date();
  const scenes = [];
  const logLines = [];
  /** @type {{chunks: Buffer[], text: string} | null} */
  let capture = null;
  const log = (s = '') => { line(s); logLines.push(s); };
  const sceneBanner = (t) => { banner(t); logLines.push('', '═'.repeat(72), `  ${t}`, '═'.repeat(72)); };

  async function runScene(name, fn, { optional = false } = {}) {
    const t0 = Date.now();
    log('');
    log(`▶ ${name}`);
    try {
      const detail = await fn();
      const ms = Date.now() - t0;
      scenes.push({ name, ok: true, detail: detail || '', ms });
      log(`  ✔ PASS  ${name}（${(ms / 1000).toFixed(1)}s）${detail ? ` · ${detail}` : ''}`);
      return true;
    } catch (err) {
      const ms = Date.now() - t0;
      const message = err && err.message ? err.message : String(err);
      scenes.push({ name, ok: false, detail: message, ms, optional });
      log(`  ✘ FAIL  ${name}（${(ms / 1000).toFixed(1)}s）· ${message}`);
      return false;
    }
  }

  if (process.stdout.isTTY) process.stdout.write(']0;SFO-DEMO');
  log(`安全智慧办公 · 多幕演示连跑（v${VERSION}）`);
  log(`时间：${startedAt.toISOString()}`);
  log(`串口：${portPath} · 设备：${deviceLabel}`);
  log(`产物：${outDir}`);

  const { key, source } = resolveDeviceKey({ label: deviceLabel });
  log(`密钥来源：${source}`);

  // ---------- 幕1：软件多幕 ----------
  if (!skipSoftware) {
    sceneBanner('幕1 · 软件多幕（攻防演示 demo.cjs）');
    const t0 = Date.now();
    const result = spawnSync(process.execPath, ['demo.cjs'], {
      cwd: path.resolve(__dirname, '..'),
      stdio: 'inherit',
    });
    const ok = result.status === 0;
    scenes.push({ name: '软件多幕 demo.cjs', ok, detail: `exit=${result.status}`, ms: Date.now() - t0 });
    log(ok ? '  ✔ PASS  软件多幕' : `  ✘ FAIL  软件多幕（exit ${result.status}）`);
  } else {
    log('（跳过软件多幕：--skip-software）');
  }

  // ---------- 幕2：设备执行（独占串口，早于监听） ----------
  if (!skipHardware) {
    sceneBanner('幕2 · 设备执行：IO13 LED 亮 / 灭');
    await runScene('设备执行：unlock → LED 亮', async () => {
      const actuator = createSerialActuator({ portPath, key, timeoutMs: 5000 });
      const ack = await actuator.actuate({ device: deviceLabel, op: 'unlock' });
      if (ack.pin !== 13 || ack.level !== 1) throw new Error(`ACK 不符：pin=${ack.pin} level=${ack.level}`);
      return `pin=${ack.pin} level=${ack.level}`;
    });
    await runScene('设备执行：lock → LED 灭', async () => {
      const actuator = createSerialActuator({ portPath, key, timeoutMs: 5000 });
      const ack = await actuator.actuate({ device: deviceLabel, op: 'lock' });
      if (ack.pin !== 13 || ack.level !== 0) throw new Error(`ACK 不符：pin=${ack.pin} level=${ack.level}`);
      return `pin=${ack.pin} level=${ack.level}`;
    });
  }

  if (skipHardware) {
    log('（跳过硬件幕：--skip-hardware）');
    await finish();
    return;
  }

  // ---------- 打开串口，开始全程监听 ----------
  const port = await openSerialPort({ path: portPath, baudRate: 115200 });
  capture = { chunks: [], text: '' };
  port.on('data', (chunk) => {
    capture.chunks.push(Buffer.from(chunk));
    capture.text += chunk.toString('utf8');
  });

  let markOffset = 0;
  function mark() { markOffset = capture.text.length; }
  async function waitForText(marker, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const index = capture.text.indexOf(marker, markOffset);
      if (index !== -1) return true;
      await sleep(50);
    }
    return false;
  }

  const closePort = () => new Promise((resolve) => {
    try {
      if (typeof port.close === 'function') port.close(() => resolve());
      else resolve();
    } catch { resolve(); }
  });

  try {
    sceneBanner('幕3 · 真板确认多幕（全程监听已开启）');
    log('  串口监听已开启：板端任何启动标志都会被抓到（用于"无重启"判定）');

    // 批准（--skip-press 时跳过，仅用于自动化回归）
    if (!skipPress) {
    mark();
    const okApprove = await runScene('批准：短按 KEY2 → decision=1', async () => {
      process.stdout.write('');
      log(`  请在 ${PRESS_TIMEOUT_MS / 1000} 秒内短按 KEY2（批准）…`);
      const transport = new SerialTransport({ port, timeoutMs: PRESS_TIMEOUT_MS });
      try {
        const confirmer = new NearfieldConfirmer({
          key, expectedDeviceId: deviceLabel, ttlSec: 60, transport,
        });
        const operation = makeOperation('approve');
        const approval = await requestResilient(confirmer, operation);
        if (!approval || approval.decision !== 1) throw new Error('未收到 decision=1');
        return `confirmationId=${String(approval.confirmationId || '').slice(0, 12)}…`;
      } finally {
        transport.close();
      }
    });

    if (!okApprove) await waitForText('SFC1 pending expired', 65000);

    // 取消
    mark();
    const okCancel = await runScene('取消：长按 KEY2 ≥600ms → DECISION', async () => {
      process.stdout.write('');
      log(`  请在 ${PRESS_TIMEOUT_MS / 1000} 秒内长按 KEY2（取消，按住到板端回应再松手）…`);
      const transport = new SerialTransport({ port, timeoutMs: PRESS_TIMEOUT_MS });
      try {
        const confirmer = new NearfieldConfirmer({
          key, expectedDeviceId: deviceLabel, ttlSec: 60, transport,
        });
        const operation = makeOperation('cancel');
        try {
          await requestResilient(confirmer, operation);
        } catch (err) {
          if (err instanceof NearfieldError && err.code === 'DECISION') return '已拒绝（用户取消）';
          throw err;
        }
        throw new Error('预期取消，但收到批准');
      } finally {
        transport.close();
      }
    });
    if (!okCancel) await waitForText('SFC1 pending expired', 65000);
    }

    // 超时
    mark();
    await runScene('超时：不按键 → TIMEOUT，板端自清 pending', async () => {
      log('  请不要按键，等待 6 秒超时…');
      const transport = new SerialTransport({ port, timeoutMs: 6000 });
      try {
        const confirmer = new NearfieldConfirmer({
          key, expectedDeviceId: deviceLabel, ttlSec: 6, transport,
        });
        const operation = makeOperation('timeout');
        try {
          await requestResilient(confirmer, operation, { retries: 2 });
        } catch (err) {
          if (err instanceof NearfieldError && err.code === 'TIMEOUT') {
            await waitForText('SFC1 pending expired', 8000);
            return 'PC 侧超时，等待板端自动过期';
          }
          throw err;
        }
        throw new Error('预期超时，但收到决定');
      } finally {
        transport.close();
      }
    });

    // 篡改
    mark();
    await runScene('篡改：MAC 末字节翻转 → rejected: MAC', async () => {
      const { frame } = buildChallenge({ key, ttlSec: 3, summary: 'RUNTHROUGH-MAC' });
      frame[frame.length - 1] ^= 0x01;
      port.write(frame);
      if (await waitForText('SFC1 challenge rejected: MAC', 5000)) return '板端拒绝：MAC';
      throw new Error('未看到 MAC 拒绝');
    });

    // 重放
    mark();
    await runScene('重放：过期后重发同一帧 → rejected: REPLAY', async () => {
      const { frame } = buildChallenge({ key, ttlSec: 2, summary: 'RUNTHROUGH-REPLAY' });
      port.write(frame);
      if (!await waitForText('SFC1 challenge:', 3000)) throw new Error('挑战未被接受');
      if (!await waitForText('SFC1 pending expired', 8000)) throw new Error('未看到 pending 过期');
      mark();
      port.write(frame);
      if (await waitForText('SFC1 challenge rejected: REPLAY', 5000)) return '板端拒绝：REPLAY';
      throw new Error('未看到 REPLAY 拒绝');
    });
  } finally {
    await closePort();
  }

  await finish();

  async function finish() {
    const finishedAt = new Date();
    const monitored = !!capture;
    const serialText = capture && capture.text ? capture.text : '';
    const bootHits = BOOT_MARKERS.filter((m) => serialText.includes(m));
    const failures = scenes.filter((s) => !s.ok && !s.optional);
    const summary = {
      version: VERSION,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      elapsedMs: finishedAt - startedAt,
      port: portPath,
      device: deviceLabel,
      keySource: source,
      scenes,
      passed: scenes.filter((s) => s.ok).length,
      failed: failures.length,
      monitored,
      serialBytes: capture && capture.chunks ? Buffer.concat(capture.chunks).length : 0,
      restartMarkers: monitored ? bootHits : null,
      rebootDetected: monitored ? bootHits.length > 0 : null,
      artifacts: {
        log: path.join(outDir, 'run.log'),
        serialRaw: capture && capture.chunks ? path.join(outDir, 'serial-raw.bin') : null,
        serialText: capture && capture.chunks ? path.join(outDir, 'serial.txt') : null,
        summary: path.join(outDir, 'summary.json'),
      },
    };
    if (summary.artifacts.serialRaw) {
      fs.writeFileSync(summary.artifacts.serialRaw, Buffer.concat(capture.chunks));
      fs.writeFileSync(summary.artifacts.serialText, serialText);
    }
    fs.writeFileSync(summary.artifacts.log, `${logLines.join('\n')}\n`);
    fs.writeFileSync(summary.artifacts.summary, `${JSON.stringify(summary, null, 2)}\n`);

    banner('多幕连跑结果');
    for (const s of scenes) log(`  ${s.ok ? '✔' : '✘'} ${s.name}（${(s.ms / 1000).toFixed(1)}s）`);
    log('');
    log(`  通过 ${summary.passed} / 失败 ${summary.failed} · 用时 ${(summary.elapsedMs / 1000).toFixed(1)}s`);
    log(`  串口原始字节：${summary.serialBytes}`);
    log(`  重启标志：${!monitored ? '未监听串口（跳过硬件）' : (bootHits.length === 0 ? '未出现（本次连跑无重启证据）' : bootHits.join(' / '))}`);
    log(`  产物：${outDir}`);
    if (failures.length > 0) process.exitCode = 1;
    if (flag('pause')) {
      log('');
      log('演示结束，按回车关闭窗口');
      await new Promise((resolve) => process.stdin.once('data', resolve));
    }
  }
})().catch((err) => {
  console.error('多幕连跑异常：', err && err.message ? err.message : err);
  process.exitCode = 1;
});
