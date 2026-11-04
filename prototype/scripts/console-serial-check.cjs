'use strict';
// 控制台 + 真板冒烟（docs/11 下一步的现场验证）：
//   用 ConsoleService 的 nearfieldTransportFactory 把 CHALLENGE 发到串口板，
//   板端 OLED 显示后按键决定，回帧走完整的 MAC/绑定/nonce 校验与执行链。
//
// 用法（先关掉其它占用串口的程序）：
//   node scripts/console-serial-check.cjs --port COM11
//   node scripts/console-serial-check.cjs --port COM11 --demo-key --json
//
// 退出码：0 批准并执行；2 取消（DECISION）；1 其它失败。
const { createHash } = require('node:crypto');
const { createSerialNearfieldFactory } = require('../src/serial-nearfield.cjs');
const { createBoardHumanConfirm } = require('../src/board-human-confirm.cjs');
const { ConsoleService } = require('../src/console-service.cjs');

const { DEMO_KEY, resolveDeviceKey } = require('../src/device-keys.cjs');

function arg(name, fallback) {
  const argv = process.argv.slice(2);
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  if (index !== -1 && index + 1 < argv.length && !argv[index + 1].startsWith('--')) {
    return argv[index + 1];
  }
  return fallback;
}

async function main() {
  const asJson = process.argv.includes('--json');
  const portPath = String(arg('port', '')).trim();
  if (!portPath) throw new Error('缺少 --port（例如 COM11）');
  const deviceLabel = String(arg('device', 'ws63-A'));
  const { key } = resolveDeviceKey({
    label: deviceLabel,
    production: process.env.SAFE_OFFICE_PRODUCTION === '1',
    demoKey: process.argv.includes('--demo-key'),
    keyHex: arg('key', ''),
  });

  const transportFactory = createSerialNearfieldFactory({
    portPath,
    logger: asJson ? null : (line) => console.log(line),
  });

  // --gate4：直接验证闸4 的板端确认适配器（不走控制台流转）
  if (process.argv.includes('--gate4')) {
    const humanConfirm = createBoardHumanConfirm({
      transportFactory,
      key,
      deviceId: deviceLabel,
      ttlSec: 60,
    });
    const transport = await transportFactory();
    try {
      const contentHash = createHash('sha256').update('gate4-demo-payload').digest('hex');
      if (!asJson) console.log('闸4 板端确认：请在 OLED 上短按 KEY2 批准（长按取消，60 秒有效）');
      const result = await humanConfirm({
        operation: { action: 'sendExternalEmail', args: { to: 'partner@example.com' }, contentHash },
      });
      if (asJson) console.log(JSON.stringify(result, null, 2));
      else console.log(`approved=${result.approved} method=${result.method}${result.proof ? ` confirmationId=${result.proof.confirmationId}` : ''}`);
      return result.approved ? 0 : 2;
    } finally {
      // 关掉底层端口，否则进程会挂住并一直占 COM 口
      try { await transport.close(); } catch { /* ignore */ }
    }
  }

  const gate4E2e = process.argv.includes('--gate4-e2e');
  const service = new ConsoleService({
    nearfieldKey: key,
    deviceId: deviceLabel,
    deviceLabel: 'WS63 真板确认端',
    nearfieldTransportFactory: transportFactory,
    gate4Nearfield: gate4E2e,
  });

  try {
    if (gate4E2e) {
      const item = service.getDemoSamples().find((s) => s.id === 'screen-share');
      if (!item) throw new Error('样例 screen-share 不存在');
      if (!asJson) console.log('投屏样例：板端应显示 SHARE ...，请短按 KEY2 批准（长按取消）');
      await service.runCommand({ ...item, role: item.role });
      const confirmed = service.audit.entries.filter((e) => e.kind === '闸4确认');
      const denied = service.audit.entries.filter((e) => e.kind === '闸4拒绝');
      if (asJson) {
        console.log(JSON.stringify({ confirmed: confirmed.length, denied: denied.length }, null, 2));
      } else {
        console.log(`闸4确认=${confirmed.length} 闸4拒绝=${denied.length}`);
        if (confirmed[0]) console.log(`method=${confirmed[0].detail.method}`);
        if (denied[0]) console.log(`拒绝原因=${denied[0].detail.method}`);
      }
      return confirmed.length > 0 && denied.length === 0 ? 0 : 1;
    }
    const item = service.getDemoSamples().find((s) => s.id === 'external-confirm');
    if (!item) throw new Error('样例 external-confirm 不存在');
    const run = await service.runCommand({ ...item, role: item.role });
    const operation = run.operations[0];
    if (!operation) throw new Error('样例没有产生待确认操作');

    const challenge = service.beginChallenge(operation.operationId);
    if (!asJson) {
      console.log(`已发起挑战 ${challenge.challengeId}`);
      console.log('请在板端查看 OLED，短按 KEY2 = 批准，长按 = 取消（最多等 65 秒）');
    }
    const decided = await service.decideChallenge(challenge.challengeId, 'approve');
    if (asJson) {
      console.log(JSON.stringify(decided, null, 2));
    } else {
      console.log(`结果：ok=${decided.ok} outcome=${decided.outcome} code=${decided.code || '-'}`);
      if (decided.message) console.log(`说明：${decided.message}`);
      if (decided.operation) console.log(`操作状态：${decided.operation.state}`);
    }
    if (decided.outcome === 'approved') return 0;
    if (decided.outcome === 'cancelled') return 2;
    return 1;
  } finally {
    service.close();
  }
}

if (require.main === module) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
      console.error(err && err.message ? err.message : String(err));
      process.exitCode = 1;
    });
}

module.exports = { DEMO_KEY };
