'use strict';
// 企业隔离演示：从 stdin 读密码，创建/覆盖用户（避免密码出现在命令行）。
// 用法：printf '%s\n' "$PW" | docker run --rm -i -v data:/app/data \
//         -v seed-user.cjs:/seed-user.cjs -e SEED_USER=name -e SEED_ROLE=管理员 \
//         image node /seed-user.cjs
const fs = require('node:fs');
const { hashPassword, loadUsers, saveUsers } = require('/app/src/auth.cjs');

const username = process.env.SEED_USER || '';
const role = process.env.SEED_ROLE || '';
const file = '/app/data/users.json';
let password = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { password += chunk; });
process.stdin.on('end', () => {
  const pw = password.trim();
  if (!username || !role || pw.length < 8) {
    console.error('用法：SEED_USER=<name> SEED_ROLE=<role>，密码从 stdin 读取且至少 8 位');
    process.exit(1);
  }
  const users = loadUsers(file).filter((user) => user.username !== username);
  const { salt, hash } = hashPassword(pw);
  users.push({ username, role, salt, hash });
  saveUsers(file, users);
  fs.chmodSync(file, 0o600);
  console.log(`seeded ${username} (${role}), total ${users.length}`);
});
