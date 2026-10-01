import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tx } from '../../app.js';
import type { Db } from '../../lib/db.js';
import { many, one } from '../../lib/db.js';
import { audit } from '../../lib/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { has, requireStaff, taskVisibility, type Actor } from '../../services/access.js';
import { notify } from '../../services/notify.js';
import { OKR_RULES, computeObjectives } from '../../services/ext/objectives.js';

const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const LIFECYCLE = ['active', 'achieved', 'missed', 'dropped'] as const;

/** Leadership and system admins create and edit objectives. */
const canEdit = (a: Actor) => has(a, 'leadership') || has(a, 'system_admin');
/** The objective owner (plus editors) maintains key results and posts check-ins. */
const canMaintain = (a: Actor, o: any) => canEdit(a) || (!!o.owner_id && o.owner_id === a.id);

async function loadObjective(db: Db, id: string) {
  if (!uuid.safeParse(id).success) throw notFound('Objective not found');
  const o = await one(db, `select * from objectives where id = $1`, [id]);
  if (!o) throw notFound('Objective not found');
  return o;
}
async function assertStaffUser(db: Db, userId: string) {
  const u = await one(db, `select id, name from users where id = $1 and status = 'active' and not ('customer' = any(roles))`, [userId]);
  if (!u) throw badRequest('The owner must be an active staff member');
  return u;
}
function checkPeriod(start: string | null | undefined, end: string | null | undefined) {
  if (start && end && end < start) throw badRequest('The period end must be on or after the period start');
}
/** Project visibility as on the projects page: company projects, projects the actor owns or belongs to, or routine admin. */
async function visibleProjectIds(db: Db, a: Actor, projectIds: string[]) {
  if (!projectIds.length) return new Set<string>();
  const rows = await many(db, `select p.id from projects p where p.id = any($3::uuid[]) and (p.visibility = 'company' or p.owner_id = $1
      or exists (select 1 from project_members m where m.project_id = p.id and m.user_id = $1) or $2::boolean)`, [a.id, has(a, 'routine_admin'), projectIds]);
  return new Set(rows.map((r) => r.id as string));
}

/** Newly linked milestones/projects must be in projects the actor can see (no linking private work by id). */
async function assertVisibleLinks(db: Db, a: Actor, milestoneIds: string[], projectIds: string[]) {
  const ms = milestoneIds.length ? await many(db, `select project_id from milestones where id = any($1::uuid[])`, [milestoneIds]) : [];
  const need = [...new Set([...ms.map((m) => m.project_id as string), ...projectIds])];
  const vis = await visibleProjectIds(db, a, need);
  if (need.some((id) => !vis.has(id))) throw badRequest('A linked milestone or project does not exist');
}

const krSchema = z.object({
  title: z.string().trim().min(1).max(300),
  kind: z.enum(['milestone_completion', 'task_completion', 'manual']),
  targetValue: z.number().positive().max(1e12).nullable().optional(),
  currentValue: z.number().min(-1e12).max(1e12).nullable().optional(),
  unit: z.string().trim().max(40).optional(),
  milestoneIds: z.array(uuid).max(50).optional(),
  projectIds: z.array(uuid).max(20).optional(),
});

/** Normalize and validate a key result; linked ids must exist in this tenant. */
async function normalizeKr(db: Db, k: { title: string; kind: string; targetValue?: number | null; currentValue?: number | null; unit?: string; milestoneIds?: string[]; projectIds?: string[] }) {
  const milestoneIds = [...new Set(k.milestoneIds ?? [])], projectIds = [...new Set(k.projectIds ?? [])];
  if (k.kind === 'manual') {
    if (!k.targetValue) throw badRequest('A manual key result needs a target value greater than zero');
    return { title: k.title, kind: k.kind, target: k.targetValue, current: k.currentValue ?? null, unit: k.unit ?? '', milestoneIds: [], projectIds: [] };
  }
  if (k.kind === 'milestone_completion' && !milestoneIds.length) throw badRequest('Link at least one milestone');
  if (k.kind === 'task_completion' && !milestoneIds.length && !projectIds.length) throw badRequest('Link at least one milestone or project');
  const pIds = k.kind === 'milestone_completion' ? [] : projectIds;
  const [m, p] = await Promise.all([
    one(db, `select count(*)::int n from milestones where id = any($1::uuid[])`, [milestoneIds]),
    one(db, `select count(*)::int n from projects where id = any($1::uuid[])`, [pIds]),
  ]);
  if (m.n !== milestoneIds.length || p.n !== pIds.length) throw badRequest('A linked milestone or project does not exist');
  return { title: k.title, kind: k.kind, target: null, current: null, unit: '', milestoneIds, projectIds: pIds };
}

const round3 = (v: number | null) => (v === null ? null : Math.round(v * 1000) / 1000);

/** Routes for the 'objectives' feature area. The basic /api/objectives list/create/patch in routes/projects.ts stays. */
export default async function (app: FastifyInstance) {
  // List with roll-up and forecast for every objective. All staff read; customers never.
  app.get('/api/objectives/overview', async (req) => tx(req, async (db, a) => {
    requireStaff(a);
    const { today, items } = await computeObjectives(db, a.tenantId);
    return {
      today, rules: OKR_RULES, permissions: { canCreate: canEdit(a) },
      items: items.map((it) => ({
        id: it.objective.id, title: it.objective.title, description: it.objective.description, status: it.objective.status, version: it.objective.version,
        owner_id: it.objective.owner_id, owner_name: it.objective.owner_name, period_start: it.objective.period_start, period_end: it.objective.period_end,
        progress: round3(it.progress.value), progressExplanation: it.progress.explanation, workBasis: it.work.basis,
        milestones: it.work.milestones, milestonesDone: it.work.milestonesDone, tasks: it.work.stats.tasks, tasksDone: it.work.stats.done,
        keyResults: it.keyResults.length,
        forecast: it.forecast ? { status: it.forecast.status, reasons: it.forecast.reasons, expected: round3(it.forecast.expected) } : null,
        latestCheckin: it.latestCheckin,
      })),
    };
  }));

  // Audited create (owner defaults to the creator).
  app.post('/api/objectives/create', async (req) => tx(req, async (db, a) => {
    if (!canEdit(a)) throw forbidden('Only leadership or a system admin can create objectives');
    const b = z.object({ title: z.string().trim().min(1).max(300), description: z.string().max(5000).default(''), ownerId: uuid.nullable().optional(),
      periodStart: date.nullable().optional(), periodEnd: date.nullable().optional() }).parse(req.body);
    checkPeriod(b.periodStart, b.periodEnd);
    const ownerId = b.ownerId ?? a.id;
    await assertStaffUser(db, ownerId);
    const o = await one(db, `insert into objectives (tenant_id, title, description, owner_id, period_start, period_end) values ($1,$2,$3,$4,$5,$6) returning *`,
      [a.tenantId, b.title, b.description, ownerId, b.periodStart ?? null, b.periodEnd ?? null]);
    await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'objective.created', resourceType: 'objective', resourceId: o.id, resourceVersion: o.version,
      details: { title: o.title, ownerId, periodStart: o.period_start, periodEnd: o.period_end } });
    if (ownerId !== a.id) await notify(db, a.tenantId, ownerId, 'objective_assigned', `You own the objective: ${o.title}`, `Set by ${a.name}.`, `/objectives/${o.id}`);
    return o;
  }));

  app.get('/api/objectives/:id', async (req) => tx(req, async (db, a) => {
    requireStaff(a);
    const o = await loadObjective(db, (req.params as any).id);
    const { today, items } = await computeObjectives(db, a.tenantId, { ids: [o.id] });
    const it = items[0];
    const visibleProjects = await visibleProjectIds(db, a, [...new Set([...it.milestones.map((m) => m.project_id), ...it.keyResults.flatMap((k) => k.project_ids)])]);
    const msIds = it.milestones.filter((m) => m.status !== 'cancelled').map((m) => m.id);
    const [vis, vp] = taskVisibility(a, 2);
    const [tasks, checkins, history, krMilestones, krProjects] = await Promise.all([
      many(db, `select t.id, t.number, t.title, t.status, t.estimate_minutes, t.due_date, t.accepted_at, t.milestone_id, t.owner_id, u.name owner_name
        from tasks t left join projects p on p.id = t.project_id left join users u on u.id = t.owner_id
        where t.milestone_id = any($1::uuid[]) and t.status <> 'cancelled' and ${vis}
        order by t.status = 'done', t.due_date nulls last, t.number limit 500`, [msIds, ...vp]),
      many(db, `select c.id, c.confidence, c.note, c.created_at, c.author_id, u.name author_name from objective_checkins c left join users u on u.id = c.author_id
        where c.objective_id = $1 order by c.created_at desc limit 100`, [o.id]),
      many(db, `select period_key, status, previous_status, progress, expected, reasons, notified, evaluated_at from objective_status_history
        where objective_id = $1 order by evaluated_at desc limit 26`, [o.id]),
      many(db, `select m.id, m.name, m.status, p.id project_id, p.key project_key from milestones m join projects p on p.id = m.project_id where m.id = any($1::uuid[])`,
        [[...new Set(it.keyResults.flatMap((k) => k.milestone_ids))]]),
      many(db, `select id, key, name from projects where id = any($1::uuid[])`, [[...new Set(it.keyResults.flatMap((k) => k.project_ids))]]),
    ]);
    const krVis = await visibleProjectIds(db, a, [...new Set([...krMilestones.map((m) => m.project_id), ...krProjects.map((p) => p.id)])]);
    const label = (m: any) => (krVis.has(m.project_id) ? `${m.project_key} · ${m.name}` : 'Milestone in a private project');
    const totalTasks = it.work.stats.tasks;
    return {
      today,
      objective: { ...o, owner_name: it.objective.owner_name },
      progress: { value: round3(it.progress.value), explanation: it.progress.explanation, parts: it.progress.parts.map((p) => ({ ...p, value: round3(p.value) })) },
      work: { value: round3(it.work.value), basis: it.work.basis, coverage: round3(it.work.coverage), explanation: it.work.explanation, stats: it.work.stats,
        milestones: it.work.milestones, milestonesDone: it.work.milestonesDone },
      keyResults: it.keyResults.map((k) => ({ ...k, progress: round3(k.progress),
        links: [...krMilestones.filter((m) => k.milestone_ids.includes(m.id)).map((m) => ({ type: 'milestone', id: m.id, label: label(m) })),
          ...krProjects.filter((p) => k.project_ids.includes(p.id)).map((p) => ({ type: 'project', id: p.id, label: krVis.has(p.id) ? `${p.key} · ${p.name}` : 'Private project' }))] })),
      forecast: it.forecast && { ...it.forecast, progress: round3(it.forecast.progress), expected: round3(it.forecast.expected), openEstimateCoverage: round3(it.forecast.openEstimateCoverage) },
      milestones: it.milestones.map((m) => visibleProjects.has(m.project_id)
        ? { id: m.id, name: m.name, due_date: m.due_date, status: m.status, project_id: m.project_id, project_key: m.project_key, project_name: m.project_name, stats: m.stats, restricted: false }
        : { id: m.id, name: 'Milestone in a private project', due_date: m.due_date, status: m.status, project_id: null, project_key: null, project_name: null, stats: m.stats, restricted: true }),
      tasks, hiddenTasks: Math.max(0, totalTasks - tasks.length),
      checkins, statusHistory: history,
      permissions: { canEdit: canEdit(a), canMaintain: canMaintain(a, o), canCheckIn: canMaintain(a, o) && o.status === 'active' },
    };
  }));

  // Edit with optimistic versioning (title, description, owner, period, lifecycle status).
  app.put('/api/objectives/:id', async (req) => tx(req, async (db, a) => {
    if (!canEdit(a)) throw forbidden('Only leadership or a system admin can edit objectives');
    const o = await loadObjective(db, (req.params as any).id);
    const b = z.object({ version: z.number().int(), title: z.string().trim().min(1).max(300).optional(), description: z.string().max(5000).optional(),
      ownerId: uuid.nullable().optional(), periodStart: date.nullable().optional(), periodEnd: date.nullable().optional(), status: z.enum(LIFECYCLE).optional(),
      reason: z.string().max(500).optional() }).parse(req.body);
    const next = {
      title: b.title ?? o.title, description: b.description ?? o.description, owner_id: 'ownerId' in b ? b.ownerId ?? null : o.owner_id,
      period_start: 'periodStart' in b ? b.periodStart ?? null : o.period_start, period_end: 'periodEnd' in b ? b.periodEnd ?? null : o.period_end, status: b.status ?? o.status,
    };
    checkPeriod(next.period_start, next.period_end);
    if (next.owner_id && next.owner_id !== o.owner_id) await assertStaffUser(db, next.owner_id);
    const r = await one(db, `update objectives set title = $3, description = $4, owner_id = $5, period_start = $6, period_end = $7, status = $8,
        version = version + 1, updated_at = now() where id = $1 and version = $2 returning *`,
      [o.id, b.version, next.title, next.description, next.owner_id, next.period_start, next.period_end, next.status]);
    if (!r) throw conflict('This objective was changed by someone else. Reload and try again.', { current: o });
    const changed = Object.fromEntries(Object.keys(next).filter((k) => (o as any)[k] !== (next as any)[k]).map((k) => [k, { from: (o as any)[k], to: (next as any)[k] }]));
    await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'objective.updated', resourceType: 'objective', resourceId: o.id, resourceVersion: r.version,
      reason: b.reason ?? null, details: { changed } });
    if (next.owner_id && next.owner_id !== o.owner_id && next.owner_id !== a.id)
      await notify(db, a.tenantId, next.owner_id, 'objective_assigned', `You now own the objective: ${r.title}`, `Changed by ${a.name}.`, `/objectives/${o.id}`);
    return r;
  }));

  // Milestones that can be linked: open milestones in projects the actor can see.
  app.get('/api/objectives/:id/milestone-options', async (req) => tx(req, async (db, a) => {
    if (!canEdit(a)) throw forbidden();
    const o = await loadObjective(db, (req.params as any).id);
    return many(db, `select m.id, m.name, m.due_date, m.objective_id, ob.title objective_title, p.key project_key, p.name project_name
      from milestones m join projects p on p.id = m.project_id left join objectives ob on ob.id = m.objective_id
      where m.status = 'open' and m.objective_id is distinct from $3 and p.status <> 'archived'
        and (p.visibility = 'company' or p.owner_id = $1 or exists (select 1 from project_members pm where pm.project_id = p.id and pm.user_id = $1) or $2::boolean)
      order by p.key, m.due_date nulls last, m.name`, [a.id, has(a, 'routine_admin'), o.id]);
  }));

  app.post('/api/objectives/:id/milestones', async (req) => tx(req, async (db, a) => {
    if (!canEdit(a)) throw forbidden('Only leadership or a system admin can link milestones');
    const o = await loadObjective(db, (req.params as any).id);
    const b = z.object({ milestoneId: uuid, move: z.boolean().optional() }).parse(req.body);
    const m = await one(db, `select m.*, ob.title objective_title from milestones m left join objectives ob on ob.id = m.objective_id where m.id = $1`, [b.milestoneId]);
    if (!m || !(await visibleProjectIds(db, a, [m.project_id])).has(m.project_id)) throw notFound('Milestone not found');
    if (m.objective_id === o.id) return { ok: true, unchanged: true };
    if (m.objective_id && !b.move) throw conflict(`This milestone is linked to "${m.objective_title}". Confirm to move it to this objective.`, { objectiveId: m.objective_id, objectiveTitle: m.objective_title });
    await db.query(`update milestones set objective_id = $2 where id = $1`, [m.id, o.id]);
    await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'objective.milestone_linked', resourceType: 'objective', resourceId: o.id,
      details: { milestoneId: m.id, milestone: m.name, movedFrom: m.objective_id ?? null } });
    return { ok: true };
  }));

  app.delete('/api/objectives/:id/milestones/:milestoneId', async (req) => tx(req, async (db, a) => {
    if (!canEdit(a)) throw forbidden('Only leadership or a system admin can unlink milestones');
    const o = await loadObjective(db, (req.params as any).id);
    const mid = uuid.parse((req.params as any).milestoneId);
    const r = await one(db, `update milestones set objective_id = null where id = $1 and objective_id = $2 returning id, name`, [mid, o.id]);
    if (!r) throw notFound('That milestone is not linked to this objective');
    await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'objective.milestone_unlinked', resourceType: 'objective', resourceId: o.id, details: { milestoneId: r.id, milestone: r.name } });
    return { ok: true };
  }));

  // Key results: owner or editors.
  app.post('/api/objectives/:id/key-results', async (req) => tx(req, async (db, a) => {
    requireStaff(a);
    const o = await loadObjective(db, (req.params as any).id);
    if (!canMaintain(a, o)) throw forbidden('Only the objective owner, leadership or a system admin can change key results');
    const k = await normalizeKr(db, krSchema.parse(req.body));
    await assertVisibleLinks(db, a, k.milestoneIds, k.projectIds);
    const r = await one(db, `insert into objective_key_results (tenant_id, objective_id, title, kind, target_value, current_value, unit, milestone_ids, project_ids, position, created_by, updated_by)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,(select coalesce(max(position), -1) + 1 from objective_key_results where objective_id = $2),$10,$10) returning *`,
      [a.tenantId, o.id, k.title, k.kind, k.target, k.current, k.unit, k.milestoneIds, k.projectIds, a.id]);
    await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'objective.key_result_created', resourceType: 'objective_key_result', resourceId: r.id, resourceVersion: r.version,
      details: { objectiveId: o.id, title: r.title, kind: r.kind, target: r.target_value, current: r.current_value } });
    return r;
  }));

  app.patch('/api/objectives/:id/key-results/:krId', async (req) => tx(req, async (db, a) => {
    requireStaff(a);
    const o = await loadObjective(db, (req.params as any).id);
    if (!canMaintain(a, o)) throw forbidden('Only the objective owner, leadership or a system admin can change key results');
    const kr = await one(db, `select * from objective_key_results where id = $1 and objective_id = $2`, [uuid.parse((req.params as any).krId), o.id]);
    if (!kr) throw notFound('Key result not found');
    const b = krSchema.partial().extend({ version: z.number().int() }).parse(req.body);
    const k = await normalizeKr(db, {
      title: b.title ?? kr.title, kind: b.kind ?? kr.kind, unit: b.unit ?? kr.unit,
      targetValue: 'targetValue' in b ? b.targetValue : kr.target_value, currentValue: 'currentValue' in b ? b.currentValue : kr.current_value,
      milestoneIds: b.milestoneIds ?? kr.milestone_ids, projectIds: b.projectIds ?? kr.project_ids,
    });
    await assertVisibleLinks(db, a, k.milestoneIds.filter((x) => !kr.milestone_ids.includes(x)), k.projectIds.filter((x) => !kr.project_ids.includes(x)));
    const r = await one(db, `update objective_key_results set title = $3, kind = $4, target_value = $5, current_value = $6, unit = $7, milestone_ids = $8, project_ids = $9,
        version = version + 1, updated_by = $10, updated_at = now() where id = $1 and version = $2 returning *`,
      [kr.id, b.version, k.title, k.kind, k.target, k.current, k.unit, k.milestoneIds, k.projectIds, a.id]);
    if (!r) throw conflict('This key result was changed by someone else. Reload and try again.');
    await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'objective.key_result_updated', resourceType: 'objective_key_result', resourceId: r.id, resourceVersion: r.version,
      details: { objectiveId: o.id, from: { title: kr.title, kind: kr.kind, target: kr.target_value, current: kr.current_value }, to: { title: r.title, kind: r.kind, target: r.target_value, current: r.current_value } } });
    return r;
  }));

  app.delete('/api/objectives/:id/key-results/:krId', async (req) => tx(req, async (db, a) => {
    requireStaff(a);
    const o = await loadObjective(db, (req.params as any).id);
    if (!canMaintain(a, o)) throw forbidden('Only the objective owner, leadership or a system admin can change key results');
    const r = await one(db, `delete from objective_key_results where id = $1 and objective_id = $2 returning id, title, kind, target_value, current_value`, [uuid.parse((req.params as any).krId), o.id]);
    if (!r) throw notFound('Key result not found');
    await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'objective.key_result_deleted', resourceType: 'objective_key_result', resourceId: r.id, details: { objectiveId: o.id, ...r } });
    return { ok: true };
  }));

  // Check-ins: owner or editors; idempotent per client key.
  app.post('/api/objectives/:id/checkins', async (req) => tx(req, async (db, a) => {
    requireStaff(a);
    const o = await loadObjective(db, (req.params as any).id);
    if (!canMaintain(a, o)) throw forbidden('Only the objective owner, leadership or a system admin can post check-ins');
    if (o.status !== 'active') throw badRequest('Check-ins are only for active objectives');
    const b = z.object({ confidence: z.number().int().min(1).max(5), note: z.string().trim().max(4000).default(''), idempotencyKey: z.string().min(8).max(100).optional() }).parse(req.body);
    let c = await one(db, `insert into objective_checkins (tenant_id, objective_id, author_id, confidence, note, idempotency_key) values ($1,$2,$3,$4,$5,$6)
        on conflict (objective_id, idempotency_key) where idempotency_key is not null do nothing returning *`, [a.tenantId, o.id, a.id, b.confidence, b.note, b.idempotencyKey ?? null]);
    if (!c) return { ...(await one(db, `select * from objective_checkins where objective_id = $1 and idempotency_key = $2`, [o.id, b.idempotencyKey])), duplicate: true };
    await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'objective.checkin', resourceType: 'objective', resourceId: o.id, details: { checkinId: c.id, confidence: c.confidence } });
    c = { ...c, author_name: a.name };
    return c;
  }));
}
