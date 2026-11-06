'use strict';
// eFuse 客户预留区只读探测（WS63，docs/60 阶段 B）
//
// 板端固件收到一行 `efuse` 后，只调用读接口打印 16B 客户预留区。
// 本脚本负责发送命令、抓串口输出并解析结果；不包含任何写 eFuse 的能力。
//
// 用法：
//   node scripts/efuse-probe.cjs --port COM11
//   node scripts/efuse-probe.cjs --port COM11 --seconds 8 --watch
//
// 退出码：0 收到完整探测块；3 串口无任何数据；4 有数据但没有完整探测块；1 参数/打开失败。

const { openSerialPort } = require('../src/serial-transport.cjs');

const START_MARK = '=== EFUSE PROBE (READ-ONLY) ===';
const END_MARK = '=== END EFUSE PROBE ===';
const DEFAULT_SECONDS = 6;

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

// 可打印 ASCII 原样，换行保留，其余转 \xNN（与 serial-probe 一致）
function renderPreview(buf, max = 4096) {
  const slice = Buffer.from(buf).subarray(0, max);
  let out = '';
  for (const byte of slice) {
    if (byte === 0x0a) out += '\n';
    else if (byte === 0x0d) continue;
    else if (byte >= 0x20 && byte <= 0x7e) out += String.fromCharCode(byte);
    else out += `\\x${byte.toString(16).padStart(2, '0')}`;
  }
  return out;
}

// 解析板端探测块；缺字段时返回 null，不猜测
function parseProbeBlock(input) {
  const text = Buffer.isBuffer(input) ? input.toString('latin1') : String(input ?? '');
  const start = text.indexOf(START_MARK);
  if (start < 0) return { found: false, complete: false };
  const end = text.indexOf(END_MARK, start);
  const complete = end >= 0;
  const body = text.slice(start, complete ? end + END_MARK.length : text.length);
  const directLine = (body.match(/^direct_hex:([^\r\n]*)$/m) || [])[1];
  let hex = null;
  if (directLine !== undefined) {
    const parts = directLine.trim().split(/\s+/);
    if (parts.length === 16 && parts.every((part) => /^[0-9a-f]{2}$/i.test(part))) {
      hex = parts.map((part) => Number.parseInt(part, 16));
    }
  }
  const ones = (body.match(/ones=(\d+)/) || [])[1];
  const allZero = /all_zero=(yes|no)/.exec(body);
  const match = /match=(yes|no)/.exec(body);
  return {
    found: true,
    complete,
    body,
    hex,
    ones: ones === undefined ? null : Number(ones),
    allZero: allZero ? allZero[1] === 'yes' : null,
    match: match ? match[1] === 'yes' : null,
  };
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

async function main() {
  const portPath = arg('port', '');
  const baudRate = Number(arg('baud', '115200'));
  const seconds = Number(arg('seconds', String(DEFAULT_SECONDS)));
  const command = arg('cmd', 'efuse');
  const watch = process.argv.includes('--watch');

  if (!portPath) {
    console.error('用法: node scripts/efuse-probe.cjs --port COM11 [--baud 115200] [--seconds 6] [--watch]');
    process.exit(1);
  }
  if (!Number.isInteger(baudRate) || baudRate <= 0) {
    console.error('--baud 必须是正整数');
    process.exit(1);
  }
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 120) {
    console.error('--seconds 必须在 (0, 120] 内');
    process.exit(1);
  }

  let port;
  let capture = Buffer.alloc(0);
  let bytes = 0;
  try {
    port = await openSerialPort({ path: portPath, baudRate });
    port.on('data', (chunk) => {
      const buf = Buffer.from(chunk);
      bytes += buf.length;
      capture = Buffer.concat([capture, buf]);
      if (watch) process.stdout.write(renderPreview(buf));
    });
    port.on('error', (err) => {
      console.error(`串口错误: ${err instanceof Error ? err.message : String(err)}`);
    });

    await sleep(300);
    const deadline = Date.now() + seconds * 1000;
    const payload = Buffer.from(`${command}\r\n`);
    let nextSend = Date.now();
    let sends = 0;
    while (Date.now() < deadline) {
      // 板子可能还在启动：最多重发 3 次，避免命令早于 UART 就绪而丢失
      if (Date.now() >= nextSend && sends < 3) {
        port.write(payload);
        sends += 1;
        nextSend = Date.now() + 1000;
      }
      if (parseProbeBlock(capture).complete) break;
      await sleep(100);
    }
  } finally {
    await closePort(port);
  }

  const result = parseProbeBlock(capture);
  if (result.found) {
    console.log(result.body);
  } else {
    console.log('--- 串口原始输出 ---');
    console.log(renderPreview(capture) || '(无数据)');
    console.log('--------------------');
  }

  if (result.complete) {
    console.log(`[efuse-probe] 完整探测块已收到（${bytes} 字节）`);
    console.log(`[efuse-probe] all_zero=${result.allZero} ones=${result.ones} match=${result.match}`);
    process.exit(0);
  }
  if (bytes === 0) {
    console.error('[efuse-probe] 串口 0 字节：检查 COM 号/接线，或先复位板子看启动日志');
    process.exit(3);
  }
  console.error('[efuse-probe] 有数据但没有完整探测块：确认固件已烧录且包含 efuse CLI');
  process.exit(4);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[efuse-probe] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}

module.exports = {
  arg,
  renderPreview,
  parseProbeBlock,
};
