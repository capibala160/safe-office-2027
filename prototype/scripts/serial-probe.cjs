'use strict';
// 串口探测与回环自检（WS63 硬件排障工具，判定流程见 docs/58）。
//
// 三种用法：
//   1) --list      列出串口，确认 CH340 与 COM 号（不打开端口）
//   2) 监听模式    在若干波特率下各监听 N 秒，统计收到的字节数并给出预览
//   3) --loopback  在 SW1=1 + 底部排针 UTX↔URX 短接时验证 USB 转串口链路
//   4) --watch     监听期间实时打印收到的数据（配合手动复位/断电重上电抓启动日志）
//
// 用法：
//   node scripts/serial-probe.cjs --list
//   node scripts/serial-probe.cjs --port COM12 --baud 115200,921600,74880 --seconds 8
//   node scripts/serial-probe.cjs --port COM12 --baud 115200 --seconds 120 --watch
//   node scripts/serial-probe.cjs --port COM12 --loopback
//   node scripts/serial-probe.cjs --port COM12 --loopback --pattern "PING-1234" --timeout 3000
//
// 退出码：0 有数据 / 回环通过；3 全 0 字节；4 回环失败；1 参数错或打开失败。
// serialport 是可选依赖：未安装时给出明确提示，不影响核心功能。

const { openSerialPort } = require('../src/serial-transport.cjs');

const PREVIEW_BYTES = 512;
const CAPTURE_BYTES = 8192;
const MARKERS = [
  'boot.',
  'flash init',
  'flashboot',
  'app|',
  'cpu 0 entering scheduler',
  'enter board confirm',
  'm3 sfc1',
];

// 同时支持 --port COM11 与 --port=COM11 两种写法
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

// "115200,921600" -> [115200, 921600]，去重并校验范围
function parseBaudList(value) {
  const text = String(value ?? '').trim();
  if (text === '') throw new Error('--baud 不能为空');
  const out = [];
  const seen = new Set();
  for (const part of text.split(',')) {
    const token = part.trim();
    if (!token) continue;
    const baud = Number(token);
    if (!Number.isInteger(baud) || baud <= 0 || baud > 4_000_000) {
      throw new Error(`非法波特率：${token}`);
    }
    if (!seen.has(baud)) {
      seen.add(baud);
      out.push(baud);
    }
  }
  if (out.length === 0) throw new Error('--baud 至少要有一个波特率');
  return out;
}

// 把字节渲染成可读文本：可打印 ASCII 原样，换行保留，其余转 \xNN
function renderPreview(buf, max = PREVIEW_BYTES) {
  const slice = Buffer.from(buf).subarray(0, max);
  let out = '';
  for (const byte of slice) {
    if (byte === 0x0a) out += '\n';
    else if (byte === 0x0d) continue;
    else if (byte === 0x09) out += '\\t';
    else if (byte >= 0x20 && byte <= 0x7e) out += String.fromCharCode(byte);
    else out += `\\x${byte.toString(16).padStart(2, '0')}`;
  }
  return out;
}

// 在捕获到的字节里找已知启动标志，判断"到底有没有在启动"
function findMarkers(buf) {
  const text = Buffer.from(buf).toString('latin1').toLowerCase();
  return MARKERS.filter((marker) => text.includes(marker));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadSerialPort() {
  try {
    return require('serialport').SerialPort;
  } catch {
    throw new Error('serialport 未安装：在 prototype 下执行 npm install serialport');
  }
}

// serialport 的 close 既可能回调也可能返回 Promise，这里统一吞掉重复关闭
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

async function listPorts() {
  const SerialPort = loadSerialPort();
  return SerialPort.list();
}

async function listenAt(portPath, baudRate, seconds, previewBytes = PREVIEW_BYTES, onChunk = null, onOpen = null) {
  const port = await openSerialPort({ path: portPath, baudRate });
  if (typeof onOpen === 'function') onOpen();
  let capture = Buffer.alloc(0);
  let bytes = 0;
  let error = null;
  const onData = (chunk) => {
    const buf = Buffer.from(chunk);
    bytes += buf.length;
    const room = CAPTURE_BYTES - capture.length;
    if (room > 0) capture = Buffer.concat([capture, buf.subarray(0, room)]);
    if (typeof onChunk === 'function') onChunk(buf);
  };
  const onError = (err) => {
    error = err instanceof Error ? err : new Error(String(err));
  };
  port.on('data', onData);
  port.on('error', onError);
  try {
    await sleep(seconds * 1000);
  } finally {
    port.removeListener('data', onData);
    port.removeListener('error', onError);
    await closePort(port);
  }
  return {
    baudRate,
    bytes,
    preview: renderPreview(capture, previewBytes),
    markers: findMarkers(capture),
    error: error ? error.message : null,
  };
}

// 发一串字节，等它原样回来。SW1=1 时 USB 直连 UTX/URX，短接排针即可自证链路。
async function loopbackAt(portPath, baudRate, pattern, timeoutMs) {
  const payload = Buffer.from(String(pattern), 'utf8');
  const port = await openSerialPort({ path: portPath, baudRate });
  const started = Date.now();
  let received = Buffer.alloc(0);
  let matchedAt = null;
  let error = null;
  const onData = (chunk) => {
    const buf = Buffer.from(chunk);
    received = Buffer.concat([received.subarray(-4096), buf]);
    if (matchedAt === null && received.includes(payload)) matchedAt = Date.now();
  };
  const onError = (err) => {
    error = err instanceof Error ? err : new Error(String(err));
  };
  port.on('data', onData);
  port.on('error', onError);
  try {
    await new Promise((resolve) => port.write(payload, () => resolve()));
    const deadline = started + timeoutMs;
    while (matchedAt === null && !error && Date.now() < deadline) {
      await sleep(20);
    }
  } finally {
    port.removeListener('data', onData);
    port.removeListener('error', onError);
    await closePort(port);
  }
  return {
    baudRate,
    ok: matchedAt !== null,
    rttMs: matchedAt === null ? null : matchedAt - started,
    sentBytes: payload.length,
    receivedBytes: received.length,
    preview: renderPreview(received, 256),
    error: error ? error.message : null,
  };
}

function indentPreview(text) {
  if (text === '') return '    (无数据)';
  return text
    .split('\n')
    .map((line) => `    | ${line}`)
    .join('\n');
}

function printPorts(ports, asJson) {
  if (asJson) {
    console.log(JSON.stringify({ ports }, null, 2));
    return;
  }
  if (ports.length === 0) {
    console.log('没有发现串口：检查 USB 线（必须是数据线）、S1 是否打开、CH340 驱动是否安装。');
    return;
  }
  console.log(`发现 ${ports.length} 个串口：`);
  for (const port of ports) {
    const vid = [port.vendorId, port.productId].filter(Boolean).join(':') || '-';
    console.log(`  ${port.path.padEnd(10)} manufacturer=${port.manufacturer || '-'} vid:pid=${vid} sn=${port.serialNumber || '-'}`);
  }
}

function describeOpenError(err) {
  const message = err instanceof Error ? err.message : String(err);
  if (/access denied|cannot lock|busy|resource busy/i.test(message)) {
    return `${message}\n串口被占用：先关掉 hsflash / HiSpark Studio / 串口助手，或拔掉重插。`;
  }
  if (/file not found|no such file|enoent/i.test(message)) {
    return `${message}\n端口不存在：先用 --list 确认 COM 号（每次插拔都可能变）。`;
  }
  return message;
}

async function main() {
  const asJson = process.argv.includes('--json');

  if (process.argv.includes('--list')) {
    printPorts(await listPorts(), asJson);
    return 0;
  }

  const portPath = String(arg('port', '')).trim();
  if (portPath === '') {
    console.error('缺少 --port。先跑 `node scripts/serial-probe.cjs --list` 看 COM 号。');
    return 1;
  }

  const bauds = parseBaudList(arg('baud', '115200'));

  if (process.argv.includes('--loopback')) {
    const pattern = String(arg('pattern', `SFC1-LOOPBACK-${Date.now()}`));
    const timeoutMs = Number(arg('timeout', 3000));
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
      throw new Error('--timeout 必须在 1~60000 毫秒之间');
    }
    const results = [];
    for (const baud of bauds) {
      try {
        results.push(await loopbackAt(portPath, baud, pattern, timeoutMs));
      } catch (err) {
        results.push({
          baudRate: baud,
          ok: false,
          rttMs: null,
          sentBytes: 0,
          receivedBytes: 0,
          preview: '',
          error: describeOpenError(err),
        });
      }
    }
    if (asJson) {
      console.log(JSON.stringify({ mode: 'loopback', port: portPath, pattern, results }, null, 2));
    } else {
      console.log(`回环自检 ${portPath}（SW1=1，UTX↔URX 已短接）`);
      for (const r of results) {
        console.log(`  ${String(r.baudRate).padEnd(7)} ${r.ok ? `通过 rtt=${r.rttMs}ms` : '失败'} 收 ${r.receivedBytes}B${r.error ? ` 错误 ${r.error}` : ''}`);
        if (!r.ok) console.log(indentPreview(r.preview));
      }
      if (!results.every((r) => r.ok)) {
        console.log('回环失败：确认 SW1 在 1、UTX↔URX 短接线没松、端口没被占用；换线/换 USB 口再试。');
      }
    }
    return results.every((r) => r.ok) ? 0 : 4;
  }

  const seconds = Number(arg('seconds', 8));
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 300) {
    throw new Error('--seconds 必须在 1~300 秒之间');
  }

  const watch = process.argv.includes('--watch');
  const results = [];
  for (const baud of bauds) {
    try {
      const started = Date.now();
      const onChunk = watch
        ? (buf) => {
            const stamp = ((Date.now() - started) / 1000).toFixed(1);
            console.log(`[+${stamp}s @${baud}] ${buf.length}B`);
            console.log(indentPreview(renderPreview(buf, 256)));
          }
        : null;
      const onOpen = watch
        ? () => console.log(`[打开] ${portPath} @${baud}，监听 ${seconds}s（现在可以复位/断电重上电）`)
        : null;
      results.push(await listenAt(portPath, baud, seconds, PREVIEW_BYTES, onChunk, onOpen));
    } catch (err) {
      results.push({
        baudRate: baud,
        bytes: 0,
        preview: '',
        markers: [],
        error: describeOpenError(err),
      });
    }
  }
  const total = results.reduce((sum, r) => sum + r.bytes, 0);

  if (asJson) {
    console.log(JSON.stringify({ mode: 'listen', port: portPath, seconds, totalBytes: total, results }, null, 2));
  } else {
    console.log(`监听 ${portPath}，每个波特率 ${seconds}s`);
    for (const r of results) {
      const marker = r.markers.length > 0 ? ` 标志=${r.markers.join(',')}` : '';
      console.log(`  ${String(r.baudRate).padEnd(7)} ${String(r.bytes).padStart(6)}B${marker}${r.error ? ` 错误 ${r.error}` : ''}`);
      if (r.bytes > 0) console.log(indentPreview(r.preview));
    }
    if (total === 0) {
      console.log('0 字节不等于坏了：固件可能只在启动瞬间打印。保持监听（加 --watch）再按 KEY1 或断电重上电；仍无输出再看电源灯 LED3，判定见 docs/58 §1。');
    }
  }
  return total > 0 ? 0 : 3;
}

if (require.main === module) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(describeOpenError(err));
      process.exitCode = 1;
    });
}

module.exports = {
  parseBaudList,
  renderPreview,
  findMarkers,
  listenAt,
  loopbackAt,
  MARKERS,
};
