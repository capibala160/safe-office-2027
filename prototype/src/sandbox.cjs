'use strict';
// ============================================================
// 工具执行沙箱（命题挑战目标 · 工具调用保护机制："白名单、沙箱、审批确认、敏感操作二次确认"）
//   白名单 = 闸2 权限令牌（任务层）；沙箱 = 执行环境层的独立一锁：
//   即使任务令牌放行，执行环境不开放对应资源（文件作用域 / 网络通道 / 物理世界），依旧拒绝。
//   两把锁相互独立——令牌管"这个任务能不能"，沙箱管"这个环境允不允许"。
//   纪律：任何工具都必须有沙箱档案；没有档案 = fail-closed（拒绝）。
// 平台无关实现——上板时对应 OH 应用沙箱 / 系统权限模型（见设计骨架 §5）
// ============================================================

/**
 * @typedef {{scope: string, arg: string}} FsSpec
 * @typedef {{
 *   local?: true,
 *   fsRead?: FsSpec,
 *   fsWrite?: FsSpec,
 *   net?: string,
 *   physical?: true,
 * }} SandboxProfile
 * @typedef {{
 *   name?: string,
 *   fs?: {read: string[], write: string[]},
 *   net?: string[],
 *   physical?: boolean,
 * }} Sandbox
 */

// 路径规范化（POSIX 语义）：用于检出 '../' 越界
/** @param {string} p */
function normalizePath(p) {
  const parts = [];
  for (const seg of String(p).split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return '/' + parts.join('/');
}

// 默认执行环境沙箱（模拟端侧应用沙箱的授权集）
//   fs：本应用被授权的文件作用域；net：被授权的网络通道；physical：是否可下达物理世界指令
/** @type {Sandbox} */
const DEFAULT_SANDBOX = {
  name: '默认应用沙箱',
  fs: { read: ['/docs', '/audio', '/images'], write: ['/docs', '/calendar'] },
  net: ['smtp-internal', 'smtp-external', 'https-upload', 'print'],
  physical: false,
};

// 工具沙箱档案：工具 → 它需要触达的资源（单一事实源：每个工具显式声明）
//   local: true        —— 纯本地计算/本机资源，无需额外授权
//   fsRead / fsWrite   —— 文件资源请求（带作用域根，参数拼路径后必须落在根内）
//   net                —— 网络通道请求
//   physical           —— 物理世界副作用请求
/** @type {Record<string, SandboxProfile>} */
const SANDBOX_PROFILES = {
  summarize:         { local: true },
  readContact:       { local: true },
  shareScreen:       { local: true },
  readDoc:           { fsRead: { scope: '/docs', arg: 'id' } },
  deleteDoc:         { fsWrite: { scope: '/docs', arg: 'id' } },
  transcribeAudio:   { fsRead: { scope: '/audio', arg: 'id' } },
  recognizeImage:    { fsRead: { scope: '/images', arg: 'id' } },
  scheduleMeeting:   { fsWrite: { scope: '/calendar', arg: 'title' } },
  sendInternalEmail: { net: 'smtp-internal' },
  sendExternalEmail: { net: 'smtp-external' },
  uploadToCloud:     { net: 'https-upload' },
  printDoc:          { net: 'print' },
  deviceControl:     { physical: true },
};

// 沙箱校验：工具在该执行环境里是否被允许触达所需资源
/**
 * @param {string} tool
 * @param {Record<string, unknown>} [args]
 * @param {Sandbox} [sandbox]
 * @param {SandboxProfile} [profile]
 * @returns {{allow: boolean, reason: string}}
 */
function checkSandbox(tool, args = {}, sandbox = DEFAULT_SANDBOX, profile = SANDBOX_PROFILES[tool]) {
  if (!profile) {
    return { allow: false, reason: `工具「${tool}」无沙箱档案（fail-closed：未知工具一律拒绝）` };
  }
  if (profile.local) return { allow: true, reason: '本地工具，无需额外资源授权' };

  const f = profile.fsRead || profile.fsWrite;
  if (f) {
    /** @type {'read' | 'write'} */
    const kind = profile.fsRead ? 'read' : 'write';
    const raw = args[f.arg] === undefined ? '' : String(args[f.arg]);
    const full = normalizePath(`${f.scope}/${raw}`);
    if (!full.startsWith(`${f.scope}/`) && full !== f.scope) {
      return { allow: false, reason: `文件路径「${full}」越出工具作用域 ${f.scope}（沙箱拒绝路径逃逸）` };
    }
    if (!(sandbox.fs && sandbox.fs[kind] && sandbox.fs[kind].includes(f.scope))) {
      return { allow: false, reason: `执行环境未开放 ${kind} 作用域 ${f.scope}（沙箱授权缺失）` };
    }
    return { allow: true, reason: `文件作用域 ${f.scope} 已授权（${kind}）` };
  }

  if (profile.net) {
    if (!(sandbox.net || []).includes(profile.net)) {
      return { allow: false, reason: `执行环境未开放网络通道「${profile.net}」（沙箱授权缺失）` };
    }
    return { allow: true, reason: `网络通道「${profile.net}」已授权` };
  }

  if (profile.physical) {
    if (sandbox.physical !== true) {
      return { allow: false, reason: '执行环境未开放物理世界通道（沙箱拒绝物理副作用指令）' };
    }
    return { allow: true, reason: '物理世界通道已开放（已授权）' };
  }

  return { allow: false, reason: '沙箱档案不完整（fail-closed）' };
}

module.exports = { DEFAULT_SANDBOX, SANDBOX_PROFILES, checkSandbox, normalizePath };
