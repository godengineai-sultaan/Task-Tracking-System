import { DateTime } from 'luxon';
import { z } from 'zod';
import type { Db } from '../../lib/db.js';
import { many, one } from '../../lib/db.js';
import { audit } from '../../lib/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { type Actor, has, isStaff, taskVisibility } from '../access.js';
import { CATEGORIES, PRIORITIES, createTask } from '../tasks.js';
import { type CalendarData, dayCapacity, loadCalendar, localToday } from '../calendar.js';
import { STARTERS } from './templates-starters.js';

export const TEMPLATE_CATEGORIES = ['people', 'finance', 'procurement', 'client', 'team', 'product', 'operations', 'other'] as const;

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((d) => DateTime.fromISO(d).isValid, 'Invalid date')
  .refine((d) => d >= '2000-01-01' && d <= '2099-12-31', 'Choose a start date between 2000 and 2099');

export const itemSchema = z.object({
  title: z.string().trim().min(1).max(300),
  description: z.string().max(5000).default(''),
  category: z.enum(CATEGORIES).default('delivery'),
  priority: z.enum(PRIORITIES).default('medium'),
  estimateMinutes: z.number().int().min(1).max(100000).nullable().default(null),
  dueOffsetDays: z.number().int().min(0).max(365).nullable().default(null),
  ownerHint: z.string().trim().max(80).default(''),
  checklist: z.array(z.string().trim().min(1).max(300)).max(50).default([]),
  requiresReview: z.boolean().default(false),
  requiresEvidence: z.boolean().default(false),
  /** 1-based positions of other steps in the same template. */
  dependsOn: z.array(z.number().int().min(1).max(200)).max(50).default([]),
});
export type ItemInput = z.infer<typeof itemSchema>;

export const templateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(5000).default(''),
  category: z.enum(TEMPLATE_CATEGORIES).default('other'),
  visibility: z.enum(['company', 'private']).default('private'),
  items: z.array(itemSchema).min(1, 'Add at least one step').max(100),
});
export type TemplateInput = z.infer<typeof templateSchema>;
export const updateSchema = templateSchema.extend({ version: z.number().int().min(1), changeNote: z.string().trim().max(500).default('') });

export const previewSchema = z.object({
  startDate: isoDate,
  projectId: uuid.nullable().optional(),
  milestoneId: uuid.nullable().optional(),
  defaultOwnerId: uuid.nullable().optional(),
  /** { "<item position>": userId } */
  assignments: z.record(z.string().regex(/^\d{1,3}$/), uuid).default({}),
});
export const applySchema = previewSchema.extend({ applyKey: z.string().trim().min(8).max(100) });
export type PreviewInput = z.infer<typeof previewSchema>;

export const fromProjectSchema = z.object({
  projectId: uuid,
  name: z.string().trim().min(1).max(120),
  description: z.string().max(5000).optional(),
  category: z.enum(TEMPLATE_CATEGORIES).default('other'),
  visibility: z.enum(['company', 'private']).default('private'),
  taskIds: z.array(uuid).min(1).max(100).optional(),
});

export const PLAN_ASSUMPTIONS = [
  "Due-date offsets count each owner's working days from the start date: weekends, company holidays and full-day leave are skipped.",
  'A start date that falls on a non-working day moves to the owner\'s next working day.',
  'Partial-leave days still count as working days.',
];

// ---------- Permissions ----------
/** Company templates are published and edited by managers and system admins. */
export const canPublish = (a: Actor) => has(a, 'system_admin') || has(a, 'manager') || a.managedUserIds.length > 0;
export const canView = (a: Actor, t: any) => isStaff(a) && (t.visibility === 'company' || t.created_by === a.id);
export const canEdit = (a: Actor, t: any) => isStaff(a) && (t.visibility === 'company' ? canPublish(a) : t.created_by === a.id);

export async function loadTemplate(db: Db, a: Actor, id: string) {
  if (!isStaff(a)) throw forbidden();
  const t = await one(db, `select * from task_templates where id = $1`, [id]);
  // Private templates of other people are indistinguishable from missing ones.
  if (!t || !canView(a, t)) throw notFound('Template not found');
  return t;
}

export const itemsOf = (db: Db, templateId: string) =>
  many(db, `select * from task_template_items where template_id = $1 order by position`, [templateId]);

export function rowToInput(r: any): ItemInput {
  return {
    title: r.title, description: r.description, category: r.category, priority: r.priority, estimateMinutes: r.estimate_minutes,
    dueOffsetDays: r.due_offset_days, ownerHint: r.owner_hint, checklist: r.checklist ?? [], requiresReview: r.requires_review,
    requiresEvidence: r.requires_evidence, dependsOn: r.depends_on ?? [],
  };
}

/** Dependencies must point at existing other steps and must not form a loop. */
export function validateItems(items: ItemInput[]) {
  const n = items.length;
  items.forEach((it, i) => {
    it.dependsOn = [...new Set(it.dependsOn)].sort((x, y) => x - y);
    for (const d of it.dependsOn) {
      if (d === i + 1) throw badRequest(`Step ${i + 1} cannot depend on itself`);
      if (d > n) throw badRequest(`Step ${i + 1} depends on step ${d}, which does not exist`);
    }
  });
  const state: number[] = new Array(n + 1).fill(0); // 0 new, 1 visiting, 2 done
  const visit = (p: number) => {
    if (state[p] === 2) return;
    if (state[p] === 1) throw badRequest(`Step ${p} is part of a circular dependency`);
    state[p] = 1;
    for (const d of items[p - 1].dependsOn) visit(d);
    state[p] = 2;
  };
  for (let p = 1; p <= n; p++) visit(p);
}

async function insertItems(db: Db, tenantId: string, templateId: string, items: ItemInput[]) {
  for (const [i, it] of items.entries()) {
    await db.query(`insert into task_template_items (tenant_id, template_id, position, title, description, category, priority, estimate_minutes,
        due_offset_days, owner_hint, checklist, requires_review, requires_evidence, depends_on)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [tenantId, templateId, i + 1, it.title, it.description, it.category, it.priority, it.estimateMinutes, it.dueOffsetDays, it.ownerHint,
      JSON.stringify(it.checklist), it.requiresReview, it.requiresEvidence, it.dependsOn]);
  }
}

async function saveVersion(db: Db, t: any, input: TemplateInput, note: string, actorId: string | null) {
  const snapshot = { name: input.name, description: input.description, category: input.category, visibility: input.visibility, items: input.items };
  await db.query(`insert into task_template_versions (tenant_id, template_id, version, snapshot, change_note, created_by) values ($1,$2,$3,$4,$5,$6)`,
    [t.tenant_id, t.id, t.version, JSON.stringify(snapshot), note, actorId]);
}

// ---------- Starter provisioning (idempotent per tenant) ----------
export async function ensureStarterTemplates(db: Db, tenantId: string, actorId: string | null) {
  const have = new Set((await many(db, `select starter_key from task_templates where tenant_id = $1 and starter_key is not null`, [tenantId])).map((r) => r.starter_key));
  const created: string[] = [];
  for (const s of STARTERS) {
    if (have.has(s.key)) continue;
    const t = await one(db, `insert into task_templates (tenant_id, name, description, category, visibility, is_starter, starter_key)
      values ($1,$2,$3,$4,'company',true,$5) on conflict (tenant_id, starter_key) where starter_key is not null do nothing returning *`,
    [tenantId, s.name, s.description, s.category, s.key]);
    if (!t) continue; // provisioned concurrently by another request
    const input = templateSchema.parse({ name: s.name, description: s.description, category: s.category, visibility: 'company', items: s.items });
    validateItems(input.items);
    await insertItems(db, tenantId, t.id, input.items);
    await saveVersion(db, t, input, 'Starter template', null);
    created.push(s.key);
  }
  if (created.length) await audit(db, { tenantId, actorId, action: 'template.starters_provisioned', resourceType: 'task_template', authority: 'system', details: { keys: created } });
  return created;
}

// ---------- Create / edit / duplicate / archive ----------
export async function createTemplate(db: Db, a: Actor, input: TemplateInput, details: Record<string, unknown> = { source: 'manual' }) {
  if (!isStaff(a)) throw forbidden();
  if (input.visibility === 'company' && !canPublish(a)) throw forbidden('Only managers and system admins publish company templates. Save it as private instead.');
  validateItems(input.items);
  const t = await one(db, `insert into task_templates (tenant_id, name, description, category, visibility, created_by, updated_by)
    values ($1,$2,$3,$4,$5,$6,$6) returning *`, [a.tenantId, input.name, input.description, input.category, input.visibility, a.id]);
  await insertItems(db, a.tenantId, t.id, input.items);
  await saveVersion(db, t, input, 'Created', a.id);
  await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'template.create', resourceType: 'task_template', resourceId: t.id, resourceVersion: 1,
    details: { ...details, items: input.items.length, visibility: input.visibility } });
  return t;
}

export async function updateTemplate(db: Db, a: Actor, t: any, input: z.infer<typeof updateSchema>) {
  if (!canEdit(a, t)) throw forbidden(t.visibility === 'company'
    ? 'Only managers and system admins edit company templates. Duplicate it to make your own copy.' : 'Only the creator can edit a private template');
  if (input.version !== t.version) throw conflict('This template was changed by someone else. Reload to see the latest version.', { currentVersion: t.version });
  if (t.archived_at) throw badRequest('Restore this template before editing it');
  if (input.visibility === 'company' && !canPublish(a)) throw forbidden('Only managers and system admins publish company templates');
  if (input.visibility === 'private' && t.visibility === 'company' && t.created_by !== a.id)
    throw badRequest('Only the creator can make a company template private. Duplicate it to keep a private copy.');
  validateItems(input.items);
  const row = await one(db, `update task_templates set name = $3, description = $4, category = $5, visibility = $6, updated_by = $7, updated_at = now(),
      version = version + 1 where id = $1 and version = $2 returning *`,
  [t.id, input.version, input.name, input.description, input.category, input.visibility, a.id]);
  if (!row) throw conflict('This template was changed by someone else. Reload to see the latest version.');
  await db.query(`delete from task_template_items where template_id = $1`, [t.id]);
  await insertItems(db, a.tenantId, t.id, input.items);
  await saveVersion(db, row, input, input.changeNote, a.id);
  await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'template.update', resourceType: 'task_template', resourceId: t.id, resourceVersion: row.version,
    reason: input.changeNote || null, authority: t.visibility === 'company' ? (has(a, 'system_admin') ? 'system_admin' : 'manager') : 'creator',
    details: { items: input.items.length, visibility: input.visibility } });
  return row;
}

export async function duplicateTemplate(db: Db, a: Actor, t: any, opts: { name?: string; visibility?: 'company' | 'private' }) {
  const items = (await itemsOf(db, t.id)).map(rowToInput);
  return createTemplate(db, a, {
    name: (opts.name ?? `${t.name} (copy)`).slice(0, 120), description: t.description, category: t.category,
    visibility: opts.visibility ?? 'private', items,
  }, { source: 'duplicate', fromTemplateId: t.id, fromVersion: t.version });
}

export async function setArchived(db: Db, a: Actor, t: any, archived: boolean) {
  if (!canEdit(a, t)) throw forbidden('Only people who can edit this template can archive or restore it');
  const row = await one(db, `update task_templates set archived_at = case when $2 then coalesce(archived_at, now()) else null end, updated_at = now(), updated_by = $3
    where id = $1 returning *`, [t.id, archived, a.id]);
  await audit(db, { tenantId: a.tenantId, actorId: a.id, action: archived ? 'template.archive' : 'template.restore', resourceType: 'task_template',
    resourceId: t.id, resourceVersion: row.version });
  return row;
}

// ---------- Apply ----------
/** People this actor may assign template steps to: self, managed team members, project members (as project owner), anyone (main/system admin). */
export async function assignableUsers(db: Db, a: Actor, project: any | null) {
  const anyone = has(a, 'routine_admin') || has(a, 'system_admin');
  return many(db, `select u.id, u.name, u.title from users u where u.status = 'active' and not ('customer' = any(u.roles))
      and ($1::boolean or u.id = $2 or u.id = any($3::uuid[])
        or ($4::uuid is not null and exists (select 1 from project_members m where m.project_id = $4 and m.user_id = u.id)))
    order by u.name`, [anyone, a.id, a.managedUserIds, project && project.owner_id === a.id ? project.id : null]);
}

export async function loadVisibleProject(db: Db, a: Actor, id: string) {
  const p = await one(db, `select p.* from projects p where p.id = $1 and (p.visibility = 'company' or p.owner_id = $2 or $3::boolean
      or exists (select 1 from project_members m where m.project_id = p.id and m.user_id = $2))`, [id, a.id, has(a, 'routine_admin')]);
  if (!p) throw notFound('Project not found');
  return p;
}

const isWorking = (cal: CalendarData, date: string) => {
  const c = dayCapacity(cal, date);
  return { working: c.status === 'working' || c.status === 'partial_leave', c };
};
/** Calendar days searched for n working days: one working day a week, plus up to two years of holidays and leave. */
const searchDays = (n: number) => 7 * (n + 1) + 730;
/** The n-th working day on/after `start` (day 0 = first working day). Null when no working day is found. */
export function addWorkingDays(cal: CalendarData, start: string, n: number) {
  const skipped: { date: string; reason: string }[] = [];
  if (!cal.schedule.size) return null;
  let d = DateTime.fromISO(start); let left = n;
  for (let guard = 0; guard < searchDays(n); guard++, d = d.plus({ days: 1 })) {
    const iso = d.toISODate()!;
    const { working, c } = isWorking(cal, iso);
    if (!working) {
      // Holidays are company-wide facts; leave is shown only as "unavailable" (no leave type is disclosed).
      if (c.status === 'holiday') skipped.push({ date: iso, reason: c.holiday ?? 'Holiday' });
      else if (c.status === 'leave') skipped.push({ date: iso, reason: 'Unavailable' });
      continue;
    }
    if (left === 0) return { date: iso, skipped };
    left--;
  }
  return null;
}

export async function computePlan(db: Db, a: Actor, items: any[], input: PreviewInput) {
  let project: any = null;
  if (input.projectId) {
    project = await loadVisibleProject(db, a, input.projectId);
    if (project.status === 'archived') throw badRequest('That project is archived');
  }
  if (input.milestoneId) {
    const m = await one(db, `select id, project_id from milestones where id = $1`, [input.milestoneId]);
    if (!m || !project || m.project_id !== project.id) throw badRequest('The milestone must belong to the chosen project');
  }
  const positions = new Set(items.map((i) => i.position));
  // Keys are positions: "2" and "02" both mean step 2.
  const assignments = new Map(Object.entries(input.assignments).map(([k, v]) => [Number(k), v]));
  for (const k of assignments.keys()) if (!positions.has(k)) throw badRequest(`Step ${k} does not exist in this template`);
  const ownerOf = (pos: number) => assignments.get(pos) ?? input.defaultOwnerId ?? a.id;
  const ownerIds = [...new Set(items.map((i) => ownerOf(i.position)))];
  const users = new Map((await many(db, `select id, name, status, roles from users where id = any($1::uuid[])`, [ownerIds])).map((u) => [u.id, u]));
  const allowed = new Set((await assignableUsers(db, a, project)).map((u) => u.id));
  for (const id of ownerIds) {
    const u = users.get(id);
    if (!u || u.status !== 'active' || u.roles.includes('customer')) throw badRequest('Every owner must be an active staff member');
    if (!allowed.has(id)) throw forbidden(`You can't assign work to ${u.name}. You can assign template steps to yourself, people you manage`
      + `${project?.owner_id === a.id ? ' and members of this project' : ''}.`);
  }

  const warnings: string[] = [];
  const dated = items.filter((i) => i.due_offset_days !== null);
  const maxOffset = Math.max(0, ...dated.map((i) => i.due_offset_days));
  const to = DateTime.fromISO(input.startDate).plus({ days: searchDays(maxOffset) }).toISODate()!;
  const cals = new Map<string, CalendarData>();
  // Leave is personal: it is used (and shown as "Unavailable") only for owners whose leave this actor may see, as in the leave calendar.
  const seesLeave = (id: string) => id === a.id || a.managedUserIds.includes(id) || has(a, 'system_admin') || has(a, 'routine_admin');
  const leaveHidden: string[] = [];
  for (const id of new Set(dated.map((i) => ownerOf(i.position)))) {
    const cal = await loadCalendar(db, id, input.startDate, to);
    if (!seesLeave(id)) { cal.leave = []; leaveHidden.push(users.get(id).name); }
    cals.set(id, cal);
  }

  const rows = items.map((i) => {
    const ownerId = ownerOf(i.position);
    let dueDate: string | null = null; let skipped: { date: string; reason: string }[] = [];
    if (i.due_offset_days !== null) {
      const r = addWorkingDays(cals.get(ownerId)!, input.startDate, i.due_offset_days);
      if (r) ({ date: dueDate, skipped } = r);
      else {
        dueDate = DateTime.fromISO(input.startDate).plus({ days: i.due_offset_days }).toISODate();
        warnings.push(`${users.get(ownerId).name} has no working days in their schedule after the start date, so step ${i.position} uses calendar days.`);
      }
    }
    return {
      position: i.position, title: i.title, category: i.category, priority: i.priority, estimateMinutes: i.estimate_minutes,
      dueOffsetDays: i.due_offset_days, dueDate, skipped, ownerId, ownerName: users.get(ownerId).name, ownerHint: i.owner_hint,
      requiresReview: i.requires_review, requiresEvidence: i.requires_evidence, dependsOn: i.depends_on ?? [], checklistCount: (i.checklist ?? []).length,
    };
  });
  const byPos = new Map(rows.map((r) => [r.position, r]));
  for (const r of rows) for (const d of r.dependsOn) {
    const dep = byPos.get(d);
    if (r.dueDate && dep?.dueDate && r.dueDate < dep.dueDate) warnings.push(`Step ${r.position} is due before step ${d}, which it depends on. Check the owners' working days or adjust the dates after applying.`);
  }
  if (input.startDate < localToday(a.timezone)) warnings.push('The start date is in the past, so some tasks may be overdue as soon as they are created.');
  return {
    startDate: input.startDate, project: project && { id: project.id, key: project.key, name: project.name, ownerId: project.owner_id },
    milestoneId: input.milestoneId ?? null, rows, warnings,
    assumptions: leaveHidden.length
      ? [...PLAN_ASSUMPTIONS, `Leave is not counted for ${leaveHidden.join(', ')}: you can see leave only for yourself and people you manage. Their dates skip weekends and company holidays only.`]
      : PLAN_ASSUMPTIONS,
  };
}

export async function appliedTasks(db: Db, ids: string[]) {
  return many(db, `select t.id, t.number, t.title, t.status, t.due_date, t.priority, t.category, t.owner_id, u.name owner_name, t.project_id,
      t.requires_review, t.requires_evidence,
      coalesce((select array_agg(dt.number::int order by dt.number) from task_dependencies d join tasks dt on dt.id = d.depends_on_task_id where d.task_id = t.id), '{}') depends_on_numbers
    from tasks t join users u on u.id = t.owner_id where t.id = any($1::uuid[]) order by array_position($1::uuid[], t.id)`, [ids]);
}

async function replay(db: Db, a: Actor, templateId: string, existing: any) {
  if (existing.template_id !== templateId || existing.applied_by !== a.id) throw conflict('This apply key was already used for a different request');
  return { application: existing, tasks: await appliedTasks(db, existing.task_ids), created: false, warnings: [] as string[] };
}

/** Create real tasks from a template. Idempotent per applyKey: a retry returns the original tasks. */
export async function applyTemplate(db: Db, a: Actor, t: any, input: z.infer<typeof applySchema>, correlationId?: string) {
  const prior = await one(db, `select * from task_template_applications where apply_key = $1`, [input.applyKey]);
  if (prior) return replay(db, a, t.id, prior);
  // Lock the template so a concurrent edit cannot swap its steps between reading the version and reading the steps.
  t = await one(db, `select * from task_templates where id = $1 for share`, [t.id]);
  if (t.archived_at) throw badRequest('This template is archived. Restore it before applying it.');
  const items = await itemsOf(db, t.id);
  const plan = await computePlan(db, a, items, input);
  const app = await one(db, `insert into task_template_applications (tenant_id, template_id, template_version, apply_key, applied_by, start_date, project_id, milestone_id)
    values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (tenant_id, apply_key) do nothing returning *`,
  [a.tenantId, t.id, t.version, input.applyKey, a.id, input.startDate, plan.project?.id ?? null, plan.milestoneId]);
  if (!app) return replay(db, a, t.id, await one(db, `select * from task_template_applications where apply_key = $1`, [input.applyKey]));

  const ids = new Map<number, string>();
  for (const row of plan.rows) {
    const it = items.find((i) => i.position === row.position)!;
    const { task } = await createTask(db, a, a.tenantId, {
      title: it.title, description: it.description, ownerId: row.ownerId, projectId: plan.project?.id ?? null, milestoneId: plan.milestoneId,
      priority: it.priority, category: it.category, dueDate: row.dueDate, estimateMinutes: it.estimate_minutes, checklist: it.checklist ?? [],
      // A template can add review/evidence requirements; it never switches off the organization's category policy.
      requiresReview: it.requires_review ? true : undefined, requiresEvidence: it.requires_evidence ? true : undefined,
      sourceType: 'template', sourceRef: { templateId: t.id, version: t.version, applicationId: app.id, position: it.position },
      externalKey: `template:${app.id}:${it.position}`,
    }, { correlationId, authority: 'template_apply' });
    ids.set(it.position, task.id);
  }
  for (const it of items) for (const d of it.depends_on ?? [])
    await db.query(`insert into task_dependencies (tenant_id, task_id, depends_on_task_id) values ($1,$2,$3) on conflict do nothing`, [a.tenantId, ids.get(it.position), ids.get(d)]);
  const taskIds = items.map((i) => ids.get(i.position)!);
  const saved = await one(db, `update task_template_applications set task_ids = $2 where id = $1 returning *`, [app.id, taskIds]);
  await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'template.apply', resourceType: 'task_template', resourceId: t.id, resourceVersion: t.version,
    correlationId, details: { applicationId: app.id, tasks: taskIds.length, startDate: input.startDate, projectId: plan.project?.id ?? null,
      owners: [...new Set(plan.rows.map((r) => r.ownerId))] } });
  return { application: saved, tasks: await appliedTasks(db, taskIds), created: true, warnings: plan.warnings };
}

// ---------- Save as template from a project ----------
export async function templateFromProject(db: Db, a: Actor, input: z.infer<typeof fromProjectSchema>) {
  if (!isStaff(a)) throw forbidden();
  const project = await loadVisibleProject(db, a, input.projectId);
  const [vis, params] = taskVisibility(a, 3);
  const tasks = await many(db, `select t.*, u.title owner_title from tasks t left join projects p on p.id = t.project_id join users u on u.id = t.owner_id
    where t.project_id = $1 and t.status <> 'cancelled' and ($2::uuid[] is null or t.id = any($2::uuid[])) and ${vis}
    order by t.due_date nulls last, t.sort_order, t.number limit 101`, [project.id, input.taskIds ?? null, ...params]);
  if (!tasks.length) throw badRequest('There are no tasks in this project that you can see to save as a template');
  if (tasks.length > 100) throw badRequest('A template holds up to 100 steps, and this project has more than 100 tasks you can see. Choose up to 100 tasks to copy.');
  const ids = tasks.map((t) => t.id);
  const pos = new Map(ids.map((id, i) => [id, i + 1]));
  const checklists = await many(db, `select task_id, text from checklist_items where task_id = any($1::uuid[]) order by position`, [ids]);
  const deps = await many(db, `select task_id, depends_on_task_id from task_dependencies where task_id = any($1::uuid[]) and depends_on_task_id = any($1::uuid[])`, [ids]);
  // Offsets: working days after the earliest due date (organization schedule and holidays; personal leave ignored).
  const dates = tasks.map((t) => t.due_date).filter(Boolean).sort();
  let offset = (_d: string) => 0;
  if (dates.length) {
    const cal = { ...(await loadCalendar(db, a.id, dates[0], dates[dates.length - 1])), leave: [] };
    offset = (due: string) => {
      let n = 0;
      for (let d = DateTime.fromISO(dates[0]).plus({ days: 1 }); d.toISODate()! <= due; d = d.plus({ days: 1 })) if (isWorking(cal, d.toISODate()!).working) n++;
      return Math.min(365, n);
    };
  }
  const items = tasks.map((t) => itemSchema.parse({
    title: t.title, description: (t.description ?? '').slice(0, 5000), category: t.category, priority: t.priority, estimateMinutes: t.estimate_minutes,
    dueOffsetDays: t.due_date ? offset(t.due_date) : null, ownerHint: (t.owner_title ?? '').slice(0, 80),
    checklist: checklists.filter((c) => c.task_id === t.id).map((c) => String(c.text).slice(0, 300)).filter((s) => s.trim()).slice(0, 50),
    requiresReview: t.requires_review, requiresEvidence: t.requires_evidence,
    dependsOn: deps.filter((d) => d.task_id === t.id).map((d) => pos.get(d.depends_on_task_id)!),
  }));
  return createTemplate(db, a, {
    name: input.name, description: input.description ?? `Saved from project ${project.key} (${project.name}).`, category: input.category,
    visibility: input.visibility, items,
  }, { source: 'project', projectId: project.id, tasks: tasks.length });
}
