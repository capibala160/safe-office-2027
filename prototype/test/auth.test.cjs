'use strict';
// 登录 / 多用户：密码哈希、会话过期、用户表读写
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  AuthService, hashPassword, verifyPassword, loadUsers, saveUsers, normalizeUser,
  createAuthFromFile,
} = require('../src/auth.cjs');

test('密码：scrypt 哈希可验证，错误密码拒绝；短密码拒绝', () => {
  const { salt, hash } = hashPassword('correct horse battery');
  const user = { username: 'a', role: '员工', salt, hash };
  assert.equal(verifyPassword('correct horse battery', user), true);
  assert.equal(verifyPassword('wrong password', user), false);
  assert.throws(() => hashPassword('short'), /至少 8 位/);
});

test('角色：非法角色不能入库', () => {
  const { salt, hash } = hashPassword('password123');
  assert.throws(() => normalizeUser({ username: 'a', role: 'root', salt, hash }), /角色非法/);
});

test('会话：登录/验证/过期/登出', () => {
  let now = 1000;
  const { salt, hash } = hashPassword('password123');
  const auth = new AuthService({
    users: [{ username: 'alice', role: '员工', salt, hash }],
    ttlMs: 100,
    now: () => now,
  });
  assert.equal(auth.login('alice', 'bad'), null);
  const session = auth.login('alice', 'password123');
  assert.ok(session && session.token);
  assert.deepEqual(auth.verify(session.token), {
    username: 'alice', role: '员工', expiresAt: 1100,
  });
  now = 1200;
  assert.equal(auth.verify(session.token), null, '过期后拒绝');
});

test('改密：校验原密码/长度/重复，成功后其他会话失效并写回用户表', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-office-users-'));
  const file = path.join(dir, 'users.json');
  const { salt, hash } = hashPassword('password123');
  try {
    saveUsers(file, [{ username: 'alice', role: '员工', salt, hash }]);
    const auth = createAuthFromFile(file);
    const current = auth.login('alice', 'password123');
    const other = auth.login('alice', 'password123');

    assert.throws(() => auth.changePassword('alice', 'wrong-password', 'newpassword123'), /原密码不正确/);
    assert.throws(() => auth.changePassword('alice', 'password123', 'short'), /至少 8 位/);
    assert.throws(() => auth.changePassword('alice', 'password123', 'password123'), /不能与原密码相同/);

    auth.changePassword('alice', 'password123', 'newpassword123', { keepToken: current.token });
    assert.ok(auth.verify(current.token), '当前会话保留');
    assert.equal(auth.verify(other.token), null, '其他会话失效');

    const reloaded = loadUsers(file);
    assert.equal(reloaded.length, 1);
    assert.equal(verifyPassword('newpassword123', reloaded[0]), true);
    assert.ok(auth.login('alice', 'newpassword123'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('改密：内存模式（无文件）只改内存', () => {
  const { salt, hash } = hashPassword('password123');
  const auth = new AuthService({ users: [{ username: 'bob', role: '员工', salt, hash }] });
  auth.changePassword('bob', 'password123', 'newpassword123');
  assert.ok(auth.login('bob', 'newpassword123'));
  assert.equal(auth.login('bob', 'password123'), null);
});

test('用户表：保存/读取，权限 0600', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-office-users-'));
  const file = path.join(dir, 'users.json');
  const { salt, hash } = hashPassword('password123');
  try {
    saveUsers(file, [{ username: 'bob', role: '审计员', salt, hash }]);
    const users = loadUsers(file);
    assert.equal(users.length, 1);
    assert.equal(users[0].username, 'bob');
    assert.equal(users[0].role, '审计员');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
