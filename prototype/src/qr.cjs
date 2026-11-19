'use strict';
// TOTP 绑定二维码（v0.53.3）：把 otpauth URI 渲染成 data URL，供控制台直接显示。
// 纯本地生成（qrcode-generator，零运行时依赖），不调用任何外部服务；
// 二维码里含 TOTP 密钥，只在本地接口响应中返回（与 setup 返回的 secret/uri 同一信任边界）。
const qrcode = require('qrcode-generator');

/**
 * @param {string} uri
 * @param {{ cellSize?: number, margin?: number }} [options]
 * @returns {string} data:image/gif;base64,... 
 */
function toDataUrl(uri, { cellSize = 6, margin = 2 } = {}) {
  const qr = qrcode(0, 'M');
  qr.addData(String(uri || ''));
  qr.make();
  return qr.createDataURL(cellSize, margin);
}

module.exports = { toDataUrl };
