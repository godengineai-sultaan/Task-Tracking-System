import { DateTime } from 'luxon';
import type { Db } from '../lib/db.js';
import { many, one } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { type Actor, assertContribute, canReassign, has, isStaff, loadActor } from './access.js';
import { notify } from './notify.js';
import { emitTaskEvent } from './events.js';
import { userToday } from './calendar.js';

export const STATUSES = ['backlog', 'planned', 'in_progress', 'blocked', 'in_review', 'done', 'cancelled'] as const;
export type Status = (typeof STATUSES)[number];
export const PRIORITIES = ['urgent', 'high', 'medium', 'low', 'none'] as const;
export const CATEGORIES = ['delivery', 'admin', 'finance', 'support', 'research', 'sales', 'operations', 'other'] as const;

/** Allowed direct transitions. done is reached via `complete` (acceptance rules), reopen via `reopen`. */
const TRANSITIONS: Record<Status, Status[]> = {
  backlog: ['planned', 'in_progress', 'cancelled'],
  planned: ['backlog', 'in_progress', 'blocked', 'in_review', 'done', 'cancelled'],
  in_progress: ['planned', 'blocked', 'in_review', 'done', 'cancelled'],
  blocked: ['in_progress', 'planned', 'cancelled'],
  in_review: ['in_progress'],
  done: [],
  cancelled: [],
};

// ---------- Quick capture (deterministic parser; proposes fields for confirmation) ----------
export interface ParsedCapture {
  title: string; dueDate: string | null; estimateMinutes: number | null; priority: string | null;
  projectKey: string | null; ownerHint: string | null; category: string | null; tokens: { kind: string; text: string }[];
}
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
export function parseQuickCapture(input: string, today: string): ParsedCapture {
  let s = ` ${input.trim()} `;
  const tokens: { kind: string; text: string }[] = [];
  const take = (re: RegExp, kind: string, fn: (m: RegExpMatchArray) => void) => {
    const m = s.match(re); if (!m) return; fn(m); tokens.push({ kind, text: m[0].trim() }); s = s.replace(m[0], ' ');
  };
  const out: ParsedCapture = { title: '', dueDate: null, estimateMinutes: null, priority: null, projectKey: null, ownerHint: null, category: null, tokens };
  take(/[\s—–-]+(\d+(?:\.\d+)?)\s*(h|hr|hrs|hours?|m|mins?|minutes?)\b/i, 'estimate', (m) => {
    const n = parseFloat(m[1]); out.estimateMinutes = Math.round(/^h/i.test(m[2]) ? n * 60 : n);
  });
  take(/\s(?:!|p)(urgent|high|medium|low|1|2|3|4)\b/i, 'priority', (m) => {
    const v = m[1].toLowerCase(); out.priority = ({ '1': 'urgent', '2': 'high', '3': 'medium', '4': 'low' } as any)[v] ?? v;
  });
  take(/\s#([A-Za-z][A-Za-z0-9]{1,9})\b/, 'project', (m) => { out.projectKey = m[1].toUpperCase(); });
  take(/\s@([\w.-]+)/, 'owner', (m) => { out.ownerHint = m[1].toLowerCase(); });
  take(/\s\/(delivery|admin|finance|support|research|sales|operations|other)\b/i, 'category', (m) => { out.category = m[1].toLowerCase(); });
  const t = DateTime.fromISO(today);
  take(/\s(?:due |by |on )?(today|tonight|tomorrow|tmrw|next week|in (\d+) days?|(mon|tue|wed|thu|fri|sat|sun)[a-z]*|(\d{4}-\d{2}-\d{2})|(\d{1,2})\/(\d{1,2}))\b/i, 'due', (m) => {
    const w = m[1].toLowerCase();
    if (w === 'today' || w === 'tonight') out.dueDate = today;
    else if (w === 'tomorrow' || w === 'tmrw') out.dueDate = t.plus({ days: 1 }).toISODate();
    else if (w === 'next week') out.dueDate = t.plus({ weeks: 1 }).startOf('week').toISODate();
    else if (m[2]) out.dueDate = t.plus({ days: Number(m[2]) }).toISODate();
    else if (m[4]) out.dueDate = m[4];
    else if (m[5]) { const d = t.set({ day: Number(m[5]), month: Number(m[6]) }); out.dueDate = (d < t ? d.plus({ years: 1 }) : d).toISODate(); }
    else if (m[3]) {
      const idx = WEEKDAYS.findIndex((d) => d.startsWith(m[3].toLowerCase())) + 1;
      let diff = idx - t.weekday; if (diff <= 0) diff += 7; out.dueDate = t.plus({ days: diff }).toISODate();
    }
  });
  out.title = s.replace(/\s+[—–-]\s*$/, '').replace(/\s{2,}/g, ' ').replace(/^[\s—–-]+|[\s—–-]+$/g, '').trim();
  return out;
}

// ---------- Create ----------
export interface TaskInput {
  title: string; description?: string; ownerId?: string; projectId?: string | null; milestoneId?: string | null;
  status?: Status; priority?: string; category?: string; dueDate?: string | null; estimateMinutes?: number | null;
  tags?: string[]; acceptanceCriteria?: string; requiresReview?: boolean; requiresEvidence?: boolean; reviewerId?: string | null;
  customerVisible?: boolean; sourceType?: string; sourceRef?: object | null; externalKey?: string | null;
  recurringTemplateId?: string | null; occurrenceDate?: string | null; collaboratorIds?: string[]; checklist?: string[];
}

export async function createTask(db: Db, a: Actor | null, tenantId: string, input: TaskInput, opts: { correlationId?: string; authority?: string; notifyOwner?: boolean } = {}) {
  if (a && !isStaff(a)) throw forbidden();
  const ownerId = input.ownerId ?? a?.id;
  if (!ownerId) throw badRequest('Owner is required');
  const owner = await one(db, `select id, status, roles from users where id = $1`, [ownerId]);
  if (!owner || owner.status !== 'active' || owner.roles.includes('customer')) throw badRequest('Owner must be an active staff member');
  if (input.projectId) await assertProjectUsable(db, a, input.projectId);
  if (input.milestoneId) await assertMilestoneInProject(db, input.milestoneId, input.projectId ?? null);
  const t = await one(db, `select settings from tenants where id = $1`, [tenantId]);
  const settings = t?.settings ?? {};
  const category = input.category ?? 'delivery';
  const requiresEvidence = input.requiresEvidence ?? (settings.evidence_required_categories ?? []).includes(category);
  const requiresReview = input.requiresReview ?? (settings.review_required_categories ?? []).includes(category);
  if (requiresReview && input.reviewerId === ownerId) throw badRequest('Reviewer must be someone other than the owner');
  const status = input.status ?? 'planned';
  if (!['backlog', 'planned', 'in_progress'].includes(status)) throw badRequest('New tasks start in Backlog, Planned or In Progress');
  const row = await one(db, `insert into tasks (tenant_id, project_id, milestone_id, title, description, owner_id, created_by, status, priority, category,
      due_date, estimate_minutes, tags, acceptance_criteria, requires_review, requires_evidence, reviewer_id, customer_visible, source_type, source_ref,
      external_key, recurring_template_id, occurrence_date, started_at, sort_order)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23, case when $8 = 'in_progress' then now() end,
      extract(epoch from now()))
    on conflict do nothing returning *`,
    [tenantId, input.projectId ?? null, input.milestoneId ?? null, input.title.trim(), input.description ?? '', ownerId, a?.id ?? null, status,
     input.priority ?? 'medium', category, input.dueDate ?? null, input.estimateMinutes ?? null, input.tags ?? [], input.acceptanceCriteria ?? '',
     requiresReview, requiresEvidence, input.reviewerId ?? null, input.customerVisible ?? false, input.sourceType ?? 'manual', input.sourceRef ?? null,
     input.externalKey ?? null, input.recurringTemplateId ?? null, input.occurrenceDate ?? null]);
  if (!row) {
    // Idempotent delivery: same external key / recurring occurrence => return existing task, never a duplicate.
    const existing = input.externalKey
      ? await one(db, `select * from tasks where external_key = $1`, [input.externalKey])
      : await one(db, `select * from tasks where recurring_template_id = $1 and occurrence_date = $2`, [input.recurringTemplateId, input.occurrenceDate]);
    return { task: existing, created: false };
  }
  await db.query(`insert into task_state_history (tenant_id, task_id, from_status, to_status, actor_id, reason) values ($1,$2,null,$3,$4,$5)`,
    [tenantId, row.id, status, a?.id ?? null, `Created (${input.sourceType ?? 'manual'})`]);
  for (const uid of input.collaboratorIds ?? []) if (uid !== ownerId)
    await db.query(`insert into task_collaborators (tenant_id, task_id, user_id) values ($1,$2,$3) on conflict do nothing`, [tenantId, row.id, uid]);
  let pos = 0;
  for (const text of input.checklist ?? []) if (text.trim())
    await db.query(`insert into checklist_items (tenant_id, task_id, text, position) values ($1,$2,$3,$4)`, [tenantId, row.id, text.trim(), pos++]);
  await audit(db, { tenantId, actorId: a?.id ?? null, action: 'task.create', resourceType: 'task', resourceId: row.id, resourceVersion: 1,
    correlationId: opts.correlationId, authority: opts.authority ?? (a ? 'owner/creator' : 'system'), details: { source: input.sourceType ?? 'manual' } });
  if (a && ownerId !== a.id && opts.notifyOwner !== false) await notify(db, tenantId, ownerId, 'task_assigned', `New task: ${row.title}`, `Assigned by ${a.name}`, `/tasks/${row.id}`);
  await emitTaskEvent(db, a, { type: 'task.created', tenantId, actorId: a?.id ?? null, task: row, to: row.status });
  return { task: await fresh(db, row), created: true };
}

/** A project work can be filed into: exists, not archived, and (when private) the actor is its owner, a member or the main admin. */
export async function assertProjectUsable(db: Db, a: Actor | null, projectId: string) {
  const p = await one(db, `select id, status, visibility, owner_id from projects where id = $1`, [projectId]);
  if (!p) throw badRequest('Project not found');
  if (p.status === 'archived') throw badRequest('Project is archived');
  // Private projects: only their owner, members or the main admin may file work into them.
  if (a && p.visibility === 'private' && p.owner_id !== a.id && !has(a, 'routine_admin')
    && !(await one(db, `select 1 from project_members where project_id = $1 and user_id = $2`, [p.id, a.id]))) throw badRequest('Project not found');
  return p;
}
async function assertMilestoneInProject(db: Db, milestoneId: string, projectId: string | null) {
  const m = await one(db, `select project_id from milestones where id = $1`, [milestoneId]);
  if (!m || m.project_id !== projectId) throw badRequest('That milestone belongs to a different project');
}

// ---------- Update fields (optimistic concurrency) ----------
const EDITABLE: Record<string, string> = {
  title: 'title', description: 'description', priority: 'priority', category: 'category', dueDate: 'due_date', estimateMinutes: 'estimate_minutes',
  tags: 'tags', acceptanceCriteria: 'acceptance_criteria', requiresReview: 'requires_review', requiresEvidence: 'requires_evidence',
  reviewerId: 'reviewer_id', projectId: 'project_id', milestoneId: 'milestone_id', customerVisible: 'customer_visible', sortOrder: 'sort_order',
};
export async function updateTask(db: Db, a: Actor, task: any, patch: Record<string, unknown>, version: number, correlationId?: string) {
  await assertContribute(db, a, task);
  if (version !== task.version) throw conflict('This task was changed by someone else. Reload to see the latest version.', { currentVersion: task.version });
  const sets: string[] = []; const vals: unknown[] = []; const changed: Record<string, unknown> = {};
  for (const [k, col] of Object.entries(EDITABLE)) {
    if (!(k in patch)) continue;
    vals.push(patch[k]); sets.push(`${col} = $${vals.length + 2}`); changed[k] = patch[k];
  }
  if (!sets.length) return task;
  if (patch.reviewerId && patch.reviewerId === task.owner_id) throw badRequest('Reviewer must be someone other than the owner');
  // Moving work between projects follows the same rules as filing it there; a milestone must belong to the resulting project.
  const projectId = ('projectId' in patch ? patch.projectId : task.project_id) as string | null;
  if ('projectId' in patch && patch.projectId && patch.projectId !== task.project_id) await assertProjectUsable(db, a, patch.projectId as string);
  if (patch.milestoneId) await assertMilestoneInProject(db, patch.milestoneId as string, projectId);
  else if (projectId !== task.project_id && task.milestone_id && !('milestoneId' in patch)) { vals.push(null); sets.push(`milestone_id = $${vals.length + 2}`); changed.milestoneId = null; }
  if (patch.reviewerId) {
    const r = await one(db, `select status, roles from users where id = $1`, [patch.reviewerId]);
    if (!r || r.status !== 'active' || r.roles.includes('customer')) throw badRequest('Reviewer must be an active staff member');
  }
  const scopeChange = ('dueDate' in patch && patch.dueDate !== task.due_date) || ('title' in patch && patch.title !== task.title);
  const row = await one(db, `update tasks set ${sets.join(', ')}, version = version + 1, updated_at = now() where id = $1 and version = $2 returning *`,
    [task.id, version, ...vals]);
  if (!row) throw conflict('This task was changed by someone else. Reload to see the latest version.');
  if (scopeChange && !('sortOrder' in patch && Object.keys(changed).length === 1)) {
    const parts: string[] = [];
    if ('dueDate' in patch && patch.dueDate !== task.due_date) parts.push(`due date ${task.due_date ?? 'none'} → ${patch.dueDate ?? 'none'}`);
    if ('title' in patch && patch.title !== task.title) parts.push(`title changed from "${task.title}"`);
    await db.query(`insert into comments (tenant_id, task_id, author_id, body, kind) values ($1,$2,$3,$4,'scope_change')`,
      [a.tenantId, task.id, a.id, `Scope change: ${parts.join('; ')}${patch.scopeNote ? ` — ${patch.scopeNote}` : ''}`]);
  }
  if (!(Object.keys(changed).length === 1 && 'sortOrder' in changed))
    await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'task.update', resourceType: 'task', resourceId: task.id, resourceVersion: row.version,
      correlationId, details: { fields: Object.keys(changed) } });
  if (!(Object.keys(changed).length === 1 && 'sortOrder' in changed))
    await emitTaskEvent(db, a, { type: 'task.updated', tenantId: a.tenantId, actorId: a.id, task: row, details: { fields: Object.keys(changed), before: { due_date: task.due_date, priority: task.priority } } });
  return fresh(db, row);
}

// ---------- State transitions ----------
export interface BlockerInput { reason: string; cause?: string; waitingOnUserId?: string | null; waitingOnText?: string; nextFollowUp?: string | null }

export async function transition(db: Db, a: Actor, task: any, to: Status, opts: { reason?: string; version?: number; blocker?: BlockerInput; resolution?: string; correlationId?: string } = {}) {
  await assertContribute(db, a, task);
  if (opts.version !== undefined && opts.version !== task.version) throw conflict('This task was changed by someone else. Reload to see the latest version.', { currentVersion: task.version });
  const from = task.status as Status;
  if (from === to) return task;
  if (!TRANSITIONS[from].includes(to)) throw badRequest(`Cannot move from ${label(from)} to ${label(to)}${from === 'done' || from === 'cancelled' ? ' — reopen it instead' : ''}`);
  if (to === 'blocked') {
    if (!opts.blocker?.reason?.trim()) throw badRequest('A blocked task needs a reason');
  }
  if (to === 'cancelled' && !opts.reason?.trim()) throw badRequest('Cancelling needs a short reason (scope change note)');
  if (to === 'done') {
    if (task.requires_review) throw badRequest('This task requires review — submit it for review instead of marking it Done');
    await assertEvidence(db, task);
  }
  if (to === 'in_review') {
    if (!task.requires_review && !task.reviewer_id) throw badRequest('Set a reviewer before submitting for review');
    await assertEvidence(db, task);
  }
  const extra: string[] = [];
  if (to === 'in_progress' && !task.started_at) extra.push('started_at = now()');
  if (to === 'done') extra.push('done_at = now()', 'accepted_at = now()');
  if (to === 'cancelled') extra.push('cancelled_at = now()', `cancel_reason = $4`);
  const row = await one(db, `update tasks set status = $2, version = version + 1, updated_at = now() ${extra.length ? ', ' + extra.join(', ') : ''}
    where id = $1 and version = $3 returning *`, to === 'cancelled' ? [task.id, to, task.version, opts.reason] : [task.id, to, task.version]);
  if (!row) throw conflict('This task was changed by someone else. Reload to see the latest version.');
  await db.query(`insert into task_state_history (tenant_id, task_id, from_status, to_status, actor_id, reason) values ($1,$2,$3,$4,$5,$6)`,
    [a.tenantId, task.id, from, to, a.id, opts.reason ?? opts.blocker?.reason ?? null]);
  if (to === 'blocked') {
    const b = opts.blocker!;
    await db.query(`insert into blockers (tenant_id, task_id, reason, cause, waiting_on_user_id, waiting_on_text, next_follow_up, raised_by)
      values ($1,$2,$3,$4,$5,$6,$7,$8)`, [a.tenantId, task.id, b.reason.trim(), b.cause ?? 'dependency', b.waitingOnUserId ?? null, b.waitingOnText ?? '', b.nextFollowUp ?? null, a.id]);
    if (b.waitingOnUserId && b.waitingOnUserId !== a.id)
      await notify(db, a.tenantId, b.waitingOnUserId, 'blocker_waiting', `${a.name} is waiting on you`, `"${task.title}": ${b.reason}`, `/tasks/${task.id}`);
  }
  if (from === 'blocked') {
    await db.query(`update blockers set resolved_at = now(), resolved_by = $2, resolution = $3 where task_id = $1 and resolved_at is null`,
      [task.id, a.id, opts.resolution ?? opts.reason ?? `Moved to ${label(to)}`]);
  }
  if (to === 'in_review') {
    const reviewer = row.reviewer_id;
    if (reviewer) await notify(db, a.tenantId, reviewer, 'review_requested', `Review requested: ${task.title}`, `From ${a.name}`, `/tasks/${task.id}`);
  }
  await audit(db, { tenantId: a.tenantId, actorId: a.id, action: `task.status.${to}`, resourceType: 'task', resourceId: task.id, resourceVersion: row.version,
    reason: opts.reason ?? opts.blocker?.reason ?? null, correlationId: opts.correlationId, details: { from, to } });
  await emitTaskEvent(db, a, { type: 'task.status_changed', tenantId: a.tenantId, actorId: a.id, task: row, from, to, details: to === 'blocked' ? { blocker: opts.blocker } : undefined });
  if (to === 'blocked') await emitTaskEvent(db, a, { type: 'blocker.raised', tenantId: a.tenantId, actorId: a.id, task: row, details: { blocker: opts.blocker } });
  return fresh(db, row);
}

async function assertEvidence(db: Db, task: any) {
  if (!task.requires_evidence) return;
  const n = await one(db, `select count(*)::int n from evidence_links where task_id = $1`, [task.id]);
  if (!n?.n) throw badRequest('Attach evidence before completing this task (required for its category)');
}

export async function reviewTask(db: Db, a: Actor, task: any, decision: 'accepted' | 'changes_requested', note: string, correlationId?: string) {
  if (task.status !== 'in_review') throw badRequest('Task is not waiting for review');
  const allowed = task.reviewer_id ? task.reviewer_id === a.id : (a.managedUserIds.includes(task.owner_id) || task.project_owner_id === a.id);
  if (!allowed) throw forbidden('Only the assigned reviewer can accept or request changes');
  if (task.owner_id === a.id) throw forbidden('Owners cannot accept their own work');
  if (decision === 'changes_requested' && !note.trim()) throw badRequest('Explain what needs to change');
  const to = decision === 'accepted' ? 'done' : 'in_progress';
  // Guarded on the state that was checked: a concurrent second decision finds no row instead of applying twice.
  const row = await one(db, `update tasks set status = $2, version = version + 1, updated_at = now()
      ${decision === 'accepted' ? ', done_at = now(), accepted_at = now()' : ''} where id = $1 and version = $3 and status = 'in_review' returning *`, [task.id, to, task.version]);
  if (!row) throw conflict('This task was changed by someone else. Reload to see the latest version.');
  await db.query(`insert into task_reviews (tenant_id, task_id, reviewer_id, decision, note) values ($1,$2,$3,$4,$5)`, [a.tenantId, task.id, a.id, decision, note]);
  await db.query(`insert into task_state_history (tenant_id, task_id, from_status, to_status, actor_id, reason) values ($1,$2,'in_review',$3,$4,$5)`,
    [a.tenantId, task.id, to, a.id, decision === 'accepted' ? `Accepted${note ? `: ${note}` : ''}` : `Changes requested: ${note}`]);
  await db.query(`insert into comments (tenant_id, task_id, author_id, body, kind) values ($1,$2,$3,$4,'review')`,
    [a.tenantId, task.id, a.id, decision === 'accepted' ? `Accepted. ${note}`.trim() : `Changes requested: ${note}`]);
  await notify(db, a.tenantId, task.owner_id, decision === 'accepted' ? 'review_accepted' : 'changes_requested',
    decision === 'accepted' ? `Accepted: ${task.title}` : `Changes requested: ${task.title}`, note, `/tasks/${task.id}`);
  await audit(db, { tenantId: a.tenantId, actorId: a.id, action: `task.review.${decision}`, resourceType: 'task', resourceId: task.id, resourceVersion: row.version,
    authority: 'reviewer', reason: note || null, correlationId });
  await emitTaskEvent(db, a, { type: 'task.reviewed', tenantId: a.tenantId, actorId: a.id, task: row, from: 'in_review', to, details: { decision, note } });
  await emitTaskEvent(db, a, { type: 'task.status_changed', tenantId: a.tenantId, actorId: a.id, task: row, from: 'in_review', to });
  return fresh(db, row);
}

export async function reopenTask(db: Db, a: Actor, task: any, reason: string, correlationId?: string) {
  await assertContribute(db, a, task);
  if (!['done', 'cancelled'].includes(task.status)) throw badRequest('Only Done or Cancelled tasks can be reopened');
  if (!reason?.trim()) throw badRequest('Reopening needs a reason (kept in rework history)');
  const to = task.status === 'done' ? 'in_progress' : 'planned';
  const row = await one(db, `update tasks set status = $2, version = version + 1, updated_at = now(), reopen_count = reopen_count + 1,
      done_at = null, accepted_at = null, cancelled_at = null where id = $1 and version = $3 and status in ('done','cancelled') returning *`, [task.id, to, task.version]);
  if (!row) throw conflict('This task was changed by someone else. Reload to see the latest version.');
  await db.query(`insert into task_state_history (tenant_id, task_id, from_status, to_status, actor_id, reason) values ($1,$2,$3,$4,$5,$6)`,
    [a.tenantId, task.id, task.status, to, a.id, `Reopened: ${reason}`]);
  await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'task.reopen', resourceType: 'task', resourceId: task.id, resourceVersion: row.version, reason, correlationId });
  await emitTaskEvent(db, a, { type: 'task.reopened', tenantId: a.tenantId, actorId: a.id, task: row, from: task.status, to, details: { reason } });
  return fresh(db, row);
}

export async function reassignTask(db: Db, a: Actor, task: any, newOwnerId: string, reason: string, correlationId?: string) {
  if (!canReassign(a, task)) throw forbidden('Only the owner, their manager, the project owner or the main admin can reassign');
  if (!reason?.trim()) throw badRequest('Reassignment needs a reason');
  const u = await one(db, `select id, name, status, roles from users where id = $1`, [newOwnerId]);
  if (!u || u.status !== 'active' || u.roles.includes('customer')) throw badRequest('New owner must be an active staff member');
  const row = await one(db, `update tasks set owner_id = $2, version = version + 1, updated_at = now() where id = $1 and version = $3 returning *`, [task.id, newOwnerId, task.version]);
  if (!row) throw conflict('This task was changed by someone else. Reload to see the latest version.');
  await db.query(`insert into comments (tenant_id, task_id, author_id, body, kind) values ($1,$2,$3,$4,'system')`,
    [a.tenantId, task.id, a.id, `Reassigned to ${u.name}: ${reason}`]);
  // The previous owner's plan keeps the item with a visible scope-change reason (from their own local today; past days are history).
  await db.query(`update daily_plan_items set removed_at = now(), removed_reason = $2 where task_id = $1 and removed_at is null
    and plan_id in (select id from daily_plans where user_id = $3 and date >= $4::date)`, [task.id, `Reassigned to ${u.name}`, task.owner_id, await userToday(db, task.owner_id)]);
  await notify(db, a.tenantId, newOwnerId, 'task_assigned', `Reassigned to you: ${task.title}`, reason, `/tasks/${task.id}`);
  if (task.owner_id !== a.id) await notify(db, a.tenantId, task.owner_id, 'task_reassigned', `Reassigned: ${task.title}`, `To ${u.name} — ${reason}`, `/tasks/${task.id}`);
  await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'task.reassign', resourceType: 'task', resourceId: task.id, resourceVersion: row.version,
    reason, correlationId, authority: has(a, 'routine_admin') ? 'routine_admin' : a.managedUserIds.includes(task.owner_id) ? 'team_manager' : 'owner',
    details: { from: task.owner_id, to: newOwnerId } });
  await emitTaskEvent(db, a, { type: 'task.reassigned', tenantId: a.tenantId, actorId: a.id, task: row, details: { fromOwner: task.owner_id, toOwner: newOwnerId, reason } });
  return fresh(db, row);
}

/** SQL predicate: projects the actor may see (company-wide, owned, member of, or main admin). Params: $n = actor id, $n+1 = is routine admin. */
export function projectVisibleSql(alias: string, n: number) {
  return `(${alias}.visibility = 'company' or ${alias}.owner_id = $${n} or $${n + 1}::boolean or exists (select 1 from project_members pm where pm.project_id = ${alias}.id and pm.user_id = $${n}))`;
}

/** Re-read a task after events: automation rules may have changed it in the same transaction (keeps version current for clients). */
async function fresh(db: Db, row: any) {
  return (await one(db, `select * from tasks where id = $1`, [row.id])) ?? row;
}

export function label(s: string) {
  return ({ backlog: 'Backlog', planned: 'Planned', in_progress: 'In Progress', blocked: 'Blocked', in_review: 'In Review', done: 'Done', cancelled: 'Cancelled' } as any)[s] ?? s;
}

// ---------- Recurring work ----------
export function occursOn(tpl: any, date: string) {
  const d = DateTime.fromISO(date);
  switch (tpl.rule) {
    case 'daily': return true;
    case 'weekdays': return d.weekday <= 5;
    case 'weekly': return d.weekday === (tpl.weekday ?? 1);
    case 'monthly': return d.day === (tpl.month_day ?? 1);
    default: return false;
  }
}
const RECURRING_CATCH_UP_DAYS = 7;
/** Create due occurrences up to `through` (idempotent through the unique (template, occurrence_date) index). */
export async function generateRecurring(db: Db, tenantId: string, through: string) {
  const tpls = await many(db, `select * from recurring_templates where active`);
  let created = 0;
  const end = DateTime.fromISO(through);
  // Missed occurrences are caught up for at most a week (e.g. after downtime); older ones are never backfilled as overdue work.
  const earliest = end.minus({ days: RECURRING_CATCH_UP_DAYS });
  const skip = (id: string) => db.query(`update recurring_templates set last_generated_date = greatest(coalesce(last_generated_date, $2::date), $2::date) where id = $1`, [id, through]);
  for (const tpl of tpls) {
    const owner = await one(db, `select status from users where id = $1`, [tpl.owner_id]);
    // While the owner is inactive nothing is due; moving the marker forward keeps a later reactivation from backfilling.
    if (owner?.status !== 'active') { await skip(tpl.id); continue; }
    // The template files work only where its creator (or, if they left, its owner) may still file it.
    if (tpl.project_id) {
      const checker = (tpl.created_by && await loadActor(db, tenantId, tpl.created_by)) || await loadActor(db, tenantId, tpl.owner_id);
      try { await assertProjectUsable(db, checker, tpl.project_id); } catch { await skip(tpl.id); continue; }
    }
    const next = tpl.last_generated_date ? DateTime.fromISO(tpl.last_generated_date).plus({ days: 1 }) : end;
    let d = next < earliest ? earliest : next;
    while (d <= end) {
      const date = d.toISODate()!;
      if (occursOn(tpl, date)) {
        const r = await createTask(db, null, tenantId, {
          title: tpl.title, description: tpl.description, ownerId: tpl.owner_id, projectId: tpl.project_id, category: tpl.category,
          priority: tpl.priority, estimateMinutes: tpl.estimate_minutes, dueDate: date, sourceType: 'recurring',
          recurringTemplateId: tpl.id, occurrenceDate: date, checklist: tpl.checklist,
        }, { authority: 'recurring_template' });
        if (r.created) created++;
      }
      d = d.plus({ days: 1 });
    }
    await db.query(`update recurring_templates set last_generated_date = greatest(coalesce(last_generated_date, $2::date), $2::date) where id = $1`, [tpl.id, through]);
  }
  return created;
}

export async function getTaskOr404(db: Db, id: string) {
  const t = await one(db, `select * from tasks where id = $1`, [id]);
  if (!t) throw notFound('Task not found');
  return t;
}
