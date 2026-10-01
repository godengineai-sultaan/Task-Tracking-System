import { DateTime } from 'luxon';
import { z } from 'zod';
import type { Db } from '../../lib/db.js';
import { many, one } from '../../lib/db.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { assertCanViewPerson, requireStaff, type Actor } from '../access.js';
import { allocateDay, METRIC_DEFINITIONS } from '../analytics.js';
import { dayCapacity, eachDate, loadCalendar, localDayBounds, localToday } from '../calendar.js';
import { csvCell, registerExportReport } from '../exports.js';

/**
 * Personal 12-week trends and focus review.
 * Everything here is computed from the person's own recorded work (time entries they confirmed, plans, recaps,
 * blockers, accepted tasks) with a handful of range queries — never per-day report builds. No scores, no ranking,
 * no comparison with other people. Unknown (unrecorded) time is never treated as idle or unfocused.
 */
export const TRENDS_DEFINITIONS = {
  version: 'trends-v1',
  comparable_working_days: 'Completed scheduled working days in the week (today is excluded until it is over), after holidays and full-day leave. Days before the person\'s records begin (account creation or the first plan, recap or time entry, whichever is earlier) are not counted. A week with none is Not Applicable: its ratios are left empty, never averaged as zero.',
  planned_commitment_completion: METRIC_DEFINITIONS.planned_commitment_completion,
  accepted_outcomes: 'Tasks you own that reached Done (accepted) during the week, by acceptance date.',
  logging_coverage: `${METRIC_DEFINITIONS.logging_coverage} Coverage is about record completeness, not productivity.`,
  unknown_time: METRIC_DEFINITIONS.unknown_time,
  blocked_time: 'Minutes inside the scheduled window during which at least one task you own had an open blocker.',
  meeting_share: 'Confirmed meeting minutes inside the scheduled window divided by available time.',
  focus_time: 'Confirmed time on one task inside the scheduled window in runs of at least 60 minutes. Gaps of up to 5 minutes are tolerated; a meeting, a different task or a longer gap ends the run. Unrecorded time is unknown, not unfocused.',
  fragmentation: 'Switches between different work items (a task, or a meeting/admin/learning/other entry) in consecutive confirmed time entries, per day that has confirmed entries.',
  carryover_rate: 'Intended outcomes not accepted (and not cancelled) by the end of their planned day, divided by intended outcomes.',
  estimate_accuracy: 'For accepted tasks with an estimate and logged time: the owner\'s confirmed minutes linked to the task (all dates, overlaps counted once) divided by the estimate. 1.0x = as estimated. Coverage = accepted tasks with both an estimate and logged time, divided by accepted tasks. Collaborators\' time is not included.',
  recap_completion: 'Confirmed (or manager-reviewed) recaps divided by completed scheduled working days (today is not counted until it is over).',
};

export const TREND_THRESHOLDS = { focusMinMinutes: 60, focusGapMinutes: 5, meetingHeavyShare: 0.5, estimateMinTasks: 3, overrunRatio: 1.4, underrunRatio: 0.7,
  switchesPerDay: 8, carryoverRate: 0.5, blockedShare: 0.2, recapRate: 0.6, shiftPoints: 0.1 };

/** Query/export parameters. `end` must be a real calendar date (the week containing it is the last week shown). */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((v) => DateTime.fromISO(v).isValid, 'must be a real calendar date');
export const trendsParams = z.object({ userId: z.string().uuid().optional(), weeks: z.coerce.number().int().min(4).max(26).default(12), end: isoDate.optional() });

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const PRECEDENCE: Record<string, number> = { manual: 0, timer: 1, integration: 2, calendar: 3 };
const ms = (v: string | Date) => (typeof v === 'string' ? Date.parse(v) : v.getTime());
const MIN = 60000;
const ratio = (a: number, b: number) => (b > 0 ? a / b : null);
const pctS = (v: number | null) => (v === null ? 'n/a' : `${Math.round(v * 100)}%`);
const hmS = (m: number) => { const h = Math.floor(m / 60), r = Math.round(m % 60); return h ? `${h}h${r ? ` ${r}m` : ''}` : `${r}m`; };
const xS = (v: number) => `${v.toFixed(1)}x`;
const dayS = (d: string) => DateTime.fromISO(d).toFormat('ccc d LLL');
const workKey = (e: any) => (e.category === 'task' ? `task:${e.task_id ?? 'unlinked'}` : `cat:${e.category}`);

interface Seg { a: number; b: number; key: string }

/** Non-overlapping timeline of one local day: the highest-precedence confirmed entry wins each instant (same rule as allocation). */
export function primarySegments(entries: any[], dayStart: number, dayEnd: number, now: number): Seg[] {
  const ivs = entries.map((e) => ({ e, a: Math.max(ms(e.started_at), dayStart), b: Math.min(e.ended_at ? ms(e.ended_at) : Math.min(now, dayEnd), dayEnd) }))
    .filter((x) => x.b > x.a);
  const pts = [...new Set(ivs.flatMap((x) => [x.a, x.b]))].sort((x, y) => x - y);
  const segs: Seg[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const active = ivs.filter((x) => x.a <= a && x.b >= b);
    if (!active.length) continue;
    active.sort((x, y) => (PRECEDENCE[x.e.source] - PRECEDENCE[y.e.source]) || (ms(x.e.created_at) - ms(y.e.created_at)));
    const key = workKey(active[0].e);
    const last = segs[segs.length - 1];
    if (last && last.key === key && last.b === a) last.b = b; else segs.push({ a, b, key });
  }
  return segs;
}

/** Focus blocks: runs on one task, clipped to the scheduled windows, gaps <= 5 min tolerated, >= 60 minutes. */
export function focusBlocks(segs: Seg[], windows: [number, number][]) {
  const clipped = segs.flatMap((s) => windows.map(([w0, w1]) => ({ key: s.key, a: Math.max(s.a, w0), b: Math.min(s.b, w1) }))).filter((s) => s.b > s.a).sort((x, y) => x.a - y.a);
  const runs: { key: string; a: number; b: number; minutes: number }[] = [];
  let cur: (typeof runs)[number] | null = null;
  for (const s of clipped) {
    if (cur && cur.key === s.key && s.a - cur.b <= TREND_THRESHOLDS.focusGapMinutes * MIN) { cur.b = s.b; cur.minutes += (s.b - s.a) / MIN; }
    else { if (cur) runs.push(cur); cur = { key: s.key, a: s.a, b: s.b, minutes: (s.b - s.a) / MIN }; }
  }
  if (cur) runs.push(cur);
  return runs.filter((r) => r.key.startsWith('task:') && r.minutes >= TREND_THRESHOLDS.focusMinMinutes);
}

/** Switches between consecutive work items (a gap between two entries of the same item is not a switch). */
export function taskSwitches(segs: Seg[]) {
  let n = 0;
  for (let i = 1; i < segs.length; i++) if (segs[i].key !== segs[i - 1].key) n++;
  return n;
}

function mergedMinutes(ivs: [number, number][]) {
  const s = ivs.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  let total = 0; let cur: [number, number] | null = null;
  for (const iv of s) { if (!cur || iv[0] > cur[1]) { if (cur) total += cur[1] - cur[0]; cur = [iv[0], iv[1]]; } else cur[1] = Math.max(cur[1], iv[1]); }
  if (cur) total += cur[1] - cur[0];
  return total / MIN;
}

export async function buildPersonalTrends(db: Db, userId: string, weeks = 12, endDate?: string) {
  const u = await one(db, `select u.id, u.name, u.title, u.created_at, coalesce(u.timezone, t.timezone) tz, t.settings, rp.coverage_target,
      (select min(started_at) from time_entries where user_id = u.id and deleted_at is null) first_entry,
      (select min(date) from daily_plans where user_id = u.id) first_plan, (select min(date) from daily_reviews where user_id = u.id) first_review
    from users u join tenants t on t.id = u.tenant_id left join role_profiles rp on rp.id = u.role_profile_id where u.id = $1`, [userId]);
  if (!u) throw notFound('Person not found');
  if (endDate !== undefined && !isoDate.safeParse(endDate).success) throw badRequest('end must be a real calendar date (YYYY-MM-DD)');
  const tz: string = u.tz || 'UTC';
  const localDate = (v: string | Date) => DateTime.fromJSDate(new Date(v)).setZone(tz).toISODate()!;
  // Weeks before the person had any records here are not "unknown time": they are simply not comparable.
  const recordsStart: string = [localDate(u.created_at), u.first_entry && localDate(u.first_entry), u.first_plan, u.first_review].filter(Boolean).sort()[0];
  const coverageThreshold: number = u.coverage_target ?? u.settings?.coverage_threshold ?? 0.5;
  const today = localToday(tz);
  const anchor = endDate && endDate < today ? endDate : today;
  const lastWeek = DateTime.fromISO(anchor).startOf('week');
  const firstWeek = lastWeek.minus({ weeks: weeks - 1 });
  const rangeStart = firstWeek.toISODate()!, rangeEnd = lastWeek.plus({ days: 6 }).toISODate()!;
  const tStart = localDayBounds(tz, rangeStart).start, tEnd = localDayBounds(tz, rangeEnd).end;
  const now = Date.now();

  const [cal, entries, plans, reviews, blockers, accepted] = await Promise.all([
    loadCalendar(db, userId, rangeStart, rangeEnd),
    many(db, `select id, task_id, category, source, started_at, ended_at, created_at from time_entries
      where user_id = $1 and deleted_at is null and started_at < $3 and coalesce(ended_at, now()) > $2 order by started_at`, [userId, tStart, tEnd]),
    many(db, `select dp.date, dpi.task_id from daily_plans dp join daily_plan_items dpi on dpi.plan_id = dp.id
      where dp.user_id = $1 and dp.date between $2 and $3 and dpi.removed_at is null`, [userId, rangeStart, rangeEnd]),
    many(db, `select date, status from daily_reviews where user_id = $1 and date between $2 and $3`, [userId, rangeStart, rangeEnd]),
    many(db, `select b.raised_at, b.resolved_at from blockers b join tasks t on t.id = b.task_id
      where t.owner_id = $1 and b.raised_at < $3 and coalesce(b.resolved_at, now()) > $2`, [userId, tStart, tEnd]),
    many(db, `select t.id, t.title, t.category, t.estimate_minutes, t.accepted_at, t.project_id, p.name project_name
      from tasks t left join projects p on p.id = t.project_id
      where t.owner_id = $1 and t.status = 'done' and t.accepted_at >= $2 and t.accepted_at < $3 order by t.accepted_at`, [userId, tStart, tEnd]),
  ]);
  const planTaskIds = [...new Set(plans.map((p) => p.task_id))];
  const [history, taskTime] = await Promise.all([
    many(db, `select task_id, to_status, at from task_state_history where task_id = any($1::uuid[]) order by at, id`, [planTaskIds]),
    many(db, `select task_id, started_at, ended_at from time_entries where user_id = $1 and deleted_at is null and ended_at is not null
      and task_id = any($2::uuid[])`, [userId, accepted.map((t) => t.id)]),
  ]);
  const histBy = new Map<string, any[]>();
  for (const h of history) { if (!histBy.has(h.task_id)) histBy.set(h.task_id, []); histBy.get(h.task_id)!.push(h); }
  const statusAt = (taskId: string, t: number) => { let s: string | null = null; for (const h of histBy.get(taskId) ?? []) { if (ms(h.at) <= t) s = h.to_status; else break; } return s ?? 'planned'; };
  const reviewBy = new Map(reviews.map((r) => [r.date, r.status]));
  const plansBy = new Map<string, string[]>();
  for (const p of plans) { if (!plansBy.has(p.date)) plansBy.set(p.date, []); plansBy.get(p.date)!.push(p.task_id); }
  const blockerIvs = blockers.map((b) => [ms(b.raised_at), b.resolved_at ? ms(b.resolved_at) : now] as [number, number]);

  // ---- Per-day facts ----
  const days = eachDate(rangeStart, rangeEnd).map((date) => {
    const cap = dayCapacity(cal, date);
    const future = date >= today; // not yet completed
    const beforeRecords = date < recordsStart;
    const working = cap.availableMinutes > 0 && date < today && !beforeRecords; // today is still in progress: excluded so unfinished hours never look unknown or carried over
    const base = { date, weekday: DateTime.fromISO(date).weekday, status: cap.status, future, beforeRecords, working, available: working ? cap.availableMinutes : 0,
      explained: 0, unknown: 0, meeting: 0, focus: 0, focusBlocks: 0, switches: 0, logged: false, blocked: 0,
      intended: 0, acceptedPlanned: 0, carryovers: 0, recapExpected: false, recapConfirmed: false };
    if (!working) return base;
    const { start, end } = localDayBounds(tz, date);
    const d0 = ms(start), d1 = ms(end);
    const dayEntries = entries.filter((e) => ms(e.started_at) < d1 && (e.ended_at ? ms(e.ended_at) : now) > d0);
    const alloc = allocateDay(dayEntries, cap, d0, d1, now);
    const wins = cap.windows.map((w) => [ms(w.start), ms(w.end)] as [number, number]);
    const segs = primarySegments(dayEntries, d0, d1, now);
    const fb = focusBlocks(segs, wins);
    const blocked = wins.reduce((s, [w0, w1]) => s + mergedMinutes(blockerIvs.map(([a, b]) => [Math.max(a, w0), Math.min(b, w1)] as [number, number])), 0);
    const endT = Math.min(d1, now);
    const intended = plansBy.get(date) ?? [];
    const statuses = intended.map((id) => statusAt(id, endT));
    const recapConfirmed = ['confirmed', 'manager_reviewed'].includes(reviewBy.get(date) ?? '');
    return { ...base, explained: alloc.explainedMinutes, unknown: alloc.unknownMinutes, meeting: alloc.byCategory.meeting,
      // Windows span the whole scheduled day including the break: cap both at what the day can actually hold.
      focus: Math.round(Math.min(fb.reduce((s, r) => s + r.minutes, 0), alloc.explainedMinutes)), focusBlocks: fb.length, switches: taskSwitches(segs), logged: alloc.explainedMinutes > 0,
      blocked: Math.round(Math.min(blocked, cap.availableMinutes)), intended: intended.length, acceptedPlanned: statuses.filter((s) => s === 'done').length,
      carryovers: statuses.filter((s) => s !== 'done' && s !== 'cancelled').length,
      recapExpected: true, recapConfirmed };
  });

  // ---- Accepted-task estimate accuracy ----
  const timeBy = new Map<string, [number, number][]>();
  for (const e of taskTime) { if (!timeBy.has(e.task_id)) timeBy.set(e.task_id, []); timeBy.get(e.task_id)!.push([ms(e.started_at), ms(e.ended_at)]); }
  const acc = accepted.map((t) => {
    const actual = Math.round(mergedMinutes(timeBy.get(t.id) ?? []));
    const acceptedDate = DateTime.fromJSDate(new Date(t.accepted_at)).setZone(tz).toISODate()!;
    return { taskId: t.id as string, title: t.title as string, category: t.category as string, projectId: t.project_id as string | null, project: (t.project_name ?? null) as string | null,
      estimate: t.estimate_minutes as number | null, actual, acceptedDate, measured: !!t.estimate_minutes && actual > 0 };
  });
  const estimateGroup = (key: string, label: string, list: typeof acc) => {
    const m = list.filter((t) => t.measured);
    const est = m.reduce((s, t) => s + t.estimate!, 0), act = m.reduce((s, t) => s + t.actual, 0);
    return { key, label, accepted: list.length, measured: m.length, coverage: ratio(m.length, list.length), estimateMinutes: est, actualMinutes: act, ratio: ratio(act, est),
      tasks: m.map((t) => ({ taskId: t.taskId, title: t.title, estimate: t.estimate, actual: t.actual, ratio: t.actual / t.estimate! })).sort((x, y) => y.ratio - x.ratio).slice(0, 5) };
  };
  const groupBy = (f: (t: (typeof acc)[number]) => [string, string]) => {
    const g = new Map<string, { label: string; list: typeof acc }>();
    for (const t of acc) { const [k, l] = f(t); if (!g.has(k)) g.set(k, { label: l, list: [] }); g.get(k)!.list.push(t); }
    return [...g.entries()].map(([k, v]) => estimateGroup(k, v.label, v.list)).sort((x, y) => y.accepted - x.accepted || x.label.localeCompare(y.label));
  };
  const catLabel = (c: string) => c[0].toUpperCase() + c.slice(1);
  const estimateAccuracy = {
    overall: estimateGroup('all', 'All accepted tasks', acc),
    byCategory: groupBy((t) => [t.category, catLabel(t.category)]),
    byProject: groupBy((t) => [t.projectId ?? 'none', t.project ?? 'No project']),
  };

  // ---- Weekly series ----
  const series: any[] = [];
  for (let w = 0; w < weeks; w++) {
    const ws = firstWeek.plus({ weeks: w }).toISODate()!, we = firstWeek.plus({ weeks: w, days: 6 }).toISODate()!;
    const wd = days.filter((d) => d.date >= ws && d.date <= we);
    const work = wd.filter((d) => d.working);
    const sum = (f: (d: (typeof days)[number]) => number) => work.reduce((s, d) => s + f(d), 0);
    const available = sum((d) => d.available), explained = sum((d) => d.explained), meeting = sum((d) => d.meeting), focus = sum((d) => d.focus);
    const intended = sum((d) => d.intended), acceptedPlanned = sum((d) => d.acceptedPlanned), carry = sum((d) => d.carryovers);
    const loggedDays = work.filter((d) => d.logged).length, switches = sum((d) => (d.logged ? d.switches : 0));
    const recapExpected = work.filter((d) => d.recapExpected).length, recapConfirmed = work.filter((d) => d.recapExpected && d.recapConfirmed).length;
    const wkAcc = acc.filter((t) => t.acceptedDate >= ws && t.acceptedDate <= we);
    const wkEst = estimateGroup('week', ws, wkAcc);
    const applicable = work.length > 0;
    const sched = wd.filter((d) => !d.future && d.status !== 'non_working');
    const holidays = sched.filter((d) => d.status === 'holiday').length, leave = sched.filter((d) => d.status === 'leave').length;
    const pre = sched.filter((d) => d.beforeRecords).length;
    const naReason = applicable ? null
      : pre ? `Records for this person begin on ${dayS(recordsStart)}; ${pre} scheduled day(s) this week came before that${sched.length > pre ? ' and the rest were holidays or leave' : ''}, so ratios are not applicable.`
      : sched.length ? `All ${sched.length} scheduled day(s) were holidays or leave (${holidays} holiday, ${leave} leave) — zero available capacity, so ratios are not applicable.`
      : ws <= today && we >= today ? 'Week in progress: no completed working days yet.' : 'No scheduled working days this week.';
    const r = (a: number, b: number) => (applicable ? ratio(a, b) : null);
    series.push({
      weekStart: ws, weekEnd: we, partial: we >= today, status: applicable ? 'applicable' : 'not_applicable', naReason,
      workingDays: work.length, holidayDays: holidays, leaveDays: leave,
      availableMinutes: available, explainedMinutes: explained, unknownMinutes: available - explained, loggingCoverage: r(explained, available),
      meetingMinutes: meeting, meetingShare: r(meeting, available), focusMinutes: focus, focusBlocks: sum((d) => d.focusBlocks), focusShare: r(focus, available),
      daysWithFocusBlock: work.filter((d) => d.focusBlocks > 0).length,
      loggedDays, taskSwitches: switches, switchesPerDay: applicable && loggedDays ? switches / loggedDays : null,
      blockedMinutes: sum((d) => d.blocked), blockedShare: r(sum((d) => d.blocked), available),
      intendedOutcomes: intended, acceptedPlanned, plannedCompletion: r(acceptedPlanned, intended), carryovers: carry, carryoverRate: r(carry, intended),
      acceptedOutcomes: wkAcc.length,
      estimate: { accepted: wkEst.accepted, measured: wkEst.measured, coverage: wkEst.coverage, estimateMinutes: wkEst.estimateMinutes, actualMinutes: wkEst.actualMinutes, ratio: wkEst.ratio },
      recaps: { expected: recapExpected, confirmed: recapConfirmed, rate: r(recapConfirmed, recapExpected) },
    });
  }

  // ---- Focus vs meeting review by weekday ----
  const workingDays = days.filter((d) => d.working);
  const weekdays = [1, 2, 3, 4, 5, 6, 7].map((n) => {
    const ds = workingDays.filter((d) => d.weekday === n);
    if (!ds.length) return null;
    const av = ds.reduce((s, d) => s + d.available, 0);
    const logged = ds.filter((d) => d.available && d.explained / d.available >= coverageThreshold);
    return { weekday: n, label: WEEKDAYS[n - 1], days: ds.length,
      availableMinutes: av, meetingMinutes: ds.reduce((s, d) => s + d.meeting, 0), focusMinutes: ds.reduce((s, d) => s + d.focus, 0),
      meetingShare: ratio(ds.reduce((s, d) => s + d.meeting, 0), av), focusShare: ratio(ds.reduce((s, d) => s + d.focus, 0), av),
      meetingHeavyDays: ds.filter((d) => d.meeting / d.available > TREND_THRESHOLDS.meetingHeavyShare).length,
      wellLoggedDays: logged.length, wellLoggedWithoutFocus: logged.filter((d) => d.focusBlocks === 0).length };
  }).filter((x): x is NonNullable<typeof x> => !!x);

  const applicable = series.filter((s) => s.status === 'applicable');
  const tot = (f: (s: (typeof series)[number]) => number) => applicable.reduce((s, w) => s + f(w), 0);
  const summary = {
    weeks, applicableWeeks: applicable.length, notApplicableWeeks: series.length - applicable.length, comparableWorkingDays: tot((s) => s.workingDays),
    plannedCompletion: ratio(tot((s) => s.acceptedPlanned), tot((s) => s.intendedOutcomes)), acceptedOutcomes: series.reduce((s, w) => s + w.acceptedOutcomes, 0),
    loggingCoverage: ratio(tot((s) => s.explainedMinutes), tot((s) => s.availableMinutes)), unknownMinutes: tot((s) => s.unknownMinutes),
    meetingShare: ratio(tot((s) => s.meetingMinutes), tot((s) => s.availableMinutes)), focusShare: ratio(tot((s) => s.focusMinutes), tot((s) => s.availableMinutes)),
    focusMinutes: tot((s) => s.focusMinutes), switchesPerDay: ratio(tot((s) => s.taskSwitches), tot((s) => s.loggedDays)),
    blockedMinutes: tot((s) => s.blockedMinutes), carryoverRate: ratio(tot((s) => s.carryovers), tot((s) => s.intendedOutcomes)),
    recapRate: ratio(tot((s) => s.recaps.confirmed), tot((s) => s.recaps.expected)), estimateRatio: estimateAccuracy.overall.ratio,
  };

  return {
    definitions: TRENDS_DEFINITIONS, thresholds: { ...TREND_THRESHOLDS, coverage: coverageThreshold },
    subject: { id: u.id, name: u.name, title: u.title }, timezone: tz, today, recordsStart,
    range: { start: rangeStart, end: rangeEnd, weeks }, generatedAt: new Date().toISOString(),
    summary, weeks: series, weekdays, estimateAccuracy,
    patterns: findPatterns({ series, workingDays, estimateAccuracy, coverageThreshold }),
  };
}

type Pattern = { id: string; tone: 'attention' | 'positive' | 'info'; title: string; facts: string[]; suggestion: string; assumptions: string[] };

/** Rule-based, explainable observations about the person's own records. Every one carries its facts and assumptions. */
export function findPatterns({ series, workingDays, estimateAccuracy, coverageThreshold }: { series: any[]; workingDays: any[]; estimateAccuracy: any; coverageThreshold: number }): Pattern[] {
  const out: Pattern[] = [];
  const T = TREND_THRESHOLDS;
  const applicable = series.filter((s) => s.status === 'applicable');
  const recent = applicable.slice(-4);
  const timeAssumption = 'Based only on confirmed time entries; unrecorded time is unknown and is not treated as idle.';

  // 1. Meeting-heavy weekday (last up to 6 working occurrences of that weekday).
  for (let wd = 1; wd <= 7; wd++) {
    const occ = workingDays.filter((d) => d.weekday === wd).slice(-6);
    if (occ.length < 3) continue;
    const heavy = occ.filter((d) => d.meeting / d.available > T.meetingHeavyShare);
    if (heavy.length < 3 || heavy.length < Math.ceil(occ.length / 2)) continue;
    const name = WEEKDAYS[wd - 1];
    out.push({ id: `meetings-weekday-${wd}`, tone: 'attention',
      title: `Meetings took over 50% of available time on ${heavy.length} of the last ${occ.length} ${name}s`,
      facts: heavy.map((d) => `${dayS(d.date)}: ${hmS(d.meeting)} of meetings out of ${hmS(d.available)} available (${pctS(d.meeting / d.available)})`),
      suggestion: `If that is more than you intended, consider protecting a focus block on ${name}s or moving a recurring meeting to a lighter day.`,
      assumptions: ['Meeting time comes from confirmed entries (accepted calendar suggestions, timers, manual entries).', `Only scheduled working ${name}s are counted; holidays and leave are excluded.`] });
  }

  // 2. Estimate accuracy by category and project (needs >= 3 measured tasks).
  // A project holding exactly the same tasks as a category would repeat the same observation: fold it into a fact instead.
  const sameTasks = (g: any) => `${g.accepted}|${g.measured}|${g.estimateMinutes}|${g.actualMinutes}`;
  const byCategoryTasks = new Map<string, Pattern>();
  for (const [dim, groups] of [['category', estimateAccuracy.byCategory], ['project', estimateAccuracy.byProject]] as const) {
    for (const g of groups) {
      if (g.measured < T.estimateMinTasks || g.ratio === null) continue;
      const over = g.ratio >= T.overrunRatio, under = g.ratio <= T.underrunRatio;
      if (!over && !under) continue;
      const noProject = dim === 'project' && g.key === 'none';
      const twin = dim === 'project' ? byCategoryTasks.get(sameTasks(g)) : undefined;
      if (twin) { twin.facts.splice(2, 0, `The same ${g.accepted} task(s) are all ${noProject ? 'without a project' : `in project ${g.label}`}`); continue; }
      const where = dim === 'category' ? `Tasks in ${g.label}` : noProject ? 'Tasks without a project' : `Tasks in project ${g.label}`;
      const p: Pattern = { id: `estimate-${dim}-${g.key}`, tone: over ? 'attention' : 'info',
        title: over ? `${where} run ${xS(g.ratio)} their estimates on average (${g.measured} tasks)` : `${where} take about ${xS(g.ratio)} of their estimates on average (${g.measured} tasks)`,
        facts: [`${hmS(g.actualMinutes)} logged against ${hmS(g.estimateMinutes)} estimated across ${g.measured} accepted task(s)`,
          `Coverage: ${g.measured} of ${g.accepted} accepted task(s) had both an estimate and logged time`,
          ...g.tasks.slice(0, 3).map((t: any) => `"${t.title}": ${hmS(t.actual)} vs ${hmS(t.estimate)} estimated (${xS(t.ratio)})`)],
        suggestion: over ? `When sizing new ${dim === 'category' ? g.label.toLowerCase() : noProject ? 'unassigned' : g.label} work, consider allowing roughly ${xS(g.ratio)} the first estimate or splitting it into smaller tasks.`
          : 'Estimates here look generous; tighter estimates make capacity planning more accurate.',
        assumptions: ['Actual = the owner\'s confirmed time linked to each task; unlogged time and collaborators\' time is not included (so ratios may be understated).',
          `Ratio = total logged / total estimated for accepted tasks with both; needs at least ${T.estimateMinTasks} tasks.`] };
      out.push(p);
      if (dim === 'category') byCategoryTasks.set(sameTasks(g), p);
    }
  }

  // 3. Focus blocks on well-logged days in the last 4 applicable weeks.
  if (recent.length) {
    const from = recent[0].weekStart;
    const logged = workingDays.filter((d) => d.date >= from && d.explained / d.available >= coverageThreshold);
    const without = logged.filter((d) => d.focusBlocks === 0);
    if (logged.length >= 5 && without.length / logged.length >= 0.6) {
      out.push({ id: 'focus-missing', tone: 'attention',
        title: `No ${T.focusMinMinutes}-minute focus block on ${without.length} of the last ${logged.length} well-logged working days`,
        facts: [`Days counted: working days since ${dayS(from)} with logging coverage of at least ${pctS(coverageThreshold)}`,
          `Days without a focus block: ${without.slice(-6).map((d) => dayS(d.date)).join(', ')}${without.length > 6 ? ', ...' : ''}`],
        suggestion: 'Try reserving one 60 to 90 minute block for the top intended outcome on a few days a week.',
        assumptions: [timeAssumption, `A focus block is ${T.focusMinMinutes}+ minutes on one task with gaps of at most ${T.focusGapMinutes} minutes.`, 'Days with low coverage are skipped, because their time is mostly unknown.'] });
    }
  }

  // 4. Shifts in focus and meeting share: last 4 applicable weeks vs the earlier applicable weeks (each >= 3 weeks, coverage OK).
  const okCov = (s: any) => s.loggingCoverage !== null && s.loggingCoverage >= coverageThreshold;
  const late = recent.filter(okCov), early = applicable.slice(0, -4).filter(okCov);
  if (late.length >= 3 && early.length >= 3) {
    const share = (ws: any[], k: 'focusMinutes' | 'meetingMinutes') => ws.reduce((s, w) => s + w[k], 0) / ws.reduce((s, w) => s + w.availableMinutes, 0);
    for (const [k, label] of [['focusMinutes', 'Focus time'], ['meetingMinutes', 'Meeting time']] as const) {
      const a = share(early, k), b = share(late, k);
      if (Math.abs(b - a) < T.shiftPoints) continue;
      const up = b > a;
      out.push({ id: `shift-${k}`, tone: k === 'focusMinutes' ? (up ? 'positive' : 'attention') : up ? 'attention' : 'positive',
        title: `${label} ${up ? 'rose' : 'fell'} from ${pctS(a)} to ${pctS(b)} of available time`,
        facts: [`Earlier: ${early.length} week(s) from ${dayS(early[0].weekStart)}`, `Recent: ${late.length} week(s) from ${dayS(late[0].weekStart)}`,
          'Only weeks with logging coverage at or above the assessment minimum are compared'],
        suggestion: k === 'focusMinutes' ? (up ? 'Whatever changed seems to be working; keep protecting those blocks.' : 'Look at what displaced focus time recently (meetings, support, context switches) and decide if it was intended.')
          : up ? 'Check whether the extra meetings are recurring and still needed.' : 'Fewer meetings left more room in the schedule.',
        assumptions: [timeAssumption, 'Compares this person only with their own earlier weeks, never with other people.'] });
    }
  }

  // 5. Fragmentation in the last 4 applicable weeks.
  const lg = recent.reduce((s, w) => s + w.loggedDays, 0), sw = recent.reduce((s, w) => s + w.taskSwitches, 0);
  if (lg >= 5 && sw / lg >= T.switchesPerDay) {
    out.push({ id: 'fragmentation', tone: 'attention', title: `Switched between work items about ${Math.round(sw / lg)} times per logged day in the last ${recent.length} weeks`,
      facts: [`${sw} switches across ${lg} day(s) with confirmed entries`, ...recent.map((w) => `Week of ${dayS(w.weekStart)}: ${w.switchesPerDay === null ? 'no logged days' : `${w.switchesPerDay.toFixed(1)} per day`}`)],
      suggestion: 'Batching small items (tickets, admin, messages) into one or two blocks can reduce switching.',
      assumptions: [timeAssumption, `Threshold: ${T.switchesPerDay} switches per logged day. A switch is a change of work item between consecutive entries.`] });
  }

  // 6. Carryover in recent weeks.
  const carryWeeks = recent.filter((w) => w.intendedOutcomes >= 3);
  const heavyCarry = carryWeeks.filter((w) => w.carryoverRate !== null && w.carryoverRate >= T.carryoverRate);
  if (carryWeeks.length >= 3 && heavyCarry.length >= 3) {
    out.push({ id: 'carryover', tone: 'attention', title: `Half or more of intended outcomes carried over in ${heavyCarry.length} of the last ${carryWeeks.length} weeks`,
      facts: heavyCarry.map((w) => `Week of ${dayS(w.weekStart)}: ${w.carryovers} of ${w.intendedOutcomes} carried over`),
      suggestion: 'Day-sized outcomes are easier to finish; consider splitting large tasks or planning two outcomes instead of three.',
      assumptions: ['Status is taken at the end of each planned day from the task history.', 'Blocked or waiting tasks count as carried over; check the blockers chart for context.'] });
  }

  // 7. Blocked time in recent weeks.
  const blockedWeeks = recent.filter((w) => w.blockedShare !== null && w.blockedShare > T.blockedShare);
  if (blockedWeeks.length >= 2) {
    out.push({ id: 'blocked', tone: 'attention', title: `Open blockers covered over ${pctS(T.blockedShare)} of available time in ${blockedWeeks.length} of the last ${recent.length} weeks`,
      facts: blockedWeeks.map((w) => `Week of ${dayS(w.weekStart)}: ${hmS(w.blockedMinutes)} blocked of ${hmS(w.availableMinutes)} available`),
      suggestion: 'Set follow-up dates when you raise a blocker, and escalate waits that last more than a day.',
      assumptions: ['Blocked time is when at least one owned task had an open blocker, inside the schedule. It reflects waiting on others, not effort.'] });
  }

  // 8. Recap completion in the last 2 applicable weeks.
  const last2 = applicable.slice(-2);
  const rx = last2.reduce((s, w) => s + w.recaps.expected, 0), rc = last2.reduce((s, w) => s + w.recaps.confirmed, 0);
  if (rx >= 3 && rc / rx < T.recapRate) {
    out.push({ id: 'recaps', tone: 'info', title: `Recaps were confirmed on ${rc} of ${rx} working days in the last ${last2.length} week(s)`,
      facts: last2.map((w) => `Week of ${dayS(w.weekStart)}: ${w.recaps.confirmed} of ${w.recaps.expected}`),
      suggestion: 'Confirming the end-of-day recap keeps these trends complete; days without one stay provisional.',
      assumptions: ['Only completed working days are counted; today is excluded until it is over.'] });
  }

  // 9. Data completeness note.
  const lowCov = applicable.filter((w) => w.loggingCoverage !== null && w.loggingCoverage < coverageThreshold);
  if (applicable.length >= 2 && lowCov.length / applicable.length > 0.5) {
    out.push({ id: 'coverage', tone: 'info', title: `Logging coverage was below ${pctS(coverageThreshold)} in ${lowCov.length} of ${applicable.length} weeks, so time-based patterns are tentative`,
      facts: [`Weeks below the assessment minimum: ${lowCov.map((w) => dayS(w.weekStart)).join(', ')}`],
      suggestion: 'No action needed unless you want sharper time patterns. Coverage measures record completeness, not productivity.',
      assumptions: [timeAssumption] });
  }
  const order = { attention: 0, positive: 1, info: 2 };
  return out.sort((a, b) => order[a.tone] - order[b.tone]);
}

// ---------- CSV export (registered with the export registry; authorized on request and again at generation) ----------
export function trendsCsv(d: any) {
  const rows: unknown[][] = [[`Personal trends: ${d.subject.name}`, `${d.range.start} to ${d.range.end}`, `Generated ${d.generatedAt}`],
    ['Recorded work only. Not a productivity score; unknown time is not idle.'], [],
    ['Week start', 'Status', 'Comparable working days', 'Available min', 'Confirmed min', 'Unknown min', 'Logging coverage', 'Meeting min', 'Meeting share',
      'Focus min', 'Focus blocks', 'Switches per logged day', 'Blocked min', 'Intended outcomes', 'Accepted planned', 'Planned completion', 'Carryovers', 'Carryover rate',
      'Accepted outcomes', 'Estimate ratio', 'Estimate coverage', 'Recaps confirmed', 'Recaps expected']];
  const f = (v: number | null, dp = 3) => (v === null ? 'N/A' : Number(v.toFixed(dp)));
  for (const w of d.weeks) rows.push([w.weekStart, w.status === 'applicable' ? (w.partial ? 'partial' : 'applicable') : 'not applicable', w.workingDays, w.availableMinutes,
    w.explainedMinutes, w.unknownMinutes, f(w.loggingCoverage), w.meetingMinutes, f(w.meetingShare), w.focusMinutes, w.focusBlocks, f(w.switchesPerDay, 2), w.blockedMinutes,
    w.intendedOutcomes, w.acceptedPlanned, f(w.plannedCompletion), w.carryovers, f(w.carryoverRate), w.acceptedOutcomes, f(w.estimate.ratio, 2), f(w.estimate.coverage),
    w.recaps.confirmed, w.recaps.expected]);
  rows.push([], ['Estimate accuracy', 'Group', 'Accepted', 'Measured', 'Coverage', 'Estimated min', 'Logged min', 'Ratio']);
  for (const [dim, gs] of [['Overall', [d.estimateAccuracy.overall]], ['Category', d.estimateAccuracy.byCategory], ['Project', d.estimateAccuracy.byProject]] as const)
    for (const g of gs) rows.push([dim, g.label, g.accepted, g.measured, f(g.coverage), g.estimateMinutes, g.actualMinutes, f(g.ratio, 2)]);
  rows.push([], ['Pattern', 'Facts', 'Suggestion', 'Assumptions']);
  for (const p of d.patterns) rows.push([p.title, p.facts.join(' | '), p.suggestion, p.assumptions.join(' | ')]);
  return rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
}

export async function authorizeTrends(db: Db, a: Actor, userId: string) {
  requireStaff(a);
  await assertCanViewPerson(db, a, userId);
}

let exportRegistered = false;
export function registerTrendsExport() {
  if (exportRegistered) return;
  exportRegistered = true;
  registerExportReport('personal_trends', {
    async authorize(db, a, p) {
      const q = trendsParams.safeParse(p ?? {});
      if (!q.success || !q.data.userId) throw badRequest(q.success ? 'userId is required' : `Invalid trends export: ${q.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
      await authorizeTrends(db, a, q.data.userId);
    },
    async build(db, _a, p) {
      const q = trendsParams.parse(p);
      const data = await buildPersonalTrends(db, q.userId!, q.weeks, q.end);
      return { data, name: `trends-${data.subject.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${data.range.start}-to-${data.range.end}` };
    },
    csv: trendsCsv,
  });
}
