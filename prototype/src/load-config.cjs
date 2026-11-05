'use strict';
// 读取 config.env（KEY=VALUE，# 开头为注释）
// 规则：已存在的环境变量优先，配置文件不覆盖它——命令行临时设置仍然生效
const fs = require('node:fs');

/** @param {string | null | undefined} file @returns {{ loaded: number, file: string | null, error?: string }} */
function loadConfigFile(file) {
  if (!file || !fs.existsSync(file)) return { loaded: 0, file: null };
  let text;
  try {
    text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return { loaded: 0, file: null, error: '读取失败' };
  }
  let loaded = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key] === undefined) {
      process.env[key] = value;
      loaded += 1;
    }
  }
  return { loaded, file };
}

module.exports = { loadConfigFile };
