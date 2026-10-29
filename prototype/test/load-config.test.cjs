'use strict';
// config.env 读取：注释/空行/引号；已存在的环境变量优先
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfigFile } = require('../src/load-config.cjs');

const KEYS = ['SAFE_OFFICE_LLM_ENDPOINT', 'SAFE_OFFICE_LLM_KEY', 'SAFE_OFFICE_LLM_MODEL'];

function withCleanEnv(t) {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  t.after(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
}

test('config.env：忽略注释与空行，去掉引号', (t) => {
  withCleanEnv(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-office-cfg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.env');
  fs.writeFileSync(file, [
    '# 这是注释',
    '',
    'SAFE_OFFICE_LLM_ENDPOINT=https://example.test/v1',
    'SAFE_OFFICE_LLM_KEY="quoted-key"',
    "SAFE_OFFICE_LLM_MODEL='quoted-model'",
    '这行没有等号，跳过',
  ].join('\n'), 'utf8');

  const info = loadConfigFile(file);
  assert.equal(info.loaded, 3);
  assert.equal(process.env.SAFE_OFFICE_LLM_ENDPOINT, 'https://example.test/v1');
  assert.equal(process.env.SAFE_OFFICE_LLM_KEY, 'quoted-key');
  assert.equal(process.env.SAFE_OFFICE_LLM_MODEL, 'quoted-model');
});

test('config.env：已存在的环境变量优先，不被文件覆盖', (t) => {
  withCleanEnv(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-office-cfg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.env');
  fs.writeFileSync(file, 'SAFE_OFFICE_LLM_MODEL=from-file\n', 'utf8');

  process.env.SAFE_OFFICE_LLM_MODEL = 'from-shell';
  const info = loadConfigFile(file);
  assert.equal(info.loaded, 0);
  assert.equal(process.env.SAFE_OFFICE_LLM_MODEL, 'from-shell');
});

test('config.env：文件不存在不报错', () => {
  const info = loadConfigFile(path.join(os.tmpdir(), 'definitely-missing-config.env'));
  assert.equal(info.loaded, 0);
  assert.equal(info.file, null);
});
