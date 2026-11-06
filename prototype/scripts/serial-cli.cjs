'use strict';
// 通用串口 CLI 发送/抓取（WS63 维护命令用，不做业务帧解析）。
//
// 用法：
//   node scripts/serial-cli.cjs --port COM11 --cmd "kek-status"
//   node scripts/serial-cli.cjs --port COM11 --cmd "kek-burn" --seconds 30 --watch
//
// 安全边界：本工具只负责发一行命令和抓串口输出；写 eFuse 的命令在板端
// 还必须再长按 KEY2 确认，本工具不能单独触发写入。
//
// 退出码：0 收到数据；3 串口 0 字节；1 参数/打开失败。

const { openSerialPort } = require('../src/serial-transport.cjs');

const DEFAULT_SECONDS = 5;

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

function renderPreview(buf, max = 8192) {
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
  const command = arg('cmd', '');
  const baudRate = Number(arg('baud', '115200'));
  const seconds = Number(arg('seconds', String(DEFAULT_SECONDS)));
  const repeat = Number(arg('repeat', '1'));
  const watch = process.argv.includes('--watch');

  if (!portPath || !command) {
    console.error('用法: node scripts/serial-cli.cjs --port COM11 --cmd "kek-status" [--seconds 5] [--repeat 1] [--watch]');
    process.exit(1);
  }
  if (!Number.isInteger(baudRate) || baudRate <= 0) {
    console.error('--baud 必须是正整数');
    process.exit(1);
  }
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 300) {
    console.error('--seconds 必须在 (0, 300] 内');
    process.exit(1);
  }
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 3) {
    console.error('--repeat 必须在 1..3 内');
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
    const payload = Buffer.from(`${command}\r\n`);
    for (let i = 0; i < repeat; i += 1) {
      port.write(payload);
      if (i + 1 < repeat) await sleep(1000);
    }
    await sleep(seconds * 1000);
  } finally {
    await closePort(port);
  }

  if (!watch) {
    console.log(`--- 串口输出（${command}） ---`);
    console.log(renderPreview(capture) || '(无数据)');
    console.log('---');
  }
  if (bytes === 0) {
    console.error('[serial-cli] 串口 0 字节：检查 COM 号/接线/固件');
    process.exit(3);
  }
  console.log(`[serial-cli] 收到 ${bytes} 字节`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[serial-cli] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}

module.exports = {
  arg,
  renderPreview,
};
