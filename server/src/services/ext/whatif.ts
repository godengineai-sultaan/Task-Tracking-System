import { DateTime } from 'luxon';
import { z } from 'zod';
import type { Db } from '../../lib/db.js';
import { many } from '../../lib/db.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { type Actor, has, isStaff, reviewableUserIds, taskVisibility } from '../access.js';
import { type CalendarData, dayCapacity, eachDate, loadCalendar, localToday } from '../calendar.js';

/**
 * What-if capacity planner. A deterministic, read-only schedule simulation:
 * each person's working-day capacity (work calendar) is filled greedily with their open tasks
 * (due date, then priority), giving a projected finish per task. A scenario applies hypothetical
 * changes to a copy of that model. Nothing here writes to the database.
 */

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine((v) => DateTime.fromISO(v).isValid, 'Invalid date');
const PRIORITIES = ['urgent', 'high', 'medium', 'low', 'none'] as const;

export const changeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('leave'), userId: uuid, start: isoDate, end: isoDate }),
  z.object({ type: z.literal('reassign'), taskId: uuid, toUserId: uuid }),
  z.object({ type: z.literal('allocation'), userId: uuid, percent: z.number().int().min(0).max(100) }),
  z.object({ type: z.literal('deadline'), taskId: uuid, dueDate: isoDate }),
  z.object({ type: z.literal('add_task'), ownerId: uuid, title: z.string().trim().min(1).max(300), estimateMinutes: z.number().int().min(1).max(6000),
    dueDate: isoDate.nullable().optional(), priority: z.enum(PRIORITIES).optional() }),
]);
export type Change = z.infer<typeof changeSchema>;

export const scenarioShape = {
  horizonDays: z.number().int().min(5).max(60).default(14),
  people: z.array(uuid).max(150).optional(),
  changes: z.array(changeSchema).max(50).default([]),
  unestimatedMinutes: z.number().int().min(0).max(6000).default(60),
};
export const simulateSchema = z.object({ ...scenarioShape, start: isoDate.optional() });
export type SimulateInput = z.infer<typeof simulateSchema>;

// ---------- Pure scheduling core ----------
export interface SimTask {
  key: string; id: string | null; number: number | null; title: string; visible: boolean;
  ownerId: string; status: string; priority: string; dueDate: string | null;
  estimateMinutes: number | null; loggedMinutes: number;
  /** Owner minutes still needed (estimate minus logged, or the explicit assumption). */
  remaining: number;
  assumption: 'unestimated' | 'estimate_used_up' | null;
  hypothetical: boolean;
}
export interface SimDay { date: string; status: string; capacity: number; simulatedLeave: boolean }
export interface PersonRun { used: number[]; scheduled: number; demand: number }
export interface Run { finish: Map<string, string | null>; scheduledByTask: Map<string, number>; people: Map<string, PersonRun> }

const PRIO_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };
export function queueOrder(a: SimTask, b: SimTask) {
  if (a.dueDate !== b.dueDate) {
    if (!a.dueDate) return 1;
    if (!b.dueDate) return -1;
    return a.dueDate < b.dueDate ? -1 : 1;
  }
  const p = (PRIO_RANK[a.priority] ?? 5) - (PRIO_RANK[b.priority] ?? 5);
  if (p) return p;
  const s = (a.status === 'in_progress' ? 0 : 1) - (b.status === 'in_progress' ? 0 : 1);
  if (s) return s;
  return ((a.number ?? Number.MAX_SAFE_INTEGER) - (b.number ?? Number.MAX_SAFE_INTEGER)) || a.key.localeCompare(b.key);
}

/** Greedy fill: each person works their queue one task at a time into each day's available minutes. */
export function schedule(days: Map<string, SimDay[]>, tasks: SimTask[], start: string): Run {
  const finish = new Map<string, string | null>();
  const scheduledByTask = new Map<string, number>();
  const people = new Map<string, PersonRun>();
  for (const [pid, ds] of days) {
    const left = ds.map((d) => d.capacity);
    const run: PersonRun = { used: ds.map(() => 0), scheduled: 0, demand: 0 };
    people.set(pid, run);
    let di = 0;
    const advance = () => { while (di < ds.length && left[di] <= 0) di++; };
    for (const t of tasks.filter((x) => x.ownerId === pid).sort(queueOrder)) {
      if (t.status === 'in_review') { finish.set(t.key, start); scheduledByTask.set(t.key, 0); continue; }
      run.demand += t.remaining;
      let need = t.remaining;
      let last: string | null = null;
      advance();
      if (need === 0) last = ds.length ? ds[Math.min(di, ds.length - 1)].date : null;
      while (need > 0) {
        advance();
        if (di >= ds.length) break;
        const take = Math.min(need, left[di]);
        left[di] -= take; run.used[di] += take; need -= take; last = ds[di].date;
      }
      finish.set(t.key, need > 0 ? null : last);
      scheduledByTask.set(t.key, t.remaining - need);
      run.scheduled += t.remaining - need;
    }
  }
  return { finish, scheduledByTask, people };
}

// ---------- Scope ----------
/** Managers simulate their team; leadership, routine admin and system admin anyone; employees only themselves. */
export async function simulationScope(db: Db, a: Actor): Promise<string[]> {
  if (!isStaff(a)) throw forbidden('The what-if planner is for staff');
  if (has(a, 'leadership') || has(a, 'system_admin'))
    return (await many(db, `select id from users where status = 'active' and not ('customer' = any(roles))`)).map((r) => r.id);
  if (has(a, 'routine_admin')) return reviewableUserIds(db, a);
  return [a.id, ...a.managedUserIds];
}

export function referencedUserIds(changes: Change[]) {
  const ids: string[] = [];
  for (const c of changes) {
    if (c.type === 'leave' || c.type === 'allocation') ids.push(c.userId);
    if (c.type === 'reassign') ids.push(c.toUserId);
    if (c.type === 'add_task') ids.push(c.ownerId);
  }
  return ids;
}

export function assertInScope(scope: string[], ids: string[]) {
  const s = new Set(scope);
  if (ids.some((id) => !s.has(id))) throw forbidden('You can only plan for yourself and the people you manage');
}

export async function planningContext(db: Db, a: Actor) {
  const scope = await simulationScope(db, a);
  const people = await many(db, `select u.id, u.name, u.title, d.name department from users u left join departments d on d.id = u.department_id
    where u.id = any($1::uuid[]) and u.status = 'active' order by u.id = $2 desc, u.name`, [scope, a.id]);
  const [vis, params] = taskVisibility(a, 2);
  const tasks = await many(db, `select t.id, t.number, t.title, t.owner_id, t.status, t.priority, t.due_date, t.estimate_minutes
    from tasks t left join projects p on p.id = t.project_id
    where t.owner_id = any($1::uuid[]) and t.status not in ('done','cancelled','backlog') and ${vis}
    order by t.due_date nulls last, t.number limit 2000`, [scope, ...params]);
  const defaults = people.length <= 12 ? people.map((p) => p.id) : [a.id, ...a.managedUserIds].filter((id) => scope.includes(id));
  return { today: localToday(a.timezone), people, tasks, defaults };
}

// ---------- Simulation ----------
const fmtD = (d: string | null) => (d ? DateTime.fromISO(d).setLocale('en').toFormat('ccc d LLL') : 'no date');
function hm(min: number) {
  const m = Math.round(min), h = Math.floor(m / 60), r = m % 60;
  return h ? (r ? `${h}h ${r}m` : `${h}h`) : `${r}m`;
}
const daysBetween = (a: string, b: string) => Math.round(DateTime.fromISO(b).diff(DateTime.fromISO(a), 'days').days);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

interface Outcome { finish: string | null; late: boolean; lateDays: number | null; beyondHorizon: boolean }
function outcome(finish: string | null, due: string | null, end: string): Outcome {
  if (finish) return { finish, late: !!due && finish > due, lateDays: due && finish > due ? daysBetween(due, finish) : null, beyondHorizon: false };
  return { finish: null, late: !!due && due <= end, lateDays: null, beyondHorizon: true };
}

export async function simulate(db: Db, a: Actor, input: SimulateInput) {
  const start = input.start ?? localToday(a.timezone);
  const end = DateTime.fromISO(start).plus({ days: input.horizonDays - 1 }).toISODate()!;
  const dates = eachDate(start, end);
  const scope = await simulationScope(db, a);
  const changes = input.changes;

  for (const c of changes) if (c.type === 'leave' && c.end < c.start) throw badRequest('Leave end date must be on or after its start date');

  // Tasks referenced by changes must exist, be open, be visible to the actor and be owned by someone in scope.
  const refTaskIds = [...new Set(changes.flatMap((c) => (c.type === 'reassign' || c.type === 'deadline' ? [c.taskId] : [])))];
  const [vis, visParams] = taskVisibility(a, 2);
  const refTasks = refTaskIds.length ? await many(db, `select t.id, t.number, t.owner_id, t.status from tasks t left join projects p on p.id = t.project_id
    where t.id = any($1::uuid[]) and ${vis}`, [refTaskIds, ...visParams]) : [];
  for (const id of refTaskIds) {
    const t = refTasks.find((x) => x.id === id);
    if (!t) throw notFound('A task in this scenario no longer exists or is not visible to you');
    if (['done', 'cancelled', 'backlog'].includes(t.status)) throw badRequest(`Task #${t.number} is no longer open (${t.status}); remove that change and run again`);
  }

  const requested = input.people && input.people.length ? input.people : (await planningContext(db, a)).defaults;
  const ids = [...new Set([...requested, ...referencedUserIds(changes), ...refTasks.map((t) => t.owner_id)])];
  if (!ids.length) throw badRequest('Pick at least one person');
  if (ids.length > 150) throw badRequest('Simulate at most 150 people at a time');
  assertInScope(scope, ids);
  const users = await many(db, `select id, name, title from users where id = any($1::uuid[]) and status = 'active' and not ('customer' = any(roles)) order by name`, [ids]);
  if (users.length !== ids.length) throw badRequest('A person in this scenario is no longer active');
  const name = new Map<string, string>(users.map((u) => [u.id, u.name]));

  // Real open work, with time already logged against each task.
  const rows = await many(db, `select t.id, t.number, t.title, t.owner_id, t.status, t.priority, t.due_date, t.estimate_minutes,
      coalesce((select sum(extract(epoch from (te.ended_at - te.started_at))) / 60 from time_entries te
        where te.task_id = t.id and te.deleted_at is null and te.ended_at is not null), 0)::int logged_minutes,
      ${vis} as visible
    from tasks t left join projects p on p.id = t.project_id
    where t.owner_id = any($1::uuid[]) and t.status not in ('done','cancelled','backlog')
    order by t.due_date nulls last, t.number`, [ids, ...visParams]);
  const N = input.unestimatedMinutes;
  const baseTasks: SimTask[] = rows.map((r, i) => {
    const used = r.estimate_minutes !== null && r.logged_minutes >= r.estimate_minutes;
    const assumption = r.estimate_minutes === null ? 'unestimated' : used ? 'estimate_used_up' : null;
    return {
      key: r.visible ? r.id : `private-${i + 1}`, id: r.id, number: r.number, title: r.visible ? r.title : 'Private task', visible: !!r.visible, ownerId: r.owner_id,
      status: r.status, priority: r.priority, dueDate: r.due_date, estimateMinutes: r.estimate_minutes, loggedMinutes: r.logged_minutes,
      remaining: r.status === 'in_review' ? 0 : assumption ? N : r.estimate_minutes - r.logged_minutes, assumption, hypothetical: false,
    };
  });

  // Scenario = baseline copy + changes (applied in order; later changes win).
  const scenTasks = baseTasks.map((t) => ({ ...t }));
  const byKey = new Map(scenTasks.map((t) => [t.key, t]));
  const simLeave = new Map<string, { start: string; end: string }[]>();
  const alloc = new Map<string, number>();
  let added = 0;
  for (const c of changes) {
    if (c.type === 'leave') simLeave.set(c.userId, [...(simLeave.get(c.userId) ?? []), { start: c.start, end: c.end }]);
    else if (c.type === 'allocation') alloc.set(c.userId, c.percent);
    else if (c.type === 'reassign') byKey.get(c.taskId)!.ownerId = c.toUserId;
    else if (c.type === 'deadline') byKey.get(c.taskId)!.dueDate = c.dueDate;
    else {
      const key = `new-${++added}`;
      const t: SimTask = { key, id: null, number: null, title: c.title, visible: true, ownerId: c.ownerId, status: 'planned', priority: c.priority ?? 'medium',
        dueDate: c.dueDate ?? null, estimateMinutes: c.estimateMinutes, loggedMinutes: 0, remaining: c.estimateMinutes, assumption: null, hypothetical: true };
      scenTasks.push(t); byKey.set(key, t);
    }
  }

  // Capacity per person per day from the work calendar (holidays, recorded leave), then simulated leave and allocation.
  const baseDays = new Map<string, SimDay[]>(), scenDays = new Map<string, SimDay[]>();
  for (const id of ids) {
    const cal = await loadCalendar(db, id, start, end);
    const extra = simLeave.get(id) ?? [];
    const scal: CalendarData = { ...cal, leave: [...extra.map((l) => ({ start_date: l.start, end_date: l.end, portion: 'full', kind: 'leave' })), ...cal.leave] };
    const pctOf = alloc.get(id) ?? 100;
    baseDays.set(id, dates.map((d) => { const c = dayCapacity(cal, d); return { date: d, status: c.status, capacity: c.availableMinutes, simulatedLeave: false }; }));
    scenDays.set(id, dates.map((d, i) => {
      const c = dayCapacity(scal, d);
      const onSim = extra.some((l) => l.start <= d && l.end >= d) && baseDays.get(id)![i].capacity > 0;
      return { date: d, status: onSim ? 'simulated_leave' : c.status, capacity: Math.floor((c.availableMinutes * pctOf) / 100), simulatedLeave: onSim };
    }));
  }
  const base = schedule(baseDays, baseTasks, start);
  const scen = schedule(scenDays, scenTasks, start);

  // Per-task comparison.
  const baseByKey = new Map(baseTasks.map((t) => [t.key, t]));
  const tasks = scenTasks.map((s) => {
    const b = baseByKey.get(s.key);
    const bo = b ? outcome(base.finish.get(s.key) ?? null, b.dueDate, end) : null;
    const so = outcome(scen.finish.get(s.key) ?? null, s.dueDate, end);
    let shiftDays: number | null = null;
    if (bo?.finish && so.finish) shiftDays = daysBetween(bo.finish, so.finish);
    const later = bo ? (bo.finish && !so.finish) || (shiftDays ?? 0) > 0 : false;
    const earlier = bo ? (!bo.finish && !!so.finish) || (shiftDays ?? 0) < 0 : false;
    const change = !bo ? 'added' : so.late && !bo.late ? 'newly_late' : bo.late && !so.late ? 'recovered' : later ? 'later' : earlier ? 'earlier' : 'same';
    return {
      key: s.key, id: s.visible ? s.id : null, number: s.visible ? s.number : null, title: s.title, visible: s.visible, hypothetical: s.hypothetical,
      status: s.status, priority: s.priority, estimateMinutes: s.estimateMinutes, loggedMinutes: s.loggedMinutes, remainingMinutes: s.remaining,
      assumption: s.assumption, blocked: s.status === 'blocked', awaitingReview: s.status === 'in_review',
      baselineOwnerId: b?.ownerId ?? null, ownerId: s.ownerId, baselineDueDate: b?.dueDate ?? null, dueDate: s.dueDate,
      overdueAtStart: !!s.dueDate && s.dueDate < start,
      baseline: bo, scenario: so, shiftDays, change,
    };
  });

  const personSummary = (id: string, ds: SimDay[], run: Run, list: typeof tasks, side: 'baseline' | 'scenario') => {
    const pr = run.people.get(id)!;
    const available = ds.reduce((s, d) => s + d.capacity, 0);
    const own = list.filter((t) => (side === 'baseline' ? t.baselineOwnerId === id && !t.hypothetical : t.ownerId === id));
    const lateOf = (t: (typeof tasks)[number]) => (side === 'baseline' ? t.baseline?.late : t.scenario.late);
    return {
      availableMinutes: available, workingDays: ds.filter((d) => d.capacity > 0).length,
      demandMinutes: pr.demand, scheduledMinutes: pr.scheduled, spareMinutes: Math.max(0, available - pr.scheduled), overflowMinutes: pr.demand - pr.scheduled,
      load: available > 0 ? pr.demand / available : null, openTasks: own.length, lateTasks: own.filter(lateOf).length,
      overdueTasks: own.filter((t) => { const due = side === 'baseline' ? t.baselineDueDate : t.dueDate; return !!due && due < start; }).length,
      days: ds.map((d, i) => ({ date: d.date, status: d.status, capacity: d.capacity, used: pr.used[i] })),
    };
  };
  const people = users.map((u) => ({
    id: u.id, name: u.name, title: u.title, allocationPercent: alloc.get(u.id) ?? 100,
    simulatedLeaveDays: scenDays.get(u.id)!.filter((d) => d.simulatedLeave).length,
    baseline: personSummary(u.id, baseDays.get(u.id)!, base, tasks, 'baseline'),
    scenario: personSummary(u.id, scenDays.get(u.id)!, scen, tasks, 'scenario'),
  }));

  const newlyLate = tasks.filter((t) => t.change === 'newly_late');
  const recovered = tasks.filter((t) => t.change === 'recovered');
  const unestimated = tasks.filter((t) => t.assumption).map((t) => ({
    key: t.key, id: t.id, number: t.number, title: t.title, ownerId: t.ownerId, assumption: t.assumption, assumedMinutes: N,
    reason: t.assumption === 'unestimated' ? 'No estimate on the task' : `Estimate (${hm(t.estimateMinutes ?? 0)}) already used up by logged time`,
  }));

  // Plain-language findings: what each change does, then what happens to deadlines and load.
  const findings: string[] = [];
  const label = (t: { title: string; visible: boolean; number: number | null }) => (t.visible ? `"${t.title}"` : 'a private task');
  const finishText = (o: Outcome | null) => (!o ? 'not scheduled' : o.finish ? fmtD(o.finish) : `after ${fmtD(end)}`);
  if (!changes.length) findings.push('No changes added yet, so the scenario matches the baseline projection.');
  added = 0;
  for (const c of changes) {
    if (c.type === 'leave') {
      const lost = baseDays.get(c.userId)!.filter((d) => d.date >= c.start && d.date <= c.end && d.capacity > 0);
      findings.push(lost.length
        ? `Leave for ${name.get(c.userId)} from ${fmtD(c.start)} to ${fmtD(c.end)} removes ${hm(lost.reduce((s, d) => s + d.capacity, 0))} of working time across ${plural(lost.length, 'working day')}.`
        : `Leave for ${name.get(c.userId)} from ${fmtD(c.start)} to ${fmtD(c.end)} falls on non-working days or outside the horizon, so capacity is unchanged.`);
    } else if (c.type === 'allocation') {
      const p = people.find((x) => x.id === c.userId)!;
      findings.push(`${name.get(c.userId)} at ${c.percent}% allocation: available time in the horizon goes from ${hm(p.baseline.availableMinutes)} to ${hm(p.scenario.availableMinutes)}.`);
    } else if (c.type === 'reassign') {
      const t = tasks.find((x) => x.key === c.taskId)!;
      findings.push(`${label(t)} moves from ${name.get(t.baselineOwnerId!)} to ${name.get(c.toUserId)} (${hm(t.remainingMinutes)} of remaining work).`);
    } else if (c.type === 'deadline') {
      const t = tasks.find((x) => x.key === c.taskId)!;
      findings.push(`${label(t)} is due ${fmtD(c.dueDate)} instead of ${fmtD(t.baselineDueDate)}.`);
    } else {
      findings.push(`New task "${c.title}" adds ${hm(c.estimateMinutes)} to ${name.get(c.ownerId)}'s queue${c.dueDate ? `, due ${fmtD(c.dueDate)}` : ''}.`);
    }
  }
  if (newlyLate.length) findings.push(`${plural(newlyLate.length, 'task')} would become late: ${newlyLate.slice(0, 3).map((t) => `${label(t)} (due ${fmtD(t.dueDate)}, projected ${finishText(t.scenario)})`).join('; ')}${newlyLate.length > 3 ? '; and more' : ''}.`);
  if (recovered.length) findings.push(`${plural(recovered.length, 'task')} would be back on time: ${recovered.slice(0, 3).map((t) => `${label(t)} (due ${fmtD(t.dueDate)}, projected ${finishText(t.scenario)})`).join('; ')}${recovered.length > 3 ? '; and more' : ''}.`);
  const addedLate = tasks.filter((t) => t.change === 'added' && t.scenario.late);
  if (addedLate.length) findings.push(`${plural(addedLate.length, 'new task')} would miss ${addedLate.length === 1 ? 'its' : 'their'} due date: ${addedLate.map((t) => `${label(t)} (projected ${finishText(t.scenario)})`).join('; ')}.`);
  if (changes.length && !newlyLate.length && !recovered.length && !addedLate.length) findings.push('No task moves between on time and late in this scenario.');
  const over = people.filter((p) => p.scenario.overflowMinutes > 0).sort((x, y) => y.scenario.overflowMinutes - x.scenario.overflowMinutes);
  for (const p of over.slice(0, 5))
    findings.push(`${p.name}: ${hm(p.scenario.overflowMinutes)} of open work does not fit before ${fmtD(end)} (${hm(p.scenario.demandMinutes)} needed, ${hm(p.scenario.availableMinutes)} available).`);
  if (over.length) {
    const spare = people.filter((p) => p.scenario.spareMinutes >= 240).sort((x, y) => y.scenario.spareMinutes - x.scenario.spareMinutes);
    if (spare.length) findings.push(`Unclaimed capacity in the scenario: ${spare.slice(0, 4).map((p) => `${p.name} (${hm(p.scenario.spareMinutes)})`).join(', ')}. This only means no known open work is scheduled there.`);
  }
  const lateBase = tasks.filter((t) => t.baseline?.late).length, lateScen = tasks.filter((t) => t.scenario.late).length;
  const overdue = tasks.filter((t) => t.overdueAtStart).length;
  if (overdue) findings.push(`${plural(overdue, 'task')} ${overdue === 1 ? 'was' : 'were'} already overdue on ${fmtD(start)} and ${overdue === 1 ? 'counts' : 'count'} as late in both projections.`);
  if (unestimated.length) findings.push(`${plural(unestimated.length, 'task')} ${unestimated.length === 1 ? 'has' : 'have'} no usable estimate; each is assumed to need ${hm(N)}. Add estimates to firm up these projections.`);
  const blocked = tasks.filter((t) => t.blocked).length;
  if (blocked) findings.push(`${plural(blocked, 'blocked task')} ${blocked === 1 ? 'is' : 'are'} scheduled as if the blocker clears; ${blocked === 1 ? 'it' : 'they'} may finish later.`);
  const hidden = tasks.filter((t) => !t.visible).length;
  if (hidden) findings.push(`${plural(hidden, 'task')} you cannot open ${hidden === 1 ? 'is' : 'are'} included in load figures but not named.`);

  const assumptions = [
    `Available time per person = scheduled working hours minus breaks, holidays and recorded leave, from ${fmtD(start)} to ${fmtD(end)}. The first day counts in full.`,
    'All available time is assumed to go to the open tasks shown (100% allocation) unless an allocation change says otherwise; meetings and other non-task time are not subtracted.',
    'Remaining work = the task estimate minus time already logged against it.',
    `Tasks with no estimate, or whose estimate is already used up by logged time, are assumed to need ${hm(N)} each.`,
    'Each person works one task at a time in order of due date (undated last), then priority, then in-progress first.',
    'Blocked tasks are scheduled as if the blocker clears. Tasks in review need no more owner time. Backlog, done and cancelled tasks are excluded.',
    'Reviewer time and dependencies between tasks are not modelled. Simulated leave is full days.',
    'This is a planning projection, not a performance measure. Spare capacity means no known open work is scheduled there, not that anyone is idle.',
  ];

  return {
    start, end, horizonDays: input.horizonDays, unestimatedMinutes: N, changes,
    summary: { tasks: tasks.length, baselineLate: lateBase, scenarioLate: lateScen, newlyLate: newlyLate.length, recovered: recovered.length,
      later: tasks.filter((t) => t.change === 'later').length, earlier: tasks.filter((t) => t.change === 'earlier').length, added: tasks.filter((t) => t.change === 'added').length,
      overdueAtStart: overdue, unestimated: unestimated.length },
    people, tasks, unestimated, findings, assumptions,
  };
}
