'use strict';
// 极简 API 客户端：同源 JSON，统一错误对象
(function () {
  async function request(path, { method = 'GET', body } = {}) {
    let res;
    try {
      res = await fetch(path, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      const e = new Error('网络请求失败：' + err.message);
      e.code = 'NETWORK';
      throw e;
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok || !data || data.ok === false) {
      const info = (data && data.error) || {};
      const err = new Error(info.message || `HTTP ${res.status}`);
      err.code = info.code || 'HTTP_ERROR';
      err.status = res.status;
      err.detail = info.detail;
      throw err;
    }
    return data;
  }

  window.API = {
    get: (path) => request(path),
    post: (path, body = {}) => request(path, { method: 'POST', body }),
  };
})();
