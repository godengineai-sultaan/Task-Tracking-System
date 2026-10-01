import { describe, expect, it } from 'vitest';
import { parseQuickCapture, occursOn } from '../server/src/services/tasks.js';
import { allocateDay } from '../server/src/services/analytics.js';
import { dayCapacity, type CalendarData } from '../server/src/services/calendar.js';
import { scanForSecrets } from '../server/src/services/integrations.js';
import { totp, verifyTotp, base32Encode, encrypt, decrypt } from '../server/src/lib/crypto.js';
import { toCsv } from '../server/src/services/exports.js';

describe('quick capture parser', () => {
  it('parses the plan example into structured fields', () => {
    const p = parseQuickCapture('Prepare laptop PO draft today — 30 minutes', '2026-10-01');
    expect(p).toMatchObject({ title: 'Prepare laptop PO draft', dueDate: '2026-10-01', estimateMinutes: 30 });
  });
  it('handles project, priority, owner, category and weekday', () => {
    const p = parseQuickCapture('Reconcile bank #FIN !high @meera /finance fri 2h', '2026-10-01');
    expect(p).toMatchObject({ title: 'Reconcile bank', projectKey: 'FIN', priority: 'high', ownerHint: 'meera', category: 'finance', dueDate: '2026-10-02', estimateMinutes: 120 });
  });
  it('leaves unknown fields null rather than inventing them', () => {
    const p = parseQuickCapture('Call the vendor', '2026-10-01');
    expect(p).toMatchObject({ title: 'Call the vendor', dueDate: null, estimateMinutes: null, priority: null, projectKey: null });
  });
});

const cal = (over: Partial<CalendarData> = {}): CalendarData => ({
  timezone: 'Asia/Kolkata',
  schedule: new Map([1, 2, 3, 4, 5].map((d) => [d, { start_minute: 540, end_minute: 1020, break_minutes: 60 }])),
  holidays: new Map(), leave: [], ...over,
});

describe('capacity', () => {
  it('working day = schedule minus break', () => {
    const c = dayCapacity(cal(), '2026-09-30');
    expect(c.status).toBe('working'); expect(c.availableMinutes).toBe(420);
  });
  it('weekend, holiday and full leave have zero capacity', () => {
    expect(dayCapacity(cal(), '2026-10-03').availableMinutes).toBe(0);
    expect(dayCapacity(cal({ holidays: new Map([['2026-10-02', 'Gandhi Jayanti']]) }), '2026-10-02')).toMatchObject({ status: 'holiday', availableMinutes: 0 });
    expect(dayCapacity(cal({ leave: [{ start_date: '2026-09-28', end_date: '2026-09-30', portion: 'full', kind: 'leave' }] }), '2026-09-29')).toMatchObject({ status: 'leave', availableMinutes: 0 });
  });
  it('half-day leave halves the window and break', () => {
    const c = dayCapacity(cal({ leave: [{ start_date: '2026-09-30', end_date: '2026-09-30', portion: 'half_pm', kind: 'leave' }] }), '2026-09-30');
    expect(c.status).toBe('partial_leave'); expect(c.availableMinutes).toBe(240 - 30);
  });
});

describe('non-overlapping allocation', () => {
  const capacity = dayCapacity(cal(), '2026-09-30');
  const dayStart = Date.parse('2026-09-29T18:30:00Z'), dayEnd = Date.parse('2026-09-30T18:30:00Z');
  const e = (id: string, source: string, category: string, s: string, en: string) => ({ id, source, category, started_at: s, ended_at: en, created_at: s });
  it('counts a timer running through a calendar meeting once and reports the conflict', () => {
    // 10:00–11:00 IST timer, 10:30–11:30 IST calendar meeting
    const r = allocateDay([e('t', 'timer', 'task', '2026-09-30T04:30:00Z', '2026-09-30T05:30:00Z'), e('m', 'calendar', 'meeting', '2026-09-30T05:00:00Z', '2026-09-30T06:00:00Z')], capacity, dayStart, dayEnd, Date.now());
    expect(r.explainedMinutes).toBe(90);
    expect(r.byCategory.task).toBe(60); expect(r.byCategory.meeting).toBe(30);
    expect(r.conflicts).toHaveLength(1); expect(r.conflicts[0].minutes).toBe(30);
    expect(r.unknownMinutes).toBe(420 - 90);
  });
  it('the same meeting imported twice is not double counted', () => {
    const r = allocateDay([e('a', 'calendar', 'meeting', '2026-09-30T05:00:00Z', '2026-09-30T06:00:00Z'), e('b', 'calendar', 'meeting', '2026-09-30T05:00:00Z', '2026-09-30T06:00:00Z')], capacity, dayStart, dayEnd, Date.now());
    expect(r.explainedMinutes).toBe(60);
  });
  it('time outside the schedule is reported separately and coverage is capped at available time', () => {
    const r = allocateDay([e('x', 'manual', 'task', '2026-09-30T01:30:00Z', '2026-09-30T14:30:00Z')], capacity, dayStart, dayEnd, Date.now()); // 07:00–20:00 IST
    expect(r.explainedMinutes).toBe(420); expect(r.coverage).toBe(1); expect(r.outsideScheduleMinutes).toBe(300); expect(r.unknownMinutes).toBe(0);
  });
  it('zero capacity gives null coverage (Not Applicable), never a division by zero', () => {
    const sat = dayCapacity(cal(), '2026-10-03');
    const r = allocateDay([], sat, Date.parse('2026-10-02T18:30:00Z'), Date.parse('2026-10-03T18:30:00Z'), Date.now());
    expect(r.coverage).toBeNull(); expect(r.unknownMinutes).toBe(0);
  });
});

describe('recurrence rules', () => {
  it('weekdays/weekly/monthly', () => {
    expect(occursOn({ rule: 'weekdays' }, '2026-10-03')).toBe(false);
    expect(occursOn({ rule: 'weekly', weekday: 4 }, '2026-10-01')).toBe(true);
    expect(occursOn({ rule: 'monthly', month_day: 1 }, '2026-10-01')).toBe(true);
  });
});

describe('security primitives', () => {
  it('secret scanner rejects credential fields and secret-looking values but allows references', () => {
    expect(scanForSecrets({ credential_ref: 'CRED-1', system_name: 'AWS' })).toBeNull();
    expect(scanForSecrets({ password: 'x' })).toMatch(/forbidden/);
    expect(scanForSecrets({ nested: { api_key: 'abc' } })).toMatch(/forbidden/);
    expect(scanForSecrets({ note: 'key AKIAABCDEFGHIJKLMNOP' })).toMatch(/secret/);
  });
  it('TOTP verifies the current code; AES-GCM round-trips', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(verifyTotp(secret, totp(secret))).toBe(true);
    expect(decrypt(encrypt('hello'))).toBe('hello');
  });
  it('CSV export neutralises spreadsheet formula injection', () => {
    const out = toCsv('team_daily', { rows: [{ date: '2026-10-01', user: { name: '=HYPERLINK("x")', department: null }, capacityStatus: 'working', availableMinutes: 1, plan: [],
      acceptedPlanned: 0, inProgress: 0, blocked: 0, overdue: 0, explainedMinutes: 0, unknownMinutes: 1, coverage: 0, recapStatus: 'missing', assessment: 'insufficient_data' }] });
    expect(out).toContain(`"'=HYPERLINK(""x"")"`);
  });
});
