import { DateTime } from 'luxon';
import type { Db } from '../lib/db.js';
import { many, one } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { enqueue } from '../lib/jobs.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { type Actor, loadVisibleTask, isStaff } from './access.js';
import { dayCapacity, loadCalendar, localDayBounds, localToday } from './calendar.js';
import { allocateDay, buildReport } from './analytics.js';
import { notify } from './notify.js';

const TASK_COLS = `t.id, t.number, t.title, t.status, t.priority, t.due_date, t.estimate_minutes, t.category, t.owner_id, t.version,
  t.requires_review, t.requires_evidence, t.project_id, p.name project_name, p.key project_key`;

export async function getMyDay(db: Db, a: Actor, date?: string) {
  if (!isStaff(a)) throw forbidden();
  const today = localToday(a.timezone);
  const d = date ?? today;
  const cal = await loadCalendar(db, a.id, d, d);
  const cap = dayCapacity(cal, d);
  const { start, end } = localDayBounds(a.timezone, d);
  const plan = await one(db, `select * from daily_plans where user_id = $1 and date = $2`, [a.id, d]);
  const planItems = plan ? await many(db, `select dpi.id item_id, dpi.position, dpi.removed_at, dpi.removed_reason, ${TASK_COLS},
      (select count(*) from checklist_items c where c.task_id = t.id)::int checklist_total,
      (select count(*) from checklist_items c where c.task_id = t.id and c.done)::int checklist_done
    from daily_plan_items dpi join tasks t on t.id = dpi.task_id left join projects p on p.id = t.project_id
    where dpi.plan_id = $1 order by dpi.removed_at nulls first, dpi.position`, [plan.id]) : [];
  const open = await many(db, `select ${TASK_COLS},
      (select b.reason from blockers b where b.task_id = t.id and b.resolved_at is null order by b.raised_at desc limit 1) blocker_reason
    from tasks t left join projects p on p.id = t.project_id
    where (t.owner_id = $1 or exists (select 1 from task_collaborators c where c.task_id = t.id and c.user_id = $1))
      and t.status not in ('done','cancelled')
    order by (t.status = 'in_progress') desc, t.due_date nulls last,
      array_position(array['urgent','high','medium','low','none'], t.priority), t.created_at limit 200`, [a.id]);
  const entries = await many(db, `select te.*, t.title task_title from time_entries te left join tasks t on t.id = te.task_id
    where te.user_id = $1 and te.deleted_at is null and te.started_at < $3 and coalesce(te.ended_at, now()) > $2 order by te.started_at`, [a.id, start, end]);
  const running = await one(db, `select te.*, t.title task_title from time_entries te left join tasks t on t.id = te.task_id
    where te.user_id = $1 and te.ended_at is null and te.deleted_at is null`, [a.id]);
  const suggestions = await many(db, `select * from suggestions where user_id = $1 and status = 'open' order by created_at desc limit 20`, [a.id]);
  const review = await one(db, `select * from daily_reviews where user_id = $1 and date = $2`, [a.id, d]);
  const pendingClarifications = await many(db, `select mr.*, u.name reviewer_name from manager_reviews mr join users u on u.id = mr.reviewer_id
    where mr.subject_user_id = $1 and mr.action in ('clarification_request','follow_up','blocker_help') and mr.resolved_at is null order by mr.created_at desc`, [a.id]);
  const alloc = allocateDay(entries, cap, Date.parse(start), Date.parse(end), Date.now());
  const active = planItems.filter((i) => !i.removed_at);
  const plannedIds = new Set(active.map((i) => i.id));
  const suggestedOutcomes = open.filter((t) => !plannedIds.has(t.id) && t.status !== 'blocked' && t.status !== 'in_review').slice(0, 5);
  return {
    date: d, today, isToday: d === today, capacity: cap, plan: plan ? { id: plan.id, focusNote: plan.focus_note } : null,
    intendedOutcomes: active, scopeChanges: planItems.filter((i) => i.removed_at),
    suggestedOutcomes, openTasks: open, timeEntries: entries, runningTimer: running, allocation: alloc,
    suggestions, recap: review, pendingClarifications,
  };
}

/** Replace today's intended outcomes (max 3). Removed items stay visible as scope changes with a reason. */
export async function setPlan(db: Db, a: Actor, date: string, taskIds: string[], reason?: string, focusNote?: string) {
  if (!isStaff(a)) throw forbidden();
  const uniq = [...new Set(taskIds)];
  if (uniq.length > 3) throw badRequest('Choose up to three intended outcomes for the day');
  for (const id of uniq) {
    const t = await loadVisibleTask(db, a, id);
    if (['done', 'cancelled'].includes(t.status)) throw badRequest(`"${t.title}" is already ${t.status}`);
  }
  const plan = await one(db, `insert into daily_plans (tenant_id, user_id, date, focus_note) values ($1,$2,$3,coalesce($4,''))
    on conflict (user_id, date) do update set updated_at = now(), focus_note = coalesce($4, daily_plans.focus_note) returning *`, [a.tenantId, a.id, date, focusNote ?? null]);
  const current = await many(db, `select * from daily_plan_items where plan_id = $1 and removed_at is null`, [plan.id]);
  const keep = current.filter((c) => uniq.includes(c.task_id));
  const removed = current.filter((c) => !uniq.includes(c.task_id));
  for (const r of removed)
    await db.query(`update daily_plan_items set removed_at = now(), removed_reason = $2 where id = $1`, [r.id, reason?.trim() || 'Replanned']);
  // Re-number kept + new in requested order.
  await db.query(`update daily_plan_items set position = null where plan_id = $1 and removed_at is null`, [plan.id]);
  for (let i = 0; i < uniq.length; i++) {
    const k = keep.find((c) => c.task_id === uniq[i]);
    if (k) await db.query(`update daily_plan_items set position = $2 where id = $1`, [k.id, i + 1]);
    else await db.query(`insert into daily_plan_items (tenant_id, plan_id, task_id, position) values ($1,$2,$3,$4)`, [a.tenantId, plan.id, uniq[i], i + 1]);
  }
  // Planning a task for today moves Backlog items to Planned (one less click).
  await db.query(`update tasks set status = 'planned', version = version + 1, updated_at = now() where id = any($1::uuid[]) and status = 'backlog'`, [uniq]);
  await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'plan.set', resourceType: 'daily_plan', resourceId: plan.id,
    details: { date, count: uniq.length, removed: removed.length }, reason: removed.length ? reason ?? 'Replanned' : null });
  return plan;
}

// ---------- Time entries ----------
export async function startTimer(db: Db, a: Actor, taskId: string | null, category: string) {
  if (!isStaff(a)) throw forbidden();
  if (taskId) await loadVisibleTask(db, a, taskId);
  const running = await one(db, `select * from time_entries where user_id = $1 and ended_at is null and deleted_at is null for update`, [a.id]);
  if (running) await stopTimer(db, a);
  const row = await one(db, `insert into time_entries (tenant_id, user_id, task_id, category, started_at, source) values ($1,$2,$3,$4,now(),'timer') returning *`,
    [a.tenantId, a.id, taskId, taskId ? 'task' : category]);
  if (taskId) {
    const t = await one(db, `select * from tasks where id = $1`, [taskId]);
    if (t && ['planned', 'backlog'].includes(t.status) && t.owner_id === a.id) {
      await db.query(`update tasks set status = 'in_progress', started_at = coalesce(started_at, now()), version = version + 1, updated_at = now() where id = $1`, [taskId]);
      await db.query(`insert into task_state_history (tenant_id, task_id, from_status, to_status, actor_id, reason) values ($1,$2,$3,'in_progress',$4,'Timer started')`,
        [a.tenantId, taskId, t.status, a.id]);
    }
  }
  return row;
}
export async function stopTimer(db: Db, a: Actor) {
  const row = await one(db, `update time_entries set ended_at = greatest(now(), started_at + interval '1 second'), version = version + 1
    where user_id = $1 and ended_at is null and deleted_at is null returning *`, [a.id]);
  if (!row) throw badRequest('No timer is running');
  return row;
}

export interface ManualEntry { taskId?: string | null; category: string; startedAt: string; endedAt: string; note?: string }
export async function addManualEntry(db: Db, a: Actor, e: ManualEntry) {
  if (!isStaff(a)) throw forbidden();
  if (e.taskId) await loadVisibleTask(db, a, e.taskId);
  const s = Date.parse(e.startedAt), en = Date.parse(e.endedAt);
  if (!(en > s)) throw badRequest('End time must be after start time');
  if (en - s > 16 * 3600000) throw badRequest('A single entry cannot exceed 16 hours');
  if (en > Date.now() + 5 * 60000) throw badRequest('Time entries cannot be in the future');
  const row = await one(db, `insert into time_entries (tenant_id, user_id, task_id, category, started_at, ended_at, source, note)
    values ($1,$2,$3,$4,$5,$6,'manual',$7) returning *`, [a.tenantId, a.id, e.taskId ?? null, e.taskId ? 'task' : e.category, e.startedAt, e.endedAt, e.note ?? '']);
  const overlaps = await overlapsFor(db, a.id, row);
  await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'time.create', resourceType: 'time_entry', resourceId: row.id, details: { source: 'manual', overlaps: overlaps.length } });
  return { entry: row, overlaps };
}
async function overlapsFor(db: Db, userId: string, row: any) {
  return many(db, `select id, source, category, started_at, ended_at from time_entries where user_id = $1 and id <> $2 and deleted_at is null
    and started_at < $4 and coalesce(ended_at, now()) > $3`, [userId, row.id, row.started_at, row.ended_at ?? new Date()]);
}

/** Correction keeps the original values in time_entry_revisions. Only the person who owns the entry may correct it. */
export async function correctEntry(db: Db, a: Actor, id: string, patch: Partial<ManualEntry> & { version: number; reason: string }) {
  const cur = await one(db, `select * from time_entries where id = $1 and deleted_at is null`, [id]);
  if (!cur) throw notFound('Time entry not found');
  if (cur.user_id !== a.id) throw forbidden('Only the person who recorded this time can correct it');
  if (cur.version !== patch.version) throw conflict('This entry changed since you loaded it. Reload and try again.');
  if (!patch.reason?.trim()) throw badRequest('A correction needs a short reason');
  const next = {
    task_id: patch.taskId !== undefined ? patch.taskId : cur.task_id,
    category: patch.taskId ? 'task' : patch.category ?? cur.category,
    started_at: patch.startedAt ?? cur.started_at, ended_at: patch.endedAt ?? cur.ended_at, note: patch.note ?? cur.note,
  };
  if (next.ended_at && !(Date.parse(next.ended_at) > Date.parse(next.started_at))) throw badRequest('End time must be after start time');
  if (next.task_id) await loadVisibleTask(db, a, next.task_id);
  const row = await one(db, `update time_entries set task_id = $2, category = $3, started_at = $4, ended_at = $5, note = $6, version = version + 1
    where id = $1 returning *`, [id, next.task_id, next.category, next.started_at, next.ended_at, next.note]);
  await db.query(`insert into time_entry_revisions (tenant_id, time_entry_id, before, after, reason, actor_id) values ($1,$2,$3,$4,$5,$6)`,
    [a.tenantId, id, pick(cur), pick(row), patch.reason, a.id]);
  await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'time.correct', resourceType: 'time_entry', resourceId: id, resourceVersion: row.version, reason: patch.reason });
  await markRecapsRevisedFor(db, a, [cur.started_at, row.started_at]);
  return { entry: row, overlaps: await overlapsFor(db, a.id, row) };
}
export async function deleteEntry(db: Db, a: Actor, id: string, reason: string) {
  const cur = await one(db, `select * from time_entries where id = $1 and deleted_at is null`, [id]);
  if (!cur) throw notFound('Time entry not found');
  if (cur.user_id !== a.id) throw forbidden('Only the person who recorded this time can remove it');
  if (!reason?.trim()) throw badRequest('Removing an entry needs a short reason');
  await db.query(`update time_entries set deleted_at = now(), ended_at = coalesce(ended_at, greatest(now(), started_at + interval '1 second')), version = version + 1 where id = $1`, [id]);
  await db.query(`insert into time_entry_revisions (tenant_id, time_entry_id, before, after, reason, actor_id) values ($1,$2,$3,null,$4,$5)`, [a.tenantId, id, pick(cur), reason, a.id]);
  await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'time.delete', resourceType: 'time_entry', resourceId: id, reason });
  await markRecapsRevisedFor(db, a, [cur.started_at]);
}
const pick = (r: any) => ({ task_id: r.task_id, category: r.category, started_at: r.started_at, ended_at: r.ended_at, note: r.note, source: r.source });

/** Corrections after a confirmed recap trigger a new report version so reports and exports reconcile. */
async function markRecapsRevisedFor(db: Db, a: Actor, times: (string | Date)[]) {
  const dates = [...new Set(times.map((t) => DateTime.fromJSDate(new Date(t)).setZone(a.timezone).toISODate()!))];
  for (const date of dates) {
    const r = await one(db, `select * from daily_reviews where user_id = $1 and date = $2 and status <> 'draft'`, [a.id, date]);
    if (r) await enqueue(db, { tenantId: a.tenantId, kind: 'report.snapshot', payload: { userId: a.id, date, reason: 'Time entry corrected after confirmation' } });
  }
}

// ---------- Daily recap ----------
export async function getRecap(db: Db, a: Actor, userId: string, date: string) {
  const { start, end } = localDayBounds(a.timezone, date);
  const review = await one(db, `select * from daily_reviews where user_id = $1 and date = $2`, [userId, date]);
  const completed = await many(db, `select distinct on (t.id) t.id, t.title, h.to_status, h.at from task_state_history h join tasks t on t.id = h.task_id
    where h.actor_id = $1 and h.at >= $2 and h.at < $3 and h.to_status in ('done','in_review') order by t.id, h.at desc`, [userId, start, end]);
  const changes = await many(db, `select h.task_id, t.title, h.from_status, h.to_status, h.reason, h.at from task_state_history h join tasks t on t.id = h.task_id
    where h.actor_id = $1 and h.at >= $2 and h.at < $3 order by h.at`, [userId, start, end]);
  const blockersRaised = await many(db, `select b.id, b.reason, b.cause, t.title from blockers b join tasks t on t.id = b.task_id
    where b.raised_by = $1 and b.raised_at >= $2 and b.raised_at < $3`, [userId, start, end]);
  const versions = review ? await many(db, `select v.version, v.change_reason, v.created_at, u.name created_by_name from daily_review_versions v
    left join users u on u.id = v.created_by where v.review_id = $1 order by v.version desc`, [review.id]) : [];
  const day = await buildReport(db, userId, 'day', date, date);
  const managerReviews = await many(db, `select mr.*, u.name reviewer_name from manager_reviews mr join users u on u.id = mr.reviewer_id
    where mr.subject_user_id = $1 and mr.date = $2 order by mr.created_at`, [userId, date]);
  return { date, review, suggestedCompleted: completed, statusChanges: changes, blockersRaised, report: day, versions, managerReviews };
}

export interface RecapInput { date: string; summary: string; blockersNote?: string; nextSteps?: string; contextNote?: string; dayType?: 'work' | 'no_work' | 'non_working'; changeReason?: string; overheadMs?: number }

export async function saveRecap(db: Db, a: Actor, input: RecapInput, confirm: boolean) {
  if (!isStaff(a)) throw forbidden();
  const today = localToday(a.timezone);
  if (input.date > today) throw badRequest('You cannot submit a recap for a future date');
  const existing = await one(db, `select * from daily_reviews where user_id = $1 and date = $2 for update`, [a.id, input.date]);
  const wasSubmitted = existing && existing.status !== 'draft';
  if (wasSubmitted && !input.changeReason?.trim()) throw badRequest('This recap was already confirmed. Explain what you are correcting — the earlier version is kept.');
  const fields = [input.summary ?? '', input.blockersNote ?? '', input.nextSteps ?? '', input.contextNote ?? '', input.dayType ?? 'work'];
  let row;
  if (!existing) {
    row = await one(db, `insert into daily_reviews (tenant_id, user_id, date, summary, blockers_note, next_steps, context_note, day_type, status, version, confirmed_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, case when $9 = 'confirmed' then now() end) returning *`,
      [a.tenantId, a.id, input.date, ...fields, confirm ? 'confirmed' : 'draft', confirm ? 1 : 0]);
  } else {
    const newStatus = confirm || wasSubmitted ? 'confirmed' : 'draft';
    row = await one(db, `update daily_reviews set summary = $2, blockers_note = $3, next_steps = $4, context_note = $5, day_type = $6, status = $7,
        version = case when $7 = 'confirmed' then version + 1 else version end,
        confirmed_at = case when $7 = 'confirmed' then now() else confirmed_at end, updated_at = now()
      where id = $1 returning *`, [existing.id, ...fields, newStatus]);
  }
  if (row.status === 'confirmed') {
    const snapshot = { summary: row.summary, blockersNote: row.blockers_note, nextSteps: row.next_steps, contextNote: row.context_note, dayType: row.day_type };
    await db.query(`insert into daily_review_versions (tenant_id, review_id, version, snapshot, change_reason, created_by) values ($1,$2,$3,$4,$5,$6)`,
      [a.tenantId, row.id, row.version, snapshot, wasSubmitted ? input.changeReason : 'Confirmed', a.id]);
    await enqueue(db, { tenantId: a.tenantId, kind: 'report.snapshot', payload: { userId: a.id, date: input.date, reason: wasSubmitted ? `Recap corrected: ${input.changeReason}` : 'Recap confirmed' } });
    if (wasSubmitted && existing.reviewed_by)
      await notify(db, a.tenantId, existing.reviewed_by, 'recap_corrected', `${a.name} corrected their ${input.date} recap`, input.changeReason ?? '', `/admin/routine/${a.id}?date=${input.date}`);
    await audit(db, { tenantId: a.tenantId, actorId: a.id, action: wasSubmitted ? 'recap.revise' : 'recap.confirm', resourceType: 'daily_review', resourceId: row.id,
      resourceVersion: row.version, reason: input.changeReason ?? null });
  }
  if (confirm && input.overheadMs && input.overheadMs > 0 && input.overheadMs < 3600000)
    await db.query(`insert into ux_timings (tenant_id, user_id, flow, duration_ms, date) values ($1,$2,'recap',$3,$4)`, [a.tenantId, a.id, Math.round(input.overheadMs), input.date]);
  return row;
}

export async function snapshotReport(db: Db, tenantId: string, userId: string, date: string, reason: string, actorId: string | null = null) {
  const report = await buildReport(db, userId, 'day', date, date);
  const prev = await one(db, `select max(version)::int v from report_versions where user_id = $1 and period_kind = 'day' and period_start = $2 and period_end = $2`, [userId, date]);
  const version = (prev?.v ?? 0) + 1;
  await db.query(`insert into report_versions (tenant_id, user_id, period_kind, period_start, period_end, version, status, definitions_version, data, reason, generated_by)
    values ($1,$2,'day',$3,$3,$4,$5,$6,$7,$8,$9)`,
    [tenantId, userId, date, version, report.reportState, report.definitions.version, report, reason, actorId]);
  return version;
}
