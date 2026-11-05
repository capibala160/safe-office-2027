'use strict';
// MockLLM 设备联动规划：门锁与一般设备必须分开（2026-11-05 继电器加固配套）
const test = require('node:test');
const assert = require('node:assert/strict');
const { MockLLM } = require('../src/llm.cjs');

test('MockLLM：开空调/开灯不会规划成开锁，门锁开关保留锁语义', async () => {
  const llm = new MockLLM();

  const unlock = await llm.plan('帮我把办公室门锁打开');
  assert.deepEqual(unlock, [
    { action: 'deviceControl', args: { device: '会议室-门锁', op: 'open' } },
  ]);

  const lock = await llm.plan('把办公室门锁关上');
  assert.deepEqual(lock, [
    { action: 'deviceControl', args: { device: '会议室-门锁', op: 'lock' } },
  ]);

  const closeDoor = await llm.plan('把大门关上');
  assert.deepEqual(closeDoor, [
    { action: 'deviceControl', args: { device: '会议室-门锁', op: 'lock' } },
  ]);

  const acOn = await llm.plan('把空调打开');
  assert.equal(acOn.length, 1);
  assert.equal(acOn[0].action, 'deviceControl');
  assert.equal(acOn[0].args.device, '会议室-空调');
  assert.equal(acOn[0].args.op, 'on');

  const lightOff = await llm.plan('把灯光关掉');
  assert.equal(lightOff[0].args.device, '会议室-灯光');
  assert.equal(lightOff[0].args.op, 'off');
});
