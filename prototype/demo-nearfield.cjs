'use strict';
// ============================================================
// WS63 近场确认适配器演示（v0.11，无硬件）
//   A 端 = Node 网关；B 端 = VirtualDevice 替身
//   真实 SFC1 二进制帧 + 真 HMAC-SHA256；虚拟的只是"设备"和"传输"
//   6 幕：正常 / 取消 / 超时 / 重放 / 篡改与记录变化 / 错设备
//   node demo-nearfield.cjs
// ============================================================
const { sealOperation } = require('./src/operation.cjs');
const { OperationStore } = require('./src/store.cjs');
const { FakeMailer } = require('./src/mailer.cjs');
const { FulfillmentService } = require('./src/fulfillment.cjs');
const { decodeFrame } = require('./src/ws63-protocol.cjs');
const {
  NearfieldConfirmer, VirtualDevice, createLoopbackTransport, confirmWithFulfillment,
} = require('./src/nearfield-confirm.cjs');

const line = (s = '') => console.log(s);
const banner = (title) => { line(); line('═'.repeat(70)); line(`  ${title}`); line('═'.repeat(70)); };
const short = (value, n = 12) => `${String(value).slice(0, n)}…`;

const KEY = Buffer.alloc(32, 0x42);
const WRONG_KEY = Buffer.alloc(32, 0x43);

let nowSec = Math.floor(Date.now() / 1000);
const clock = () => nowSec;
let seq = 0;

function makeOperation(overrides = {}) {
  seq += 1;
  return sealOperation({
    taskId: `DEMO-${seq}`,
    action: 'sendExternalEmail',
    protocolAction: 1,
    tool: 'sendExternalEmail',
    recipient: 'partner@example.com',
    subject: '周例会纪要',
    body: `最终正文（演示 ${seq}）`,
    attachments: [],
    sourceDocIds: ['M2'],
    level: '内部',
    createdAt: new Date(nowSec * 1000).toISOString(),
    expiresAt: new Date((nowSec + 300) * 1000).toISOString(),
    modelId: 'mock',
    planHash: `plan-${seq}`,
    ...overrides,
  });
}

function makeService() {
  const store = new OperationStore(':memory:', { now: () => new Date(nowSec * 1000).toISOString() });
  const mailer = new FakeMailer();
  const service = new FulfillmentService({ store, mailer, now: () => nowSec * 1000 });
  return { store, mailer, service };
}

function makeConfirmer(transport = null, extra = {}) {
  return new NearfieldConfirmer({
    key: KEY, expectedDeviceId: 'ws63-A', deviceLabel: 'ws63-A',
    ttlSec: 30, now: clock, transport, ...extra,
  });
}

function makeDevice(options = {}) {
  return new VirtualDevice({ key: KEY, deviceId: 'ws63-A', now: clock, ...options });
}

(async () => {
  line();
  line('  安全智慧办公 · WS63 近场确认适配器演示（v0.11）');
  line('  真实：SFC1 二进制帧、HMAC-SHA256、8 条 nonce 窗口、冻结操作哈希绑定');
  line('  虚拟：确认端设备与传输层（上板时只换 transport）');

  // 幕1 · 正常
  banner('幕1 · 正常：设备在场按键确认 → 冻结记录 confirmed → 发送 sent');
  {
    const { store, service } = makeService();
    const operation = service.prepare(makeOperation());
    const device = makeDevice();
    const transport = createLoopbackTransport(device);

    // 用一台"探针"只发挑战，展示设备端会看到什么
    const probe = makeConfirmer();
    const { frame } = probe.beginChallenge(operation);
    const challenge = decodeFrame(frame, KEY);
    line(`  挑战帧 ${frame.length}B：task=${challenge.taskId.toString('hex')} nonce=${short(challenge.nonce.toString('hex'))}`);
    line(`  设备屏摘要：${challenge.summary}`);
    line(`  target_hash = operationHash：${short(challenge.operationHash.toString('hex'))}`);
    probe.abort();

    const confirmer = makeConfirmer(transport);
    const result = await confirmWithFulfillment({ fulfillment: service, confirmer, operation });
    line(`  设备决定：decision=${result.approval.decision} device=${result.approval.deviceLabel}`);
    line(`  操作状态：${store.getOperation(operation.operationId).state}（confirmationId=${short(result.approval.confirmationId, 20)}）`);
    line(`  outbox：${result.outbox.state}`);
    const sent = await service.send(result.outbox.outboxId);
    line(`  发送：${sent.state} messageId=${sent.messageId}`);
    line(`  事件链校验：${store.verifyEvents() ? 'OK' : '断裂'}`);
    store.close();
  }

  // 幕2 · 取消
  banner('幕2 · 取消：持有者按取消 → DECISION，操作仍 frozen');
  {
    const { store, service } = makeService();
    const operation = service.prepare(makeOperation({ subject: '对外合同' }));
    const device = makeDevice({ decide: () => 'cancel' });
    const confirmer = makeConfirmer();
    const { pending, frame } = confirmer.beginChallenge(operation);
    const reply = await device.receive(frame);
    try {
      confirmer.acceptDecision(pending, reply, { finalOperation: operation });
    } catch (err) {
      line(`  A 端拒绝：${err.code}（cancelled=${err.cancelled}）`);
    }
    line(`  nonce 已消费：used=${confirmer.used.length}；pending=${confirmer.pending === null ? '已清空' : '仍在'}`);
    line(`  操作状态仍：${store.getOperation(operation.operationId).state}`);
    store.setOperationState(operation.operationId, 'rejected');
    line(`  调用方显式标记：${store.getOperation(operation.operationId).state}（不发送）`);
    store.close();
  }

  // 幕3 · 超时
  banner('幕3 · 不在场/超时：确认端无应答 → TIMEOUT，新 nonce 可重试');
  {
    const { store, service } = makeService();
    const operation = service.prepare(makeOperation({ subject: '预算外发' }));
    const device = makeDevice();
    const confirmer = makeConfirmer(createLoopbackTransport(device, { drop: true }));
    try {
      await confirmer.requestApproval(operation);
    } catch (err) {
      line(`  A 端拒绝：${err.code}；used=${confirmer.used.length}；pending 已清空`);
    }
    const approval = await confirmer.requestApproval(operation, {
      transport: createLoopbackTransport(device),
    });
    line(`  重试（新 nonce）：decision=${approval.decision}，nonce=${short(approval.nonce.toString('hex'))}`);
    line(`  操作状态：${store.getOperation(operation.operationId).state}（尚未 confirm，符合预期）`);
    store.close();
  }

  // 幕4 · 重放
  banner('幕4 · 重放：旧 DECISION → STATE；复用 nonce → REPLAY');
  {
    const operation = makeOperation({ subject: '重放样本' });
    const device = makeDevice();
    const confirmer = makeConfirmer();
    const { pending, frame } = confirmer.beginChallenge(operation);
    const reply = await device.receive(frame);
    confirmer.acceptDecision(pending, reply, { finalOperation: operation });
    try {
      confirmer.acceptDecision(pending, reply, { finalOperation: operation });
    } catch (err) {
      line(`  同一 DECISION 再投：${err.code}（一次性 nonce）`);
    }

    const fixed = Buffer.alloc(16, 0x77);
    const fixedConfirmer = makeConfirmer(null, { randomBytes: () => fixed });
    const first = fixedConfirmer.beginChallenge(operation);
    fixedConfirmer.cancel(first.pending);
    try {
      fixedConfirmer.beginChallenge(operation);
    } catch (err) {
      line(`  复用已消费 nonce：${err.code}`);
    }
  }

  // 幕5 · 篡改与记录变化
  banner('幕5 · 篡改：改 DECISION → MAC；改冻结记录 → OPERATION');
  {
    const operation = makeOperation({ subject: '篡改样本' });
    const device = makeDevice();
    const tampered = makeConfirmer(createLoopbackTransport(device, {
      tamper: (buffer) => { buffer[35] ^= 1; return buffer; }, // device_id 首字节
    }));
    try {
      await tampered.requestApproval(operation);
    } catch (err) {
      line(`  (a) 篡改决定帧：${err.code}（MAC 先于绑定检查）`);
    }

    const confirmer = makeConfirmer();
    const { pending, frame } = confirmer.beginChallenge(operation);
    const reply = await device.receive(frame);
    try {
      confirmer.acceptDecision(pending, reply, {
        finalOperation: { ...operation, body: '被偷换的正文' },
      });
    } catch (err) {
      line(`  (b) 挑战后记录被改：${err.code}（绑定最终 operationHash）`);
    }
    const approval = confirmer.acceptDecision(pending, reply, { finalOperation: operation });
    line(`  原记录随后确认：decision=${approval.decision}（失败不消费 pending）`);
  }

  // 幕6 · 错设备
  banner('幕6 · 错设备：错密钥 → MAC；同 key 错设备 ID → DEVICE');
  {
    const operation = makeOperation({ subject: '错设备样本' });

    const wrongSigner = new VirtualDevice({
      key: KEY, deviceId: 'ws63-A', now: clock, replyKey: WRONG_KEY,
    });
    const a = makeConfirmer(createLoopbackTransport(wrongSigner));
    try {
      await a.requestApproval(operation);
    } catch (err) {
      line(`  (a) 应答签名密钥不对：${err.code}`);
    }

    const proper = makeDevice();
    const otherDevice = new VirtualDevice({ key: KEY, deviceId: 'ws63-B', now: clock });
    const b = makeConfirmer();
    const { pending, frame } = b.beginChallenge(operation);
    const replyB = await otherDevice.receive(frame);
    try {
      b.acceptDecision(pending, replyB, { finalOperation: operation });
    } catch (err) {
      line(`  (b) 设备 ID 与可信配对配置不符：${err.code}（pending 未消费）`);
    }
    const replyA = await proper.receive(frame);
    const approval = b.acceptDecision(pending, replyA, { finalOperation: operation });
    line(`  正确设备随后确认：decision=${approval.decision}`);
  }

  banner('错误码与边界');
  line('  错误码：ARG / FRAME / VERSION / TYPE / MAC / STATE / TASK / NONCE / REPLAY /');
  line('          EXPIRED / DECISION / DEVICE / OPERATION / TIMEOUT');
  line('  边界：虚拟设备不是硬件；无 SLE/串口；PSK 在 Node 堆内存；');
  line('        不证明距离/本人身份/防中继；闸4 运行时仍为模拟确认。');
  line('  上板接入：只替换 transport.send(frame) → 串口/SLE，上层状态机不变。');
  line();
})().catch((err) => {
  console.error('\n演示失败：', err);
  process.exitCode = 1;
});
