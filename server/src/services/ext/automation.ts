import { AsyncLocalStorage } from 'node:async_hooks';
import { DateTime } from 'luxon';
import { z } from 'zod';
import type { Db } from '../../lib/db.js';
import { many, one } from '../../lib/db.js';
import { audit } from '../../lib/audit.js';
import { badRequest, forbidden } from '../../lib/errors.js';
import { log } from '../../lib/log.js';
import { type Actor, has, loadActor, taskVisibility } from '../access.js';
import { notify } from '../notify.js';
import { CATEGORIES, PRIORITIES, STATUSES, createTask, label } from '../tasks.js';
import { asAutomation, emitTaskEvent, type TaskEvent } from '../events.js';

/**
 * No-code automation rules: trigger -> conditions -> actions.
 * - Event triggers run inside the transaction of the change that caused them (task event bus).
 * - Time triggers (due soon / overdue) run from an hourly tenant tick, at most once per rule, task and due date.
 * - Each rule runs inside its own savepoint: a rule error is recorded as a failed run and never fails the person's action.
 * - Team rules only ever match tasks owned by the people their owner manages, checked at evaluation time.
 * - Every executed action is audited with authority `automation_rule:<id>`.
 */

export const LOOP_DEPTH_LIMIT = 3;
export const EVENT_TRIGGERS = ['task.created', 'task.status_changed', 'blocker.raised', 'task.reviewed', 'task.reopened'] as const;
export const TIME_TRIGGERS = ['task.due_soon', 'task.overdue'] as const;
export const TRIGGER_TYPES = [...EVENT_TRIGGERS, ...TIME_TRIGGERS] as const;
/** Overdue rules ignore work that has been overdue for longer than this, so a new rule never floods people about stale history. */
const OVERDUE_LOOKBACK_DAYS = 30;
const PER_RULE_TICK_LIMIT = 200;

const uuid = z.string().uuid();
const target = z.enum(['owner', 'manager', 'reviewer', 'user']);
export const TriggerSchema = z.object({
  type: z.enum(TRIGGER_TYPES),
  from: z.enum(STATUSES).nullable().optional(),
  to: z.enum(STATUSES).nullable().optional(),
  decision: z.enum(['accepted', 'changes_requested']).nullable().optional(),
  days: z.number().int().min(0).max(30).optional(),
});
export const ConditionsSchema = z.object({
  projectIds: z.array(uuid).max(20).optional(),
  categories: z.array(z.enum(CATEGORIES)).max(CATEGORIES.length).optional(),
  priorities: z.array(z.enum(PRIORITIES)).max(PRIORITIES.length).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  ownerIds: z.array(uuid).max(50).optional(),
  statuses: z.array(z.enum(STATUSES)).max(STATUSES.length).optional(),
});
export const ActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('notify'), target, userId: uuid.nullable().optional(), message: z.string().trim().max(300).optional() }),
  z.object({ type: z.literal('create_follow_up'), title: z.string().trim().min(1).max(200), owner: target, userId: uuid.nullable().optional(),
    dueInDays: z.number().int().min(0).max(365).nullable().optional(), priority: z.enum(PRIORITIES).optional() }),
  z.object({ type: z.literal('set_priority'), priority: z.enum(PRIORITIES) }),
  z.object({ type: z.literal('set_reviewer'), target: z.enum(['manager', 'user']), userId: uuid.nullable().optional() }),
  z.object({ type: z.literal('add_checklist_item'), text: z.string().trim().min(1).max(300) }),
  z.object({ type: z.literal('add_comment'), text: z.string().trim().min(1).max(2000) }),
  z.object({ type: z.literal('assign'), userId: uuid }),
]);
export const RuleSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
  enabled: z.boolean().optional(),
  scope: z.enum(['company', 'team']),
  trigger: TriggerSchema,
  conditions: ConditionsSchema.default({}),
  actions: z.array(ActionSchema).min(1).max(6),
  preset: z.string().max(40).nullable().optional(),
});
export type Trigger = z.infer<typeof TriggerSchema>;
export type Conditions = z.infer<typeof ConditionsSchema>;
export type Action = z.infer<typeof ActionSchema>;
export type RuleInput = z.infer<typeof RuleSchema>;

/** Preset recipes offered in the rule builder. Scope is chosen by the person creating the rule. */
export const PRESETS: { key: string; name: string; description: string; trigger: Trigger; conditions: Conditions; actions: Action[] }[] = [
  { key: 'escalate_blocked_finance', name: 'Escalate blocked finance tasks', description: 'When finance work gets blocked, the owner\'s manager hears about it straight away.',
    trigger: { type: 'task.status_changed', to: 'blocked' }, conditions: { categories: ['finance'] },
    actions: [{ type: 'notify', target: 'manager', message: 'Blocked finance task needs attention: {task.title}' },
      { type: 'add_comment', text: 'Escalated to the owner\'s manager automatically because finance work is blocked.' }] },
  { key: 'follow_up_changes_requested', name: 'Follow up when changes are requested', description: 'A review that asks for changes creates a follow-up task for the owner, due in two days.',
    trigger: { type: 'task.reviewed', decision: 'changes_requested' }, conditions: {},
    actions: [{ type: 'create_follow_up', title: 'Address review feedback: {task.title}', owner: 'owner', dueInDays: 2 }] },
  { key: 'notify_reviewer_submitted', name: 'Tell the reviewer when work is submitted', description: 'Sends the reviewer a direct note when a task moves to In Review.',
    trigger: { type: 'task.status_changed', to: 'in_review' }, conditions: {},
    actions: [{ type: 'notify', target: 'reviewer', message: 'Ready for your review: {task.title}' }] },
  { key: 'due_tomorrow', name: 'Due-tomorrow reminder', description: 'Reminds the owner once when an open task is due by tomorrow.',
    trigger: { type: 'task.due_soon', days: 1 }, conditions: {},
    actions: [{ type: 'notify', target: 'owner', message: 'Due {task.due}: {task.title}' }] },
  { key: 'overdue_manager', name: 'Overdue: loop in the manager', description: 'When a task is a day overdue, the owner and their manager both get one note.',
    trigger: { type: 'task.overdue', days: 1 }, conditions: {},
    actions: [{ type: 'notify', target: 'owner', message: 'Overdue since {task.due}: {task.title}' }, { type: 'notify', target: 'manager', message: 'Overdue on your team: {task.title}' }] },
  { key: 'urgent_needs_review', name: 'Urgent work gets a reviewer', description: 'New urgent tasks get the owner\'s manager as reviewer and a review step on the checklist.',
    trigger: { type: 'task.created' }, conditions: { priorities: ['urgent'] },
    actions: [{ type: 'set_reviewer', target: 'manager' }, { type: 'add_checklist_item', text: 'Second pair of eyes before closing' }] },
];

// ---------- Normalization and validation ----------
export function normalizeTrigger(t: Trigger): Trigger {
  switch (t.type) {
    case 'task.status_changed': return { type: t.type, from: t.from ?? null, to: t.to ?? null };
    case 'task.reviewed': return { type: t.type, decision: t.decision ?? null };
    case 'task.due_soon': return { type: t.type, days: t.days ?? 1 };
    case 'task.overdue': return { type: t.type, days: Math.max(1, t.days ?? 1) };
    default: return { type: t.type };
  }
}
function normalizeConditions(c: Conditions): Conditions {
  const out: Conditions = {};
  for (const [k, v] of Object.entries(c) as [keyof Conditions, string[] | undefined][]) if (v?.length) (out as any)[k] = [...new Set(v)];
  return out;
}

/** People a manager's team rules may reach: the people in the teams they manage (excluding themselves). Active users only. */
export async function teamOf(db: Db, managerId: string): Promise<string[]> {
  const rows = await many(db, `select distinct tm.user_id from teams t join team_members tm on tm.team_id = t.id join users u on u.id = t.manager_id
    where t.manager_id = $1 and tm.user_id <> $1 and u.status = 'active'`, [managerId]);
  return rows.map((r) => r.user_id);
}

export function canCreateScope(a: Actor, scope: 'company' | 'team') {
  return scope === 'company' ? has(a, 'system_admin') : a.managedUserIds.length > 0;
}
export function canManageRule(a: Actor, rule: { scope: string; owner_id: string }) {
  return has(a, 'system_admin') || (rule.scope === 'team' && rule.owner_id === a.id);
}

/** Validate references for a rule owned by `ownerId`. Team rules may only point at the owner and their team. */
export async function validateRule(db: Db, input: RuleInput, ownerId: string) {
  const trigger = normalizeTrigger(input.trigger);
  const conditions = normalizeConditions(input.conditions ?? {});
  if (trigger.type === 'task.status_changed' && trigger.from && trigger.from === trigger.to) throw badRequest('Pick different "from" and "to" statuses');
  const team = input.scope === 'team' ? await teamOf(db, ownerId) : null;
  if (team && !team.length) throw badRequest('Team rules need a team: the rule owner does not manage anyone');
  const allowed = team ? new Set([ownerId, ...team]) : null;
  const userIds = new Set<string>(conditions.ownerIds ?? []);
  input.actions.forEach((act, i) => {
    const needsUser = ('target' in act && act.target === 'user') || (act.type === 'create_follow_up' && act.owner === 'user') || act.type === 'assign';
    const uid = 'userId' in act ? act.userId : null;
    if (needsUser && !uid) throw badRequest(`Action ${i + 1}: choose a person`);
    if (needsUser && uid) userIds.add(uid);
  });
  if (userIds.size) {
    const rows = await many(db, `select id from users where id = any($1::uuid[]) and status = 'active' and not ('customer' = any(roles))`, [[...userIds]]);
    if (rows.length !== userIds.size) throw badRequest('Every person in a rule must be an active staff member');
    if (allowed && [...userIds].some((u) => !allowed.has(u))) throw badRequest('Team rules can only involve you and the people on your team');
  }
  if (conditions.ownerIds?.length && allowed && conditions.ownerIds.some((u) => !allowed.has(u))) throw badRequest('Team rules can only match tasks owned by your team');
  if (conditions.projectIds?.length) {
    const n = await one(db, `select count(*)::int n from projects where id = any($1::uuid[])`, [conditions.projectIds]);
    if (n.n !== conditions.projectIds.length) throw badRequest('Project not found');
  }
  const actions = input.actions.map((a) => {
    // Keep only the fields each action uses (drop stray userIds on non-user targets).
    if ('userId' in a && !(('target' in a && a.target === 'user') || (a.type === 'create_follow_up' && a.owner === 'user') || a.type === 'assign')) {
      const { userId: _u, ...rest } = a as any; return rest as Action;
    }
    return a;
  });
  return { trigger, conditions, actions };
}

// ---------- Matching ----------
interface EventInfo { trigger: string; from?: string | null; to?: string | null; decision?: string | null; depth: number; dedupeKey?: string | null }

export function matchTrigger(t: Trigger, e: EventInfo): { ok: boolean; detail: string } {
  if (t.type !== e.trigger) return { ok: false, detail: `Different trigger (${e.trigger})` };
  if (t.type === 'task.status_changed') {
    if (t.from && e.from !== t.from) return { ok: false, detail: `Moved from ${label(e.from ?? '')}, rule needs ${label(t.from)}` };
    if (t.to && e.to !== t.to) return { ok: false, detail: `Moved to ${label(e.to ?? '')}, rule needs ${label(t.to)}` };
    return { ok: true, detail: `Moved ${e.from ? `from ${label(e.from)} ` : ''}to ${label(e.to ?? '')}` };
  }
  if (t.type === 'task.reviewed' && t.decision && e.decision !== t.decision)
    return { ok: false, detail: `Review was "${e.decision === 'accepted' ? 'accepted' : 'changes requested'}"` };
  return { ok: true, detail: 'Trigger matched' };
}

const list = (xs: string[]) => xs.join(', ');
/** Each condition is "any of" its values; an empty condition matches everything. */
export async function checkConditions(db: Db, c: Conditions, task: any) {
  const checks: { label: string; ok: boolean; detail: string }[] = [];
  if (c.projectIds?.length) {
    const ps = await many(db, `select id, key from projects where id = any($1::uuid[])`, [c.projectIds]);
    const cur = task.project_id ? (await one(db, `select key from projects where id = $1`, [task.project_id]))?.key : null;
    checks.push({ label: 'Project', ok: !!task.project_id && c.projectIds.includes(task.project_id), detail: `Task is in ${cur ?? 'no project'}; rule needs ${list(ps.map((p) => p.key))}` });
  }
  if (c.categories?.length) checks.push({ label: 'Category', ok: c.categories.includes(task.category), detail: `Task is ${task.category}; rule needs ${list(c.categories)}` });
  if (c.priorities?.length) checks.push({ label: 'Priority', ok: c.priorities.includes(task.priority), detail: `Task is ${task.priority}; rule needs ${list(c.priorities)}` });
  if (c.statuses?.length) checks.push({ label: 'Status', ok: c.statuses.includes(task.status), detail: `Task is ${label(task.status)}; rule needs ${list(c.statuses.map(label))}` });
  if (c.tags?.length) {
    const tags: string[] = (task.tags ?? []).map((t: string) => t.toLowerCase());
    checks.push({ label: 'Tag', ok: c.tags.some((t) => tags.includes(t.toLowerCase())), detail: `Task tags: ${tags.length ? list(tags) : 'none'}; rule needs ${list(c.tags)}` });
  }
  if (c.ownerIds?.length) {
    const names = await many(db, `select name from users where id = any($1::uuid[]) order by name`, [c.ownerIds]);
    checks.push({ label: 'Owner', ok: c.ownerIds.includes(task.owner_id), detail: `Rule needs a task owned by ${list(names.map((n) => n.name))}` });
  }
  return checks;
}

/** SQL form of checkConditions (alias t = tasks), appending its parameters to `params`. */
function conditionFilters(c: Conditions, params: unknown[]) {
  const out: string[] = [];
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  if (c.projectIds?.length) out.push(`t.project_id = any(${p(c.projectIds)}::uuid[])`);
  if (c.categories?.length) out.push(`t.category = any(${p(c.categories)}::text[])`);
  if (c.priorities?.length) out.push(`t.priority = any(${p(c.priorities)}::text[])`);
  if (c.statuses?.length) out.push(`t.status = any(${p(c.statuses)}::text[])`);
  if (c.ownerIds?.length) out.push(`t.owner_id = any(${p(c.ownerIds)}::uuid[])`);
  if (c.tags?.length) out.push(`exists (select 1 from unnest(t.tags) tg where lower(tg) = any(${p(c.tags.map((x) => x.toLowerCase()))}::text[]))`);
  return out;
}

async function scopeCheck(db: Db, rule: { scope: string; owner_id: string }, task: any) {
  if (rule.scope !== 'team') return { ok: true, detail: 'Company-wide rule' };
  const team = await teamOf(db, rule.owner_id);
  return team.includes(task.owner_id)
    ? { ok: true, detail: 'Task owner is on the rule owner\'s team' }
    : { ok: false, detail: 'Team rule: the task owner is not managed by the rule owner, so it never runs here' };
}

// ---------- Actions ----------
interface Plan { summary: string; skip?: string; apply?: () => Promise<string | void> }
interface RunCtx { rule: any; today: string; depth: number; dedupeKey?: string | null; trigger: string }
const authorityOf = (rule: any) => `automation_rule:${rule.id}`;
const TARGET_LABEL: Record<string, string> = { owner: 'the owner', manager: 'the owner\'s manager', reviewer: 'the reviewer', user: '' };

async function loadTask(db: Db, id: string) {
  return one(db, `select t.*, p.key project_key, p.status project_status, u.name owner_name from tasks t left join projects p on p.id = t.project_id
    join users u on u.id = t.owner_id where t.id = $1`, [id]);
}
async function managersOf(db: Db, userId: string): Promise<{ id: string; name: string }[]> {
  return many(db, `select distinct u.id, u.name from team_members tm join teams t on t.id = tm.team_id join users u on u.id = t.manager_id
    where tm.user_id = $1 and t.manager_id <> $1 and u.status = 'active' order by u.name`, [userId]);
}
async function activeStaff(db: Db, id: string) {
  return one<{ id: string; name: string }>(db, `select id, name from users where id = $1 and status = 'active' and not ('customer' = any(roles))`, [id]);
}
/** Resolve a target to people. Team rules can only reach the rule owner and their team, re-checked at run time. */
async function resolveTarget(db: Db, rule: any, kind: string, userId: string | null | undefined, task: any) {
  let people: { id: string; name: string }[] = [];
  if (kind === 'owner') people = [{ id: task.owner_id, name: task.owner_name }];
  else if (kind === 'manager') people = await managersOf(db, task.owner_id);
  else if (kind === 'reviewer') { const r = task.reviewer_id ? await activeStaff(db, task.reviewer_id) : null; people = r ? [r] : []; }
  else if (kind === 'user' && userId) { const u = await activeStaff(db, userId); people = u ? [u] : []; }
  if (rule.scope === 'team' && kind === 'user' && people.length) {
    const team = await teamOf(db, rule.owner_id);
    if (![rule.owner_id, ...team].includes(people[0].id)) return { people: [], why: 'that person is no longer on the rule owner\'s team' };
  }
  const why = people.length ? '' : kind === 'manager' ? 'the owner has no manager' : kind === 'reviewer' ? 'the task has no reviewer' : 'that person is not an active staff member';
  return { people, why };
}

/** Single pass with a function replacer: task text is inserted literally ("$&" stays "$&", a "{owner.name}" inside a title is not expanded). */
export function renderTemplate(s: string, task: any) {
  const vals: Record<string, string> = {
    'task.title': task.title ?? '', 'task.number': String(task.number ?? ''), 'project.key': task.project_key ?? '', 'owner.name': task.owner_name ?? '',
    'task.due': task.due_date ? DateTime.fromISO(task.due_date).toFormat('d LLL') : 'no due date',
  };
  return s.replace(/\{(task\.title|task\.number|task\.due|project\.key|owner\.name)\}/g, (_m, k: string) => vals[k]);
}

/** Can this user open the task? Same predicate as the task screens. */
async function canOpenTask(db: Db, tenantId: string, userId: string, taskId: string) {
  const viewer = await loadActor(db, tenantId, userId);
  if (!viewer) return false;
  const [vis, params] = taskVisibility(viewer, 2);
  return !!(await one(db, `select 1 from tasks t left join projects p on p.id = t.project_id where t.id = $1 and ${vis}`, [taskId, ...params]));
}
/** A specific person only receives task text (notification titles, follow-up titles) when they can already open the task. */
async function hiddenFrom(db: Db, rule: any, kind: string, person: { id: string; name: string }, task: any) {
  return kind === 'user' && !(await canOpenTask(db, rule.tenant_id, person.id, task.id))
    ? `${person.name} cannot open this task, so nothing about it was sent to them` : null;
}

async function planAction(db: Db, act: Action, task: any, ctx: RunCtx): Promise<Plan> {
  const { rule } = ctx;
  const tenantId = rule.tenant_id;
  const auditBase = { tenantId, actorId: null, resourceType: 'task', resourceId: task.id, authority: authorityOf(rule) };
  switch (act.type) {
    case 'notify': {
      const { people, why } = await resolveTarget(db, rule, act.target, act.userId, task);
      if (!people.length) return { summary: 'Notify', skip: `Nobody to notify: ${why}` };
      const hidden = await hiddenFrom(db, rule, act.target, people[0], task);
      if (hidden) return { summary: `Notify ${people[0].name}`, skip: hidden };
      const names = people.map((p) => p.name).join(', ');
      return { summary: `Notify ${names}${act.target !== 'user' ? ` (${TARGET_LABEL[act.target]})` : ''}`, apply: async () => {
        const title = act.message ? renderTemplate(act.message, task) : `${rule.name}: ${task.title}`;
        for (const p of people) await notify(db, tenantId, p.id, 'automation', title, `Automation rule "${rule.name}" on #${task.number} ${task.title}`, `/tasks/${task.id}`);
        await audit(db, { ...auditBase, action: 'automation.notify', details: { ruleId: rule.id, recipients: people.map((p) => p.id) } });
        return `Notified ${names}`;
      } };
    }
    case 'create_follow_up': {
      const { people, why } = await resolveTarget(db, rule, act.owner, act.userId, task);
      if (!people.length) return { summary: 'Create follow-up', skip: `No owner for the follow-up: ${why}` };
      const owner = people[0];
      const hidden = await hiddenFrom(db, rule, act.owner, owner, task);
      if (hidden) return { summary: `Create follow-up for ${owner.name}`, skip: hidden };
      const title = renderTemplate(act.title, task).slice(0, 300);
      const dueDate = act.dueInDays === null || act.dueInDays === undefined ? null : DateTime.fromISO(ctx.today).plus({ days: act.dueInDays }).toISODate();
      return { summary: `Create follow-up "${title}" for ${owner.name}${dueDate ? `, due ${dueDate}` : ''}`, apply: async () => {
        const r = await createTask(db, null, tenantId, {
          title, ownerId: owner.id, projectId: task.project_id && task.project_status !== 'archived' ? task.project_id : null, category: task.category,
          priority: act.priority ?? task.priority, dueDate, sourceType: 'automation', sourceRef: { ruleId: rule.id, taskId: task.id },
          description: `Follow-up created by automation rule "${rule.name}" from #${task.number}.`,
          externalKey: ctx.dedupeKey ? `automation:${ctx.dedupeKey}:${title}` : null,
        }, { authority: authorityOf(rule) });
        if (!r.created) return `Follow-up #${r.task.number} already existed`;
        await db.query(`insert into comments (tenant_id, task_id, author_id, body, kind) values ($1,$2,null,$3,'system')`,
          [tenantId, task.id, `Automation · ${rule.name}: created follow-up #${r.task.number} for ${owner.name}`]);
        await notify(db, tenantId, owner.id, 'task_assigned', `New follow-up: ${r.task.title}`, `Created by automation rule "${rule.name}"`, `/tasks/${r.task.id}`);
        return `Created follow-up #${r.task.number} for ${owner.name}`;
      } };
    }
    case 'set_priority': {
      if (task.priority === act.priority) return { summary: `Set priority to ${act.priority}`, skip: `Priority is already ${act.priority}` };
      return { summary: `Set priority ${task.priority} to ${act.priority}`, apply: async () => {
        const row = await one(db, `update tasks set priority = $2, version = version + 1, updated_at = now() where id = $1 returning *`, [task.id, act.priority]);
        await audit(db, { ...auditBase, action: 'task.update', resourceVersion: row.version, details: { fields: ['priority'], from: task.priority, to: act.priority, ruleId: rule.id } });
        await emitTaskEvent(db, null, { type: 'task.updated', tenantId, actorId: null, task: row, details: { fields: ['priority'], before: { due_date: task.due_date, priority: task.priority }, automationRuleId: rule.id } });
        return `Priority set to ${act.priority}`;
      } };
    }
    case 'set_reviewer': {
      const { people, why } = await resolveTarget(db, rule, act.target, act.userId, task);
      if (!people.length) return { summary: 'Set reviewer', skip: `No reviewer: ${why}` };
      const rv = people[0];
      if (rv.id === task.owner_id) return { summary: `Make ${rv.name} the reviewer`, skip: 'The reviewer must be someone other than the owner' };
      if (task.reviewer_id === rv.id && task.requires_review) return { summary: `Make ${rv.name} the reviewer`, skip: `${rv.name} is already the reviewer` };
      return { summary: `Make ${rv.name} the reviewer (review required)`, apply: async () => {
        const row = await one(db, `update tasks set reviewer_id = $2, requires_review = true, version = version + 1, updated_at = now() where id = $1 returning *`, [task.id, rv.id]);
        await notify(db, tenantId, rv.id, task.status === 'in_review' ? 'review_requested' : 'automation',
          task.status === 'in_review' ? `Review requested: ${task.title}` : `You are the reviewer for: ${task.title}`, `Set by automation rule "${rule.name}"`, `/tasks/${task.id}`);
        await audit(db, { ...auditBase, action: 'task.update', resourceVersion: row.version, details: { fields: ['reviewerId', 'requiresReview'], from: task.reviewer_id, to: rv.id, ruleId: rule.id } });
        await emitTaskEvent(db, null, { type: 'task.updated', tenantId, actorId: null, task: row, details: { fields: ['reviewerId', 'requiresReview'], before: { due_date: task.due_date, priority: task.priority }, automationRuleId: rule.id } });
        return `${rv.name} is now the reviewer`;
      } };
    }
    case 'add_checklist_item': {
      const text = renderTemplate(act.text, task).slice(0, 300);
      if (await one(db, `select 1 from checklist_items where task_id = $1 and lower(text) = lower($2)`, [task.id, text])) return { summary: `Add checklist item "${text}"`, skip: 'The checklist already has that item' };
      return { summary: `Add checklist item "${text}"`, apply: async () => {
        await db.query(`insert into checklist_items (tenant_id, task_id, text, position) values ($1,$2,$3,(select coalesce(max(position),0)+1 from checklist_items where task_id = $2))`, [tenantId, task.id, text]);
        await audit(db, { ...auditBase, action: 'checklist.add', details: { text, ruleId: rule.id } });
        return 'Added a checklist item';
      } };
    }
    case 'add_comment': {
      const body = `Automation · ${rule.name}: ${renderTemplate(act.text, task)}`.slice(0, 10000);
      return { summary: 'Post a comment on the task', apply: async () => {
        await db.query(`insert into comments (tenant_id, task_id, author_id, body, kind) values ($1,$2,null,$3,'system')`, [tenantId, task.id, body]);
        await audit(db, { ...auditBase, action: 'comment.add', details: { ruleId: rule.id } });
        return 'Posted a comment';
      } };
    }
    case 'assign': {
      const { people, why } = await resolveTarget(db, rule, 'user', act.userId, task);
      if (!people.length) return { summary: 'Assign', skip: `Cannot assign: ${why}` };
      const u = people[0];
      if (['done', 'cancelled'].includes(task.status)) return { summary: `Assign to ${u.name}`, skip: 'The task is closed' };
      if (task.owner_id === u.id) return { summary: `Assign to ${u.name}`, skip: `${u.name} already owns it` };
      if (task.reviewer_id === u.id) return { summary: `Assign to ${u.name}`, skip: `${u.name} is the reviewer; the owner must be someone else` };
      return { summary: `Assign to ${u.name}`, apply: async () => {
        const row = await one(db, `update tasks set owner_id = $2, version = version + 1, updated_at = now() where id = $1 returning *`, [task.id, u.id]);
        await db.query(`insert into comments (tenant_id, task_id, author_id, body, kind) values ($1,$2,null,$3,'system')`,
          [tenantId, task.id, `Automation · ${rule.name}: reassigned from ${task.owner_name} to ${u.name}`]);
        await db.query(`update daily_plan_items set removed_at = now(), removed_reason = $2 where task_id = $1 and removed_at is null
          and plan_id in (select id from daily_plans where user_id = $3 and date >= current_date)`, [task.id, `Reassigned to ${u.name} by automation`, task.owner_id]);
        await notify(db, tenantId, u.id, 'task_assigned', `Assigned to you: ${task.title}`, `By automation rule "${rule.name}"`, `/tasks/${task.id}`);
        await notify(db, tenantId, task.owner_id, 'task_reassigned', `Reassigned: ${task.title}`, `To ${u.name} by automation rule "${rule.name}"`, `/tasks/${task.id}`);
        await audit(db, { ...auditBase, action: 'task.reassign', resourceVersion: row.version, reason: `Automation rule "${rule.name}"`, details: { from: task.owner_id, to: u.id, ruleId: rule.id } });
        await emitTaskEvent(db, null, { type: 'task.reassigned', tenantId, actorId: null, task: row, details: { fromOwner: task.owner_id, toOwner: u.id, reason: `Automation rule "${rule.name}"` } });
        return `Assigned to ${u.name}`;
      } };
    }
  }
}

// ---------- Execution ----------
/** Depth of this engine's rule chain, per async context (rules run at depth + 1 of the event that fired them). */
const chainDepth = new AsyncLocalStorage<number>();
let spSeq = 0;
/** Run fn inside a savepoint; on error roll back just that work and rethrow. Keeps the surrounding transaction usable. */
async function guarded<T>(db: Db, fn: () => Promise<T>): Promise<T> {
  const sp = `automation_sp_${++spSeq}`;
  await db.query(`savepoint ${sp}`);
  try {
    const out = await fn();
    await db.query(`release savepoint ${sp}`);
    return out;
  } catch (e) {
    await db.query(`rollback to savepoint ${sp}`);
    await db.query(`release savepoint ${sp}`);
    throw e;
  }
}

interface ActionResult { type: string; status: 'done' | 'skipped'; detail: string }
async function recordRun(db: Db, rule: any, taskId: string, ctx: RunCtx, status: string, message: string, results: ActionResult[]) {
  try {
    await guarded(db, () => db.query(`insert into automation_runs (tenant_id, rule_id, rule_version, task_id, trigger, status, message, results, depth, dedupe_key, created_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, clock_timestamp()) on conflict do nothing`,
      [rule.tenant_id, rule.id, rule.version, taskId, ctx.trigger, status, message.slice(0, 1000), JSON.stringify(results), ctx.depth, ctx.dedupeKey ?? null]));
  } catch (e: any) { log.error({ rule: rule.id, err: e?.message }, 'automation run not recorded'); }
}

/** Evaluate one rule against one task; never throws. Returns the recorded run status, or null when the rule did not match. */
async function evaluateRule(db: Db, rule: any, task: any, ev: EventInfo, today: string): Promise<string | null> {
  const ctx: RunCtx = { rule, today, depth: ev.depth, dedupeKey: ev.dedupeKey, trigger: ev.trigger };
  try {
    if (!matchTrigger(rule.trigger, ev).ok) return null;
    if ((await checkConditions(db, rule.conditions ?? {}, task)).some((c) => !c.ok)) return null;
    if (!(await scopeCheck(db, rule, task)).ok) return null;
  } catch (e: any) {
    log.error({ rule: rule.id, err: e?.message }, 'automation match failed');
    return null;
  }
  if (ev.depth >= LOOP_DEPTH_LIMIT) {
    await recordRun(db, rule, task.id, ctx, 'skipped', `Loop guard: this change came from a chain of ${ev.depth} automations, so rules stop here.`, []);
    return 'skipped';
  }
  const results: ActionResult[] = [];
  try {
    await guarded(db, () => chainDepth.run(ev.depth + 1, () => asAutomation(async () => {
      for (const [i, act] of (rule.actions as Action[]).entries()) {
        const fresh = await loadTask(db, task.id);
        if (!fresh) throw new Error('The task no longer exists');
        try {
          const plan = await planAction(db, act, fresh, ctx);
          if (plan.skip) { results.push({ type: act.type, status: 'skipped', detail: plan.skip }); continue; }
          results.push({ type: act.type, status: 'done', detail: (await plan.apply!()) || plan.summary });
        } catch (e: any) {
          throw new Error(`Action ${i + 1} (${act.type.replace(/_/g, ' ')}): ${e?.message ?? e}`);
        }
      }
    })));
  } catch (e: any) {
    await recordRun(db, rule, task.id, ctx, 'failed', `${e?.message ?? e}. Nothing from this rule was applied; the original change went through.`, results);
    return 'failed';
  }
  const status = results.some((r) => r.status === 'done') ? 'success' : 'skipped';
  await recordRun(db, rule, task.id, ctx, status, results.map((r) => r.detail).join('; '), results);
  return status;
}

async function tenantToday(db: Db, tenantId: string) {
  const t = await one(db, `select timezone from tenants where id = $1`, [tenantId]);
  return DateTime.now().setZone(t?.timezone || 'UTC').toISODate()!;
}

/** Task event listener body: run every enabled rule whose trigger matches this event. */
export async function handleTaskEvent(db: Db, ev: TaskEvent) {
  if (!(EVENT_TRIGGERS as readonly string[]).includes(ev.type) || !ev.task?.id) return;
  const rules = await many(db, `select * from automation_rules where enabled and archived_at is null and trigger->>'type' = $1 order by created_at, id`, [ev.type]);
  if (!rules.length) return;
  const today = await tenantToday(db, ev.tenantId);
  // events.ts counts automation depth in one process-wide counter, so concurrent requests inflate ev.depth.
  // Inside this engine's own chain the async-local depth is exact; a person's direct change (actor set, no chain) is depth 0.
  const depth = chainDepth.getStore() ?? (ev.actorId ? 0 : ev.depth);
  const info: EventInfo = { trigger: ev.type, from: ev.from ?? null, to: ev.to ?? null, decision: (ev.details?.decision as string) ?? null, depth };
  for (const rule of rules) await evaluateRule(db, rule, ev.task, info, today);
}

/** Hourly tenant tick: due-soon and overdue rules, at most once per rule, task and due date. */
export async function runTimeTriggers(db: Db, tenantId: string) {
  // One tick per tenant at a time: an overlapping tick waits, then its "already fired" check sees the first tick's committed runs.
  await db.query(`select pg_advisory_xact_lock(hashtext('automation.time_rules:' || $1))`, [tenantId]);
  const today = await tenantToday(db, tenantId);
  const rules = await many(db, `select * from automation_rules where enabled and archived_at is null and trigger->>'type' = any($1::text[]) order by created_at, id`, [[...TIME_TRIGGERS]]);
  let fired = 0;
  for (const rule of rules) {
    const days = Number(rule.trigger.days ?? 1);
    const window = rule.trigger.type === 'task.due_soon'
      ? `t.due_date between $2::date and $2::date + $3::int`
      : `t.due_date between $2::date - ${OVERDUE_LOOKBACK_DAYS} and $2::date - $3::int`;
    // Conditions and team scope are filtered in SQL so the per-tick limit only ever counts tasks the rule can match
    // (otherwise a busy window of non-matching tasks would starve the matching ones forever).
    const params: unknown[] = [`${rule.trigger.type}:${rule.id}`, today, days];
    const filters = conditionFilters(rule.conditions ?? {}, params);
    if (rule.scope === 'team') {
      const team = await teamOf(db, rule.owner_id);
      if (!team.length) continue;
      params.push(team); filters.push(`t.owner_id = any($${params.length}::uuid[])`);
    }
    const tasks = await many(db, `select t.* from tasks t where t.status not in ('done','cancelled') and ${window} ${filters.map((f) => `and ${f}`).join(' ')}
      and not exists (select 1 from automation_runs r where r.dedupe_key = $1 || ':' || t.id || ':' || t.due_date)
      order by t.due_date, t.id limit ${PER_RULE_TICK_LIMIT}`, params);
    for (const t of tasks)
      if (await evaluateRule(db, rule, t, { trigger: rule.trigger.type, depth: 0, dedupeKey: `${rule.trigger.type}:${rule.id}:${t.id}:${t.due_date}` }, today)) fired++;
  }
  return fired;
}

// ---------- Dry run ----------
/** Explain what a rule would do to a task right now, without changing anything. */
export async function dryRun(db: Db, rule: any, taskId: string) {
  const task = await loadTask(db, taskId);
  if (!task) throw badRequest('Task not found');
  const today = await tenantToday(db, rule.tenant_id);
  const checks: { label: string; ok: boolean; detail: string }[] = [];
  const t: Trigger = rule.trigger;
  checks.push({ label: 'Rule enabled', ok: rule.enabled !== false, detail: rule.enabled !== false ? 'Enabled' : 'Paused: it will not run until enabled' });
  let simulated = { ...task };
  if (t.type === 'task.status_changed') {
    const to = t.to ?? null;
    const okFrom = !t.from || task.status === t.from;
    const okMove = !to || task.status !== to;
    checks.push({ label: 'Trigger', ok: okFrom && okMove, detail: !okFrom ? `Task is ${label(task.status)}; this rule only fires on moves from ${label(t.from!)}`
      : !okMove ? `Task is already ${label(to!)}` : `Simulated: task moves from ${label(task.status)}${to ? ` to ${label(to)}` : ''}` });
    if (to) simulated = { ...simulated, status: to };
  } else if (t.type === 'task.due_soon' || t.type === 'task.overdue') {
    const days = t.days ?? 1;
    const due = task.due_date as string | null;
    const open = !['done', 'cancelled'].includes(task.status);
    const lo = DateTime.fromISO(today);
    const inWindow = !!due && (t.type === 'task.due_soon'
      ? due >= today && due <= lo.plus({ days }).toISODate()!
      : due <= lo.minus({ days }).toISODate()! && due >= lo.minus({ days: OVERDUE_LOOKBACK_DAYS }).toISODate()!);
    const fired = due ? await one(db, `select 1 from automation_runs where dedupe_key = $1`, [`${t.type}:${rule.id}:${task.id}:${due}`]) : null;
    checks.push({ label: 'Trigger', ok: open && inWindow && !fired,
      detail: !open ? 'Task is closed' : !due ? 'Task has no due date' : fired ? `Already fired for due date ${due}; it does not repeat`
        : inWindow ? `Due ${due}: inside the window, the next hourly check would fire` : `Due ${due}: outside the window today` });
  } else {
    checks.push({ label: 'Trigger', ok: true, detail: `Simulated: ${({ 'task.created': 'the task is created', 'blocker.raised': 'a blocker is raised', 'task.reopened': 'the task is reopened',
      'task.reviewed': t.decision === 'changes_requested' ? 'a reviewer requests changes' : t.decision === 'accepted' ? 'a reviewer accepts it' : 'the task is reviewed' } as Record<string, string>)[t.type]}` });
    if (t.type === 'task.reviewed') simulated = { ...simulated, status: t.decision === 'accepted' ? 'done' : 'in_progress' };
    if (t.type === 'blocker.raised') simulated = { ...simulated, status: 'blocked' };
  }
  checks.push(...await checkConditions(db, rule.conditions ?? {}, simulated));
  checks.push({ label: 'Scope', ...(await scopeCheck(db, rule, task)) });
  const wouldRun = checks.every((c) => c.ok);
  const actions: { type: string; summary: string; skip?: string }[] = [];
  const ctx: RunCtx = { rule, today, depth: 0, trigger: t.type };
  // Planning only reads; the savepoint is a second guarantee that a dry run never changes data.
  await guarded(db, async () => {
    for (const act of rule.actions as Action[]) {
      const p = await planAction(db, act, simulated, ctx);
      actions.push({ type: act.type, summary: p.summary, ...(p.skip ? { skip: p.skip } : {}) });
    }
    throw new DryRunDone();
  }).catch((e) => { if (!(e instanceof DryRunDone)) throw e; });
  return { wouldRun, checks, actions, task: { id: task.id, number: task.number, title: task.title, status: task.status },
    note: 'Dry run: nothing was changed and nobody was notified.' };
}
class DryRunDone extends Error {}

export function assertCanCreate(a: Actor, scope: 'company' | 'team') {
  if (!canCreateScope(a, scope)) throw forbidden(scope === 'company' ? 'Only system admins can create company-wide rules' : 'Team rules are for managers of a team');
}
