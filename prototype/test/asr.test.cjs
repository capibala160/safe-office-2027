'use strict';
// 录音转写适配器测试（腾讯云一句话识别）
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createTencentAsr, createAsrFromEnv, signTc3, buildPayload, detectFormat, assertMagic, MAX_BYTES,
} = require('../src/asr.cjs');

const wavBuffer = Buffer.concat([
  Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(20),
]);
const mp3Buffer = Buffer.concat([Buffer.from([0xFF, 0xFB, 0x90, 0x64]), Buffer.alloc(32)]);
const m4aBuffer = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypM4A '), Buffer.alloc(16)]);

test('ASR：格式与魔数校验', () => {
  assert.equal(detectFormat('a.wav'), 'wav');
  assert.equal(detectFormat('a.MP3'), 'mp3');
  assert.throws(() => detectFormat('a.txt'), /不支持的音频格式/);
  assert.doesNotThrow(() => assertMagic('wav', wavBuffer));
  assert.throws(() => assertMagic('wav', mp3Buffer), /不是 WAV/);
  assert.doesNotThrow(() => assertMagic('mp3', mp3Buffer));
  assert.throws(() => assertMagic('mp3', wavBuffer), /不是 MP3/);
  assert.doesNotThrow(() => assertMagic('m4a', m4aBuffer));
});

test('ASR：TC3 签名结构稳定（同输入同签名）', () => {
  const input = {
    secretId: 'AKIDEXAMPLE', secretKey: 'secret', payload: '{"A":1}', timestamp: 1793798400,
  };
  const a = signTc3(input);
  const b = signTc3(input);
  assert.equal(a, b);
  assert.match(a, /^TC3-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{4}-\d{2}-\d{2}\/asr\/tc3_request, SignedHeaders=content-type;host, Signature=[0-9a-f]{64}$/);
  assert.notEqual(a, signTc3({ ...input, payload: '{"A":2}' }));
});

test('ASR：载荷包含引擎、格式与 DataLen', () => {
  const payload = JSON.parse(buildPayload({ format: 'wav', data: Buffer.from('abcd').toString('base64') }));
  assert.equal(payload.EngSerViceType, '16k_zh');
  assert.equal(payload.VoiceFormat, 'wav');
  assert.equal(payload.SourceType, 1);
  assert.equal(payload.DataLen, 4);
});

test('ASR：缺密钥 / 超 5MB / 非法格式被拒', async () => {
  assert.throws(() => createTencentAsr({ secretId: '', secretKey: '' }), /需要 SecretId/);
  const asr = createTencentAsr({ secretId: 'ak', secretKey: 'sk', fetchImpl: async () => ({ ok: true }) });
  await assert.rejects(asr.transcribeBuffer(Buffer.alloc(MAX_BYTES + 1), 'wav'), /超过 5MB/);
  await assert.rejects(asr.transcribeBuffer(Buffer.alloc(0), 'wav'), /音频内容为空/);
  await assert.rejects(asr.transcribeBuffer(Buffer.from('notaudio'), 'wav'), /不是 WAV/);
});

test('ASR：请求头/请求体正确，解析 Result', async () => {
  let captured;
  const asr = createTencentAsr({
    secretId: 'ak', secretKey: 'sk', region: 'ap-shanghai', engine: '16k_zh',
    now: () => 1793798400,
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return {
        status: 200,
        text: async () => JSON.stringify({ Response: { Result: '会议纪要测试', RequestId: 'req-1' } }),
      };
    },
  });
  const result = await asr.transcribeBuffer(wavBuffer, 'wav');
  assert.equal(result.text, '会议纪要测试');
  assert.equal(result.requestId, 'req-1');
  assert.equal(captured.url, 'https://asr.tencentcloudapi.com');
  assert.equal(captured.init.headers['X-TC-Action'], 'SentenceRecognition');
  assert.equal(captured.init.headers['X-TC-Version'], '2019-06-14');
  assert.equal(captured.init.headers['X-TC-Region'], 'ap-shanghai');
  assert.match(captured.init.headers.Authorization, /^TC3-HMAC-SHA256 Credential=ak\//);
  const body = JSON.parse(captured.init.body);
  assert.equal(body.EngSerViceType, '16k_zh');
  assert.equal(body.VoiceFormat, 'wav');
  assert.equal(body.DataLen, wavBuffer.length);
});

test('ASR：云侧 Error 映射为异常', async () => {
  const asr = createTencentAsr({
    secretId: 'ak', secretKey: 'sk',
    fetchImpl: async () => ({
      status: 200,
      text: async () => JSON.stringify({ Response: { Error: { Code: 'AuthFailure.SignatureFailure', Message: '签名错误' } } }),
    }),
  });
  await assert.rejects(asr.transcribeBuffer(wavBuffer, 'wav'), /AuthFailure\.SignatureFailure/);
});

test('ASR：环境变量开关（默认关闭）', () => {
  assert.equal(createAsrFromEnv({}), null);
  assert.throws(() => createAsrFromEnv({ SAFE_OFFICE_ASR: '1' }), /缺少 TENCENT_ASR_SECRET_ID/);
  const asr = createAsrFromEnv({
    SAFE_OFFICE_ASR: '1', TENCENT_ASR_SECRET_ID: 'ak', TENCENT_ASR_SECRET_KEY: 'sk',
  });
  assert.ok(asr);
});
