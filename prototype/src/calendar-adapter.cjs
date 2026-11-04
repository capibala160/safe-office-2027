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

function validYmd(year, month, day) {
  if (![year, month, day].every((n) => Number.isInteger(n))) return false;
  if (month < 1 || month > 12 || day < 1) return false;
  const probe = new Date(Date.UTC(2000, 0, 1));
  probe.setUTCFullYear(year, month - 1, day);
  return probe.getUTCFullYear() === year
    && probe.getUTCMonth() === month - 1
    && probe.getUTCDate() === day;
}

// 只接受明确支持的格式：YYYY-MM-DD[(T| )HH:mm[:ss][.SSS]][Z|±HH:mm]
// 其他格式（2027/02/30、2027-2-30 等）一律拒绝，不能交给 new Date 猜。
// 各段都有固定长度/量词，输入长度有限，不存在灾难性回溯。
// eslint-disable-next-line security/detect-unsafe-regex
const WHEN_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

function parseWhen(at) {
  if (at instanceof Date) return Number.isNaN(at.getTime()) ? null : new Date(at.getTime());
  const src = String(at === undefined || at === null ? '' : at).trim();
  if (!src) return null;
  const m = src.match(WHEN_RE);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (!validYmd(year, month, day)) return null;

  // 带时间
  if (m[4] !== undefined) {
    const hour = Number(m[4]);
    const minute = Number(m[5]);
    const second = m[6] ? Number(m[6]) : 0;
    if (hour > 23 || minute > 59 || second > 59) return null;
    if (m[8]) {
      // 带时区：格式已严格限定，交给 Date 做时区换算；再确认解析结果存在
      const zoned = new Date(src);
      return Number.isNaN(zoned.getTime()) ? null : zoned;
    }
    const date = new Date(2000, 0, 1, hour, minute, second);
    date.setFullYear(year, month - 1, day);
    return date;
  }

  // 只有日期：按本机时区 00:00
  const date = new Date(2000, 0, 1, 0, 0, 0);
  date.setFullYear(year, month - 1, day);
  return date;
}

function buildIcs({ title, at, id = '', description = '', now = new Date() } = {}) {
  const start = parseWhen(at);
  if (!start) throw new Error(`会议时间无法解析或日期不存在：${String(at || '(空)')}`);
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

// 环境变量 → 写入函数；未配置返回 null（调用方保持模拟）。
// 配了 SAFE_OFFICE_CALDAV_URL 时写 CalDAV（.ics 同时可在本地留一份），否则只写本地目录。
function createCalendarWriterFromEnv(env = process.env) {
  const dir = env.SAFE_OFFICE_CALENDAR_DIR ? String(env.SAFE_OFFICE_CALENDAR_DIR) : null;
  const caldavUrl = env.SAFE_OFFICE_CALDAV_URL ? String(env.SAFE_OFFICE_CALDAV_URL).trim() : '';
  if (!caldavUrl) {
    if (!dir) return null;
    return async (input) => writeMeeting({ ...input, dir });
  }
  const { createCalDavWriter } = require('./caldav-writer.cjs');
  const writer = createCalDavWriter({
    url: caldavUrl,
    username: env.SAFE_OFFICE_CALDAV_USER || '',
    password: env.SAFE_OFFICE_CALDAV_PASS || '',
    timeoutMs: Number(env.SAFE_OFFICE_CALDAV_TIMEOUT_MS) || undefined,
  });
  return async (input) => {
    const ics = buildIcs(input);
    const uidMatch = /^UID:(.+)$/m.exec(ics);
    const uid = uidMatch ? uidMatch[1].trim() : '';
    const remote = await writer.putEvent({ uid, ics });
    const local = dir ? writeMeeting({ ...input, dir }) : null;
    return { mode: 'caldav', ...remote, local };
  };
}

module.exports = {
  buildIcs, writeMeeting, createCalendarWriterFromEnv, escapeIcsText, toIcsUtc, parseWhen,
};
