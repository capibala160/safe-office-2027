'use strict';
// M2 双板 SLE 链路验收：同时监听两个串口，按板端日志断言心跳与重连。
//
// 用法：
//   node scripts/sle-link-verify.cjs --a COM11 --b COM12 --seconds 30
//   node scripts/sle-link-verify.cjs --a COM11 --b COM12 --expect-reconnect
//
// 约定：A 烧 exec 镜像（SLE client/执行端），B 烧 confirm 镜像（SLE server/确认端）；
//       端口接反也能通过——脚本按日志里的 role 自动识别。
//
// 验收点：
//   1) 两块板各自打印 "SFC1 LINK: init role=exec|confirm ret=0"
//   2) 两端都出现 "SFC1 LINK: ALIVE peer=..."
//   3) --expect-reconnect 时：至少一端出现 "peer lost" 且之后再次 ALIVE
//
// 退出码：0 通过；3 串口 0 字节；4 断言失败；1 参数/打开失败。

const { openSerialPort } = require('../src/serial-transport.cjs');

const DEFAULT_SECONDS = 30;

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

function closePort(port) {
  return new Promise((resolve) => {
    if (!port) return resolve();
    let settled = false;
    const finish = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    try {
      if (typeof port.close !== 'function' || port.isOpen === false) return finish();
      port.close(finish);
    } catch {
      finish();
    }
    setTimeout(finish, 1500).unref?.();
  });
}

class BoardLog {
  /** @param {string} label @param {{ logger?: (line: string) => void }} [options] */
  constructor(label, { logger = console.log } = {}) {
    this.label = label;
    this.logger = logger;
    this.buffer = '';
    this.bytes = 0;
    this.lines = 0;
    this.init = null; // 'exec' | 'confirm'
    this.alive = 0;
    this.lost = 0;
    this.lastAliveAfterLoss = false;
    this.lostSinceAlive = false;
  }

  /** @param {Buffer} chunk */
  push(chunk) {
    this.bytes += chunk.length;
    this.buffer += chunk.toString('utf8');
    /* 启动日志可能夹带非文本噪声且长时间无换行，限制缓冲避免无限增长 */
    if (this.buffer.length > 65536) {
      this.buffer = this.buffer.slice(-4096);
    }
    for (;;) {
      const index = this.buffer.indexOf('\n');
      if (index < 0) break;
      const line = this.buffer.slice(0, index).replace(/\r$/, '').trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line !== '') this.onLine(line);
    }
  }

  /** @param {string} line */
  onLine(line) {
    this.lines += 1;
    this.logger(`[${this.label}] ${line}`);

    if (/SFC1 LINK: init role=(exec|confirm) ret=0/.test(line)) {
      this.init = line.includes('role=exec') ? 'exec' : 'confirm';
    }
    if (line.includes('SFC1 LINK: ALIVE peer=')) {
      this.alive += 1;
      if (this.lostSinceAlive) this.lastAliveAfterLoss = true;
      this.lostSinceAlive = false;
    }
    if (line.includes('SFC1 LINK: peer lost')) {
      this.lost += 1;
      if (this.alive > 0) this.lostSinceAlive = true;
    }
  }
}

async function main() {
  const portA = arg('a', '');
  const portB = arg('b', '');
  const seconds = Number(arg('seconds', String(DEFAULT_SECONDS)));
  const expectReconnect = process.argv.includes('--expect-reconnect');

  if (!portA || !portB) {
    console.error('用法: node scripts/sle-link-verify.cjs --a COM11 --b COM12 [--seconds 30] [--expect-reconnect]');
    process.exit(1);
  }
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 600) {
    console.error('--seconds 必须是 1–600 的秒数');
    process.exit(1);
  }

  const boards = { a: new BoardLog('A'), b: new BoardLog('B') };
  let ports;
  try {
    const [a, b] = await Promise.all([
      openSerialPort({ path: portA, baudRate: 115200 }),
      openSerialPort({ path: portB, baudRate: 115200 }),
    ]);
    ports = { a, b };
  } catch (error) {
    console.error(`打开串口失败：${error.message}`);
    console.error('提示：serialport 是可选依赖；先 npm install serialport，并确认 COM 号（scripts/serial-probe.cjs --list）');
    process.exit(1);
  }

  const onA = (chunk) => boards.a.push(chunk);
  const onB = (chunk) => boards.b.push(chunk);
  ports.a.on('data', onA);
  ports.b.on('data', onB);

  console.log(`[verify] 监听中：A=${portA} B=${portB}，${seconds}s（请在这段时间内复位/上电两块板）`);
  await sleep(seconds * 1000);

  ports.a.removeListener('data', onA);
  ports.b.removeListener('data', onB);
  await Promise.all([closePort(ports.a), closePort(ports.b)]);

  const failures = [];
  if (boards.a.bytes === 0) failures.push('A 串口 0 字节');
  if (boards.b.bytes === 0) failures.push('B 串口 0 字节');
  if (boards.a.init === null) failures.push('A 未打印 init role=... ret=0');
  if (boards.b.init === null) failures.push('B 未打印 init role=... ret=0');
  if (boards.a.init !== null && boards.a.init === boards.b.init) {
    failures.push(`两块板角色相同（都是 ${boards.a.init}），应一 exec 一 confirm`);
  }
  if (boards.a.alive === 0) failures.push('A 未收到对端心跳（无 ALIVE）');
  if (boards.b.alive === 0) failures.push('B 未收到对端心跳（无 ALIVE）');
  if (expectReconnect) {
    const recovered = boards.a.lastAliveAfterLoss || boards.b.lastAliveAfterLoss;
    const lost = boards.a.lost > 0 || boards.b.lost > 0;
    if (!lost) failures.push('--expect-reconnect：未观察到 peer lost');
    if (!recovered) failures.push('--expect-reconnect：超时后未恢复 ALIVE');
  }

  console.log('[verify] 汇总：');
  for (const key of ['a', 'b']) {
    const board = boards[key];
    console.log(
      `  ${key.toUpperCase()}: role=${board.init ?? '?'} bytes=${board.bytes} lines=${board.lines} ` +
        `alive=${board.alive} lost=${board.lost}`
    );
  }

  if (failures.length > 0) {
    console.error('[verify] FAIL');
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(4);
  }
  console.log('[verify] PASS: 双板心跳与链路状态通过');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[verify] 异常：${error.stack || error.message}`);
    process.exit(1);
  });
}

module.exports = { BoardLog };
