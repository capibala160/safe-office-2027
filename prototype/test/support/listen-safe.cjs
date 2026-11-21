'use strict';
// 测试假端点监听：listen(0) 偶尔会被系统分到 undici 的 bad port
// （6000/6666 等），fetch 会直接报 "bad port"。命中就关闭换一个端口重试。
const { isFetchBadPort } = require('../../src/net-ports.cjs');

/**
 * @param {import('node:http').Server} server
 * @returns {Promise<number>}
 */
function listenSafe(server) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const attempt = () => {
      attempts += 1;
      if (attempts > 20) { reject(new Error('无法找到非 bad port 的测试端口')); return; }
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        if (isFetchBadPort(port)) { server.close(() => attempt()); return; }
        resolve(port);
      });
    };
    server.once('error', reject);
    attempt();
  });
}

module.exports = { listenSafe };
