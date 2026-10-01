import { DateTime } from 'luxon';
import type { Db } from '../lib/db.js';
import { many, one } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { type Actor, assertCanViewPerson, has, reviewableUserIds } from './access.js';
import { buildReport, buildReports, primaryEntrySegments } from './analytics.js';
import { dayCapacity, eachDate, loadCalendarsFor, localDayBounds } from './calendar.js';
import { createTask, reassignTask } from './tasks.js';
import { notify } from './notify.js';

/** Admin Daily Routine table: one row per employee for a date, scoped to what the actor may review. */
export async function routineTable(db: Db, a: Actor, f: { date: string; departmentId?: string; projectId?: string; userId?: string; status?: string }) {
  const ids = await reviewableUserIds(db, a);
  if (!has(a, 'routine_admin') && !a.managedUserIds.length) throw forbidden('Only the main administrator and team managers can open the daily routine view');
  let users = await many(db, `select u.id, u.name, u.title, u.is_founder, d.name department, u.department_id from users u left join departments d on d.id = u.department_id
    where u.id = any($1::uuid[]) and u.status = 'active' order by u.name`, [ids]);
  if (f.departmentId) users = users.filter((u) => u.department_id === f.departmentId);
  if (f.userId) users = users.filter((u) => u.id === f.userId);
  if (f.projectId) {
    const inProject = new Set((await many(db, `select distinct owner_id from tasks where project_id = $1 union select user_id from project_members where project_id = $1`, [f.projectId])).map((r) => r.owner_id));
    users = users.filter((u) => inProject.has(u.id));
  }
  const rows: any[] = [];
  // Everyone's day report and counts in one set of queries (not ~20 queries per person).
  const uids = users.map((u) => u.id);
  const reports = await buildReports(db, uids, 'day', f.date, f.date);
  const openBy = new Map((await many(db, `select owner_id, count(*) filter (where status = 'in_progress')::int in_progress, count(*) filter (where status = 'blocked')::int blocked,
      count(*) filter (where due_date < $2 and status not in ('done','cancelled'))::int overdue
    from tasks where owner_id = any($1::uuid[]) and status not in ('done','cancelled') group by owner_id`, [uids, f.date])).map((r) => [r.owner_id, r]));
  const reviewRows = await many(db, `select subject_user_id, action, resolved_at from manager_reviews where subject_user_id = any($1::uuid[]) and date = $2`, [uids, f.date]);
  for (const u of users) {
    const r = reports.get(u.id)!;
    const d = r.days[0] as any;
    const open = openBy.get(u.id) ?? { in_progress: 0, blocked: 0, overdue: 0 };
    const reviews = reviewRows.filter((x) => x.subject_user_id === u.id);
    const recapStatus = !d.recap ? (d.capacity.availableMinutes === 0 ? 'not_required' : d.isToday ? 'pending' : 'missing') : d.recap.status;
    rows.push({
      user: { id: u.id, name: u.name, title: u.title, department: u.department, isFounder: u.is_founder },
      date: f.date, capacityStatus: d.capacity.status, availableMinutes: d.capacity.availableMinutes,
      plan: d.intendedOutcomes.map((o: any) => ({ title: o.title, status: o.statusAtEndOfDay })),
      acceptedPlanned: d.acceptedPlanned, inProgress: open.in_progress, blocked: open.blocked, overdue: open.overdue,
      explainedMinutes: d.time.explainedMinutes, unknownMinutes: d.time.unknownMinutes, coverage: d.time.coverage,
      recapStatus, reviewActions: reviews.map((x) => x.action), openClarifications: reviews.filter((x) => x.action === 'clarification_request' && !x.resolved_at).length,
      assessment: d.assessment.label,
    });
  }
  const filtered = f.status ? rows.filter((r) => r.recapStatus === f.status || r.assessment === f.status) : rows;
  const confirmed = rows.filter((r) => ['confirmed', 'manager_reviewed'].includes(r.recapStatus)).length;
  const required = rows.filter((r) => !['not_required', 'pending'].includes(r.recapStatus)).length;
  return {
    date: f.date, scope: has(a, 'routine_admin') ? 'company' : 'team', rows: filtered,
    rollup: { people: rows.length, recapCompletion: required ? confirmed / required : null, missing: rows.filter((r) => r.recapStatus === 'missing').length,
      blocked: rows.reduce((s, r) => s + r.blocked, 0), overdue: rows.reduce((s, r) => s + r.overdue, 0) },
  };
}

/** Individual recorded routine for a date: state changes, time by source, evidence, blockers, recap, reviews. Not surveillance. */
export async function timeline(db: Db, a: Actor, userId: string, date: string) {
  await assertCanViewPerson(db, a, userId);
  const tz = (await one(db, `select coalesce(u.timezone, t.timezone) tz from users u join tenants t on t.id = u.tenant_id where u.id = $1`, [userId]))!.tz;
  const { start, end } = localDayBounds(tz, date);
  const includeMeetings = a.tenantSettings.include_meetings_in_work_policy !== false;
  const [changes, entries, evidence, blockers, comments] = await Promise.all([
    many(db, `select h.at, h.from_status, h.to_status, h.reason, t.id task_id, t.title from task_state_history h join tasks t on t.id = h.task_id
      where (h.actor_id = $1 or t.owner_id = $1) and h.at >= $2 and h.at < $3 order by h.at`, [userId, start, end]),
    many(db, `select te.id, te.started_at, te.ended_at, te.category, te.source, te.note, te.version, t.title task_title,
        (select count(*) from time_entry_revisions r where r.time_entry_id = te.id)::int corrections
      from time_entries te left join tasks t on t.id = te.task_id where te.user_id = $1 and te.deleted_at is null and te.started_at < $3 and coalesce(te.ended_at, now()) > $2 order by te.started_at`, [userId, start, end]),
    many(db, `select e.created_at at, e.label, e.kind, e.restricted, e.url, t.title, t.owner_id, e.added_by, e.allowed_user_ids from evidence_links e join tasks t on t.id = e.task_id
      where e.added_by = $1 and e.created_at >= $2 and e.created_at < $3`, [userId, start, end]),
    many(db, `select b.raised_at at, b.reason, b.cause, b.resolved_at, t.title from blockers b join tasks t on t.id = b.task_id
      where (b.raised_by = $1 or t.owner_id = $1) and b.raised_at < $3 and coalesce(b.resolved_at, now()) >= $2`, [userId, start, end]),
    many(db, `select c.created_at at, c.kind, left(c.body, 300) body, t.title from comments c join tasks t on t.id = c.task_id
      where c.author_id = $1 and c.created_at >= $2 and c.created_at < $3`, [userId, start, end]),
  ]);
  const corrections = await many(db, `select r.at, r.reason, r.before, r.after from time_entry_revisions r join time_entries te on te.id = r.time_entry_id
    where te.user_id = $1 and r.at >= $2 and r.at < $3 order by r.at`, [userId, start, end]);
  const items = [
    ...changes.map((c) => ({ at: c.at, type: 'status', title: c.title, taskId: c.task_id, detail: `${c.from_status ?? 'new'} → ${c.to_status}${c.reason ? ` — ${c.reason}` : ''}` })),
    ...entries.map((e) => ({ at: e.started_at, end: e.ended_at, type: 'time', title: e.category === 'meeting' && !includeMeetings ? 'Meeting (outside work policy)' : e.task_title ?? e.note ?? e.category,
      detail: `${e.category} · source: ${e.source}${e.corrections ? ` · corrected ${e.corrections}×` : ''}` })),
    ...evidence.map((e) => ({ at: e.at, type: 'evidence', title: e.title, detail: e.restricted && !(e.added_by === a.id || e.owner_id === a.id || (e.allowed_user_ids ?? []).includes(a.id)) ? 'Restricted reference (source permissions apply)' : e.label })),
    ...blockers.map((b) => ({ at: b.at, type: 'blocker', title: b.title, detail: `${b.cause}: ${b.reason}${b.resolved_at ? ' (resolved)' : ''}` })),
    ...comments.map((c) => ({ at: c.at, type: 'comment', title: c.title, detail: c.body })),
    ...corrections.map((c) => ({ at: c.at, type: 'correction', title: 'Time entry corrected', detail: c.reason })),
  ].sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
  const report = await buildReport(db, userId, 'day', date, date);
  const reviews = await many(db, `select mr.*, u.name reviewer_name from manager_reviews mr join users u on u.id = mr.reviewer_id
    where mr.subject_user_id = $1 and mr.date = $2 order by mr.created_at`, [userId, date]);
  const recapVersions = await many(db, `select v.version, v.snapshot, v.change_reason, v.created_at from daily_review_versions v join daily_reviews r on r.id = v.review_id
    where r.user_id = $1 and r.date = $2 order by v.version`, [userId, date]);
  return { userId, date, timezone: tz, items, report, reviews, recapVersions,
    note: 'This is the recorded routine — status changes, confirmed time, evidence, blockers and the recap. It is not continuous monitoring and does not account for every minute.' };
}

export interface ReviewActionInput {
  subjectUserId: string; date: string; action: 'acknowledge' | 'note' | 'clarification_request' | 'clarification_response' | 'follow_up' | 'blocker_help' | 'reassign';
  note?: string; taskId?: string; blockerId?: string; newOwnerId?: string; followUp?: { title: string; dueDate?: string; ownerId?: string }; parentId?: string;
}

/** Visible review actions. They never modify the employee's submitted recap or entries. */
export async function reviewAction(db: Db, a: Actor, i: ReviewActionInput) {
  if (i.action === 'clarification_response') {
    if (i.subjectUserId !== a.id) throw forbidden('Only the person asked can respond to a clarification');
    const parent = i.parentId ? await one(db, `select * from manager_reviews where id = $1 and subject_user_id = $2`, [i.parentId, a.id]) : null;
    if (!parent) throw badRequest('Clarification request not found');
    if (!i.note?.trim()) throw badRequest('Write a response');
    const row = await one(db, `insert into manager_reviews (tenant_id, subject_user_id, date, reviewer_id, action, note, parent_id) values ($1,$2,$3,$4,'clarification_response',$5,$6) returning *`,
      [a.tenantId, a.id, parent.date, a.id, i.note, parent.id]);
    await db.query(`update manager_reviews set resolved_at = now() where id = $1`, [parent.id]);
    await notify(db, a.tenantId, parent.reviewer_id, 'clarification_response', `${a.name} responded`, i.note, `/admin/routine/${a.id}?date=${parent.date}`);
    await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'review.clarification_response', resourceType: 'manager_review', resourceId: row.id });
    return row;
  }
  if (i.subjectUserId === a.id) throw forbidden('You cannot review your own routine');
  await assertCanViewPerson(db, a, i.subjectUserId);
  const review = await one(db, `select * from daily_reviews where user_id = $1 and date = $2`, [i.subjectUserId, i.date]);
  let relatedTaskId = i.taskId ?? null;
  switch (i.action) {
    case 'acknowledge':
      if (!review || review.status === 'draft') throw badRequest('There is no confirmed recap to acknowledge yet');
      await db.query(`update daily_reviews set status = 'manager_reviewed', reviewed_at = now(), reviewed_by = $2 where id = $1`, [review.id, a.id]);
      await enqueueSnapshot(db, a, i.subjectUserId, i.date, `Acknowledged by ${a.name}`);
      break;
    case 'note': case 'clarification_request':
      if (!i.note?.trim()) throw badRequest('Write the note or question');
      break;
    case 'follow_up': {
      if (!i.followUp?.title?.trim()) throw badRequest('Follow-up needs a title');
      const r = await createTask(db, a, a.tenantId, { title: i.followUp.title, ownerId: i.followUp.ownerId ?? i.subjectUserId, dueDate: i.followUp.dueDate ?? null,
        sourceType: 'follow_up', sourceRef: { from_review_of: i.subjectUserId, date: i.date }, description: i.note ?? '' });
      relatedTaskId = r.task.id;
      break;
    }
    case 'blocker_help': {
      const b = i.blockerId ? await one(db, `select b.*, t.owner_id from blockers b join tasks t on t.id = b.task_id where b.id = $1`, [i.blockerId]) : null;
      if (!b || b.owner_id !== i.subjectUserId) throw badRequest('Blocker not found for this person');
      if (!i.note?.trim()) throw badRequest('Describe the help or decision');
      await db.query(`insert into comments (tenant_id, task_id, author_id, body, kind) values ($1,$2,$3,$4,'comment')`, [a.tenantId, b.task_id, a.id, `Blocker help: ${i.note}`]);
      relatedTaskId = b.task_id;
      break;
    }
    case 'reassign': {
      if (!i.taskId || !i.newOwnerId) throw badRequest('Choose the task and the new owner');
      const t = await one(db, `select t.*, p.owner_id project_owner_id from tasks t left join projects p on p.id = t.project_id where t.id = $1`, [i.taskId]);
      if (!t) throw notFound('Task not found');
      await reassignTask(db, a, t, i.newOwnerId, i.note || 'Workload rebalanced during routine review');
      break;
    }
  }
  const row = await one(db, `insert into manager_reviews (tenant_id, subject_user_id, date, daily_review_id, reviewer_id, action, note, related_task_id, related_blocker_id)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
    [a.tenantId, i.subjectUserId, i.date, review?.id ?? null, a.id, i.action, i.note ?? '', relatedTaskId, i.blockerId ?? null]);
  const titles: Record<string, string> = { acknowledge: 'acknowledged your recap', note: 'added a review note', clarification_request: 'asked for clarification',
    follow_up: 'assigned a follow-up', blocker_help: 'responded to your blocker', reassign: 'reassigned a task' };
  await notify(db, a.tenantId, i.subjectUserId, `review_${i.action}`, `${a.name} ${titles[i.action]}`, i.note ?? '', `/recap?date=${i.date}`);
  await audit(db, { tenantId: a.tenantId, actorId: a.id, action: `review.${i.action}`, resourceType: 'manager_review', resourceId: row.id,
    authority: has(a, 'routine_admin') ? 'routine_admin' : 'team_manager', details: { subject: i.subjectUserId, date: i.date } });
  return row;
}
async function enqueueSnapshot(db: Db, a: Actor, userId: string, date: string, reason: string) {
  const { enqueue } = await import('../lib/jobs.js');
  await enqueue(db, { tenantId: a.tenantId, kind: 'report.snapshot', payload: { userId, date, reason } });
}

/** Team capacity: available hours vs estimated open commitments for the next N working days. */
export async function teamCapacity(db: Db, a: Actor, start: string, days = 10) {
  const ids = await reviewableUserIds(db, a);
  if (ids.length <= 1 && !has(a, 'leadership')) throw forbidden('Capacity view is for managers, leadership and the main admin');
  const scope = has(a, 'leadership') && !has(a, 'routine_admin') ? (await many(db, `select id from users where status='active' and not ('customer' = any(roles))`)).map((r) => r.id) : ids;
  const end = DateTime.fromISO(start).plus({ days: days * 2 }).toISODate()!;
  const out: any[] = [];
  // People and calendars in bulk; open work and allocations below are read once for everyone and split per person.
  const people = new Map((await many(db, `select u.id, u.name, u.title, d.name department from users u left join departments d on d.id = u.department_id
    where u.id = any($1::uuid[])`, [scope])).map((u) => [u.id, u]));
  const cals = await loadCalendarsFor(db, scope, start, end);
  const openAll = await many(db, `select t.owner_id, t.estimate_minutes, t.due_date, t.status, p.name project from tasks t left join projects p on p.id = t.project_id
    where t.owner_id = any($1::uuid[]) and t.status not in ('done','cancelled','backlog')`, [scope]);
  const allocAll = await many(db, `select ca.user_id, ca.percent, ca.assumption, ca.start_date::text start_date, ca.end_date::text end_date, p.name project
    from capacity_allocations ca join projects p on p.id = ca.project_id where ca.user_id = any($1::uuid[])`, [scope]);
  for (const uid of scope) {
    const u = people.get(uid) ?? null;
    const cal = cals.get(uid)!;
    let wd = 0, avail = 0, leaveDays = 0, last = start;
    const daily: { date: string; minutes: number; status: string }[] = [];
    for (const d of eachDate(start, end)) {
      if (wd >= days) break;
      const c = dayCapacity(cal, d);
      daily.push({ date: d, minutes: c.availableMinutes, status: c.status });
      if (c.status === 'leave' || c.status === 'holiday') leaveDays++;
      if (c.availableMinutes > 0) { wd++; avail += c.availableMinutes; last = d; }
    }
    const open = openAll.filter((t) => t.owner_id === uid && (t.due_date === null || t.due_date <= last)).map(({ owner_id, ...t }) => t);
    const allocations = allocAll.filter((x) => x.user_id === uid && x.start_date <= last && (x.end_date === null || x.end_date >= start))
      .map((x) => ({ percent: x.percent, assumption: x.assumption, project: x.project }));
    const est = open.filter((t) => t.estimate_minutes);
    const estMinutes = est.reduce((s, t) => s + t.estimate_minutes, 0);
    out.push({ user: u, horizon: { start, end: last, workingDays: wd }, availableMinutes: avail, leaveOrHolidayDays: leaveDays, daily,
      openTasks: open.length, estimatedMinutes: estMinutes, estimateCoverage: open.length ? est.length / open.length : null,
      load: avail > 0 ? estMinutes / avail : null, blocked: open.filter((t) => t.status === 'blocked').length, allocations });
  }
  return { start, days, people: out, note: 'Load = estimated open commitments ÷ available capacity. Tasks without estimates are not counted — see estimate coverage.' };
}

/** Groups smaller than this are withheld from leadership-only viewers (same rule as Insights). */
const MIN_GROUP = 3;
/**
 * Which groups to withhold: those under MIN_GROUP people, plus (complementary suppression) the smallest visible groups until the
 * withheld people number at least MIN_GROUP — otherwise "total minus visible groups" would reveal them.
 */
function withheldGroups<K>(groups: { key: K; ids: Set<string> }[]) {
  const sorted = [...groups].sort((x, y) => x.ids.size - y.ids.size);
  const withheld = new Set(sorted.filter((g) => g.ids.size < MIN_GROUP).map((g) => g.key));
  const people = () => new Set(sorted.filter((g) => withheld.has(g.key)).flatMap((g) => [...g.ids])).size;
  for (const g of sorted) {
    const n = people();
    if (n === 0 || n >= MIN_GROUP) break;
    withheld.add(g.key);
  }
  return withheld;
}

/** Leadership delivery: projects, milestones, lateness, blockers, allocation. Aggregates only — no person ranking. */
export async function leadershipDelivery(db: Db, a: Actor) {
  if (!has(a, 'leadership') && !has(a, 'routine_admin')) throw forbidden('Leadership view requires the leadership role');
  // Per-person workload is for the main admin only (alphabetical, never ranked); leadership-only viewers get department aggregates
  // with small groups withheld. A routine admin without leadership follows the founder-visibility policy.
  const perPerson = has(a, 'routine_admin');
  const hideFounders = !has(a, 'leadership') && a.tenantSettings.founders_visible_to_routine_admin === false && !a.isFounder;
  const projects = await many(db, `select p.id, p.key, p.name, p.status, p.target_date, p.business_outcome, p.visibility, c.name customer, d.name department, u.name owner,
      count(t.*) filter (where t.status not in ('done','cancelled'))::int open,
      count(t.*) filter (where t.status = 'done')::int done,
      count(t.*) filter (where t.status = 'blocked')::int blocked,
      count(t.*) filter (where t.due_date < current_date and t.status not in ('done','cancelled'))::int overdue,
      count(t.*) filter (where t.status = 'in_review')::int in_review,
      count(t.*) filter (where t.reopen_count > 0)::int reworked,
      coalesce(sum(t.estimate_minutes) filter (where t.status not in ('done','cancelled')), 0)::int remaining_estimate
    from projects p left join tasks t on t.project_id = p.id left join customers c on c.id = p.customer_id left join departments d on d.id = p.department_id
    left join users u on u.id = p.owner_id where p.status <> 'archived' group by p.id, c.name, d.name, u.name order by overdue desc, blocked desc, p.name`);
  const milestones = await many(db, `select m.id, m.name, m.due_date, m.status, p.name project, p.id project_id,
      count(t.*)::int tasks, count(t.*) filter (where t.status = 'done')::int done
    from milestones m join projects p on p.id = m.project_id left join tasks t on t.milestone_id = m.id
    where m.status = 'open' group by m.id, p.name, p.id order by m.due_date nulls last limit 50`);
  const since = DateTime.now().minus({ days: 30 }).toISODate();
  // Confirmed (finished) time only; each person's overlapping entries are counted once, as in every other report.
  const entries = await many(db, `select te.user_id, te.started_at, te.ended_at, te.source, te.created_at, te.category,
      coalesce(p.name, 'No project') project, coalesce(d.name, 'No department') department
    from time_entries te join users u on u.id = te.user_id left join tasks t on t.id = te.task_id left join projects p on p.id = t.project_id
    left join departments d on d.id = u.department_id
    where te.deleted_at is null and te.ended_at is not null and te.started_at >= $1 and ($2::boolean = false or u.is_founder = false or u.id = $3)`, [since, hideFounders, a.id]);
  const byUser = new Map<string, any[]>();
  for (const e of entries) { const l = byUser.get(e.user_id); if (l) l.push(e); else byUser.set(e.user_id, [e]); }
  const cells = new Map<string, { project: string; department: string; category: string; minutes: number; ids: Set<string> }>();
  for (const [uid, list] of byUser) for (const s of primaryEntrySegments(list, Date.now())) {
    const k = `${s.e.project}\u0000${s.e.department}\u0000${s.e.category}`;
    const c = cells.get(k) ?? { project: s.e.project, department: s.e.department, category: s.e.category, minutes: 0, ids: new Set<string>() };
    c.minutes += (s.b - s.a) / 60000; c.ids.add(uid); cells.set(k, c);
  }
  const deptGroups = new Map<string, Set<string>>(), projGroups = new Map<string, Set<string>>();
  for (const c of cells.values()) {
    for (const [m, key] of [[deptGroups, c.department], [projGroups, c.project]] as const) { const g = m.get(key) ?? new Set<string>(); c.ids.forEach((i) => g.add(i)); m.set(key, g); }
  }
  const hiddenDepts = perPerson ? new Set<string>() : withheldGroups([...deptGroups].map(([key, ids]) => ({ key, ids })));
  const hiddenProjects = perPerson ? new Set<string>() : withheldGroups([...projGroups].map(([key, ids]) => ({ key, ids })));
  const SMALL_PROJECTS = 'Other projects (combined to protect small groups)', SMALL_DEPTS = 'Other departments (combined to protect small groups)';
  // Leadership-only viewers get project x category cells and department totals separately (a project x department cell could single someone out).
  const merged = new Map<string, { project: string; department: string | null; category: string; minutes: number }>();
  const deptTotals = new Map<string, number>();
  for (const c of cells.values()) {
    const project = hiddenProjects.has(c.project) ? SMALL_PROJECTS : c.project;
    const department = perPerson ? c.department : null;
    const k = `${project}\u0000${department}\u0000${c.category}`;
    const row = merged.get(k) ?? { project, department, category: c.category, minutes: 0 };
    row.minutes += c.minutes; merged.set(k, row);
    const dk = hiddenDepts.has(c.department) ? SMALL_DEPTS : c.department;
    deptTotals.set(dk, (deptTotals.get(dk) ?? 0) + c.minutes);
  }
  const allocation = [...merged.values()].map((r) => ({ ...r, minutes: Math.round(r.minutes) })).sort((x, y) => y.minutes - x.minutes);
  const allocationByDepartment = [...deptTotals].map(([department, m]) => ({ department, minutes: Math.round(m) }))
    .filter((r) => r.department !== SMALL_DEPTS || new Set([...deptGroups].filter(([k]) => hiddenDepts.has(k)).flatMap(([, ids]) => [...ids])).size >= MIN_GROUP)
    .sort((x, y) => y.minutes - x.minutes);
  const blockerPatterns = await many(db, `select cause, count(*)::int open, round(avg(extract(epoch from now() - raised_at) / 3600))::int avg_age_hours
    from blockers where resolved_at is null group by cause order by open desc`);
  const workload = await many(db, `select u.id, u.name, coalesce(d.name, 'No department') department, count(t.id)::int open_tasks, coalesce(sum(t.estimate_minutes), 0)::int estimate
    from users u left join departments d on d.id = u.department_id
    left join tasks t on t.owner_id = u.id and t.status not in ('done','cancelled','backlog')
    where u.status = 'active' and not ('customer' = any(u.roles)) and ($1::boolean = false or u.is_founder = false or u.id = $2)
    group by u.id, u.name, d.name`, [hideFounders, a.id]);
  // Open work per person (main admin only), alphabetical: a picture of where work sits, not a ranking.
  const concentration = perPerson ? workload.filter((w) => w.open_tasks > 0).map(({ name, open_tasks, estimate }) => ({ name, open_tasks, estimate }))
    .sort((x, y) => x.name.localeCompare(y.name)) : [];
  const wGroups = new Map<string, { ids: Set<string>; open_tasks: number; estimate: number }>();
  for (const w of workload) { const g = wGroups.get(w.department) ?? { ids: new Set<string>(), open_tasks: 0, estimate: 0 }; g.ids.add(w.id); g.open_tasks += w.open_tasks; g.estimate += w.estimate; wGroups.set(w.department, g); }
  const hiddenW = perPerson ? new Set<string>() : withheldGroups([...wGroups].map(([key, g]) => ({ key, ids: g.ids })));
  const workloadByDepartment = [...wGroups].filter(([k]) => !hiddenW.has(k)).map(([department, g]) => ({ department, people: g.ids.size, open_tasks: g.open_tasks, estimate: g.estimate }))
    .sort((x, y) => x.department.localeCompare(y.department));
  const hiddenWl = [...wGroups].filter(([k]) => hiddenW.has(k)).map(([, g]) => g);
  const hiddenPeople = hiddenWl.reduce((n, g) => n + g.ids.size, 0);
  if (hiddenPeople >= MIN_GROUP) workloadByDepartment.push({ department: SMALL_DEPTS, people: hiddenPeople,
    open_tasks: hiddenWl.reduce((n, g) => n + g.open_tasks, 0), estimate: hiddenWl.reduce((n, g) => n + g.estimate, 0) });
  const objectives = await many(db, `select o.id, o.title, o.status, o.period_end, u.name owner,
      (select count(*) from milestones m where m.objective_id = o.id)::int milestones,
      (select count(*) from milestones m where m.objective_id = o.id and m.status = 'done')::int milestones_done
    from objectives o left join users u on u.id = o.owner_id where o.status = 'active' order by o.period_end nulls last`);
  let cost: any[] | null = null;
  if (has(a, 'cost_viewer')) {
    cost = await many(db, `with rates as (select distinct on (user_id) user_id, hourly_rate, currency from cost_rates where effective_from <= current_date order by user_id, effective_from desc)
      select coalesce(p.name, 'No project') project, r.currency, round(sum(extract(epoch from (te.ended_at - te.started_at)) / 3600 * r.hourly_rate), 2)::float cost,
        round(sum(extract(epoch from (te.ended_at - te.started_at)) / 3600)::numeric, 1)::float hours
      from time_entries te join rates r on r.user_id = te.user_id left join tasks t on t.id = te.task_id left join projects p on p.id = t.project_id
      where te.deleted_at is null and te.ended_at is not null and te.started_at >= $1 group by 1, 2 order by cost desc`, [since]);
  }
  return { projects, milestones, allocation, allocationByDepartment, allocationSince: since, blockerPatterns, workloadConcentration: concentration, workloadByDepartment,
    smallGroupsWithheld: !perPerson && (hiddenDepts.size + hiddenProjects.size + hiddenW.size) > 0, objectives, cost,
    note: 'Declared allocation comes from confirmed time entries (overlaps counted once); unknown time is not shown as unproductive. Workload lists open work, not performance, and is never ranked.'
      + (perPerson ? '' : ` Groups with fewer than ${MIN_GROUP} people are combined or withheld so individuals cannot be identified.`) };
}

/** Customer portal: only customer-visible tasks of projects belonging to the viewer's customer. */
export async function customerView(db: Db, a: Actor) {
  if (!has(a, 'customer') || !a.customerId) throw forbidden();
  const projects = await many(db, `select id, key, name, status, target_date, business_outcome from projects where customer_id = $1 and status <> 'archived'`, [a.customerId]);
  const ids = projects.map((p) => p.id);
  const milestones = await many(db, `select id, project_id, name, due_date, status from milestones where project_id = any($1::uuid[]) order by due_date nulls last`, [ids]);
  const tasks = await many(db, `select id, project_id, milestone_id, title, status, due_date, accepted_at from tasks
    where project_id = any($1::uuid[]) and customer_visible order by due_date nulls last`, [ids]);
  return { projects, milestones, tasks };
}
