#!/usr/bin/env node
'use strict';
// 添加/覆盖控制台用户：node add-user.cjs <username> <role>
// 密码从环境变量 SAFE_OFFICE_NEW_USER_PASSWORD 读（避免出现在命令行历史/进程参数里）。
// 用户表默认 data/users.json（gitignore）。
const path = require('node:path');
const fs = require('node:fs');
const { hashPassword, loadUsers, saveUsers, ROLES } = require('./src/auth.cjs');

const [username, role] = process.argv.slice(2);
const password = process.env.SAFE_OFFICE_NEW_USER_PASSWORD || '';
const file = process.env.SAFE_OFFICE_USERS_FILE || path.join(__dirname, 'data', 'users.json');

if (!username || !role) {
  console.error('用法：SAFE_OFFICE_NEW_USER_PASSWORD=... node add-user.cjs <username> <role>');
  console.error(`可用角色：${[...ROLES].join(' / ')}`);
  process.exitCode = 1;
} else if (!ROLES.has(role)) {
  console.error(`未知角色：${role}；可用：${[...ROLES].join(' / ')}`);
  process.exitCode = 1;
} else if (password.length < 8) {
  console.error('请用 SAFE_OFFICE_NEW_USER_PASSWORD 提供至少 8 位密码');
  process.exitCode = 1;
} else {
  const users = loadUsers(file).filter((u) => u.username !== username);
  const { salt, hash } = hashPassword(password);
  users.push({ username, role, salt, hash });
  saveUsers(file, users);
  fs.chmodSync(file, 0o600);
  console.log(`已写入 ${file}：${username}（${role}），共 ${users.length} 个用户`);
}
