/**
 * Insights: organization & team analytics from recorded work evidence.
 * Bulk queries + SQL aggregates for the whole population (never buildReport per person-day).
 * Time allocation reuses allocateDay/dayCapacity so figures match individual reports exactly.
 * No ranking, no single score: per-person rows exist only for workload (load, alphabetical).
 */
import { DateTime } from 'luxon';
import { z } from 'zod';
import type { Db } from '../../lib/db.js';
import { many, one } from '../../lib/db.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { type Actor, has } from '../access.js';
import { allocateDay } from '../analytics.js';
import { dayCapacity, eachDate, loadCalendars, localToday, type CalendarData } from '../calendar.js';
import { registerExportReport } from '../exports.js';
import { buildObservations, insightsCsv } from './orgdashRules.js';

export const INSIGHTS_VERSION = 'insights-v1';
/** Leadership-only viewers never see aggregates for groups smaller than this, so individuals cannot be identified. */
export const MIN_GROUP = 3;
const FOCUS_BLOCK_MIN = 60;
const HORIZON_WORKING_DAYS = 10;
export const CATS = ['task', 'meeting', 'admin', 'learning', 'other'] as const;
type Cat = (typeof CATS)[number];

const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => DateTime.fromISO(s).isValid, 'Not a valid calendar date');
export const insightsQuery = z.object({
  weeks: z.coerce.number().int().refine((n) => [4, 8, 12].includes(n), 'weeks must be 4, 8 or 12').default(4),
  start: date.optional(), end: date.optional(),
  departmentId: uuid.optional(), teamId: uuid.optional(), projectId: uuid.optional(),
  scope: z.enum(['company', 'team']).optional(),
});
export type InsightsQuery = z.infer<typeof insightsQuery>;

export const INSIGHT_DEFINITIONS = {
  recapAdoption: { label: 'Recap adoption', direction: 'up', definition: 'Confirmed (or manager-reviewed) daily recaps divided by working person-days. Working person-days come from each person\'s schedule minus holidays and approved leave; today is excluded until its recap is due.' },
  loggingCoverage: { label: 'Logging coverage', direction: 'neutral', definition: 'Confirmed, non-overlapping time inside scheduled hours divided by available time, summed across people. The remainder is unknown time and is not treated as idle. Coverage describes how complete the records are, not productivity.' },
  plannedCompletion: { label: 'Planned-commitment completion', direction: 'up', definition: 'Intended outcomes on My Day plans (working days, up to three per person per day) accepted by the end of that day, divided by intended outcomes.' },
  acceptedOutcomes: { label: 'Accepted outcomes', direction: 'neutral', definition: 'Tasks that reached Done in the period (reviewer-accepted where review is required). A count of delivered outcomes, not of effort.' },
  deadlineReliability: { label: 'Deadline reliability', direction: 'up', definition: 'Commitments due in the period that were done on or before the due date, divided by those met, late or still overdue. Items not yet due are excluded.' },
  blockers: { label: 'Blockers', direction: 'neutral', definition: 'Blockers recorded on tasks owned by people in scope. Age runs from when a blocker was raised until it was resolved, or until the end of the period if still open; the median is shown. Raising blockers early is healthy, so counts are not judged.' },
  cycleTime: { label: 'Cycle time', direction: 'neutral', definition: 'Calendar time from first moving to In Progress until acceptance, for outcomes accepted in the period (median and 75th percentile). Tasks never marked In Progress are excluded and shown in coverage.' },
  reworkRate: { label: 'Rework rate', direction: 'down', definition: 'Accepted outcomes that were reopened or had changes requested before acceptance, divided by accepted outcomes.' },
  wip: { label: 'Work in progress', direction: 'neutral', definition: 'Tasks In Progress, In Review or Blocked at the end of each week, from the recorded status history (attributed to the current owner).' },
  meetingShare: { label: 'Meeting load', direction: 'neutral', definition: 'Confirmed meeting time inside scheduled hours divided by available time.' },
  // Named differently from the personal Trends "Focus time" (one task, short gaps tolerated): this counts any task time without a break or meeting.
  focusShare: { label: 'Uninterrupted task time', direction: 'neutral', definition: `Confirmed task time (on any tasks) in unbroken stretches of at least ${FOCUS_BLOCK_MIN} minutes with no overlapping meeting, inside scheduled hours, divided by available time. Unlike personal Trends focus time, switching between tasks does not break a stretch, and any gap does. A lower bound: unrecorded time is not counted either way.` },
  estimateAccuracy: { label: 'Estimate accuracy', direction: 'neutral', definition: 'For accepted outcomes with an estimate and confirmed task time from their owner: the owner\'s confirmed time on the task (overlaps counted once) divided by the estimate, totalled (1.0x = as estimated). Collaborators\' time is not included. Coverage shows how many accepted outcomes qualified.' },
  workload: { label: 'Workload', direction: 'neutral', definition: `Estimated minutes of open owned work (not Backlog) that is undated or due within each person's next ${HORIZON_WORKING_DAYS} working days, divided by their available minutes in that horizon. This is load, not performance.` },
} as const;

type Status = 'ok' | 'not_applicable' | 'no_data';
export interface Ratio { value: number | null; status: Status; num: number; den: number }
const r4 = (v: number | null) => (v === null ? null : Math.round(v * 10000) / 10000);
const r1 = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10);
function ratio(num: number, den: number, na: boolean): Ratio {
  num = Math.round(num); den = Math.round(den);
  if (na) return { value: null, status: 'not_applicable', num, den };
  return den > 0 ? { value: r4(num / den), status: 'ok', num, den } : { value: null, status: 'no_data', num, den };
}
export function quantile(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}
const D = (s: string) => DateTime.fromISO(s, { zone: 'utc' });
const addDays = (s: string, n: number) => D(s).plus({ days: n }).toISODate()!;
const localMidnight = (tz: string, d: string) => DateTime.fromISO(d, { zone: tz }).startOf('day').toMillis();

// ---------------------------------------------------------------- scope

export interface Scope {
  mode: 'company' | 'team';
  perPerson: boolean;
  userIds: string[];
  foundersExcluded: boolean;
  canCompany: boolean;
  canTeam: boolean;
  suppressed: string | null;
  notes: string[];
}

/** Who is in scope. Managers: their teams. Main admin: everyone (founder policy). Leadership-only: aggregates, no per-person rows. */
export async function resolveScope(db: Db, a: Actor, q: Partial<InsightsQuery>): Promise<Scope> {
  const admin = has(a, 'routine_admin'), leader = has(a, 'leadership'), manager = a.managedUserIds.length > 0;
  if (has(a, 'customer') || (!admin && !leader && !manager)) throw forbidden('Insights are available to team managers, the main administrator and leadership');
  const canCompany = admin || leader;
  let mode: 'company' | 'team';
  if (q.scope === 'team') { if (!manager) throw forbidden('You do not manage a team'); mode = 'team'; }
  else if (q.scope === 'company') { if (!canCompany) throw forbidden('Company-wide insights need the main administrator or leadership role'); mode = 'company'; }
  else mode = admin || !manager ? 'company' : 'team';

  const hideFounders = mode === 'company' && a.tenantSettings.founders_visible_to_routine_admin === false && !a.isFounder;
  // Active staff only in both modes (managedUserIds also lists deactivated or invited team members).
  const base: string[] = (await many(db, `select id from users where status = 'active' and not ('customer' = any(roles))
    and ($3::boolean = false or id = any($4::uuid[])) and ($1::boolean = false or is_founder = false or id = $2)`,
    [hideFounders, a.id, mode === 'team', a.managedUserIds])).map((r) => r.id);
  const perPerson = mode === 'team' || admin;
  const notes: string[] = ['Built from recorded work evidence only. Nothing here ranks people or produces a productivity score.'];
  if (hideFounders) notes.push('Founders are excluded under your organization\'s founder-visibility policy.');
  if (!perPerson) notes.push(`Aggregates only: individual rows are not shown, and groups smaller than ${MIN_GROUP} people are withheld.`);

  const filters: Set<string>[] = [];
  if (q.departmentId) {
    if (!(await one(db, `select 1 from departments where id = $1`, [q.departmentId]))) throw notFound('Department not found');
    const r = await many(db, `select id from users where id = any($1::uuid[]) and department_id = $2`, [base, q.departmentId]);
    filters.push(new Set(r.map((x) => x.id)));
  }
  if (q.teamId) {
    const team = await one(db, `select id, manager_id from teams where id = $1`, [q.teamId]);
    if (!team) throw notFound('Team not found');
    if (mode === 'team' && team.manager_id !== a.id) throw forbidden('You can only view teams you manage');
    filters.push(new Set((await many(db, `select user_id from team_members where team_id = $1`, [q.teamId])).map((x) => x.user_id)));
  }
  if (q.projectId) {
    const p = await one(db, `select p.id from projects p where p.id = $1 and ($3::boolean or p.visibility = 'company' or p.owner_id = $2
      or exists (select 1 from project_members pm where pm.project_id = p.id and pm.user_id = $2))`, [q.projectId, a.id, admin || leader]);
    if (!p) throw notFound('Project not found');
    filters.push(new Set((await many(db, `select owner_id uid from tasks where project_id = $1 union select user_id from project_members where project_id = $1
      union select owner_id from projects where id = $1 and owner_id is not null`, [q.projectId])).map((x) => x.uid)));
    notes.push('Project filter: task metrics count only this project\'s tasks; time and recap metrics cover the people working on it (owner, members and task owners).');
  }
  /** People matching the filters whose bit is set in mask (mask 0 = the unfiltered scope). */
  const pick = (mask: number) => base.filter((id) => filters.every((f, i) => !((mask >> i) & 1) || f.has(id)));
  const full = (1 << filters.length) - 1;
  const ids = pick(full);
  let suppressed: string | null = null;
  if (!perPerson && ids.length > 0) {
    if (ids.length < MIN_GROUP) suppressed = `This selection covers fewer than ${MIN_GROUP} people. Aggregates for very small groups are withheld from leadership-only access so individuals cannot be identified.`;
    // Differencing guard: a wider selection (dropping any filter) must not differ by only 1-2 people, or subtracting the two would reveal them.
    else if (Array.from({ length: full }, (_, m) => pick(m).length - ids.length).some((d) => d > 0 && d < MIN_GROUP))
      suppressed = `Fewer than ${MIN_GROUP} people in the wider view fall outside this selection, so comparing the two would identify them. Aggregates are withheld from leadership-only access.`;
  }
  return { mode, perPerson, userIds: ids, foundersExcluded: hideFounders, canCompany, canTeam: manager, suppressed, notes };
}

/** Filter choices for the page, limited to what the viewer may select. */
export async function insightsOptions(db: Db, a: Actor) {
  const s = await resolveScope(db, a, {});
  const admin = has(a, 'routine_admin'), leader = has(a, 'leadership');
  const teams = await many(db, `select t.id, t.name, t.department_id, (t.manager_id = $1) managed_by_me from teams t
    where $2::boolean or t.manager_id = $1 order by t.name`, [a.id, s.canCompany]);
  const departments = s.canCompany ? await many(db, `select id, name from departments order by name`)
    : await many(db, `select distinct d.id, d.name from departments d join users u on u.department_id = d.id where u.id = any($1::uuid[]) order by d.name`, [a.managedUserIds]);
  const projects = await many(db, `select p.id, p.key, p.name from projects p where p.status <> 'archived' and ($2::boolean or p.visibility = 'company' or p.owner_id = $1
    or exists (select 1 from project_members pm where pm.project_id = p.id and pm.user_id = $1)) order by p.name`, [a.id, admin || leader]);
  return {
    defaultScope: s.mode, scopes: [...(s.canCompany ? ['company'] : []), ...(s.canTeam ? ['team'] : [])],
    perPersonCompany: admin, departments, teams, projects, minGroup: MIN_GROUP,
  };
}

// ---------------------------------------------------------------- period

export interface Bucket { start: string; end: string; t0: number; t1: number }
export interface WeekBucket extends Bucket { weekOf: string; partial: boolean; complete: boolean }

export function resolvePeriod(q: Pick<InsightsQuery, 'weeks' | 'start' | 'end'>, today: string) {
  let start: string, end: string;
  if (q.start || q.end) {
    end = q.end && q.end < today ? q.end : today;
    start = q.start ?? addDays(end, -27);
    if (start > end) throw badRequest('The start date must be on or before the end date, and not in the future');
  } else {
    end = today;
    start = D(today).startOf('week').minus({ weeks: q.weeks - 1 }).toISODate()!;
  }
  const days = Math.round(D(end).diff(D(start), 'days').days) + 1;
  if (days > 26 * 7) throw badRequest('Choose a period of 26 weeks or less');
  const weeks: { start: string; end: string; weekOf: string; partial: boolean; complete: boolean }[] = [];
  for (let m = D(start).startOf('week'); m.toISODate()! <= end; m = m.plus({ weeks: 1 })) {
    const ws = m.toISODate()!, we = m.plus({ days: 6 }).toISODate()!;
    weeks.push({ start: ws < start ? start : ws, end: we > end ? end : we, weekOf: ws, partial: ws < start || we > end, complete: ws >= start && we <= end && we < today });
  }
  return { start, end, days, prevStart: addDays(start, -days), prevEnd: addDays(start, -1), weeks };
}

// ---------------------------------------------------------------- raw data

interface PersonDay { userId: string; date: string; working: boolean; available: number; explained: number; byCat: Record<Cat, number>; focus: number; recap: boolean; intended: number; acceptedPlanned: number }
interface AcceptedTask { ownerId: string; at: number; category: string; startedAt: number | null; estimate: number | null; actual: number; entries: number; reworked: boolean }
interface Raw {
  now: number;
  personDays: PersonDay[];
  accepted: AcceptedTask[];
  deadlines: { ownerId: string; date: string; met: number; late: number; overdue: number; open: number }[];
  blockers: { ownerId: string; cause: string; raised: number; resolved: number | null }[];
  /** WIP snapshot by snapshot date key, then by owner. */
  wip: Map<string, Map<string, { wip: number; blocked: number; inReview: number }>>;
}

type Iv = [number, number];
function union(ivs: Iv[]): Iv[] {
  const s = ivs.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: Iv[] = [];
  for (const iv of s) { const last = out[out.length - 1]; if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]); else out.push([iv[0], iv[1]]); }
  return out;
}
function subtract(a: Iv[], b: Iv[]): Iv[] {
  let cur = a;
  for (const [b0, b1] of b) cur = cur.flatMap(([a0, a1]): Iv[] => (b1 <= a0 || b0 >= a1 ? [[a0, a1]] : [[a0, b0], [b1, a1]].filter(([x, y]) => y > x) as Iv[]));
  return cur;
}
/** Task time in contiguous blocks >= FOCUS_BLOCK_MIN inside the scheduled window(s), with meetings cut out. */
export function focusMinutes(entries: any[], windows: { start: string; end: string }[], now: number) {
  const ms = (v: any) => (v instanceof Date ? v.getTime() : Date.parse(v));
  const wins = windows.map((w) => [Date.parse(w.start), Date.parse(w.end)] as Iv);
  const clip = (cat: string) => union(entries.filter((e) => e.category === cat).flatMap((e) => {
    const a = ms(e.started_at), b = e.ended_at ? ms(e.ended_at) : now;
    return wins.map(([w0, w1]) => [Math.max(a, w0), Math.min(b, w1)] as Iv);
  }));
  const blocks = subtract(clip('task'), clip('meeting'));
  return blocks.reduce((s, [a, b]) => s + ((b - a) / 60000 >= FOCUS_BLOCK_MIN ? (b - a) / 60000 : 0), 0);
}

async function loadUsers(db: Db, ids: string[]) {
  return many(db, `select u.id, u.name, u.department_id, d.name department, coalesce(u.timezone, tn.timezone) tz
    from users u join tenants tn on tn.id = u.tenant_id left join departments d on d.id = u.department_id where u.id = any($1::uuid[])`, [ids]);
}

async function loadRaw(db: Db, users: any[], cals: Map<string, CalendarData & { scheduleKey: string }>, p: ReturnType<typeof resolvePeriod>, tz: string, today: string, now: number, snapshotKeys: string[], projectId: string | null): Promise<Raw> {
  const ids = users.map((u) => u.id);
  const from = p.prevStart, to = p.end;
  const t0 = localMidnight(tz, from), t1 = Math.min(localMidnight(tz, addDays(to, 1)), now);
  const dayLimit = to < today ? to : addDays(today, -1);
  const margin = 86400000 * 2;
  const snapshots = snapshotKeys.map((k) => ({ key: k, at: Math.min(localMidnight(tz, addDays(k, 1)), now) })).sort((x, y) => x.at - y.at);
  const firstSnap = new Date(snapshots[0]?.at ?? now), lastSnap = new Date(snapshots[snapshots.length - 1]?.at ?? now);
  const [entries, recaps, plans, accepted, deadlines, blockers, wipBase, wipChanges, starts] = await Promise.all([
    many(db, `select id, user_id, category, source, started_at, ended_at, created_at from time_entries
      where user_id = any($1::uuid[]) and deleted_at is null and started_at < $3 and coalesce(ended_at, now()) > $2 order by started_at`,
      [ids, new Date(t0 - margin), new Date(localMidnight(tz, addDays(to, 1)) + margin)]),
    many(db, `select user_id, date::text as date from daily_reviews where user_id = any($1::uuid[]) and date between $2 and $3
      and status in ('confirmed','manager_reviewed')`, [ids, from, to]),
    many(db, `select dp.user_id, dp.date::text as date, count(*)::int intended,
        count(*) filter (where (select h.to_status from task_state_history h where h.task_id = dpi.task_id
          and h.at < ((dp.date + 1)::timestamp at time zone coalesce(u.timezone, $4)) order by h.at desc, h.id desc limit 1) = 'done')::int accepted
      from daily_plans dp join daily_plan_items dpi on dpi.plan_id = dp.id and dpi.removed_at is null
      join users u on u.id = dp.user_id join tasks t on t.id = dpi.task_id
      where dp.user_id = any($1::uuid[]) and dp.date between $2 and $3 and ($5::uuid is null or t.project_id = $5)
      group by dp.user_id, dp.date`, [ids, from, to, tz, projectId]),
    many(db, `select t.id, t.owner_id, t.category, t.estimate_minutes, t.started_at, t.accepted_at,
        (exists (select 1 from task_state_history h where h.task_id = t.id and h.from_status in ('done','in_review')
            and h.to_status in ('in_progress','planned','backlog') and h.at <= t.accepted_at)
          or exists (select 1 from task_reviews r where r.task_id = t.id and r.decision = 'changes_requested' and r.created_at <= t.accepted_at)) reworked
      from tasks t where t.owner_id = any($1::uuid[]) and t.status = 'done' and t.accepted_at >= $2 and t.accepted_at < $3
        and ($4::uuid is null or t.project_id = $4)`, [ids, new Date(t0), new Date(t1), projectId]),
    many(db, `select t.owner_id, t.due_date::text as date,
        count(*) filter (where t.status = 'done' and (t.done_at at time zone $4)::date <= t.due_date)::int met,
        count(*) filter (where t.status = 'done' and (t.done_at at time zone $4)::date > t.due_date)::int late,
        count(*) filter (where t.status <> 'done' and t.due_date < $5::date)::int overdue,
        count(*) filter (where t.status <> 'done' and t.due_date >= $5::date)::int open
      from tasks t where t.owner_id = any($1::uuid[]) and t.due_date between $2 and $3 and t.status <> 'cancelled'
        and ($6::uuid is null or t.project_id = $6) group by 1, 2`, [ids, from, to, tz, today, projectId]),
    many(db, `select t.owner_id, b.cause, b.raised_at, b.resolved_at from blockers b join tasks t on t.id = b.task_id
      where t.owner_id = any($1::uuid[]) and b.raised_at < $3 and coalesce(b.resolved_at, now()) > $2
        and ($4::uuid is null or t.project_id = $4)`, [ids, new Date(t0), new Date(t1), projectId]),
    // Work in progress at each week end in one ordered pass: each task's status before the first snapshot, then the changes since
    // (instead of re-scanning and re-sorting all history once per snapshot).
    many(db, `select distinct on (h.task_id) h.task_id, t.owner_id, h.to_status from task_state_history h join tasks t on t.id = h.task_id
      where t.owner_id = any($1::uuid[]) and h.at < $2 and ($3::uuid is null or t.project_id = $3) order by h.task_id, h.at desc, h.id desc`, [ids, firstSnap, projectId]),
    many(db, `select h.task_id, t.owner_id, h.to_status, h.at from task_state_history h join tasks t on t.id = h.task_id
      where t.owner_id = any($1::uuid[]) and h.at >= $2 and h.at < $3 and ($4::uuid is null or t.project_id = $4) order by h.at, h.id`, [ids, firstSnap, lastSnap, projectId]),
    // Days before a person's records begin (account, time, plan or recap) are not working days to compare: they are not "unknown time".
    many(db, `select u.id, least((u.created_at at time zone coalesce(u.timezone, tn.timezone))::date,
        (select (min(te.started_at) at time zone coalesce(u.timezone, tn.timezone))::date from time_entries te where te.user_id = u.id and te.deleted_at is null),
        (select min(dp.date) from daily_plans dp where dp.user_id = u.id), (select min(dr.date) from daily_reviews dr where dr.user_id = u.id))::text records_start
      from users u join tenants tn on tn.id = u.tenant_id where u.id = any($1::uuid[])`, [ids]),
  ]);
  // Estimate actuals: the owner's own confirmed time on each accepted task, overlaps merged (as personal Trends), in one grouped query.
  const ownerTime = accepted.length ? await many(db, `select te.task_id, te.started_at, te.ended_at from time_entries te join tasks t on t.id = te.task_id
    where te.task_id = any($1::uuid[]) and te.user_id = t.owner_id and te.deleted_at is null and te.ended_at is not null`, [accepted.map((t) => t.id)]) : [];
  const timeBy = new Map<string, Iv[]>();
  for (const e of ownerTime) { const l = timeBy.get(e.task_id) ?? []; l.push([e.started_at.getTime(), e.ended_at.getTime()]); timeBy.set(e.task_id, l); }
  const recordsStart = new Map(starts.map((r) => [r.id as string, r.records_start as string]));
  // Most people share the organization timezone and default schedule: compute each day's capacity once per (timezone, schedule).
  const capCache = new Map<string, ReturnType<typeof dayCapacity>>(), midCache = new Map<string, number>();
  const midnight = (z: string, d: string) => { const k = `${z}|${d}`; let v = midCache.get(k); if (v === undefined) { v = localMidnight(z, d); midCache.set(k, v); } return v; };
  const capacityOf = (cal: CalendarData & { scheduleKey: string }, d: string) => {
    if (cal.leave.length) return dayCapacity(cal, d);
    const k = `${cal.timezone}|${cal.scheduleKey}|${d}`;
    let v = capCache.get(k); if (!v) { v = dayCapacity(cal, d); capCache.set(k, v); }
    return v;
  };

  const recapSet = new Set(recaps.map((r) => `${r.user_id}|${r.date}`));
  const planMap = new Map(plans.map((r) => [`${r.user_id}|${r.date}`, r]));
  const byUser = new Map<string, any[]>();
  for (const e of entries) { const l = byUser.get(e.user_id); if (l) l.push(e); else byUser.set(e.user_id, [e]); }
  const personDays: PersonDay[] = [];
  const zero = () => ({ task: 0, meeting: 0, admin: 0, learning: 0, other: 0 });
  if (dayLimit >= from) {
    for (const u of users) {
      const cal = cals.get(u.id)!;
      const ues = byUser.get(u.id) ?? [];
      const startsOn = recordsStart.get(u.id) ?? from;
      for (const d of eachDate(from, dayLimit)) {
        const cap = capacityOf(cal, d);
        if (cap.availableMinutes <= 0 || d < startsOn) { personDays.push({ userId: u.id, date: d, working: false, available: 0, explained: 0, byCat: zero(), focus: 0, recap: false, intended: 0, acceptedPlanned: 0 }); continue; }
        const ds = midnight(u.tz, d), de = midnight(u.tz, addDays(d, 1));
        const dayEntries = ues.filter((e) => e.started_at.getTime() < de && (e.ended_at ? e.ended_at.getTime() : now) > ds);
        const alloc = allocateDay(dayEntries, cap, ds, de, now);
        const plan = planMap.get(`${u.id}|${d}`);
        personDays.push({ userId: u.id, date: d, working: true, available: cap.availableMinutes, explained: alloc.explainedMinutes, byCat: alloc.byCategory,
          focus: Math.min(Math.round(focusMinutes(dayEntries, cap.windows, now)), alloc.explainedMinutes),
          recap: recapSet.has(`${u.id}|${d}`), intended: plan?.intended ?? 0, acceptedPlanned: plan?.accepted ?? 0 });
      }
    }
  }
  const wip = new Map(snapshotKeys.map((k) => [k, new Map<string, { wip: number; blocked: number; inReview: number }>()]));
  const state = new Map<string, { owner: string; status: string }>(wipBase.map((r) => [r.task_id, { owner: r.owner_id, status: r.to_status }]));
  let ci = 0;
  for (const snap of snapshots) {
    while (ci < wipChanges.length && wipChanges[ci].at.getTime() < snap.at) { const c = wipChanges[ci++]; state.set(c.task_id, { owner: c.owner_id, status: c.to_status }); }
    const per = wip.get(snap.key)!;
    for (const { owner, status } of state.values()) {
      if (!['in_progress', 'in_review', 'blocked'].includes(status)) continue;
      const v = per.get(owner) ?? { wip: 0, blocked: 0, inReview: 0 };
      v.wip++; if (status === 'blocked') v.blocked++; if (status === 'in_review') v.inReview++;
      per.set(owner, v);
    }
  }
  return {
    now, personDays, wip,
    accepted: accepted.map((t) => ({ ownerId: t.owner_id, at: t.accepted_at.getTime(), category: t.category, startedAt: t.started_at ? t.started_at.getTime() : null,
      estimate: t.estimate_minutes, actual: union(timeBy.get(t.id) ?? []).reduce((m, [a, b]) => m + (b - a) / 60000, 0), entries: (timeBy.get(t.id) ?? []).length, reworked: t.reworked })),
    deadlines: deadlines.map((r) => ({ ownerId: r.owner_id, date: r.date, met: r.met, late: r.late, overdue: r.overdue, open: r.open })),
    blockers: blockers.map((b) => ({ ownerId: b.owner_id, cause: b.cause, raised: b.raised_at.getTime(), resolved: b.resolved_at ? b.resolved_at.getTime() : null })),
  };
}

// ---------------------------------------------------------------- aggregation

export type Metrics = ReturnType<typeof aggregate>;

function aggregate(raw: Raw, b: Bucket, only: Set<string>) {
  const pds = raw.personDays.filter((d) => d.date >= b.start && d.date <= b.end && only.has(d.userId));
  const work = pds.filter((d) => d.working);
  const na = work.length === 0;
  const sum = (f: (d: PersonDay) => number) => work.reduce((s, d) => s + f(d), 0);
  const available = sum((d) => d.available), explained = sum((d) => d.explained);
  const byCategory = Object.fromEntries(CATS.map((c) => [c, Math.round(sum((d) => d.byCat[c]))])) as Record<Cat, number>;
  const intended = sum((d) => d.intended);

  const acc = raw.accepted.filter((t) => t.at >= b.t0 && t.at < b.t1 && only.has(t.ownerId));
  const cyc = acc.filter((t) => t.startedAt !== null && t.startedAt <= t.at).map((t) => (t.at - t.startedAt!) / 3.6e6);
  const est = acc.filter((t) => t.estimate && t.entries > 0);
  const ratios = est.map((t) => t.actual / t.estimate!);
  const estSum = est.reduce((s, t) => s + t.estimate!, 0), actSum = est.reduce((s, t) => s + t.actual, 0);

  const dl = raw.deadlines.filter((r) => r.date >= b.start && r.date <= b.end && only.has(r.ownerId))
    .reduce((s, r) => ({ met: s.met + r.met, late: s.late + r.late, overdue: s.overdue + r.overdue, open: s.open + r.open }), { met: 0, late: 0, overdue: 0, open: 0 });

  const end = Math.min(b.t1, raw.now);
  const bl = raw.blockers.filter((x) => only.has(x.ownerId) && x.raised < b.t1 && (x.resolved ?? Infinity) > b.t0);
  const ages = bl.map((x) => (Math.min(x.resolved ?? end, end) - x.raised) / 3.6e6);

  const snap = raw.wip.get(b.end);
  let wip: number | null = null, blocked = 0, inReview = 0;
  if (snap) { wip = 0; for (const [owner, v] of snap) if (only.has(owner)) { wip += v.wip; blocked += v.blocked; inReview += v.inReview; } }

  return {
    people: only.size,
    workingPersonDays: work.length,
    nonWorkingPersonDays: pds.length - work.length,
    recapAdoption: ratio(work.filter((d) => d.recap).length, work.length, na),
    loggingCoverage: { ...ratio(explained, available, na), unknownMinutes: Math.round(Math.max(0, available - explained)) },
    byCategory,
    plannedCompletion: { ...ratio(sum((d) => d.acceptedPlanned), intended, na), planDays: work.filter((d) => d.intended > 0).length },
    acceptedOutcomes: acc.length,
    deadlineReliability: { ...ratio(dl.met, dl.met + dl.late + dl.overdue, false), ...dl },
    blockers: { raised: bl.filter((x) => x.raised >= b.t0).length, active: bl.length, openAtEnd: bl.filter((x) => x.resolved === null || x.resolved >= end).length,
      medianAgeHours: r1(quantile(ages, 0.5)) },
    cycleTime: { n: cyc.length, accepted: acc.length, medianHours: r1(quantile(cyc, 0.5)), p75Hours: r1(quantile(cyc, 0.75)) },
    reworkRate: ratio(acc.filter((t) => t.reworked).length, acc.length, false),
    wip: { value: wip, blocked, inReview },
    meetingShare: ratio(byCategory.meeting, available, na),
    focusShare: ratio(sum((d) => d.focus), available, na),
    estimateAccuracy: { value: estSum > 0 ? r4(actSum / estSum) : null, status: (est.length ? 'ok' : 'no_data') as Status, n: est.length, accepted: acc.length,
      medianRatio: r4(quantile(ratios, 0.5)), withinBand: est.length ? r4(ratios.filter((x) => x >= 0.75 && x <= 1.25).length / est.length) : null,
      actualMinutes: Math.round(actSum), estimateMinutes: estSum },
  };
}

const CYCLE_BUCKETS = [
  { key: 'lt1d', label: 'Under 1 day', maxHours: 24 }, { key: '1to3d', label: '1 to 3 days', maxHours: 72 },
  { key: '3to7d', label: '3 to 7 days', maxHours: 168 }, { key: '1to2w', label: '1 to 2 weeks', maxHours: 336 }, { key: 'gt2w', label: 'Over 2 weeks', maxHours: Infinity },
];

function workloadFor(users: any[], cals: Map<string, CalendarData>, open: any[], today: string) {
  const horizonEnd = addDays(today, 20);
  return users.map((u) => {
    let avail = 0, wd = 0, last = today;
    for (const d of eachDate(today, horizonEnd)) { const c = dayCapacity(cals.get(u.id)!, d); if (c.availableMinutes > 0) { avail += c.availableMinutes; wd++; last = d; } if (wd >= HORIZON_WORKING_DAYS) break; }
    const mine = open.filter((t) => t.owner_id === u.id && (t.due === null || t.due <= last));
    const s = (k: string) => mine.reduce((x, t) => x + t[k], 0);
    const openTasks = s('n'), estimated = s('estimated'), est = s('est');
    return {
      userId: u.id, name: u.name, departmentId: u.department_id, department: u.department ?? null,
      openTasks, estimatedTasks: estimated, estimateCoverage: openTasks ? r4(estimated / openTasks) : null, estimatedMinutes: est,
      availableMinutes: avail, horizonWorkingDays: wd, load: ratio(est, avail, avail === 0),
      inProgress: s('in_progress'), blocked: s('blocked'), inReview: s('in_review'), overdue: open.filter((t) => t.owner_id === u.id && t.due !== null && t.due < today).reduce((x, t) => x + t.n, 0),
    };
  });
}

// ---------------------------------------------------------------- entry point

export async function computeInsights(db: Db, a: Actor, q: InsightsQuery) {
  const t = await one(db, `select timezone from tenants where id = $1`, [a.tenantId]);
  const tz: string = t.timezone, today = localToday(tz), now = Date.now();
  const scope = await resolveScope(db, a, q);
  const p = resolvePeriod(q, today);
  const bucket = (start: string, end: string): Bucket => ({ start, end, t0: localMidnight(tz, start), t1: Math.min(localMidnight(tz, addDays(end, 1)), now) });
  const base = {
    version: INSIGHTS_VERSION, generatedAt: new Date(now).toISOString(), timezone: tz, today,
    period: { start: p.start, end: p.end, days: p.days, weeks: p.weeks.length, previous: { start: p.prevStart, end: p.prevEnd } },
    filters: { departmentId: q.departmentId ?? null, teamId: q.teamId ?? null, projectId: q.projectId ?? null },
    scope: { mode: scope.mode, perPerson: scope.perPerson, people: scope.userIds.length, foundersExcluded: scope.foundersExcluded, notes: scope.notes, minGroup: MIN_GROUP },
    definitions: INSIGHT_DEFINITIONS,
  };
  const empty = { ...base, suppressed: scope.suppressed, weeks: [], totals: null, groups: [], blockersByCause: [], cycleTime: null, workload: null, observations: [] };
  if (scope.suppressed || scope.userIds.length === 0) return empty;

  const users = (await loadUsers(db, scope.userIds)).sort((x, y) => x.name.localeCompare(y.name));
  const cals = await loadCalendars(db, users, p.prevStart, addDays(today > p.end ? today : p.end, 21));
  const snapshotKeys = [...new Set([...p.weeks.map((w) => w.end), p.prevEnd])];
  const raw = await loadRaw(db, users, cals, p, tz, today, now, snapshotKeys, q.projectId ?? null);
  const all = new Set(scope.userIds);

  const weekBuckets: WeekBucket[] = p.weeks.map((w) => ({ ...bucket(w.start, w.end), weekOf: w.weekOf, partial: w.partial, complete: w.complete }));
  const weeks = weekBuckets.map((w) => ({ weekOf: w.weekOf, start: w.start, end: w.end, partial: w.partial, complete: w.complete, metrics: aggregate(raw, w, all) }));
  const cur = bucket(p.start, p.end), prev = bucket(p.prevStart, p.prevEnd);
  const totals = { current: aggregate(raw, cur, all), previous: aggregate(raw, prev, all) };

  // Groups (departments), alphabetical. Leadership-only viewers do not get groups smaller than MIN_GROUP.
  const groupMap = new Map<string, { id: string | null; name: string; ids: Set<string> }>();
  for (const u of users) {
    const k = u.department_id ?? 'none';
    if (!groupMap.has(k)) groupMap.set(k, { id: u.department_id, name: u.department ?? 'No department', ids: new Set() });
    groupMap.get(k)!.ids.add(u.id);
  }
  const sortedGroups = [...groupMap.values()].sort((x, y) => x.name.localeCompare(y.name));
  const withheld = new Set(scope.perPerson ? [] : sortedGroups.filter((g) => g.ids.size < MIN_GROUP));
  // Complementary suppression: if the withheld groups add up to 1-2 people, total minus visible groups would reveal them,
  // so also withhold the smallest visible groups until the withheld total reaches MIN_GROUP.
  let withheldPeople = [...withheld].reduce((s, g) => s + g.ids.size, 0);
  for (const g of [...sortedGroups].sort((x, y) => x.ids.size - y.ids.size)) {
    if (withheldPeople === 0 || withheldPeople >= MIN_GROUP) break;
    if (!withheld.has(g)) { withheld.add(g); withheldPeople += g.ids.size; }
  }
  const groups = sortedGroups.map((g) => {
    const hidden = withheld.has(g);
    return { id: g.id, name: g.name, people: g.ids.size, suppressed: hidden,
      metrics: hidden ? null : aggregate(raw, cur, g.ids), weekly: hidden ? null : weekBuckets.map((w) => aggregate(raw, w, g.ids)) };
  });

  // Blockers by cause and cycle-time breakdowns for the current period.
  const end = Math.min(cur.t1, now);
  const active = raw.blockers.filter((x) => x.raised < cur.t1 && (x.resolved ?? Infinity) > cur.t0);
  const causes = [...new Set(active.map((x) => x.cause))];
  const blockersByCause = causes.map((c) => {
    const xs = active.filter((x) => x.cause === c);
    return { cause: c, active: xs.length, raised: xs.filter((x) => x.raised >= cur.t0).length, openAtEnd: xs.filter((x) => x.resolved === null || x.resolved >= end).length,
      medianAgeHours: r1(quantile(xs.map((x) => (Math.min(x.resolved ?? end, end) - x.raised) / 3.6e6), 0.5)) };
  }).sort((x, y) => y.active - x.active || x.cause.localeCompare(y.cause));
  const acc = raw.accepted.filter((x) => x.at >= cur.t0 && x.at < cur.t1);
  const started = acc.filter((x) => x.startedAt !== null && x.startedAt <= x.at).map((x) => ({ category: x.category, h: (x.at - x.startedAt!) / 3.6e6 }));
  const cycleTime = {
    accepted: acc.length, withStart: started.length,
    distribution: CYCLE_BUCKETS.map((bk, i) => ({ key: bk.key, label: bk.label, count: started.filter((s) => s.h < bk.maxHours && (i === 0 || s.h >= CYCLE_BUCKETS[i - 1].maxHours)).length })),
    byCategory: [...new Set(acc.map((x) => x.category))].sort().map((c) => {
      const hs = started.filter((s) => s.category === c).map((s) => s.h);
      return { category: c, accepted: acc.filter((x) => x.category === c).length, n: hs.length, medianHours: r1(quantile(hs, 0.5)), p75Hours: r1(quantile(hs, 0.75)) };
    }),
  };

  // Workload (current): per person only when allowed; department totals always (small groups withheld for leadership-only).
  const open = await many(db, `select owner_id, due_date::text as due, count(*)::int n, count(estimate_minutes)::int estimated, coalesce(sum(estimate_minutes), 0)::int est,
      count(*) filter (where status = 'in_progress')::int in_progress, count(*) filter (where status = 'blocked')::int blocked, count(*) filter (where status = 'in_review')::int in_review
    from tasks where owner_id = any($1::uuid[]) and status not in ('done','cancelled','backlog') and ($2::uuid is null or project_id = $2) group by 1, 2`, [scope.userIds, q.projectId ?? null]);
  const rows = workloadFor(users, cals, open, today);
  const sumRows = (rs: typeof rows) => {
    const s = (f: (r: (typeof rows)[number]) => number) => rs.reduce((x, r) => x + f(r), 0);
    const avail = s((r) => r.availableMinutes), est = s((r) => r.estimatedMinutes), openTasks = s((r) => r.openTasks);
    return { people: rs.length, openTasks, estimatedTasks: s((r) => r.estimatedTasks), estimateCoverage: openTasks ? r4(s((r) => r.estimatedTasks) / openTasks) : null,
      estimatedMinutes: est, availableMinutes: avail, load: ratio(est, avail, avail === 0), overloaded: rs.filter((r) => r.load.value !== null && r.load.value > 1.25).length,
      inProgress: s((r) => r.inProgress), blocked: s((r) => r.blocked), overdue: s((r) => r.overdue) };
  };
  const workload = {
    horizonWorkingDays: HORIZON_WORKING_DAYS,
    note: 'Load, not performance: open estimated work against each person\'s available time. Listed alphabetically.',
    totals: sumRows(rows),
    rows: scope.perPerson ? rows : null,
    byGroup: groups.map((g) => (g.suppressed ? { id: g.id, name: g.name, people: g.people, suppressed: true }
      : { id: g.id, name: g.name, suppressed: false, ...sumRows(rows.filter((r) => (r.departmentId ?? null) === g.id)) })),
  };

  const label = q.departmentId || q.teamId || q.projectId ? 'this selection' : scope.mode === 'team' ? 'your teams' : 'the company';
  const observations = buildObservations({ scope, label, minGroup: MIN_GROUP, weeks, totals, groups, blockersByCause, workload });
  return {
    ...base, suppressed: null, weeks, totals,
    groups: groups.map(({ weekly: _w, ...g }) => g),
    blockersByCause, cycleTime, workload, observations,
    timeComposition: { availableMinutes: totals.current.loggingCoverage.den, byCategory: totals.current.byCategory,
      focusMinutes: totals.current.focusShare.num, unknownMinutes: totals.current.loggingCoverage.unknownMinutes },
  };
}

export function registerInsightsExport() {
  registerExportReport('insights', {
    async authorize(db, a, params) {
      const q = insightsQuery.parse(params);
      await resolveScope(db, a, q);
      const t = await one(db, `select timezone from tenants where id = $1`, [a.tenantId]);
      resolvePeriod(q, localToday(t.timezone)); // refuse an invalid period now, not in the worker
    },
    async build(db, a, params) {
      const data = await computeInsights(db, a, insightsQuery.parse(params));
      return { data, name: `insights-${data.period.start}-to-${data.period.end}` };
    },
    csv: (d) => insightsCsv(d),
  });
}
