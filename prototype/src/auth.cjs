'use strict';
// ============================================================
// 控制台登录 / 多用户（v0.32）
//   - 用户表：data/users.json（gitignore），密码 scrypt 哈希 + 随机 salt
//   - 会话：内存 + 可选 JSON 落盘（默认 data/sessions.json）；8 小时滑动过期
//   - 角色：登录用户绑定一个角色，命令请求不能自行提权
//   - TOTP：可选第二步验证（RFC 6238，HMAC-SHA1 / 30s / 6 位）
//   - 管理员可重置他人密码（不要求知道原密码）
// 边界：会话文件只存 token 的 SHA-256；TOTP 密钥明文存 users.json（0600）。
//       仍共享同一工作区（租户隔离见 v0.33）。
// ============================================================
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  generateSecret, verifyTotp, otpauthUri, base32Decode,
} = require('./totp.cjs');

const ROLES = new Set(['员工', '实习生', '审计员', '设备助手', '管理员', '访客']);
const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000;

// 带业务错误码的 Error（登录/账号管理层的既有约定）
/** @param {string} message @param {string} code @returns {Error} */
function authError(message, code) {
  const err = new Error(message);
  /** @type {any} */ (err).code = code;
  return err;
}

function hashPassword(/** @type {any} */ password, salt = crypto.randomBytes(16).toString('hex')) {
  if (typeof password !== 'string' || password.length < 8) {
    throw new Error('密码至少 8 位');
  }
  const hash = crypto.scryptSync(password, salt, 32).toString('hex');
  return { salt, hash };
}

function verifyPassword(/** @type {any} */ password, /** @type {any} */ user) {
  if (!user || typeof user.hash !== 'string' || typeof user.salt !== 'string') return false;
  const expected = Buffer.from(user.hash, 'hex');
  const actual = crypto.scryptSync(String(password || ''), user.salt, 32);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function hashToken(/** @type {any} */ token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function normalizeUser(/** @type {any} */ raw) {
  if (!raw || typeof raw !== 'object') throw new Error('用户记录必须是对象');
  const username = String(raw.username || '').trim();
  if (!username) throw new Error('用户缺少 username');
  if (!ROLES.has(raw.role)) throw new Error(`用户「${username}」角色非法：${raw.role}`);
  if (!/^[0-9a-f]{32,128}$/i.test(String(raw.salt || ''))) throw new Error(`用户「${username}」salt 非法`);
  if (!/^[0-9a-f]{64}$/i.test(String(raw.hash || ''))) throw new Error(`用户「${username}」hash 非法`);
  const totpEnabled = raw.totpEnabled === true;
  const totpSecret = String(raw.totpSecret || '').toUpperCase();
  if (totpEnabled && !totpSecret) throw new Error(`用户「${username}」启用了两步验证但缺少密钥`);
  if (totpSecret) {
    try { base32Decode(totpSecret); } catch { throw new Error(`用户「${username}」两步验证密钥非法`); }
  }
  return { username, role: raw.role, salt: raw.salt, hash: raw.hash, totpSecret, totpEnabled, disabled: raw.disabled === true };
}

function loadUsers(/** @type {any} */ file) {
  if (!file || !fs.existsSync(file)) return [];
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = Array.isArray(data) ? data : data.users;
  if (!Array.isArray(list)) throw new Error('users.json 必须是数组或 { users: [...] }');
  return list.map(normalizeUser);
}

function saveUsers(/** @type {any} */ file, /** @type {any} */ users) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ users }, null, 2), { encoding: 'utf8', mode: 0o600 });
}

class AuthService {
  /** @param {any} [options] */
  constructor({
    users = [], ttlMs = DEFAULT_TTL_MS, now = () => Date.now(), file = null, sessionFile = null,
  } = {}) {
    this.users = new Map(users.map((/** @type {any} */ u) => [u.username, normalizeUser(u)]));
    this.sessions = new Map();      // tokenHash → { username, role, expiresAt }
    this.pendingTotp = new Map();   // username → secret（尚未启用）
    this.ttlMs = ttlMs;
    // 滑动续期的落盘节流：默认最多每分钟写一次；测试/短 TTL 时按 TTL/4 缩小
    this.sessionSaveIntervalMs = Math.min(60_000, Math.max(1_000, Math.floor(ttlMs / 4)));
    this.now = now;
    this.file = file;
    this.sessionFile = sessionFile;
    this.sessionLoadError = null;
    this.sessionSaveError = null;
    this._loadSessions();
  }

  // ---------- 会话落盘 ----------
  _loadSessions() {
    if (!this.sessionFile || !fs.existsSync(this.sessionFile)) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.sessionFile, 'utf8'));
      const list = Array.isArray(data) ? data : data.sessions;
      if (!Array.isArray(list)) throw new Error('sessions.json 必须是数组或 { sessions: [...] }');
      const now = this.now();
      for (const item of list) {
        if (!item || !/^[0-9a-f]{64}$/i.test(String(item.tokenHash || ''))) continue;
        const user = this.users.get(String(item.username || ''));
        if (!user) continue;
        const expiresAt = Number(item.expiresAt);
        if (!Number.isFinite(expiresAt) || expiresAt <= now) continue;
        // 角色以用户表为准；用户被删/改角色后旧会话不能沿用旧权限
        this.sessions.set(String(item.tokenHash).toLowerCase(), {
          username: user.username, role: user.role, expiresAt,
          persistedExpiresAt: expiresAt,
        });
      }
    } catch (errRaw) { const err = /** @type {any} */ (errRaw);
      this.sessionLoadError = err.message;
      this.sessions.clear();
    }
  }

  _saveSessions() {
    if (!this.sessionFile) return;
    const now = this.now();
    const list = [...this.sessions.entries()]
      .filter(([, session]) => session.expiresAt > now)
      .map(([tokenHash, session]) => ({
        tokenHash, username: session.username, role: session.role, expiresAt: session.expiresAt,
      }));
    try {
      fs.mkdirSync(path.dirname(this.sessionFile), { recursive: true });
      const tmp = `${this.sessionFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ sessions: list }, null, 2), { encoding: 'utf8', mode: 0o600 });
      try {
        fs.renameSync(tmp, this.sessionFile);
      } catch {
        try { fs.rmSync(this.sessionFile, { force: true }); } catch { /* ignore */ }
        fs.renameSync(tmp, this.sessionFile);
      }
      this.sessionSaveError = null;
      // 记录"这份文件里实际写下的过期时间"，续期落盘以它为基准而不是相邻请求差
      for (const session of this.sessions.values()) {
        session.persistedExpiresAt = session.expiresAt;
      }
    } catch (errRaw) { const err = /** @type {any} */ (errRaw);
      this.sessionSaveError = err.message;
    }
  }

  // ---------- 登录 / 会话 ----------
  /**
   * @param {any} username
   * @param {any} password
   * @param {any} [code]
   */
  login(username, password, code = '') {
    const user = this.users.get(String(username || '').trim());
    if (!user || user.disabled || !verifyPassword(password, user)) return null;
    if (user.totpEnabled && !verifyTotp(user.totpSecret, code, { now: this.now() })) return null;
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = this.now() + this.ttlMs;
    this.sessions.set(hashToken(token), { username: user.username, role: user.role, expiresAt });
    this._saveSessions();
    return { token, expiresAt, user: { username: user.username, role: user.role } };
  }

  /**
   * @param {any} token
   */
  verify(token) {
    if (!token) return null;
    const key = hashToken(token);
    const session = this.sessions.get(key);
    if (!session) return null;
    const user = this.users.get(session.username);
    if (!user || user.disabled) {
      this.sessions.delete(key);
      this._saveSessions();
      return null;
    }
    const now = this.now();
    if (session.expiresAt <= now) {
      this.sessions.delete(key);
      this._saveSessions();
      return null;
    }
    session.expiresAt = now + this.ttlMs;
    // 滑动过期：与"上次真正落盘的过期时间"比较，而不是相邻两次请求的差值。
    // 否则请求间隔一直小于 1 分钟时，续期永远不会落盘。
    const persisted = Number(session.persistedExpiresAt) || 0;
    if (session.expiresAt - persisted >= this.sessionSaveIntervalMs) this._saveSessions();
    return { username: session.username, role: session.role, expiresAt: session.expiresAt };
  }

  /**
   * @param {any} token
   */
  logout(token) {
    const removed = this.sessions.delete(hashToken(token));
    if (removed) this._saveSessions();
    return removed;
  }

  /**
   * @param {any} username
   */
  userInfo(username) {
    const user = this.users.get(String(username || '').trim());
    if (!user) return null;
    return {
      username: user.username, role: user.role,
      totpEnabled: !!user.totpEnabled, disabled: !!user.disabled,
    };
  }

  listUsers() {
    return [...this.users.values()]
      .map((user) => ({
        username: user.username, role: user.role,
        totpEnabled: !!user.totpEnabled, disabled: !!user.disabled,
      }))
      .sort((a, b) => a.username.localeCompare(b.username));
  }

  /**
   * @param {any} updated
   */
  _persistUser(updated) {
    if (this.file) {
      const list = [...this.users.values()].map((u) => (u.username === updated.username ? updated : u));
      saveUsers(this.file, list);
    }
    this.users.set(updated.username, updated);
  }

  _persistAll() {
    if (this.file) saveUsers(this.file, [...this.users.values()]);
  }

  /**
   * @param {any} username
   * @param {any} [options]
   */
  _dropSessions(username, { keepToken = null } = {}) {
    const keepKey = keepToken ? hashToken(keepToken) : null;
    let removed = 0;
    for (const [key, session] of this.sessions) {
      if (session.username === username && key !== keepKey) {
        this.sessions.delete(key);
        removed += 1;
      }
    }
    if (removed) this._saveSessions();
    return removed;
  }

  // 改密：校验原密码 → 重算 scrypt → 落盘 → 注销该用户的其他会话（保留当前会话）。
  // 用户表写入失败时不改内存，避免"内存已改、磁盘没改"的重启回退。
  /**
   * @param {any} username
   * @param {any} oldPassword
   * @param {any} newPassword
   * @param {any} [options]
   */
  changePassword(username, oldPassword, newPassword, { keepToken = null } = {}) {
    const user = this.users.get(String(username || '').trim());
    if (!user) {
      throw authError('用户不存在', 'INVALID_CREDENTIALS');
    }
    if (!verifyPassword(oldPassword, user)) {
      throw authError('原密码不正确', 'INVALID_CREDENTIALS');
    }
    if (verifyPassword(newPassword, user)) {
      throw authError('新密码不能与原密码相同', 'BAD_PASSWORD');
    }
    const next = hashPassword(newPassword);
    this._persistUser({ ...user, salt: next.salt, hash: next.hash });
    this._dropSessions(user.username, { keepToken });
    return { username: user.username };
  }

  // 管理员重置：不知道原密码；注销目标用户全部会话
  /**
   * @param {any} username
   * @param {any} newPassword
   */
  adminResetPassword(username, newPassword) {
    const user = this.users.get(String(username || '').trim());
    if (!user) {
      throw authError('用户不存在', 'USER_NOT_FOUND');
    }
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      throw authError('密码至少 8 位', 'BAD_PASSWORD');
    }
    const next = hashPassword(newPassword);
    this._persistUser({ ...user, salt: next.salt, hash: next.hash });
    this.pendingTotp.delete(user.username);
    this._dropSessions(user.username);
    return { username: user.username };
  }

  // 管理员禁用/启用：禁用立即注销该用户全部会话；最后一个可用管理员不能被禁用。
  /**
   * @param {any} username
   * @param {any} disabled
   */
  setDisabled(username, disabled) {
    const user = this.users.get(String(username || '').trim());
    if (!user) {
      throw authError('用户不存在', 'USER_NOT_FOUND');
    }
    const next = disabled === true;
    if (next && user.role === '管理员') {
      const others = [...this.users.values()].filter((u) => u.username !== user.username && u.role === '管理员' && !u.disabled);
      if (others.length === 0) {
        throw authError('不能禁用最后一个可用管理员', 'LAST_ADMIN');
      }
    }
    this._persistUser({ ...user, disabled: next });
    if (next) this._dropSessions(user.username);
    return { username: user.username, disabled: next };
  }

  // 管理员删除账号：删除后不可登录、会话立即失效；最后一个可用管理员不能被删除。
  /**
   * @param {any} username
   */
  deleteUser(username) {
    const user = this.users.get(String(username || '').trim());
    if (!user) {
      throw authError('用户不存在', 'USER_NOT_FOUND');
    }
    if (user.role === '管理员') {
      const others = [...this.users.values()].filter((u) => u.username !== user.username && u.role === '管理员' && !u.disabled);
      if (others.length === 0) {
        throw authError('不能删除最后一个可用管理员', 'LAST_ADMIN');
      }
    }
    // 先成功写盘，再改内存/注销会话：写盘失败时不能出现「内存已删、磁盘还在」，
    // 否则重启后账号会复活。
    if (this.file) {
      saveUsers(this.file, [...this.users.values()].filter((u) => u.username !== user.username));
    }
    this._dropSessions(user.username);
    this.pendingTotp.delete(user.username);
    this.users.delete(user.username);
    return { username: user.username, deleted: true };
  }

  // ---------- TOTP ----------
  /**
   * @param {any} username
   */
  beginTotpSetup(username) {
    const user = this.users.get(String(username || '').trim());
    if (!user) {
      throw authError('用户不存在', 'USER_NOT_FOUND');
    }
    if (user.totpEnabled) {
      throw authError('两步验证已启用；请先关闭再重新绑定', 'TOTP_ENABLED');
    }
    const secret = generateSecret();
    this.pendingTotp.set(user.username, secret);
    return { secret, uri: otpauthUri({ secret, account: user.username }) };
  }

  /**
   * @param {any} username
   * @param {any} code
   */
  enableTotp(username, code) {
    const user = this.users.get(String(username || '').trim());
    if (!user) {
      throw authError('用户不存在', 'USER_NOT_FOUND');
    }
    if (user.totpEnabled) {
      throw authError('两步验证已启用', 'TOTP_ENABLED');
    }
    const secret = this.pendingTotp.get(user.username);
    if (!secret) {
      throw authError('请先生成两步验证密钥', 'TOTP_SETUP_REQUIRED');
    }
    if (!verifyTotp(secret, code, { now: this.now() })) {
      throw authError('动态验证码不正确', 'INVALID_TOTP');
    }
    this._persistUser({ ...user, totpSecret: secret, totpEnabled: true });
    this.pendingTotp.delete(user.username);
    return { username: user.username, totpEnabled: true };
  }

  /**
   * @param {any} username
   * @param {any} password
   * @param {any} code
   */
  disableTotp(username, password, code) {
    const user = this.users.get(String(username || '').trim());
    if (!user) {
      throw authError('用户不存在', 'USER_NOT_FOUND');
    }
    if (!verifyPassword(password, user)) {
      throw authError('密码不正确', 'INVALID_CREDENTIALS');
    }
    if (user.totpEnabled && !verifyTotp(user.totpSecret, code, { now: this.now() })) {
      throw authError('动态验证码不正确', 'INVALID_TOTP');
    }
    this._persistUser({ ...user, totpSecret: '', totpEnabled: false });
    this.pendingTotp.delete(user.username);
    return { username: user.username, totpEnabled: false };
  }
}

/** @param {any} file @param {{ sessionFile?: string | null }} [options] */
function createAuthFromFile(file, { sessionFile = null } = {}) {
  const users = loadUsers(file);
  return users.length > 0 ? new AuthService({ users, file, sessionFile }) : null;
}

module.exports = {
  AuthService, hashPassword, verifyPassword, loadUsers, saveUsers, normalizeUser,
  createAuthFromFile, ROLES,
};
