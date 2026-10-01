import { DateTime } from 'luxon';
import type { Db } from '../../lib/db.js';
import { many, one } from '../../lib/db.js';
import { audit } from '../../lib/audit.js';
import { enqueue } from '../../lib/jobs.js';
import { badRequest, forbidden } from '../../lib/errors.js';
import { type Actor, isStaff, taskVisibility } from '../access.js';
import { buildReport } from '../analytics.js';
import { dayCapacity, loadCalendar, localToday, type DayCapacity } from '../calendar.js';
import { notify } from '../notify.js';

/**
 * Plan-my-day assistant, routine nudges and the weekly self-summary.
 * Everything here is deterministic and rule-based (no AI): the same records always give the same output,
 * and every suggestion carries the facts and rules that produced it.
 */

export const MAX_OUTCOMES = 3;
const PRIORITY_POINTS: Record<string, number> = { urgent: 20, high: 12, medium: 5, low: 0, none: 0 };
const PRIORITY_ORDER = ['urgent', 'high', 'medium', 'low', 'none'];
const PRIORITY_LABEL: Record<string, string> = { urgent: 'Urgent', high: 'High', medium: 'Medium', low: 'Low', none: 'No' };
const STATUS_LABEL: Record<string, string> = { backlog: 'Backlog', planned: 'Planned', in_progress: 'In Progress', blocked: 'Blocked', in_review: 'In Review', done: 'Done', cancelled: 'Cancelled' };
const CAT_LABEL: Record<string, string> = { task: 'Task work', meeting: 'Meetings', admin: 'Admin', learning: 'Learning', other: 'Other declared' };

export const RANKING_RULES = [
  'Overdue on the planned day: +40, plus 2 for each day overdue (at most +20 more).',
  'Due on the planned day: +35. Due 1, 2 or 3 days later: +20, +15 or +10.',
  'Already in progress: +15.',
  'Carried over (planned on an earlier day in the last 14 days and not accepted yet): +10, plus 3 for each further day (at most +20).',
  'Priority: Urgent +20, High +12, Medium +5, Low or None 0.',
  'Estimate fits the remaining scheduled time: +8. Estimate is longer than the remaining time: -10. No estimate: 0.',
  'Ties are broken by due date, then priority, then the oldest task first.',
  'Set aside instead of ranked: blocked work, work in review, work waiting on open dependencies, and work already done or cancelled.',
];

export const hm = (m: number) => { const r = Math.max(0, Math.round(m)); const h = Math.floor(r / 60), mm = r % 60; return h ? (mm ? `${h}h ${mm}m` : `${h}h`) : `${mm}m`; };
const fmtDay = (iso: string) => DateTime.fromISO(iso).toFormat('ccc d LLL');
const daysBetween = (from: string, to: string) => Math.round(DateTime.fromISO(to).diff(DateTime.fromISO(from), 'days').days);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Scheduled minutes still ahead on the day (today: after `now`), with breaks spread evenly across the windows. */
export function remainingMinutes(cap: DayCapacity, isToday: boolean, now: number) {
  if (!isToday || cap.availableMinutes === 0) return cap.availableMinutes;
  let total = 0, left = 0;
  for (const w of cap.windows) {
    const s = Date.parse(w.start), e = Date.parse(w.end);
    total += e - s; left += Math.max(0, e - Math.max(s, now));
  }
  return total > 0 ? Math.round((cap.availableMinutes * left) / total) : 0;
}

function capacityWhy(cap: DayCapacity) {
  const kind = cap.leave?.kind === 'sick' ? 'sick leave' : cap.leave?.kind === 'training' ? 'training' : 'leave';
  return cap.status === 'holiday' ? `Holiday (${cap.holiday})` : cap.status === 'leave' ? `You are on ${kind}` : 'Not a scheduled working day';
}

interface ScorePart { key: string; label: string; points: number }

// ---------- Suggest my day ----------
export async function suggestDay(db: Db, a: Actor, date?: string, now = Date.now()) {
  if (!isStaff(a)) throw forbidden();
  const today = localToday(a.timezone);
  const d = date ?? today;
  if (d < today) throw badRequest('Suggestions are for today or a later day. Past plans cannot be changed; add context in that day\'s recap instead.');
  if (d > DateTime.fromISO(today).plus({ days: 31 }).toISODate()!) throw badRequest('Suggestions are available up to 31 days ahead.');
  const isToday = d === today;
  const cal = await loadCalendar(db, a.id, d, d);
  const cap = dayCapacity(cal, d);
  const remaining = remainingMinutes(cap, isToday, now);
  const assumptions = [
    'Ranking is rule-based: the same tasks, dates and plans always give the same order. It ranks tasks, never people.',
    'Estimates come from the tasks themselves. Tasks without an estimate are not assumed to fit.',
    isToday ? 'Remaining time is your scheduled window after now, with breaks spread evenly across it.' : 'Available time is the full scheduled day, minus breaks, holidays and leave.',
    'Nothing is planned until you choose "Use these". Already-chosen outcomes are kept.',
  ];
  const capacity = { status: cap.status, availableMinutes: cap.availableMinutes, remainingMinutes: remaining, schedule: cap.schedule, holiday: cap.holiday, leave: cap.leave };
  const base = { date: d, today, isToday, capacity, rules: RANKING_RULES, assumptions, maxOutcomes: MAX_OUTCOMES };
  if (cap.availableMinutes === 0) {
    return { ...base, applicable: false, label: 'not_applicable' as const,
      rationale: `${capacityWhy(cap)}: there is no scheduled time on ${fmtDay(d)}, so no outcomes are suggested. Nothing is expected of you on a zero-capacity day.`,
      current: [], slots: 0, candidates: [], excluded: [], proposal: null, capacityCheck: null };
  }

  const windowStart = DateTime.fromISO(d).minus({ days: 14 }).toISODate()!;
  const current = await many(db, `select t.id, t.title, t.status, t.priority, t.due_date, t.estimate_minutes, p.key project_key, dpi.position
    from daily_plans dp join daily_plan_items dpi on dpi.plan_id = dp.id join tasks t on t.id = dpi.task_id left join projects p on p.id = t.project_id
    where dp.user_id = $1 and dp.date = $2 and dpi.removed_at is null order by dpi.position`, [a.id, d]);
  const currentIds = new Set(current.map((c) => c.id));
  const open = await many(db, `select t.id, t.number, t.title, t.status, t.priority, t.due_date, t.estimate_minutes, t.owner_id, t.created_at,
      p.key project_key, p.name project_name, b.reason blocker_reason, coalesce(wu.name, nullif(b.waiting_on_text, '')) blocker_waiting_on
    from tasks t left join projects p on p.id = t.project_id
    left join lateral (select * from blockers x where x.task_id = t.id and x.resolved_at is null order by x.raised_at desc limit 1) b on true
    left join users wu on wu.id = b.waiting_on_user_id
    where (t.owner_id = $1 or exists (select 1 from task_collaborators c where c.task_id = t.id and c.user_id = $1))
      and t.status not in ('done','cancelled')
    order by t.created_at, t.id limit 300`, [a.id]);
  const [vis, visParams] = taskVisibility(a, 2);
  const deps = open.length ? await many(db, `select d.task_id, t.title, t.status, (${vis}) visible
    from task_dependencies d join tasks t on t.id = d.depends_on_task_id left join projects p on p.id = t.project_id
    where d.task_id = any($1::uuid[]) and t.status not in ('done','cancelled') order by t.created_at`, [open.map((t) => t.id), ...visParams]) : [];
  const carryRows = await many(db, `select dpi.task_id, count(distinct dp.date)::int days, max(dp.date) last_date
    from daily_plans dp join daily_plan_items dpi on dpi.plan_id = dp.id
    where dp.user_id = $1 and dp.date < $2 and dp.date >= $3 and dpi.removed_at is null group by dpi.task_id`, [a.id, d, windowStart]);
  const carry = new Map(carryRows.map((r) => [r.task_id, r]));
  const finished = await many(db, `select distinct on (t.id) t.id, t.title, t.status, t.done_at, t.cancelled_at, p.key project_key
    from daily_plans dp join daily_plan_items dpi on dpi.plan_id = dp.id join tasks t on t.id = dpi.task_id left join projects p on p.id = t.project_id
    where dp.user_id = $1 and dp.date < $2 and dp.date >= $3 and dpi.removed_at is null and t.status in ('done','cancelled')
      and coalesce(t.done_at, t.cancelled_at) >= $4 order by t.id`, [a.id, d, windowStart, new Date(now - 7 * 86400000)]);

  const excluded: any[] = [];
  const ranked: any[] = [];
  for (const t of open) {
    if (currentIds.has(t.id)) continue;
    const item = { id: t.id, number: t.number, title: t.title, status: t.status, priority: t.priority, dueDate: t.due_date, estimateMinutes: t.estimate_minutes, projectKey: t.project_key };
    const openDeps = deps.filter((x) => x.task_id === t.id);
    if (t.status === 'blocked') {
      excluded.push({ ...item, reason: 'blocked', label: `Blocked: ${t.blocker_reason ?? 'no reason recorded'}${t.blocker_waiting_on ? ` (waiting on ${t.blocker_waiting_on})` : ''}` });
      continue;
    }
    if (t.status === 'in_review') { excluded.push({ ...item, reason: 'in_review', label: 'In review: waiting for a reviewer to accept it' }); continue; }
    if (openDeps.length) {
      const names = openDeps.map((x) => (x.visible ? `"${x.title}" (${STATUS_LABEL[x.status]})` : 'a task you cannot view'));
      excluded.push({ ...item, reason: 'dependencies', label: `Waiting on ${openDeps.length === 1 ? 'an open dependency' : `${openDeps.length} open dependencies`}: ${names.join(', ')}` });
      continue;
    }
    const parts: ScorePart[] = [];
    const due = t.due_date ? daysBetween(d, t.due_date) : null;
    if (due !== null && due < 0) parts.push({ key: 'overdue', points: 40 + Math.min(20, -2 * due), label: `Overdue by ${plural(-due, 'day')} (was due ${fmtDay(t.due_date)})` });
    else if (due === 0) parts.push({ key: 'due', points: 35, label: isToday ? 'Due today' : `Due on ${fmtDay(d)}` });
    else if (due !== null && due <= 3) parts.push({ key: 'due_soon', points: [0, 20, 15, 10][due], label: `Due ${due === 1 ? (isToday ? 'tomorrow' : 'the next day') : `in ${due} days`} (${fmtDay(t.due_date)})` });
    if (t.status === 'in_progress') parts.push({ key: 'in_progress', points: 15, label: 'Already in progress' });
    const c = carry.get(t.id);
    if (c) parts.push({ key: 'carried_over', points: Math.min(20, 10 + 3 * (c.days - 1)), label: `Carried over: planned on ${plural(c.days, 'earlier day')} (last ${fmtDay(c.last_date)}) and not accepted yet` });
    if (PRIORITY_POINTS[t.priority]) parts.push({ key: 'priority', points: PRIORITY_POINTS[t.priority], label: `${PRIORITY_LABEL[t.priority]} priority` });
    if (t.estimate_minutes == null) parts.push({ key: 'estimate_fit', points: 0, label: 'No estimate, so its fit against the remaining time is unknown' });
    else if (t.estimate_minutes <= remaining) parts.push({ key: 'estimate_fit', points: 8, label: `Estimate ${hm(t.estimate_minutes)} fits in the ${hm(remaining)} remaining` });
    else parts.push({ key: 'estimate_fit', points: -10, label: `Estimate ${hm(t.estimate_minutes)} is longer than the ${hm(remaining)} remaining; consider a smaller first step` });
    const score = parts.reduce((s, p) => s + p.points, 0);
    const reasons = parts.filter((p) => p.points > 0 || p.key === 'estimate_fit').map((p) => p.label);
    ranked.push({ ...item, score, parts, reasons, createdAt: t.created_at });
  }
  ranked.sort((x, y) => (y.score - x.score)
    || ((x.dueDate ?? '9999-12-31') < (y.dueDate ?? '9999-12-31') ? -1 : (x.dueDate ?? '9999-12-31') > (y.dueDate ?? '9999-12-31') ? 1 : 0)
    || (PRIORITY_ORDER.indexOf(x.priority) - PRIORITY_ORDER.indexOf(y.priority))
    || (+new Date(x.createdAt) - +new Date(y.createdAt)) || (x.id < y.id ? -1 : 1));
  for (const t of finished) {
    if (currentIds.has(t.id)) continue;
    excluded.push({ id: t.id, title: t.title, status: t.status, projectKey: t.project_key, reason: t.status,
      label: t.status === 'done' ? `Already done (${fmtDay(DateTime.fromJSDate(new Date(t.done_at)).setZone(a.timezone).toISODate()!)}); nothing left to plan` : 'Cancelled; nothing left to plan' });
  }

  const slots = Math.max(0, MAX_OUTCOMES - current.length);
  const candidates = ranked.slice(0, 12).map(({ createdAt: _c, ...r }, i) => ({ ...r, rank: i + 1, proposed: i < slots }));
  const add = candidates.slice(0, slots);
  const closedCurrent = current.filter((c) => ['done', 'cancelled'].includes(c.status));
  const counted = [...current.filter((c) => !['done', 'cancelled'].includes(c.status)).map((c) => c.estimate_minutes), ...add.map((c) => c.estimateMinutes)];
  const estimated = counted.filter((m): m is number => m != null);
  const estimateMinutes = estimated.reduce((s, m) => s + m, 0);
  const unestimated = counted.length - estimated.length;
  const left = isToday ? `${hm(remaining)} of scheduled time left today` : `${hm(remaining)} of scheduled time on ${fmtDay(d)}`;
  const state = counted.length === 0 ? 'empty' : estimateMinutes > remaining ? 'over' : unestimated ? 'partial' : 'fits';
  const capacityCheck = {
    state, outcomes: counted.length, estimateMinutes, unestimated, remainingMinutes: remaining,
    text: state === 'empty' ? `No open outcomes to check against the ${left}.`
      : state === 'over' ? `The proposed outcomes are estimated at ${hm(estimateMinutes)}, more than the ${left}. Consider a smaller first step for one of them.`
      : state === 'partial' ? `The estimated outcomes add up to ${hm(estimateMinutes)} of the ${left}; ${plural(unestimated, 'outcome has', 'outcomes have')} no estimate, so the real total is unknown.`
      : `The proposed outcomes are estimated at ${hm(estimateMinutes)} of the ${left}, leaving ${hm(remaining - estimateMinutes)} for meetings, reviews and unplanned work.`,
  };
  const canApply = add.length > 0 && closedCurrent.length === 0;
  const applyNote = closedCurrent.length && add.length
    ? `"${closedCurrent[0].title}" is already ${STATUS_LABEL[closedCurrent[0].status].toLowerCase()} and the plan editor only accepts open outcomes, so the proposal cannot be applied in one click. Add outcomes from Open work instead.`
    : null;

  const sentences: string[] = [];
  sentences.push(isToday
    ? `You have ${hm(remaining)} of scheduled time left today${cap.schedule ? ` (${cap.schedule.start}–${cap.schedule.end}${cap.status === 'partial_leave' ? ', half-day leave applied' : ''})` : ''}.`
    : `${fmtDay(d)} has ${hm(remaining)} of scheduled time${cap.schedule ? ` (${cap.schedule.start}–${cap.schedule.end})` : ''}.`);
  if (isToday && remaining === 0) sentences.push('Your scheduled time for today has ended, so every estimate is shown as not fitting. You can still plan if you are working late, or plan tomorrow instead.');
  if (current.length) sentences.push(`${plural(current.length, 'outcome is', 'outcomes are')} already chosen and will be kept.`);
  if (!slots) sentences.push('All three outcome slots are used, so nothing new is proposed.');
  else if (!add.length) sentences.push('No open work is ready to plan right now.');
  else sentences.push(`Proposed: ${add.map((c) => `"${c.title}" (${c.reasons[0].replace(/^./, (s: string) => s.toLowerCase())})`).join(', ')}.`);
  if (excluded.length) {
    const by = (r: string) => excluded.filter((e) => e.reason === r).length;
    const bits = [['blocked', 'blocked'], ['in_review', 'in review'], ['dependencies', 'waiting on dependencies'], ['done', 'already done'], ['cancelled', 'cancelled']]
      .filter(([r]) => by(r)).map(([r, l]) => `${by(r)} ${l}`);
    sentences.push(`Set aside: ${bits.join(', ')}.`);
  }

  return {
    ...base, applicable: true, label: null,
    rationale: sentences.join(' '),
    current: current.map((c) => ({ id: c.id, title: c.title, status: c.status, priority: c.priority, dueDate: c.due_date, estimateMinutes: c.estimate_minutes, projectKey: c.project_key, position: c.position })),
    slots, candidates, excluded,
    proposal: { taskIds: [...current.map((c) => c.id), ...add.map((c) => c.id)], keep: current.map((c) => c.id), add: add.map((c) => c.id), canApply, applyNote },
    capacityCheck,
  };
}

// ---------- Nudge preferences ----------
export async function getPreferences(db: Db, userId: string) {
  const r = await one(db, `select plan_nudge, recap_nudge, updated_at from planning_preferences where user_id = $1`, [userId]);
  return { planNudge: r?.plan_nudge ?? true, recapNudge: r?.recap_nudge ?? true, updatedAt: r?.updated_at ?? null,
    rules: [`"Plan your day": at most once a day, from ${PLAN_GRACE_MINUTES} minutes after your scheduled start, only if no intended outcome is chosen yet.`,
      `"Confirm your recap": at most once a day, in the last ${RECAP_WINDOW_MINUTES} minutes of your schedule, only if the recap is not confirmed yet.`,
      'Only on your working days: never on holidays, full-day leave or non-working days. In-app only; nothing is emailed.'] };
}
export async function setPreferences(db: Db, a: Actor, patch: { planNudge?: boolean; recapNudge?: boolean }) {
  if (!isStaff(a)) throw forbidden();
  const before = await getPreferences(db, a.id);
  const next = { planNudge: patch.planNudge ?? before.planNudge, recapNudge: patch.recapNudge ?? before.recapNudge };
  await db.query(`insert into planning_preferences (tenant_id, user_id, plan_nudge, recap_nudge) values ($1,$2,$3,$4)
    on conflict (user_id) do update set plan_nudge = $3, recap_nudge = $4, updated_at = now()`, [a.tenantId, a.id, next.planNudge, next.recapNudge]);
  if (next.planNudge !== before.planNudge || next.recapNudge !== before.recapNudge)
    await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'planning.preferences.update', resourceType: 'planning_preferences', resourceId: a.id,
      details: { before: { planNudge: before.planNudge, recapNudge: before.recapNudge }, after: next } });
  return getPreferences(db, a.id);
}

// ---------- Nudges (in-app notifications) ----------
export const PLAN_GRACE_MINUTES = 15;
export const RECAP_WINDOW_MINUTES = 45;
type NudgeKind = 'plan' | 'recap';

/** When each nudge may be sent on a working day: [from, to) in epoch ms. */
function nudgeWindows(cap: DayCapacity) {
  const start = Math.min(...cap.windows.map((w) => Date.parse(w.start)));
  const end = Math.max(...cap.windows.map((w) => Date.parse(w.end)));
  const recapFrom = Math.max(start, end - RECAP_WINDOW_MINUTES * 60000);
  return { plan: [start + PLAN_GRACE_MINUTES * 60000, recapFrom] as const, recap: [recapFrom, end] as const };
}

async function staffUsers(db: Db, tenantId: string, userId?: string) {
  return many(db, `select u.id, coalesce(u.timezone, t.timezone) tz, coalesce(pp.plan_nudge, true) plan_nudge, coalesce(pp.recap_nudge, true) recap_nudge
    from users u join tenants t on t.id = u.tenant_id left join planning_preferences pp on pp.user_id = u.id
    where u.tenant_id = $1 and u.status = 'active' and not ('customer' = any(u.roles)) and ($2::uuid is null or u.id = $2) order by u.id`, [tenantId, userId ?? null]);
}

/** Sends one nudge if the condition still holds; the planning_nudges primary key makes it idempotent per user, day and kind. */
async function sendIfNeeded(db: Db, tenantId: string, userId: string, kind: NudgeKind, date: string) {
  if (kind === 'plan') {
    const planned = await one(db, `select 1 from daily_plans dp join daily_plan_items i on i.plan_id = dp.id
      where dp.user_id = $1 and dp.date = $2 and i.removed_at is null limit 1`, [userId, date]);
    if (planned) return false;
  } else {
    const confirmed = await one(db, `select 1 from daily_reviews where user_id = $1 and date = $2 and status in ('confirmed','manager_reviewed')`, [userId, date]);
    if (confirmed) return false;
  }
  const claimed = await one(db, `insert into planning_nudges (tenant_id, user_id, date, kind) values ($1,$2,$3,$4)
    on conflict (user_id, date, kind) do nothing returning user_id`, [tenantId, userId, date, kind]);
  if (!claimed) return false;
  if (kind === 'plan') await notify(db, tenantId, userId, 'planning_plan_nudge', 'Plan your day',
    'Choose up to three intended outcomes for today. "Suggest my day" on My Day can propose them, with reasons.', '/');
  else await notify(db, tenantId, userId, 'planning_recap_nudge', 'Confirm your recap',
    'Your scheduled day ends soon. Review the suggested summary and confirm your recap; it takes about a minute.', '/recap');
  return true;
}

/**
 * Hourly tenant tick. For each staff user on a working day: sends a nudge whose window is open now, and schedules a
 * one-off job for a window that opens before the next tick (ticks are hourly; windows are 45 minutes).
 */
export async function runNudges(db: Db, tenantId: string, now = Date.now()) {
  const stats = { users: 0, sent: 0, scheduled: 0, skippedNoCapacity: 0, optedOut: 0 };
  for (const u of await staffUsers(db, tenantId)) {
    stats.users++;
    const date = DateTime.fromMillis(now, { zone: u.tz }).toISODate()!;
    const cap = dayCapacity(await loadCalendar(db, u.id, date, date), date);
    if (cap.availableMinutes <= 0 || !cap.windows.length) { stats.skippedNoCapacity++; continue; }
    const wins = nudgeWindows(cap);
    for (const kind of ['plan', 'recap'] as const) {
      if (!(kind === 'plan' ? u.plan_nudge : u.recap_nudge)) { stats.optedOut++; continue; }
      const [from, to] = wins[kind];
      if (from >= to) continue;
      if (now >= from && now < to) { if (await sendIfNeeded(db, tenantId, u.id, kind, date)) stats.sent++; }
      else if (from > now && from - now <= 65 * 60000) {
        const id = await enqueue(db, { tenantId, kind: 'planning.nudge', payload: { userId: u.id, kind, date }, runAt: new Date(from),
          idempotencyKey: `planning.nudge:${kind}:${u.id}:${date}` });
        if (id) stats.scheduled++;
      }
    }
  }
  return stats;
}

/** One scheduled nudge: re-checks preferences, capacity, window and condition at run time. */
export async function nudgeUser(db: Db, tenantId: string, userId: string, kind: NudgeKind, date: string, now = Date.now()) {
  const [u] = await staffUsers(db, tenantId, userId);
  if (!u || !(kind === 'plan' ? u.plan_nudge : u.recap_nudge)) return false;
  if (DateTime.fromMillis(now, { zone: u.tz }).toISODate() !== date) return false;
  const cap = dayCapacity(await loadCalendar(db, u.id, date, date), date);
  if (cap.availableMinutes <= 0 || !cap.windows.length) return false;
  const [from, to] = nudgeWindows(cap)[kind];
  if (now < from - 60000 || now >= to) return false;
  return sendIfNeeded(db, tenantId, u.id, kind, date);
}

// ---------- Weekly self-summary ----------
export async function weeklySummary(db: Db, a: Actor, date?: string) {
  if (!isStaff(a)) throw forbidden();
  const today = localToday(a.timezone);
  const ref = DateTime.fromISO(date ?? today);
  const start = ref.startOf('week').toISODate()!, end = ref.endOf('week').toISODate()!;
  if (start > today) throw badRequest('That week has not started yet.');
  const r = await buildReport(db, a.id, 'week', start, end, { trend: false });
  const s = r.summary;
  const nextStart = ref.startOf('week').plus({ weeks: 1 }).toISODate()!, nextEnd = ref.endOf('week').plus({ weeks: 1 }).toISODate()!;
  const nextDue = await many(db, `select t.title, t.due_date from tasks t where t.owner_id = $1 and t.status not in ('done','cancelled')
    and t.due_date between $2 and $3 order by t.due_date, t.title limit 6`, [a.id, nextStart, nextEnd]);

  // Carry-overs: intended outcomes of finished days that were not accepted by the end of that day.
  const accepted = new Set(r.acceptedOutcomes.map((o: any) => o.taskId));
  const carryMap = new Map<string, { taskId: string; title: string; days: number; lastStatus: string }>();
  for (const day of r.days as any[]) {
    if (day.date >= today) continue;
    for (const c of day.carryovers) {
      const e = carryMap.get(c.taskId) ?? { taskId: c.taskId, title: c.title, days: 0, lastStatus: c.statusAtEndOfDay };
      e.days++; e.lastStatus = c.statusAtEndOfDay; carryMap.set(c.taskId, e);
    }
  }
  const carryIds = [...carryMap.keys()];
  const nowStatus = new Map((carryIds.length ? await many(db, `select id, status from tasks where id = any($1::uuid[])`, [carryIds]) : []).map((t) => [t.id, t.status]));
  const carryovers = [...carryMap.values()].filter((c) => !accepted.has(c.taskId)).map((c) => ({ ...c, status: nowStatus.get(c.taskId) ?? c.lastStatus }))
    .sort((x, y) => y.days - x.days || x.title.localeCompare(y.title));
  const openBlockers = r.blockers.filter((b: any) => !b.resolvedAt);
  const resolvedBlockers = r.blockers.filter((b: any) => b.resolvedAt);

  const L: string[] = [];
  L.push(`Weekly summary: ${fmtDay(start)} to ${fmtDay(end)} ${DateTime.fromISO(end).year}`);
  L.push(`${a.name}. Prepared from my recorded work: plans, task status changes, time entries and recaps.`);
  L.push(s.workingDays === 0 ? 'No scheduled working days so far this week.'
    : `${plural(s.workingDays, 'working day')} so far, ${s.confirmedRecaps} with a confirmed recap${s.confirmedRecaps < s.workingDays ? ' (figures for the other days are provisional)' : ''}.`);
  L.push('');
  L.push(`Accepted outcomes (${r.acceptedOutcomes.length})`);
  if (!r.acceptedOutcomes.length) L.push('- None accepted this week.');
  for (const o of r.acceptedOutcomes as any[])
    L.push(`- ${o.title}${o.project ? ` (${o.project})` : ''}: accepted ${fmtDay(DateTime.fromJSDate(new Date(o.acceptedAt)).setZone(r.timezone).toISODate()!)}${o.reviewed ? ', reviewed' : ''}`);
  L.push('');
  L.push(`Planned outcomes: ${s.acceptedPlannedOutcomes} of ${s.intendedOutcomes} accepted on the day they were planned.`);
  L.push(`Carried over (${carryovers.length})`);
  if (!carryovers.length) L.push('- Nothing carried over.');
  for (const c of carryovers) L.push(`- ${c.title}: planned on ${plural(c.days, 'day')} without being accepted; now ${STATUS_LABEL[c.status] ?? c.status}`);
  L.push('');
  L.push(`Blockers (${openBlockers.length} open, ${resolvedBlockers.length} resolved)`);
  if (!r.blockers.length) L.push('- No blockers recorded.');
  for (const b of [...openBlockers, ...resolvedBlockers] as any[])
    L.push(`- ${b.task}: ${b.reason}${b.waitingOn ? `; waiting on ${b.waitingOn}` : ''}${b.resolvedAt ? ' (resolved)' : b.nextFollowUp ? ` (open; follow-up ${fmtDay(b.nextFollowUp)})` : ' (open; no follow-up date)'}`);
  L.push('');
  L.push('Time allocation');
  if (s.availableMinutes === 0) L.push('- No scheduled time so far this week, so time ratios are not applicable.');
  else {
    L.push(`- ${hm(s.explainedMinutes)} recorded of ${hm(s.availableMinutes)} scheduled (logging coverage ${Math.round((s.loggingCoverage ?? 0) * 100)}%; this measures how much time was recorded, not productivity).`);
    const cats = Object.entries(s.byCategory as Record<string, number>).filter(([, m]) => m > 0).map(([k, m]) => `${CAT_LABEL[k] ?? k} ${hm(m)}`);
    if (cats.length) L.push(`- By category: ${cats.join(', ')}.`);
    if (s.unknownMinutes > 0) L.push(`- ${hm(s.unknownMinutes)} of scheduled time has no time entry. Unrecorded time is unknown; it is not treated as idle.`);
  }
  L.push('');
  const dl = r.deadlines as any[];
  L.push(`Deadlines this week (${dl.length})`);
  if (!dl.length) L.push('- No deadlines fell in this week.');
  else L.push(`- ${s.deadlines.met} met, ${s.deadlines.late} met late, ${s.deadlines.overdue} overdue, ${s.deadlines.open} still open.`);
  for (const x of dl.filter((x) => x.state === 'overdue' || x.state === 'late')) L.push(`- ${x.state === 'overdue' ? 'Overdue' : 'Late'}: ${x.title} (due ${fmtDay(x.dueDate)})`);
  L.push('');

  const focus: string[] = [];
  for (const b of openBlockers.slice(0, 3) as any[]) focus.push(`Follow up on "${b.task}"${b.waitingOn ? ` with ${b.waitingOn}` : ''}.`);
  for (const c of carryovers.filter((c) => !['done', 'cancelled'].includes(c.status)).slice(0, 3))
    focus.push(c.days >= 2 ? `Split "${c.title}" into a smaller outcome; it carried over ${c.days} times.` : `Finish "${c.title}".`);
  for (const x of dl.filter((x) => x.state === 'overdue').slice(0, 3)) focus.push(`Finish "${x.title}" or agree a new date (was due ${fmtDay(x.dueDate)}).`);
  for (const t of nextDue) focus.push(`Due next week: "${t.title}" (${fmtDay(t.due_date)}).`);
  for (const rec of r.recommendations as any[]) if (['estimate', 'rebalance', 'focus', 'recap', 'correct'].includes(rec.kind)) focus.push(rec.text);
  const uniqFocus = [...new Set(focus)].slice(0, 8);
  L.push('Suggested focus for next week');
  if (!uniqFocus.length) L.push('- Nothing needs special attention. Keep planning up to three outcomes a day.');
  for (const f of uniqFocus) L.push(`- ${f}`);

  return {
    period: { start, end }, generatedAt: new Date().toISOString(), reportState: r.reportState, text: L.join('\n'),
    facts: {
      workingDays: s.workingDays, confirmedRecaps: s.confirmedRecaps, acceptedOutcomes: r.acceptedOutcomes.length,
      intendedOutcomes: s.intendedOutcomes, acceptedPlannedOutcomes: s.acceptedPlannedOutcomes, carryovers: carryovers.length,
      openBlockers: openBlockers.length, resolvedBlockers: resolvedBlockers.length,
      availableMinutes: s.availableMinutes, explainedMinutes: s.explainedMinutes, unknownMinutes: s.unknownMinutes, loggingCoverage: s.loggingCoverage,
      deadlines: s.deadlines,
    },
    assumptions: [
      'Built only from your own records with fixed rules; no AI is used. Edit the text freely before sharing it.',
      'Unrecorded time is unknown, never idle. Logging coverage is not a productivity measure.',
      'Days without a confirmed recap are provisional. Future days of the week are not counted.',
    ],
  };
}
