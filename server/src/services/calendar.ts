import { DateTime } from 'luxon';
import type { Db } from '../lib/db.js';
import { many, one } from '../lib/db.js';

export interface DayCapacity {
  date: string;
  status: 'working' | 'non_working' | 'holiday' | 'leave' | 'partial_leave';
  holiday: string | null;
  leave: { kind: string; portion: string } | null;
  /** Scheduled window(s) in UTC ISO after removing leave portions. */
  windows: { start: string; end: string }[];
  breakMinutes: number;
  availableMinutes: number;
  schedule: { start: string; end: string } | null;
  timezone: string;
}

export interface CalendarData {
  timezone: string;
  schedule: Map<number, { start_minute: number; end_minute: number; break_minutes: number }>;
  holidays: Map<string, string>;
  leave: { start_date: string; end_date: string; portion: string; kind: string }[];
}

export async function loadCalendar(db: Db, userId: string, from: string, to: string): Promise<CalendarData> {
  const u = await one(db, `select coalesce(u.timezone, t.timezone) as tz from users u join tenants t on t.id = u.tenant_id where u.id = $1`, [userId]);
  const own = await many(db, `select * from work_schedules where user_id = $1`, [userId]);
  const rows = own.length ? own : await many(db, `select * from work_schedules where user_id is null`);
  const holidays = await many(db, `select date, name from holidays where date between $1 and $2`, [from, to]);
  const leave = await many(db, `select start_date, end_date, portion, kind from leave_entries
    where user_id = $1 and start_date <= $3 and end_date >= $2`, [userId, from, to]);
  return {
    timezone: u?.tz || 'UTC',
    schedule: new Map(rows.map((r) => [r.weekday, r])),
    holidays: new Map(holidays.map((h) => [h.date, h.name])),
    leave,
  };
}

/**
 * Calendars for many people in three queries (schedules, holidays, leave). `scheduleKey` names the schedule a person follows
 * ('default' or their id), so callers can share per-day capacity between people with the same timezone and schedule.
 */
export async function loadCalendars(db: Db, users: { id: string; tz: string }[], from: string, to: string): Promise<Map<string, CalendarData & { scheduleKey: string }>> {
  const ids = users.map((u) => u.id);
  const [schedules, holidays, leave] = await Promise.all([
    many(db, `select user_id, weekday, start_minute, end_minute, break_minutes from work_schedules where user_id is null or user_id = any($1::uuid[])`, [ids]),
    many(db, `select date::text as date, name from holidays where date between $1 and $2`, [from, to]),
    many(db, `select user_id, start_date::text as start_date, end_date::text as end_date, portion, kind from leave_entries
      where user_id = any($1::uuid[]) and start_date <= $3 and end_date >= $2`, [ids, from, to]),
  ]);
  const hol = new Map(holidays.map((h) => [h.date, h.name]));
  const def = schedules.filter((s) => !s.user_id);
  const cals = new Map<string, CalendarData & { scheduleKey: string }>();
  for (const u of users) {
    const own = schedules.filter((s) => s.user_id === u.id);
    cals.set(u.id, { timezone: u.tz, schedule: new Map((own.length ? own : def).map((r) => [r.weekday, r])), holidays: hol, leave: leave.filter((l) => l.user_id === u.id),
      scheduleKey: own.length ? u.id : 'default' });
  }
  return cals;
}

/** Bulk calendars for people known only by id (their timezone, else the organization's). */
export async function loadCalendarsFor(db: Db, userIds: string[], from: string, to: string) {
  const users = userIds.length ? await many(db, `select u.id, coalesce(u.timezone, t.timezone) tz from users u join tenants t on t.id = u.tenant_id where u.id = any($1::uuid[])`, [userIds]) : [];
  return loadCalendars(db, users.map((u) => ({ id: u.id, tz: u.tz || 'UTC' })), from, to);
}

/** Available capacity for one local date. Zero capacity days are reported, never divided by. */
export function dayCapacity(cal: CalendarData, date: string): DayCapacity {
  const d = DateTime.fromISO(date, { zone: cal.timezone });
  const base: DayCapacity = { date, status: 'non_working', holiday: null, leave: null, windows: [], breakMinutes: 0, availableMinutes: 0, schedule: null, timezone: cal.timezone };
  const s = cal.schedule.get(d.weekday);
  if (!s) return base;
  const start = d.startOf('day').plus({ minutes: s.start_minute });
  const end = d.startOf('day').plus({ minutes: s.end_minute });
  base.schedule = { start: start.toFormat('HH:mm'), end: end.toFormat('HH:mm') };
  const holiday = cal.holidays.get(date);
  if (holiday) return { ...base, status: 'holiday', holiday };
  const lv = cal.leave.find((l) => l.start_date <= date && l.end_date >= date);
  const span = s.end_minute - s.start_minute;
  if (lv && lv.portion === 'full') return { ...base, status: 'leave', leave: { kind: lv.kind, portion: lv.portion } };
  let ws = start, we = end, brk = s.break_minutes;
  if (lv) {
    const mid = start.plus({ minutes: Math.floor(span / 2) });
    if (lv.portion === 'half_am') ws = mid; else we = mid;
    brk = Math.floor(brk / 2);
  }
  const minutes = Math.max(0, Math.round(we.diff(ws, 'minutes').minutes) - brk);
  return {
    ...base, status: lv ? 'partial_leave' : 'working', leave: lv ? { kind: lv.kind, portion: lv.portion } : null,
    windows: [{ start: ws.toUTC().toISO()!, end: we.toUTC().toISO()! }], breakMinutes: brk, availableMinutes: minutes,
  };
}

export function eachDate(from: string, to: string): string[] {
  const out: string[] = [];
  let d = DateTime.fromISO(from);
  const end = DateTime.fromISO(to);
  while (d <= end && out.length < 400) { out.push(d.toISODate()!); d = d.plus({ days: 1 }); }
  return out;
}

export function localToday(tz: string) { return DateTime.now().setZone(tz).toISODate()!; }
/** A person's local today (their own timezone, else the organization's). */
export async function userToday(db: Db, userId: string) {
  const u = await one(db, `select coalesce(u.timezone, t.timezone) tz from users u join tenants t on t.id = u.tenant_id where u.id = $1`, [userId]);
  return localToday(u?.tz || 'UTC');
}
export function localDayBounds(tz: string, date: string) {
  const d = DateTime.fromISO(date, { zone: tz });
  return { start: d.startOf('day').toUTC().toISO()!, end: d.plus({ days: 1 }).startOf('day').toUTC().toISO()! };
}
