'use strict';
// ============================================================
// 控制台登录 / 多用户（v0.25）
//   - 用户表：data/users.json（gitignore），密码 scrypt 哈希 + 随机 salt
//   - 会话：内存 token（HttpOnly Cookie），默认 8 小时滑动过期
//   - 角色：登录用户绑定一个角色，命令请求不能自行提权
// 边界：共享同一工作区（不是租户隔离）；会话在内存，重启后需重新登录。
// ============================================================
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROLES = new Set(['员工', '实习生', '审计员', '设备助手', '管理员', '访客']);
const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000;

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  if (typeof password !== 'string' || password.length < 8) {
    throw new Error('密码至少 8 位');
  }
  const hash = crypto.scryptSync(password, salt, 32).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, user) {
  if (!user || typeof user.hash !== 'string' || typeof user.salt !== 'string') return false;
  const expected = Buffer.from(user.hash, 'hex');
  const actual = crypto.scryptSync(String(password || ''), user.salt, 32);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function normalizeUser(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('用户记录必须是对象');
  const username = String(raw.username || '').trim();
  if (!username) throw new Error('用户缺少 username');
  if (!ROLES.has(raw.role)) throw new Error(`用户「${username}」角色非法：${raw.role}`);
  if (!/^[0-9a-f]{32,128}$/i.test(String(raw.salt || ''))) throw new Error(`用户「${username}」salt 非法`);
  if (!/^[0-9a-f]{64}$/i.test(String(raw.hash || ''))) throw new Error(`用户「${username}」hash 非法`);
  return { username, role: raw.role, salt: raw.salt, hash: raw.hash };
}

function loadUsers(file) {
  if (!file || !fs.existsSync(file)) return [];
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = Array.isArray(data) ? data : data.users;
  if (!Array.isArray(list)) throw new Error('users.json 必须是数组或 { users: [...] }');
  return list.map(normalizeUser);
}

function saveUsers(file, users) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ users }, null, 2), { encoding: 'utf8', mode: 0o600 });
}

class AuthService {
  constructor({ users = [], ttlMs = DEFAULT_TTL_MS, now = () => Date.now() } = {}) {
    this.users = new Map(users.map((u) => [u.username, normalizeUser(u)]));
    this.sessions = new Map();
    this.ttlMs = ttlMs;
    this.now = now;
  }

  login(username, password) {
    const user = this.users.get(String(username || '').trim());
    if (!user || !verifyPassword(password, user)) return null;
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = this.now() + this.ttlMs;
    this.sessions.set(token, { username: user.username, role: user.role, expiresAt });
    return { token, expiresAt, user: { username: user.username, role: user.role } };
  }

  verify(token) {
    if (!token) return null;
    const session = this.sessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= this.now()) {
      this.sessions.delete(token);
      return null;
    }
    session.expiresAt = this.now() + this.ttlMs;
    return { username: session.username, role: session.role, expiresAt: session.expiresAt };
  }

  logout(token) {
    return this.sessions.delete(token);
  }
}

function createAuthFromFile(file) {
  const users = loadUsers(file);
  return users.length > 0 ? new AuthService({ users }) : null;
}

module.exports = {
  AuthService, hashPassword, verifyPassword, loadUsers, saveUsers, normalizeUser,
  createAuthFromFile, ROLES,
};
