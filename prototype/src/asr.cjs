'use strict';
// ============================================================
// 录音转写（腾讯云一句话识别，2026-11-04）
//   - 只做「≤60 秒、wav/mp3/m4a、≤5MB」的短音频识别；
//   - 音频会发给腾讯云 ASR（音频出端），调用方必须显式开启并写审计；
//   - 返回文本按不可信输入处理（调用方走闸1 注入隔离后在入知识库）。
// 签名：TC3-HMAC-SHA256（腾讯云 API 3.0），只依赖 node:crypto。
// 边界：不证明说话人身份，不做长音频/实时流；混元实时 ASR 不在此模块。
// ============================================================
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const HOST = 'asr.tencentcloudapi.com';
const SERVICE = 'asr';
const VERSION = '2019-06-14';
const ACTION = 'SentenceRecognition';
const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_FORMATS = new Set(['wav', 'mp3', 'm4a']);

/** @param {Buffer | string} data @returns {string} */
function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** @param {Buffer | string} key @param {Buffer | string} data @returns {Buffer} */
function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

// TC3-HMAC-SHA256 签名；返回 Authorization 头
/**
 * @param {{ secretId: string, secretKey: string, payload: string, timestamp: number, host?: string, service?: string }} params
 * @returns {string}
 */
function signTc3({ secretId, secretKey, payload, timestamp, host = HOST, service = SERVICE }) {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${host}\n`;
  const signedHeaders = 'content-type;host';
  const canonicalRequest = [
    'POST', '/', '', canonicalHeaders, signedHeaders, sha256Hex(payload),
  ].join('\n');
  const credentialScope = `${date}/${service}/tc3_request`;
  const stringToSign = ['TC3-HMAC-SHA256', String(timestamp), credentialScope, sha256Hex(canonicalRequest)].join('\n');
  const secretDate = hmac(`TC3${secretKey}`, date);
  const secretService = hmac(secretDate, service);
  const secretSigning = hmac(secretService, 'tc3_request');
  const signature = crypto.createHmac('sha256', secretSigning).update(stringToSign).digest('hex');
  return `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

/** @param {string} filePath @returns {string} */
function detectFormat(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase().replace('.', '');
  if (!ALLOWED_FORMATS.has(ext)) {
    throw new TypeError(`不支持的音频格式：.${ext || '(无扩展名)'}（只收 wav/mp3/m4a）`);
  }
  return ext;
}

/** @param {string} format @param {Buffer} buffer */
function assertMagic(format, buffer) {
  const head = buffer.subarray(0, 12);
  if (format === 'wav' && !(head.subarray(0, 4).toString('ascii') === 'RIFF' && head.subarray(8, 12).toString('ascii') === 'WAVE')) {
    throw new TypeError('文件内容不是 WAV（缺 RIFF/WAVE 头）');
  }
  if (format === 'mp3') {
    const id3 = head.subarray(0, 3).toString('ascii') === 'ID3';
    const frame = head[0] === 0xFF && (head[1] & 0xE0) === 0xE0;
    if (!id3 && !frame) throw new TypeError('文件内容不是 MP3（缺 ID3/帧同步头）');
  }
  if (format === 'm4a' && head.subarray(4, 8).toString('ascii') !== 'ftyp') {
    throw new TypeError('文件内容不是 M4A（缺 ftyp）');
  }
}

/** @param {{ format: string, data: string, engine?: string }} params @returns {string} */
function buildPayload({ format, data, engine = '16k_zh' }) {
  return JSON.stringify({
    EngSerViceType: engine,
    SourceType: 1,
    VoiceFormat: format,
    Data: data,
    DataLen: Buffer.from(data, 'base64').length,
  });
}

/**
 * @param {{ secretId?: string, secretKey?: string, region?: string, engine?: string, fetchImpl?: typeof fetch, now?: () => number }} [options]
 */
function createTencentAsr({
  secretId,
  secretKey,
  region = 'ap-guangzhou',
  engine = '16k_zh',
  fetchImpl = globalThis.fetch,
  now = () => Math.floor(Date.now() / 1000),
} = {}) {
  if (!secretId || !secretKey) throw new TypeError('腾讯云 ASR 需要 SecretId 和 SecretKey');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl 必须是函数');

  /** @param {Buffer} buffer @param {string} format */
  async function transcribeBuffer(buffer, format) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new TypeError('音频内容为空');
    if (buffer.length > MAX_BYTES) throw new TypeError(`音频超过 5MB（${buffer.length} 字节）`);
    assertMagic(format, buffer);
    const payload = buildPayload({ format, data: buffer.toString('base64'), engine });
    const timestamp = now();
    const authorization = signTc3({ secretId: String(secretId), secretKey: String(secretKey), payload, timestamp });
    let response;
    try {
      response = await fetchImpl(`https://${HOST}`, {
        method: 'POST',
        headers: {
          Authorization: authorization,
          'Content-Type': 'application/json; charset=utf-8',
          Host: HOST,
          'X-TC-Action': ACTION,
          'X-TC-Timestamp': String(timestamp),
          'X-TC-Version': VERSION,
          'X-TC-Region': region,
        },
        body: payload,
        signal: AbortSignal.timeout(30000),
      });
    } catch (err) {
      const e = /** @type {{ message?: string }} */ (err);
      const error = /** @type {any} */ (new Error(`腾讯云 ASR 请求失败：${e && e.message ? e.message : err}`));
      error.code = 'ASR_NETWORK';
      throw error;
    }
    const text = await response.text();
    /** @type {any} */
    let body;
    try { body = JSON.parse(text); } catch {
      const error = /** @type {any} */ (new Error(`腾讯云 ASR 返回非 JSON（HTTP ${response.status}）`));
      error.code = 'ASR_BAD_RESPONSE';
      throw error;
    }
    const data = body && body.Response ? body.Response : {};
    if (data.Error) {
      const error = /** @type {any} */ (new Error(`腾讯云 ASR 失败：${data.Error.Code || ''} ${data.Error.Message || ''}`.trim()));
      error.code = data.Error.Code || 'ASR_ERROR';
      throw error;
    }
    if (typeof data.Result !== 'string') {
      const error = /** @type {any} */ (new Error('腾讯云 ASR 返回缺少 Result'));
      error.code = 'ASR_BAD_RESPONSE';
      throw error;
    }
    return {
      text: data.Result,
      requestId: data.RequestId || null,
      engine,
      format,
      bytes: buffer.length,
    };
  }

  /** @param {string} filePath */
  async function transcribeFile(filePath) {
    const format = detectFormat(filePath);
    const buffer = fs.readFileSync(filePath);
    return { ...(await transcribeBuffer(buffer, format)), file: path.basename(filePath) };
  }

  return { transcribeFile, transcribeBuffer };
}

// 环境变量 → 客户端；未开启返回 null（保持模拟）
/** @param {Record<string, string | undefined>} [env] */
function createAsrFromEnv(env = process.env) {
  if (!/^(1|true|yes|on)$/i.test(String(env.SAFE_OFFICE_ASR || ''))) return null;
  const provider = String(env.SAFE_OFFICE_ASR_PROVIDER || 'tencent').toLowerCase();
  if (provider !== 'tencent') throw new Error(`不支持的 ASR 提供方：${provider}`);
  const secretId = String(env.TENCENT_ASR_SECRET_ID || '').trim();
  const secretKey = String(env.TENCENT_ASR_SECRET_KEY || '').trim();
  if (!secretId || !secretKey) {
    throw new Error('SAFE_OFFICE_ASR=1 但缺少 TENCENT_ASR_SECRET_ID / TENCENT_ASR_SECRET_KEY');
  }
  return createTencentAsr({
    secretId,
    secretKey,
    region: String(env.TENCENT_ASR_REGION || 'ap-guangzhou'),
    engine: String(env.TENCENT_ASR_ENGINE || '16k_zh'),
  });
}

module.exports = {
  createTencentAsr,
  createAsrFromEnv,
  signTc3,
  buildPayload,
  detectFormat,
  assertMagic,
  MAX_BYTES,
  ALLOWED_FORMATS,
  HOST,
  SERVICE,
  VERSION,
  ACTION,
};
