'use strict';
// ASR 连通性验证：node scripts/asr-probe.cjs --file 录音.wav
// 读取 config.env；未配置时明确提示。只发一次 HTTP 请求，不写操作库。
const path = require('node:path');
const { loadConfigFile } = require('../src/load-config.cjs');
const { createAsrFromEnv } = require('../src/asr.cjs');

function getArg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : '';
}

loadConfigFile(path.join(__dirname, '..', 'config.env'));

const file = getArg('--file');
if (!file) {
  console.error('用法：node scripts/asr-probe.cjs --file <音频.wav|mp3|m4a>');
  process.exit(2);
}

let asr;
try {
  asr = createAsrFromEnv(process.env);
} catch (err) {
  console.error(`配置错误：${err.message}`);
  process.exit(2);
}
if (!asr) {
  console.error('未开启：在 config.env 设 SAFE_OFFICE_ASR=1，并填 TENCENT_ASR_SECRET_ID / TENCENT_ASR_SECRET_KEY');
  process.exit(2);
}

asr.transcribeFile(path.resolve(file))
  .then((result) => {
    console.log(JSON.stringify({
      ok: true,
      text: result.text,
      requestId: result.requestId,
      engine: result.engine,
      format: result.format,
      bytes: result.bytes,
    }, null, 2));
  })
  .catch((err) => {
    console.error(JSON.stringify({ ok: false, code: err.code || null, message: err.message }));
    process.exit(1);
  });
