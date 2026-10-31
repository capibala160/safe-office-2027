'use strict';
// ============================================================
// 日历写入适配器（v0.37）
//   - 会议预约不再只写一句"已预约"：配置 SAFE_OFFICE_CALENDAR_DIR 后
//     生成标准 .ics（VCALENDAR/VEVENT），可被系统日历导入
//   - 未配置目录 → 返回 simulated，不冒充真写入
//   - 时间：ISO 或 "YYYY-MM-DD HH:mm"（按本机时区），统一转 UTC（...Z）
// 边界：只证明文件已落盘，不证明已同步到任何日历账户或通知到参会人。
// ============================================================
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_DURATION_MS = 60 * 60 * 1000;

function escapeIcsText(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function toIcsUtc(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`
    + `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

function parseWhen(at) {
  if (at instanceof Date) return new Date(at.getTime());
  const src = String(at === undefined || at === null ? '' : at).trim();
  if (!src) return null;
  const date = new Date(src);
  return Number.isNaN(date.getTime()) ? null : date;
}

function buildIcs({ title, at, id = '', description = '', now = new Date() } = {}) {
  const start = parseWhen(at);
  if (!start) throw new Error(`会议时间无法解析：${String(at || '(空)')}`);
  const end = new Date(start.getTime() + DEFAULT_DURATION_MS);
  const uid = `${id || crypto.randomUUID()}@safe-office.local`;
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Safe Office//Agent Governance//CN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${toIcsUtc(now)}`,
    `DTSTART:${toIcsUtc(start)}`,
    `DTEND:${toIcsUtc(end)}`,
    `SUMMARY:${escapeIcsText(title || '会议')}`,
    ...(description ? [`DESCRIPTION:${escapeIcsText(description)}`] : []),
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

function writeMeeting({ dir, title, at, id = '', description = '', now = new Date() } = {}) {
  if (!dir) return { mode: 'simulated', file: null, uid: null };
  const ics = buildIcs({ title, at, id, description, now });
  fs.mkdirSync(dir, { recursive: true });
  const hash = crypto.createHash('sha256').update(`${title}|${at}|${id}`).digest('hex').slice(0, 12);
  const file = path.join(dir, `meeting-${hash}.ics`);
  fs.writeFileSync(file, ics, { encoding: 'utf8', mode: 0o600 });
  const uidMatch = /^UID:(.+)$/m.exec(ics);
  return { mode: 'written', file, uid: uidMatch ? uidMatch[1].trim() : null };
}

// 环境变量 → 写入函数；未配置返回 null（调用方保持模拟）
function createCalendarWriterFromEnv(env = process.env) {
  const dir = env.SAFE_OFFICE_CALENDAR_DIR ? String(env.SAFE_OFFICE_CALENDAR_DIR) : null;
  if (!dir) return null;
  return async (input) => writeMeeting({ ...input, dir });
}

module.exports = {
  buildIcs, writeMeeting, createCalendarWriterFromEnv, escapeIcsText, toIcsUtc, parseWhen,
};
