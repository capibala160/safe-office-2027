'use strict';
// ============================================================
// 演示前自检（v0.47）
//   目标：答辩/演示前一次性确认环境，而不是现场逐个踩坑。
//   - 只读：不启动服务、不写数据、不主动访问外网；端口探测只连本机
//   - CLI 与 HTTP 共用同一套检查项：CLI 看静态配置，HTTP 额外看运行中的 service
//   - 状态：ok / warn / fail；warn = 能演示但有边界，fail = 会直接影响演示
// ============================================================
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { findEdge } = require('./print-adapter.cjs');
const { findClamav } = require('./file-scan.cjs');

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const STATUS = { OK: 'ok', WARN: 'warn', FAIL: 'fail' };

/** @param {string} id @param {string} label @param {string} status @param {unknown} detail @returns {{ id: string, label: string, status: string, detail: string }} */
function check(id, label, status, detail) {
  return { id, label, status, detail: String(detail) };
}

/** @param {string} file @returns {boolean} */
function fileExists(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

/** @param {string} dir @returns {boolean} */
function dirWritable(dir) {
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** @param {string} file @returns {{ username: string, role: string, disabled: boolean }[] | null} */
function parseUsersFile(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(raw) ? raw : (Array.isArray(raw.users) ? raw.users : []);
    return list.map((/** @type {any} */ u) => ({ username: u && u.username, role: u && u.role, disabled: !!(u && u.disabled) }));
  } catch {
    return null;
  }
}

/** @param {number} port @param {string} [host] @param {number} [timeoutMs] @returns {Promise<boolean>} */
function probePort(port, host = '127.0.0.1', timeoutMs = 300) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
    let settled = false;
    const finish = (/** @type {boolean} */ inUse) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(inUse);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

// ---------- 静态检查：不依赖运行中的服务 ----------
/** @param {{ env?: Record<string, string | undefined>, dataDir?: string, port?: number | null, checkPort?: boolean }} [options] @returns {ReturnType<typeof check>[]} */
function staticChecks({ env = process.env, dataDir = DATA_DIR, port = null, checkPort = false } = {}) {
  const out = [];
  const major = Number(String(process.versions.node || '').split('.')[0]);
  out.push(check(
    'node', 'Node 版本',
    major >= 22 ? STATUS.OK : STATUS.FAIL,
    `v${process.versions.node}${major >= 22 ? '' : '（node:sqlite 需要 Node 22+）'}`,
  ));

  if (dirWritable(dataDir)) out.push(check('data-dir', '数据目录', STATUS.OK, dataDir));
  else if (fs.existsSync(dataDir)) out.push(check('data-dir', '数据目录', STATUS.FAIL, `${dataDir} 不可写`));
  else out.push(check('data-dir', '数据目录', STATUS.WARN, `${dataDir} 不存在（首次启动会创建）`));

  const usersFile = env.SAFE_OFFICE_USERS_FILE || path.join(dataDir, 'users.json');
  const users = fileExists(usersFile) ? parseUsersFile(usersFile) : null;
  const authRequired = /^(1|true|yes|on|required)$/i.test(String(env.SAFE_OFFICE_AUTH || ''));
  if (users && users.length > 0) {
    const active = users.filter((u) => !u.disabled).length;
    out.push(check('users', '登录账号', STATUS.OK, `${usersFile}（${active}/${users.length} 个可用）`));
  } else if (users) {
    out.push(check('users', '登录账号', STATUS.FAIL, `${usersFile} 没有用户`));
  } else if (authRequired) {
    out.push(check('users', '登录账号', STATUS.FAIL, `SAFE_OFFICE_AUTH=required，但 ${usersFile} 不存在或无法解析`));
  } else {
    out.push(check('users', '登录账号', STATUS.WARN, `${usersFile} 不存在（未启用登录，仅本机演示）`));
  }

  const auditFile = env.SAFE_OFFICE_AUDIT_FILE || path.join(dataDir, 'audit.jsonl');
  const checkpointFile = env.SAFE_OFFICE_AUDIT_CHECKPOINT || `${auditFile}.head`;
  if (fileExists(auditFile)) {
    const checkpointOk = fileExists(checkpointFile);
    out.push(check(
      'audit', '审计落盘',
      checkpointOk ? STATUS.OK : STATUS.WARN,
      checkpointOk ? auditFile : `${auditFile} 存在但检查点缺失（恢复会从新链开始）`,
    ));
  } else {
    out.push(check('audit', '审计落盘', STATUS.WARN, `${auditFile} 不存在（首次启动创建）`));
  }

  const edPrivFile = env.SAFE_OFFICE_AUDIT_ED25519_PRIVATE_KEY_FILE;
  const edPrivPem = env.SAFE_OFFICE_AUDIT_ED25519_PRIVATE_KEY;
  if ((edPrivFile && fileExists(edPrivFile)) || (edPrivPem && String(edPrivPem).includes('BEGIN'))) {
    out.push(check('audit-signing', '检查点签名', STATUS.OK, 'Ed25519（公钥可交第三方复核）'));
  } else if (env.SAFE_OFFICE_AUDIT_KEY) {
    out.push(check('audit-signing', '检查点签名', STATUS.WARN, 'HMAC（只能本机自证）'));
  } else {
    out.push(check('audit-signing', '检查点签名', STATUS.WARN, '未配置（检查点不签名）'));
  }

  const externalDir = env.SAFE_OFFICE_AUDIT_EXTERNAL_DIR;
  if (externalDir) {
    out.push(check(
      'audit-external', '审计外部快照',
      dirWritable(externalDir) ? STATUS.OK : STATUS.FAIL,
      dirWritable(externalDir) ? externalDir : `${externalDir} 不可写`,
    ));
  } else {
    out.push(check('audit-external', '审计外部快照', STATUS.WARN, '未配置 SAFE_OFFICE_AUDIT_EXTERNAL_DIR'));
  }

  // 端点和 key 必须同时配齐才会走 HttpLLM；只配端点会静默回退 MockLLM（llm.cjs）。
  const llmEndpoint = env.SAFE_OFFICE_LLM_ENDPOINT;
  const llmKey = env.SAFE_OFFICE_LLM_KEY;
  if (llmEndpoint && llmKey) {
    out.push(check('llm', '模型', STATUS.OK, `真实模型端点 ${llmEndpoint}`));
  } else if (llmEndpoint) {
    out.push(check('llm', '模型', STATUS.WARN, '端点已配但缺 SAFE_OFFICE_LLM_KEY（会回退 MockLLM）'));
  } else {
    out.push(check('llm', '模型', STATUS.WARN, 'MockLLM（演示模式；真实模型需同时配 ENDPOINT + KEY）'));
  }

  const smtpHost = env.SAFE_OFFICE_SMTP_HOST;
  const smtpAccounts = env.SAFE_OFFICE_SMTP_ACCOUNTS;
  const smtpOn = !!(smtpHost || smtpAccounts);
  const smtpReady = !!smtpAccounts || !!(smtpHost && env.SAFE_OFFICE_SMTP_USER && env.SAFE_OFFICE_SMTP_PASS);
  out.push(check(
    'smtp', '邮件发送',
    smtpOn ? (smtpReady ? STATUS.OK : STATUS.WARN) : STATUS.WARN,
    smtpOn
      ? (smtpReady
        ? `SMTP ${smtpHost || '多账号配置'}`
        : `SMTP ${smtpHost} 已配但缺 USER/PASS（启动会失败）`)
      : 'FakeMailer（模拟发送，不会真发）',
  ));

  const imapOn = !!env.SAFE_OFFICE_IMAP_HOST;
  const imapReady = !!(env.SAFE_OFFICE_IMAP_HOST && env.SAFE_OFFICE_IMAP_USER && env.SAFE_OFFICE_IMAP_PASS);
  out.push(check(
    'imap', '收件箱同步',
    imapOn ? (imapReady ? STATUS.OK : STATUS.WARN) : STATUS.WARN,
    imapOn
      ? (imapReady ? `IMAP ${env.SAFE_OFFICE_IMAP_HOST}` : `IMAP ${env.SAFE_OFFICE_IMAP_HOST} 已配但缺 USER/PASS`)
      : '未配置（收件箱/退信轮询不可用）',
  ));

  // CalDAV 与本地目录是两条写入路径；配了 CalDAV 时本地目录可以只当副本。
  const calendarDir = env.SAFE_OFFICE_CALENDAR_DIR;
  const caldavUrl = env.SAFE_OFFICE_CALDAV_URL;
  if (caldavUrl) {
    out.push(check('calendar', '日历写入', STATUS.OK, `CalDAV ${caldavUrl}（只校验配置，连通性看启动日志）`));
  } else if (calendarDir) {
    out.push(check(
      'calendar', '日历落盘',
      dirWritable(calendarDir) ? STATUS.OK : STATUS.FAIL,
      dirWritable(calendarDir) ? calendarDir : `${calendarDir} 不可写`,
    ));
  } else {
    out.push(check('calendar', '日历写入', STATUS.WARN, '未配置（会议预约保持模拟）'));
  }

  // 录音转写：SAFE_OFFICE_ASR=1 且腾讯云两个密钥齐全才会真实调用（asr.cjs）。
  const asrOn = /^(1|true|yes|on)$/i.test(String(env.SAFE_OFFICE_ASR || ''));
  const asrReady = !!(env.TENCENT_ASR_SECRET_ID && env.TENCENT_ASR_SECRET_KEY);
  if (!asrOn) {
    out.push(check('asr', '录音转写', STATUS.WARN, '未启用（转写保持模拟）'));
  } else if (asrReady) {
    out.push(check('asr', '录音转写', STATUS.OK, '腾讯云一句话识别'));
  } else {
    out.push(check('asr', '录音转写', STATUS.FAIL, 'SAFE_OFFICE_ASR=1 但缺少 TENCENT_ASR_SECRET_ID/KEY'));
  }

  const printer = env.SAFE_OFFICE_PRINTER;
  out.push(check(
    'printer', '打印',
    printer ? STATUS.OK : STATUS.WARN,
    printer ? `打印机 ${printer}` : '未配置（打印保持模拟）',
  ));

  const clamavMode = String(env.SAFE_OFFICE_CLAMAV || 'off').toLowerCase();
  if (clamavMode === 'off' || !clamavMode) {
    out.push(check('clamav', '附件扫描', STATUS.OK, 'ClamAV 关闭'));
  } else {
    const scanner = findClamav();
    out.push(check(
      'clamav', '附件扫描',
      scanner ? STATUS.OK : (clamavMode === 'required' ? STATUS.FAIL : STATUS.WARN),
      scanner ? `ClamAV ${clamavMode}（${scanner}）` : `ClamAV ${clamavMode}，但未找到扫描器`,
    ));
  }

  const edge = findEdge();
  out.push(check(
    'edge', 'PDF 打印排版',
    edge ? STATUS.OK : STATUS.WARN,
    edge ? edge : '未找到 Edge（可用 SAFE_OFFICE_EDGE 指定）',
  ));

  const demoUsers = path.join(dataDir, 'demo', 'users.json');
  if (fileExists(demoUsers)) {
    const list = parseUsersFile(demoUsers) || [];
    out.push(check('demo-data', '一键演示包', STATUS.OK, `${demoUsers}（${list.length} 个演示账号）`));
  } else {
    out.push(check('demo-data', '一键演示包', STATUS.WARN, '未建演示数据（先跑 npm run demo:check）'));
  }

  if (checkPort && port) {
    // 异步检查由 runPreflight 补上；这里占位避免调用方漏项
    out.push(check('port', '控制台端口', STATUS.OK, `待检查 ${port}`));
  }
  return out;
}

// ---------- 运行态检查：额外看 service 的真实状态 ----------
/** @param {{ service?: any, auth?: any }} [options] @returns {ReturnType<typeof check>[]} */
function serviceChecks({ service, auth = null } = {}) {
  if (!service) return [];
  const out = [];
  const state = typeof service.getState === 'function' ? service.getState() : null;

  if (auth) {
    out.push(check('auth-live', '登录（运行中）', STATUS.OK, `${auth.users ? auth.users.size : '?'} 个用户`));
  } else {
    out.push(check('auth-live', '登录（运行中）', STATUS.WARN, '未启用登录（仅本机演示）'));
  }

  if (service.auditFile) {
    const verified = !!(service.audit && service.audit.verify());
    const count = service.audit && Array.isArray(service.audit.entries) ? service.audit.entries.length : 0;
    out.push(check(
      'audit-live', '审计链（运行中）',
      verified ? STATUS.OK : STATUS.FAIL,
      verified ? `${count} 条，链校验通过` : '链校验失败（不要继续演示，先查恢复错误）',
    ));
  } else {
    out.push(check('audit-live', '审计链（运行中）', STATUS.WARN, '内存模式（重启丢失）'));
  }

  const signing = service.auditSigner || {};
  out.push(check(
    'signing-live', '检查点签名（运行中）',
    signing.algorithm === 'Ed25519' ? STATUS.OK : STATUS.WARN,
    signing.algorithm ? `${signing.algorithm}${signing.keyId ? `（keyId ${signing.keyId}）` : ''}` : '未签名',
  ));

  if (typeof service.getAuditExternalStatus === 'function') {
    const ext = service.getAuditExternalStatus();
    if (ext.configured && !ext.error) {
      out.push(check('external-live', '外部快照（运行中）', STATUS.OK, `${ext.dir} · ${ext.snapshots || 0} 个快照`));
    } else if (ext.error) {
      out.push(check('external-live', '外部快照（运行中）', STATUS.FAIL, ext.error));
    } else {
      out.push(check('external-live', '外部快照（运行中）', STATUS.WARN, '未配置外部目录'));
    }
  }

  const model = state && state.model;
  if (model) {
    out.push(check(
      'model-live', '模型（运行中）',
      model.location === 'cloud' ? STATUS.OK : STATUS.WARN,
      `${model.mode}${model.model ? ` / ${model.model}` : ''}`,
    ));
  }

  const mailerName = service.mailer && service.mailer.constructor
    ? service.mailer.constructor.name : 'unknown';
  out.push(check(
    'mailer-live', '邮件发送（运行中）',
    mailerName === 'FakeMailer' ? STATUS.WARN : STATUS.OK,
    mailerName === 'FakeMailer' ? 'FakeMailer（模拟发送）' : mailerName,
  ));

  const transport = service.pairingCode ? 'phone-lan' : 'virtual-loopback';
  out.push(check(
    'confirm-live', '确认端（运行中）',
    transport === 'phone-lan' ? STATUS.OK : STATUS.WARN,
    transport === 'phone-lan' ? `手机确认端（配对码 ${service.pairingCode}）` : '虚拟设备（非硬件；WS63 未接入）',
  ));

  if (typeof service.getAutoReplyStatus === 'function') {
    const auto = service.getAutoReplyStatus();
    out.push(check(
      'autoreply-live', '自动回信',
      auto.enabled ? STATUS.WARN : STATUS.OK,
      auto.enabled ? '已启用（配置层预授权，绕过 WS63）' : '未启用（默认）',
    ));
  }

  const storeFile = service.storeFile || ':memory:';
  out.push(check(
    'store-live', '操作持久化',
    storeFile === ':memory:' ? STATUS.WARN : STATUS.OK,
    storeFile === ':memory:' ? '内存模式（重启丢失）' : storeFile,
  ));

  if (state && state.risk && state.risk.frozen) {
    out.push(check('risk-live', '风险状态', STATUS.WARN, `已冻结（风险分 ${state.risk.score}）；先人工复核 clear`));
  }

  return out;
}

/** @param {{ env?: Record<string, string | undefined>, dataDir?: string, service?: any, auth?: any, port?: number | null, checkPort?: boolean }} [options] */
async function runPreflight({ env = process.env, dataDir = DATA_DIR, service = null, auth = null, port = null, checkPort = false } = {}) {
  const checks = staticChecks({ env, dataDir, port, checkPort });
  if (checkPort && port) {
    const inUse = await probePort(port);
    const index = checks.findIndex((c) => c.id === 'port');
    if (index >= 0) {
      checks[index] = check(
        'port', '控制台端口',
        inUse ? STATUS.WARN : STATUS.OK,
        inUse ? `${port} 已被占用（可能已有实例在跑）` : `${port} 可用`,
      );
    }
  }
  checks.push(...serviceChecks({ service, auth }));
  const failures = checks.filter((c) => c.status === STATUS.FAIL);
  const warnings = checks.filter((c) => c.status === STATUS.WARN);
  return {
    ok: failures.length === 0,
    generatedAt: new Date().toISOString(),
    counts: { total: checks.length, ok: checks.length - failures.length - warnings.length, warn: warnings.length, fail: failures.length },
    checks,
  };
}

/** @param {any} result @returns {string} */
function formatPreflight(result) {
  /** @type {Record<string, string>} */
  const icon = { ok: '✓', warn: '!', fail: '✗' };
  const lines = [
    `演示前自检：${result.ok ? '通过' : '有阻塞项'}（${result.counts.ok} 通过 / ${result.counts.warn} 提醒 / ${result.counts.fail} 失败）`,
  ];
  for (const c of result.checks) {
    lines.push(`  ${icon[c.status] || '?'} ${c.label}: ${c.detail}`);
  }
  return lines.join('\n');
}

module.exports = {
  STATUS, staticChecks, serviceChecks, runPreflight, formatPreflight, probePort, DATA_DIR,
};
