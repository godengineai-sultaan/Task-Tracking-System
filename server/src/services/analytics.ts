import { DateTime } from 'luxon';
import type { Db } from '../lib/db.js';
import { many, one } from '../lib/db.js';
import { dayCapacity, eachDate, loadCalendar, localDayBounds, localToday, type DayCapacity } from './calendar.js';

export const DEFINITIONS_VERSION = 'metrics-v1';
export const METRIC_DEFINITIONS = {
  version: DEFINITIONS_VERSION,
  available_time: 'Scheduled working minutes from the configured work schedule, minus breaks, holidays and approved leave. Presence is never inferred from browser activity.',
  confirmed_allocation: 'Non-overlapping confirmed time entries (timer, manual, accepted calendar/integration suggestions) inside the scheduled window, by category. Overlaps are counted once. This is recorded allocation, not proof of productivity.',
  logging_coverage: 'Confirmed allocation divided by available time. The remainder is unknown time — it is not assumed idle or unproductive.',
  unknown_time: 'Available time not explained by any confirmed entry.',
  planned_commitment_completion: 'Intended outcomes (My Day plan, max 3/day) accepted by the end of that day, divided by intended outcomes. Scope changes are listed separately.',
  accepted_outcome: 'A task in Done. Tasks requiring review reach Done only after a reviewer accepts them; others are self-accepted by the owner.',
  evidence_coverage: 'Accepted outcomes that require evidence and have at least one evidence item, divided by accepted outcomes requiring evidence.',
  blocker_share: 'Minutes inside the scheduled window during which at least one owned task had an open blocker, divided by available time. Shown only when blockers were recorded.',
  capacity_pressure: 'Estimated minutes of open owned commitments due in the next 10 working days, divided by available minutes in that horizon. Estimate coverage shows how many open tasks have estimates.',
  rework: 'Transitions from Done/In Review back to active work, plus reviewer change requests.',
  assessment: 'On Track / Needs Attention / Insufficient Data / Not Applicable is a rule-based explanation using the role profile targets shown with it. It is not a productivity score or ranking.',
};

const SOURCE_PRECEDENCE: Record<string, number> = { manual: 0, timer: 1, integration: 2, calendar: 3 };
const CATS = ['task', 'meeting', 'admin', 'learning', 'other'] as const;
type Cat = (typeof CATS)[number];

type Label = 'on_track' | 'needs_attention' | 'insufficient_data' | 'not_applicable';

interface Ctx {
  userId: string; tz: string; today: string;
  profile: { name: string; commitment_target: number; coverage_target: number; judge_by_closed_tasks: boolean; outcome_guidance: string };
  coverageThreshold: number;
}

async function loadCtx(db: Db, userId: string): Promise<Ctx & { user: any }> {
  const u = await one(db, `select u.id, u.name, u.title, u.is_founder, coalesce(u.timezone, t.timezone) tz, t.settings,
      rp.name rp_name, rp.commitment_target, rp.coverage_target, rp.judge_by_closed_tasks, rp.outcome_guidance,
      d.name department
    from users u join tenants t on t.id = u.tenant_id left join role_profiles rp on rp.id = u.role_profile_id
    left join departments d on d.id = u.department_id where u.id = $1`, [userId]);
  if (!u) throw new Error('user not found');
  return {
    user: { id: u.id, name: u.name, title: u.title, department: u.department, isFounder: u.is_founder },
    userId, tz: u.tz, today: localToday(u.tz),
    profile: {
      name: u.rp_name ?? 'Default', commitment_target: u.commitment_target ?? 0.6, coverage_target: u.coverage_target ?? (u.settings?.coverage_threshold ?? 0.5),
      judge_by_closed_tasks: u.judge_by_closed_tasks ?? true, outcome_guidance: u.outcome_guidance ?? '',
    },
    coverageThreshold: u.coverage_target ?? u.settings?.coverage_threshold ?? 0.5,
  };
}

const ms = (iso: string | Date) => (typeof iso === 'string' ? Date.parse(iso) : iso.getTime());
const minutes = (a: number, b: number) => Math.max(0, (b - a) / 60000);
function overlapMs(a0: number, a1: number, b0: number, b1: number) { return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0)); }

/** Non-overlapping allocation of confirmed entries for one local day. */
export function allocateDay(entries: any[], cap: DayCapacity, dayStart: number, dayEnd: number, now: number) {
  const ivs = entries.map((e) => ({
    e, a: Math.max(ms(e.started_at), dayStart), b: Math.min(e.ended_at ? ms(e.ended_at) : Math.min(now, dayEnd), dayEnd),
  })).filter((x) => x.b > x.a);
  const pts = [...new Set(ivs.flatMap((x) => [x.a, x.b]))].sort((x, y) => x - y);
  const windows = cap.windows.map((w) => [ms(w.start), ms(w.end)] as const);
  const byCat: Record<Cat, number> = { task: 0, meeting: 0, admin: 0, learning: 0, other: 0 };
  const bySource: Record<string, number> = {};
  let outside = 0;
  const conflicts: { start: string; end: string; minutes: number; entries: { id: string; source: string; category: string }[] }[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const active = ivs.filter((x) => x.a <= a && x.b >= b);
    if (!active.length) continue;
    active.sort((x, y) => (SOURCE_PRECEDENCE[x.e.source] - SOURCE_PRECEDENCE[y.e.source]) || (ms(x.e.created_at) - ms(y.e.created_at)));
    const primary = active[0].e;
    const inWin = windows.reduce((s, [w0, w1]) => s + overlapMs(a, b, w0, w1), 0) / 60000;
    const total = minutes(a, b);
    byCat[primary.category as Cat] += inWin;
    bySource[primary.source] = (bySource[primary.source] ?? 0) + inWin;
    outside += total - inWin;
    if (active.length > 1) {
      const last = conflicts[conflicts.length - 1];
      const ids = active.map((x) => x.e.id).sort().join(',');
      if (last && last.end === new Date(a).toISOString() && last.entries.map((x) => x.id).sort().join(',') === ids) {
        last.end = new Date(b).toISOString(); last.minutes += total;
      } else {
        conflicts.push({ start: new Date(a).toISOString(), end: new Date(b).toISOString(), minutes: total,
          entries: active.map((x) => ({ id: x.e.id, source: x.e.source, category: x.e.category })) });
      }
    }
  }
  const explainedRaw = Object.values(byCat).reduce((s, v) => s + v, 0);
  const explained = Math.min(explainedRaw, cap.availableMinutes);
  const round = (v: number) => Math.round(v);
  return {
    byCategory: Object.fromEntries(CATS.map((c) => [c, round(byCat[c])])) as Record<Cat, number>,
    bySource: Object.fromEntries(Object.entries(bySource).map(([k, v]) => [k, round(v)])),
    explainedMinutes: round(explained),
    recordedInBreakOrOverMinutes: round(explainedRaw - explained),
    outsideScheduleMinutes: round(outside),
    unknownMinutes: round(Math.max(0, cap.availableMinutes - explained)),
    coverage: cap.availableMinutes > 0 ? explained / cap.availableMinutes : null,
    conflicts: conflicts.map((c) => ({ ...c, minutes: round(c.minutes) })),
    runningTimer: entries.some((e) => !e.ended_at),
  };
}

function statusAt(history: any[], taskId: string, t: number): string | null {
  let s: string | null = null;
  for (const h of history) { if (h.task_id !== taskId) continue; if (ms(h.at) <= t) s = h.to_status; else break; }
  return s;
}

/** Build a report for any period. kind 'day' => start == end. */
export async function buildReport(db: Db, userId: string, kind: 'day' | 'week' | 'month' | 'custom', start: string, end: string, opts: { trend?: boolean } = {}) {
  const ctx = await loadCtx(db, userId);
  const dates = eachDate(start, end);
  if (dates.length === 0) throw new Error('Empty period');
  const periodStart = localDayBounds(ctx.tz, start).start, periodEnd = localDayBounds(ctx.tz, end).end;
  const now = Date.now();
  const cal = await loadCalendar(db, userId, start, end);

  const [entries, plans, reviews, blockers, dueTasks, acceptedTasks, mgrReviews, suggestions] = await Promise.all([
    many(db, `select te.*, t.title task_title from time_entries te left join tasks t on t.id = te.task_id
      where te.user_id = $1 and te.deleted_at is null and te.started_at < $3 and coalesce(te.ended_at, now()) > $2 order by te.started_at`,
      [userId, periodStart, periodEnd]),
    many(db, `select dp.date, dpi.task_id, dpi.position, dpi.removed_at, dpi.removed_reason, dpi.added_at, t.title, t.status, t.estimate_minutes,
        t.requires_review, t.project_id, p.name project_name
      from daily_plans dp join daily_plan_items dpi on dpi.plan_id = dp.id join tasks t on t.id = dpi.task_id left join projects p on p.id = t.project_id
      where dp.user_id = $1 and dp.date between $2 and $3 order by dp.date, dpi.position`, [userId, start, end]),
    many(db, `select * from daily_reviews where user_id = $1 and date between $2 and $3`, [userId, start, end]),
    many(db, `select b.*, t.title task_title, t.status task_status, wu.name waiting_on_name from blockers b join tasks t on t.id = b.task_id
      left join users wu on wu.id = b.waiting_on_user_id
      where t.owner_id = $1 and b.raised_at < $3 and coalesce(b.resolved_at, now()) > $2 order by b.raised_at`, [userId, periodStart, periodEnd]),
    many(db, `select t.id, t.title, t.due_date, t.status, t.done_at, t.cancelled_at, t.estimate_minutes, p.name project_name
      from tasks t left join projects p on p.id = t.project_id where t.owner_id = $1 and t.due_date between $2 and $3`, [userId, start, end]),
    many(db, `select t.id, t.title, t.accepted_at, t.requires_evidence, t.requires_review, t.category, t.due_date, p.name project_name, p.business_outcome,
        m.name milestone_name, (select count(*) from evidence_links e where e.task_id = t.id)::int evidence_count,
        (select r.reviewer_id from task_reviews r where r.task_id = t.id and r.decision = 'accepted' order by r.created_at desc limit 1) accepted_by
      from tasks t left join projects p on p.id = t.project_id left join milestones m on m.id = t.milestone_id
      where t.owner_id = $1 and t.status = 'done' and t.accepted_at >= $2 and t.accepted_at < $3 order by t.accepted_at`, [userId, periodStart, periodEnd]),
    many(db, `select mr.*, u.name reviewer_name from manager_reviews mr join users u on u.id = mr.reviewer_id
      where mr.subject_user_id = $1 and mr.date between $2 and $3 order by mr.created_at`, [userId, start, end]),
    many(db, `select * from suggestions where user_id = $1 and kind = 'time_entry' and status = 'open'
      and (data->>'started_at') >= $2 and (data->>'started_at') < $3`, [userId, periodStart, periodEnd]),
  ]);
  const taskIds = [...new Set([...plans.map((p) => p.task_id), ...dueTasks.map((t) => t.id)])];
  const history = await many(db, `select h.*, t.title from task_state_history h join tasks t on t.id = h.task_id
    where (h.task_id = any($1::uuid[]) or (t.owner_id = $2 and h.at >= $3 and h.at < $4)) order by h.at, h.id`, [taskIds, userId, periodStart, periodEnd]);
  const rework = await many(db, `select h.task_id, t.title, h.from_status, h.to_status, h.reason, h.at from task_state_history h join tasks t on t.id = h.task_id
    where t.owner_id = $1 and h.at >= $2 and h.at < $3 and h.from_status in ('done','in_review','cancelled') and h.to_status in ('in_progress','planned','backlog')
    order by h.at`, [userId, periodStart, periodEnd]);
  const changeRequests = await many(db, `select r.task_id, t.title, r.note, r.created_at from task_reviews r join tasks t on t.id = r.task_id
    where t.owner_id = $1 and r.decision = 'changes_requested' and r.created_at >= $2 and r.created_at < $3`, [userId, periodStart, periodEnd]);

  const reviewByDate = new Map(reviews.map((r) => [r.date, r]));
  const days = dates.map((date) => {
    const cap = dayCapacity(cal, date);
    const { start: ds, end: de } = localDayBounds(ctx.tz, date);
    const dayStart = ms(ds), dayEnd = ms(de);
    const dayEntries = entries.filter((e) => ms(e.started_at) < dayEnd && (e.ended_at ? ms(e.ended_at) : now) > dayStart);
    const alloc = allocateDay(dayEntries, cap, dayStart, dayEnd, now);
    const items = plans.filter((p) => p.date === date);
    const intended = items.filter((p) => !p.removed_at);
    const scopeChanges = items.filter((p) => p.removed_at).map((p) => ({ taskId: p.task_id, title: p.title, reason: p.removed_reason, at: p.removed_at }));
    const endT = Math.min(dayEnd, now);
    const outcomes = intended.map((p) => {
      const st = statusAt(history, p.task_id, endT) ?? 'planned';
      return { taskId: p.task_id, title: p.title, project: p.project_name, statusAtEndOfDay: st, accepted: st === 'done', estimateMinutes: p.estimate_minutes };
    });
    const accepted = outcomes.filter((o) => o.accepted);
    const carryovers = outcomes.filter((o) => !o.accepted && o.statusAtEndOfDay !== 'cancelled');
    const due = dueTasks.filter((t) => t.due_date === date).map((t) => ({ taskId: t.id, title: t.title, statusAtEndOfDay: statusAt(history, t.id, endT) ?? t.status }));
    // Blocked minutes inside the scheduled window (union across tasks).
    const wins = cap.windows.map((w) => [ms(w.start), ms(w.end)] as [number, number]);
    const bIvs = blockers.map((b) => [Math.max(ms(b.raised_at), dayStart), Math.min(b.resolved_at ? ms(b.resolved_at) : now, dayEnd)] as [number, number]).filter(([a, b]) => b > a);
    let blockedMinutes = 0;
    for (const [w0, w1] of wins) {
      const clipped = bIvs.map(([a, b]) => [Math.max(a, w0), Math.min(b, w1)]).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
      let cur: number[] | null = null;
      for (const iv of clipped) { if (!cur || iv[0] > cur[1]) { if (cur) blockedMinutes += minutes(cur[0], cur[1]); cur = [...iv]; } else cur[1] = Math.max(cur[1], iv[1]); }
      if (cur) blockedMinutes += minutes(cur[0], cur[1]);
    }
    const review = reviewByDate.get(date);
    const inferred = suggestions.filter((s) => ms(s.data.started_at) >= dayStart && ms(s.data.started_at) < dayEnd)
      .reduce((s, x) => s + minutes(ms(x.data.started_at), ms(x.data.ended_at)), 0);
    const day = {
      date, isToday: date === ctx.today, isFuture: date > ctx.today, capacity: cap,
      recap: review ? { status: review.status, dayType: review.day_type, version: review.version, confirmedAt: review.confirmed_at, summary: review.summary,
        blockersNote: review.blockers_note, nextSteps: review.next_steps, contextNote: review.context_note } : null,
      reportState: review?.status === 'manager_reviewed' ? 'manager_reviewed' : review?.status === 'confirmed' ? 'confirmed' : 'provisional',
      intendedOutcomes: outcomes, acceptedPlanned: accepted.length, carryovers, scopeChanges, commitmentsDue: due,
      time: { ...alloc, availableMinutes: cap.availableMinutes, plannedEstimateMinutes: intended.reduce((s, p) => s + (p.estimate_minutes ?? 0), 0),
        plannedEstimateCoverage: intended.length ? intended.filter((p) => p.estimate_minutes).length / intended.length : null,
        inferredUnconfirmedMinutes: Math.round(inferred) },
      blockedMinutes: Math.round(blockedMinutes),
      blockerShare: cap.availableMinutes > 0 && blockedMinutes > 0 ? blockedMinutes / cap.availableMinutes : null,
      assessment: null as any,
    };
    day.assessment = assessDay(day, ctx, blockers, dueTasks);
    return day;
  });

  // Period aggregates
  const working = days.filter((d) => d.capacity.availableMinutes > 0 && !d.isFuture);
  const sum = (f: (d: (typeof days)[number]) => number) => working.reduce((s, d) => s + f(d), 0);
  const available = sum((d) => d.capacity.availableMinutes);
  const explained = sum((d) => d.time.explainedMinutes);
  const intendedCount = sum((d) => d.intendedOutcomes.length);
  const acceptedPlanned = sum((d) => d.acceptedPlanned);
  const reqEvidence = acceptedTasks.filter((t) => t.requires_evidence);
  const todayIso = ctx.today;
  const deadlines = dueTasks.filter((t) => t.status !== 'cancelled').map((t) => {
    const doneDate = t.done_at ? DateTime.fromJSDate(new Date(t.done_at)).setZone(ctx.tz).toISODate() : null;
    const state = t.status === 'done' ? (doneDate! <= t.due_date ? 'met' : 'late') : t.due_date < todayIso ? 'overdue' : 'open';
    return { taskId: t.id, title: t.title, project: t.project_name, dueDate: t.due_date, state };
  });
  const byCause: Record<string, { count: number; minutes: number }> = {};
  for (const b of blockers) {
    const m = minutes(Math.max(ms(b.raised_at), ms(periodStart)), Math.min(b.resolved_at ? ms(b.resolved_at) : now, ms(periodEnd)));
    byCause[b.cause] ??= { count: 0, minutes: 0 }; byCause[b.cause].count++; byCause[b.cause].minutes += Math.round(m);
  }
  const catTotals = Object.fromEntries(CATS.map((c) => [c, sum((d) => d.time.byCategory[c])]));
  const confirmedDays = working.filter((d) => d.reportState !== 'provisional').length;
  const capacityPressure = await capacityPressureFor(db, userId, ctx.today, cal);
  const summary = {
    workingDays: working.length,
    nonWorkingDays: days.filter((d) => d.capacity.availableMinutes === 0).length,
    confirmedRecaps: confirmedDays,
    missingRecaps: working.filter((d) => !d.recap && !d.isToday).length,
    reportCompleteness: working.length ? confirmedDays / working.length : null,
    availableMinutes: available, explainedMinutes: explained, unknownMinutes: available - explained,
    loggingCoverage: available > 0 ? explained / available : null,
    byCategory: catTotals,
    outsideScheduleMinutes: sum((d) => d.time.outsideScheduleMinutes),
    conflictMinutes: sum((d) => d.time.conflicts.reduce((s, c) => s + c.minutes, 0)),
    intendedOutcomes: intendedCount, acceptedPlannedOutcomes: acceptedPlanned,
    plannedCommitmentCompletion: intendedCount > 0 ? acceptedPlanned / intendedCount : null,
    carryovers: sum((d) => d.carryovers.length),
    acceptedOutcomes: acceptedTasks.length,
    evidenceCoverage: reqEvidence.length ? reqEvidence.filter((t) => t.evidence_count > 0).length / reqEvidence.length : null,
    evidenceRequired: reqEvidence.length,
    blockedMinutes: sum((d) => d.blockedMinutes),
    blockerShare: available > 0 && sum((d) => d.blockedMinutes) > 0 ? sum((d) => d.blockedMinutes) / available : null,
    reworkCount: rework.length + changeRequests.length,
    deadlines: { met: deadlines.filter((d) => d.state === 'met').length, late: deadlines.filter((d) => d.state === 'late').length,
      overdue: deadlines.filter((d) => d.state === 'overdue').length, open: deadlines.filter((d) => d.state === 'open').length },
    capacityPressure,
  };
  const assessment = kind === 'day' ? days[0].assessment : assessPeriod(summary, ctx, days);
  const recommendations = recommend(summary, days, blockers, ctx, capacityPressure);

  let trend: any = null;
  if (opts.trend !== false && kind !== 'day') {
    const len = dates.length;
    const ps = DateTime.fromISO(start).minus({ days: len }).toISODate()!, pe = DateTime.fromISO(start).minus({ days: 1 }).toISODate()!;
    const prev = await buildReport(db, userId, 'custom', ps, pe, { trend: false });
    const delta = (a: number | null, b: number | null) => (a === null || b === null ? null : a - b);
    trend = {
      previousPeriod: { start: ps, end: pe }, comparableWorkingDays: prev.summary.workingDays,
      plannedCommitmentCompletion: { current: summary.plannedCommitmentCompletion, previous: prev.summary.plannedCommitmentCompletion, delta: delta(summary.plannedCommitmentCompletion, prev.summary.plannedCommitmentCompletion) },
      loggingCoverage: { current: summary.loggingCoverage, previous: prev.summary.loggingCoverage, delta: delta(summary.loggingCoverage, prev.summary.loggingCoverage) },
      blockedMinutes: { current: summary.blockedMinutes, previous: prev.summary.blockedMinutes, delta: summary.blockedMinutes - prev.summary.blockedMinutes },
      meetingMinutes: { current: catTotals.meeting, previous: prev.summary.byCategory.meeting, delta: catTotals.meeting - prev.summary.byCategory.meeting },
      acceptedOutcomes: { current: summary.acceptedOutcomes, previous: prev.summary.acceptedOutcomes, delta: summary.acceptedOutcomes - prev.summary.acceptedOutcomes },
      note: 'Compared with the immediately preceding period of equal length for the same person and role profile. Coverage differences limit comparability.',
    };
  }

  const reportState = kind === 'day' ? days[0].reportState : summary.reportCompleteness === 1 ? 'confirmed' : 'provisional';
  return {
    definitions: METRIC_DEFINITIONS,
    subject: ctx.user, roleProfile: ctx.profile, timezone: ctx.tz,
    period: { kind, start, end }, generatedAt: new Date().toISOString(), reportState,
    summary, assessment, recommendations, trend,
    days: kind === 'day' ? days : days.map(({ capacity, ...d }) => ({ ...d, capacity: { status: capacity.status, availableMinutes: capacity.availableMinutes, holiday: capacity.holiday, leave: capacity.leave } })),
    acceptedOutcomes: acceptedTasks.map((t) => ({ taskId: t.id, title: t.title, project: t.project_name, milestone: t.milestone_name, businessOutcome: t.business_outcome,
      acceptedAt: t.accepted_at, reviewed: !!t.accepted_by, requiresEvidence: t.requires_evidence, evidenceCount: t.evidence_count })),
    deadlines, blockers: blockers.map((b) => ({ id: b.id, taskId: b.task_id, task: b.task_title, reason: b.reason, cause: b.cause,
      waitingOn: b.waiting_on_name || b.waiting_on_text, nextFollowUp: b.next_follow_up, raisedAt: b.raised_at, resolvedAt: b.resolved_at })),
    blockersByCause: byCause,
    rework: [...rework.map((r) => ({ taskId: r.task_id, title: r.title, kind: 'reopened', reason: r.reason, at: r.at })),
      ...changeRequests.map((r) => ({ taskId: r.task_id, title: r.title, kind: 'changes_requested', reason: r.note, at: r.created_at }))],
    managerReviews: mgrReviews.map((m) => ({ id: m.id, date: m.date, action: m.action, note: m.note, reviewer: m.reviewer_name, at: m.created_at, resolvedAt: m.resolved_at })),
  };
}

function pct(v: number | null) { return v === null ? 'n/a' : `${Math.round(v * 100)}%`; }
function hm(m: number) { const h = Math.floor(m / 60), r = Math.round(m % 60); return h ? `${h}h${r ? ` ${r}m` : ''}` : `${r}m`; }

function assessDay(d: any, ctx: Ctx, blockers: any[], dueTasks: any[]): { label: Label; reasons: string[]; facts: string[]; assumptions: string[] } {
  const facts: string[] = [], reasons: string[] = [];
  const assumptions = [`Role profile: ${ctx.profile.name}`, `Commitment target ${pct(ctx.profile.commitment_target)}${ctx.profile.judge_by_closed_tasks ? '' : ' (not judged by closed-task counts for this role)'}`,
    `Minimum logging coverage to assess: ${pct(ctx.coverageThreshold)}`];
  if (ctx.profile.outcome_guidance) assumptions.push(ctx.profile.outcome_guidance);
  if (d.capacity.availableMinutes === 0) {
    const why = d.capacity.status === 'holiday' ? `Holiday: ${d.capacity.holiday}` : d.capacity.status === 'leave' ? `On ${d.capacity.leave.kind}` : 'Not a scheduled working day';
    return { label: 'not_applicable', reasons: [why + ' — zero available capacity, ratios are not applicable.'], facts: [], assumptions };
  }
  if (d.isFuture) return { label: 'insufficient_data', reasons: ['This day has not happened yet.'], facts: [], assumptions };
  const t = d.time;
  facts.push(`${d.acceptedPlanned} of ${d.intendedOutcomes.length} intended outcome(s) accepted`);
  facts.push(`${hm(t.explainedMinutes)} confirmed of ${hm(d.capacity.availableMinutes)} available (${pct(t.coverage)} logging coverage); ${hm(t.unknownMinutes)} unknown`);
  if (d.carryovers.length) facts.push(`${d.carryovers.length} carried over: ${d.carryovers.map((c: any) => c.title).join('; ')}`);
  if (d.blockedMinutes) facts.push(`${hm(d.blockedMinutes)} with an open blocker`);
  if (t.conflicts.length) facts.push(`${t.conflicts.length} overlapping time conflict(s) counted once`);
  if (d.recap?.dayType === 'no_work') {
    return { label: 'needs_attention', reasons: ['Recap confirms no work on a scheduled working day — record leave if this was time off so capacity is correct.'], facts, assumptions };
  }
  if (d.recap?.dayType === 'non_working') {
    return { label: 'not_applicable', reasons: ['Recap confirms this was a non-working day. Ask an admin to record leave/holiday so capacity reflects it.'], facts, assumptions };
  }
  if (!d.recap || d.recap.status === 'draft') {
    reasons.push(d.isToday ? 'Recap not confirmed yet — today is provisional.' : 'No confirmed recap for this day — figures are provisional.');
    return { label: 'insufficient_data', reasons, facts, assumptions };
  }
  if (t.coverage !== null && t.coverage < ctx.coverageThreshold) {
    reasons.push(`Logging coverage ${pct(t.coverage)} is below the ${pct(ctx.coverageThreshold)} needed to assess the day. Unknown time is not treated as idle.`);
    return { label: 'insufficient_data', reasons, facts, assumptions };
  }
  if (!d.intendedOutcomes.length && !d.commitmentsDue.length) {
    reasons.push('No intended outcomes or commitments were due, so completion cannot be assessed. Time and notes are still recorded.');
    return { label: 'insufficient_data', reasons, facts, assumptions };
  }
  const completion = d.intendedOutcomes.length ? d.acceptedPlanned / d.intendedOutcomes.length : null;
  if (ctx.profile.judge_by_closed_tasks && completion !== null && completion < ctx.profile.commitment_target) {
    const waiting = d.carryovers.filter((c: any) => c.statusAtEndOfDay === 'blocked');
    reasons.push(`Planned completion ${pct(completion)} is below the ${pct(ctx.profile.commitment_target)} role target` +
      (waiting.length ? ` (${waiting.length} waiting on a blocker).` : '.'));
  }
  const noFollowUp = blockers.filter((b) => !b.resolved_at && (!b.next_follow_up || b.next_follow_up < d.date) && ms(b.raised_at) < ms(localDayBounds(ctx.tz, d.date).end));
  if (noFollowUp.length) reasons.push(`${noFollowUp.length} open blocker(s) without a current follow-up date.`);
  const overdue = dueTasks.filter((t) => t.due_date < d.date && !['done', 'cancelled'].includes(t.status));
  if (overdue.length) reasons.push(`${overdue.length} commitment(s) overdue.`);
  return { label: reasons.length ? 'needs_attention' : 'on_track', reasons: reasons.length ? reasons : ['Intended outcomes and commitments are progressing with sufficient recorded evidence.'], facts, assumptions };
}

function assessPeriod(s: any, ctx: Ctx, days: any[]): { label: Label; reasons: string[]; facts: string[]; assumptions: string[] } {
  const assumptions = [`Role profile: ${ctx.profile.name}`, `Commitment target ${pct(ctx.profile.commitment_target)}`, `Minimum logging coverage ${pct(ctx.coverageThreshold)}`, 'At least half of working days need a confirmed recap'];
  const facts = [`${s.workingDays} working day(s), ${s.confirmedRecaps} confirmed recap(s), ${s.missingRecaps} missing`,
    `${s.acceptedPlannedOutcomes}/${s.intendedOutcomes} intended outcomes accepted (${pct(s.plannedCommitmentCompletion)})`,
    `${hm(s.explainedMinutes)} confirmed of ${hm(s.availableMinutes)} available (${pct(s.loggingCoverage)}); ${hm(s.unknownMinutes)} unknown`,
    `Deadlines: ${s.deadlines.met} met, ${s.deadlines.late} late, ${s.deadlines.overdue} overdue`];
  if (s.workingDays === 0) return { label: 'not_applicable', reasons: ['No scheduled working days in this period.'], facts, assumptions };
  if (s.reportCompleteness < 0.5) return { label: 'insufficient_data', reasons: [`Only ${pct(s.reportCompleteness)} of working days have a confirmed recap.`], facts, assumptions };
  if (s.loggingCoverage !== null && s.loggingCoverage < ctx.coverageThreshold) return { label: 'insufficient_data', reasons: [`Logging coverage ${pct(s.loggingCoverage)} is below ${pct(ctx.coverageThreshold)}.`], facts, assumptions };
  const reasons: string[] = [];
  if (ctx.profile.judge_by_closed_tasks && s.plannedCommitmentCompletion !== null && s.plannedCommitmentCompletion < ctx.profile.commitment_target)
    reasons.push(`Planned completion ${pct(s.plannedCommitmentCompletion)} below ${pct(ctx.profile.commitment_target)} target.`);
  if (s.deadlines.overdue) reasons.push(`${s.deadlines.overdue} commitment(s) overdue.`);
  if (s.capacityPressure.ratio !== null && s.capacityPressure.ratio > 1.25) reasons.push(`Upcoming estimated work is ${pct(s.capacityPressure.ratio)} of available capacity.`);
  return { label: reasons.length ? 'needs_attention' : 'on_track', reasons: reasons.length ? reasons : ['Commitments and deadlines are on track with sufficient confirmed records.'], facts, assumptions };
}

async function capacityPressureFor(db: Db, userId: string, today: string, _cal: any) {
  const horizonEnd = DateTime.fromISO(today).plus({ days: 20 }).toISODate()!;
  const cal = await loadCalendar(db, userId, today, horizonEnd);
  let avail = 0, wd = 0, lastDate = today;
  for (const d of eachDate(today, horizonEnd)) { const c = dayCapacity(cal, d); if (c.availableMinutes > 0) { avail += c.availableMinutes; wd++; lastDate = d; } if (wd >= 10) break; }
  const open = await many(db, `select estimate_minutes from tasks where owner_id = $1 and status not in ('done','cancelled','backlog')
    and (due_date is null or due_date <= $2)`, [userId, lastDate]);
  const est = open.filter((t) => t.estimate_minutes);
  const estMinutes = est.reduce((s, t) => s + t.estimate_minutes, 0);
  return { horizonWorkingDays: wd, availableMinutes: avail, estimatedMinutes: estMinutes, openTasks: open.length,
    estimateCoverage: open.length ? est.length / open.length : null, ratio: avail > 0 ? estMinutes / avail : null };
}

function recommend(s: any, days: any[], blockers: any[], ctx: Ctx, cp: any) {
  const recs: { kind: string; text: string; ref?: string }[] = [];
  const open = blockers.filter((b) => !b.resolved_at);
  for (const b of open) {
    const ageDays = (Date.now() - ms(b.raised_at)) / 86400000;
    if (b.cause === 'requirement') recs.push({ kind: 'clarify', text: `Clarify the requirement blocking "${b.task_title}".`, ref: b.task_id });
    else if (ageDays > 1 || !b.next_follow_up || b.next_follow_up <= ctx.today)
      recs.push({ kind: 'escalate', text: `Escalate "${b.task_title}" — waiting ${Math.floor(ageDays)} day(s) on ${b.waiting_on_name || b.waiting_on_text || 'a dependency'}.`, ref: b.task_id });
  }
  if (cp.ratio !== null && cp.ratio > 1.1) recs.push({ kind: 'rebalance', text: `Upcoming estimated work is ${pct(cp.ratio)} of available capacity in the next ${cp.horizonWorkingDays} working days — rebalance or re-scope tasks.` });
  if (cp.estimateCoverage !== null && cp.estimateCoverage < 0.5 && cp.openTasks >= 3) recs.push({ kind: 'estimate', text: `Only ${pct(cp.estimateCoverage)} of open tasks have estimates — add rough estimates so capacity pressure is meaningful.` });
  if (s.availableMinutes > 0 && s.byCategory.meeting / s.availableMinutes > 0.5) recs.push({ kind: 'focus', text: 'Meetings took over half of available time — protect a focus block.' });
  const carriedTwice = new Map<string, number>();
  for (const d of days) for (const c of d.carryovers ?? []) carriedTwice.set(c.title, (carriedTwice.get(c.title) ?? 0) + 1);
  for (const [title, n] of carriedTwice) if (n >= 2) recs.push({ kind: 'split', text: `"${title}" carried over ${n} times — split it into a smaller outcome or re-plan it.` });
  if (s.missingRecaps > 0) recs.push({ kind: 'recap', text: `${s.missingRecaps} working day(s) have no recap — confirm them so the report is complete.` });
  if (s.conflictMinutes > 0) recs.push({ kind: 'correct', text: `${hm(s.conflictMinutes)} of overlapping time entries — review and correct the duplicates.` });
  if (s.evidenceCoverage !== null && s.evidenceCoverage < 1) recs.push({ kind: 'evidence', text: 'Some accepted outcomes that require evidence have none attached.' });
  return recs.slice(0, 8);
}
