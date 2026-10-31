'use strict';
// 日历 .ics 写入测试（v0.37）
//   覆盖：UTC 转换/文本转义/稳定文件名、未配置=模拟、坏时间拒绝、控制台端到端
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  buildIcs, writeMeeting, createCalendarWriterFromEnv, parseWhen,
} = require('../src/calendar-adapter.cjs');
const { ConsoleService } = require('../src/console-service.cjs');

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-office-cal-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('ICS：本地时区转 UTC，文本按 RFC 5545 转义', () => {
  const ics = buildIcs({
    title: '评审, 会议; 第一版',
    at: '2026-10-31T10:00:00+08:00',
    id: 'T1-1',
    description: '第一行\n第二行',
    now: new Date('2026-10-31T00:00:00Z'),
  });
  assert.match(ics, /^BEGIN:VCALENDAR/);
  assert.match(ics, /DTSTART:20261031T020000Z/);
  assert.match(ics, /DTEND:20261031T030000Z/);
  assert.match(ics, /SUMMARY:评审\\, 会议\\; 第一版/);
  assert.match(ics, /DESCRIPTION:第一行\\n第二行/);
  assert.match(ics, /UID:T1-1@safe-office\.local/);
  assert.match(ics, /END:VCALENDAR/);
});

test('未配置目录 → simulated，不冒充写入', () => {
  const result = writeMeeting({ title: '周会', at: '2026-10-31T10:00:00+08:00' });
  assert.equal(result.mode, 'simulated');
  assert.equal(result.file, null);
  assert.equal(createCalendarWriterFromEnv({}), null);
});

test('写入 .ics：目录自动创建、文件名稳定、重复写入覆盖同一文件', (t) => {
  const dir = path.join(tmpDir(t), 'calendar');
  const input = { dir, title: '项目对齐会', at: '2026-10-31 10:00', id: 'T-9' };
  const first = writeMeeting(input);
  assert.equal(first.mode, 'written');
  assert.ok(fs.existsSync(first.file));
  assert.match(path.basename(first.file), /^meeting-[0-9a-f]{12}\.ics$/);
  const body = fs.readFileSync(first.file, 'utf8');
  assert.match(body, /SUMMARY:项目对齐会/);
  assert.match(body, /UID:T-9@safe-office\.local/);

  const second = writeMeeting(input);
  assert.equal(second.file, first.file);
  assert.equal(fs.readdirSync(dir).length, 1);
});

test('时间缺失/非法 → 明确抛错', () => {
  assert.equal(parseWhen(''), null);
  assert.equal(parseWhen('not-a-date'), null);
  assert.throws(() => buildIcs({ title: 'x', at: 'not-a-date' }), /无法解析/);
});

test('控制台：配置 calendarDir 后预约会议真写 .ics 并留审计', async (t) => {
  const dir = tmpDir(t);
  const service = new ConsoleService({ calendarDir: dir, now: () => Date.now() });
  t.after(() => service.close());
  const run = await service.runCommand({
    command: '预约一下周三的项目对齐会',
    role: '员工',
    tools: ['scheduleMeeting'],
    documentIds: [],
  });
  assert.equal(run.ok, true);
  assert.ok(run.lines.join('\n').includes('.ics 已写入'), '执行结果里可见真实路径');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ics'));
  assert.equal(files.length, 1);
  const entry = service.audit.entries.find((e) => e.kind === '日历写入');
  assert.ok(entry, '审计里有日历写入');
  assert.match(entry.detail.file, /meeting-[0-9a-f]{12}\.ics$/);

  // 日历页能区分"已落盘"与"模拟"
  const agentEvents = service.listCalendar().filter((x) => x.source === 'agent');
  assert.equal(agentEvents.length, 1);
  assert.equal(agentEvents[0].real, true);
  assert.match(agentEvents[0].file, /meeting-[0-9a-f]{12}\.ics$/);
});

test('控制台：未配置 calendarDir 时保持模拟，不产生日历审计', async (t) => {
  const service = new ConsoleService({ now: () => Date.now() });
  t.after(() => service.close());
  const run = await service.runCommand({
    command: '预约一下周三的项目对齐会',
    role: '员工',
    tools: ['scheduleMeeting'],
    documentIds: [],
  });
  assert.equal(run.ok, true);
  assert.ok(run.lines.join('\n').includes('已预约'));
  assert.equal(service.audit.entries.filter((e) => e.kind === '日历写入').length, 0);
});
