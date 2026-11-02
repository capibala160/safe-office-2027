'use strict';
// fetch 禁用端口列表：覆盖已知遗漏端口，普通端口不误伤
const test = require('node:test');
const assert = require('node:assert');
const { isFetchBadPort } = require('../src/net-ports.cjs');

test('bad port：4190 / 6679 必须命中，普通端口不命中', () => {
  assert.equal(isFetchBadPort(4190), true);
  assert.equal(isFetchBadPort(6679), true);
  assert.equal(isFetchBadPort(7812), false);
  assert.equal(isFetchBadPort(3000), false);
});
