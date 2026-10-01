import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tx } from '../app.js';
import { many, one } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { readStored, storeFile } from '../lib/storage.js';
import { assertContribute, canSeeRestrictedEvidence, has, isStaff, loadVisibleTask, requireStaff, taskVisibility } from '../services/access.js';
import { CATEGORIES, PRIORITIES, STATUSES, createTask, parseQuickCapture, reassignTask, reopenTask, reviewTask, transition, updateTask } from '../services/tasks.js';
import { setPlan } from '../services/myday.js';
import { localToday } from '../services/calendar.js';
import { notify } from '../services/notify.js';

const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const createSchema = z.object({
  title: z.string().trim().min(1).max(300), description: z.string().max(20000).optional(), ownerId: uuid.optional(),
  projectId: uuid.nullable().optional(), milestoneId: uuid.nullable().optional(), status: z.enum(['backlog', 'planned', 'in_progress']).optional(),
  priority: z.enum(PRIORITIES).optional(), category: z.enum(CATEGORIES).optional(), dueDate: date.nullable().optional(),
  estimateMinutes: z.number().int().min(1).max(100000).nullable().optional(), tags: z.array(z.string().max(40)).max(20).optional(),
  acceptanceCriteria: z.string().max(5000).optional(), requiresReview: z.boolean().optional(), requiresEvidence: z.boolean().optional(),
  reviewerId: uuid.nullable().optional(), customerVisible: z.boolean().optional(), collaboratorIds: z.array(uuid).max(20).optional(),
  checklist: z.array(z.string().max(300)).max(50).optional(), addToMyDay: z.boolean().optional(), sourceType: z.enum(['manual', 'quick_capture', 'ai_draft']).optional(),
  captureMs: z.number().int().min(0).max(600000).optional(),
});

export async function taskRoutes(app: FastifyInstance) {
  app.get('/api/users', async (req) => tx(req, async (db, a) => {
    requireStaff(a);
    return many(db, `select u.id, u.name, u.email, u.title, u.department_id, d.name department, u.is_founder from users u left join departments d on d.id = u.department_id
      where u.status = 'active' and not ('customer' = any(u.roles)) order by u.name`);
  }));

  app.post('/api/tasks/parse', async (req) => tx(req, async (db, a) => {
    const { text } = z.object({ text: z.string().min(1).max(500) }).parse(req.body);
    const p = parseQuickCapture(text, localToday(a.timezone));
    const project = p.projectKey ? await one(db, `select id, key, name from projects where key = $1 and status <> 'archived'`, [p.projectKey]) : null;
    const owner = p.ownerHint ? await one(db, `select id, name from users where status = 'active' and not ('customer' = any(roles))
      and (lower(split_part(email, '@', 1)) = $1 or lower(split_part(name, ' ', 1)) = $1 or lower(replace(name, ' ', '.')) = $1) limit 1`, [p.ownerHint]) : null;
    return { ...p, project, owner, warnings: [
      ...(p.projectKey && !project ? [`No project with key ${p.projectKey}`] : []),
      ...(p.ownerHint && !owner ? [`No teammate matches @${p.ownerHint}`] : []),
      ...(!p.title ? ['Add a short title'] : []),
    ] };
  }));

  app.get('/api/tasks', async (req) => tx(req, async (db, a) => {
    const q = z.object({
      status: z.string().optional(), projectId: uuid.optional(), ownerId: z.string().optional(), q: z.string().max(200).optional(),
      due: z.enum(['overdue', 'today', 'week', 'none']).optional(), priority: z.string().optional(), category: z.string().optional(),
      mine: z.enum(['1', '0']).optional(), includeDone: z.enum(['1', '0']).optional(), limit: z.coerce.number().int().min(1).max(500).default(300),
      milestoneId: uuid.optional(), tag: z.string().optional(),
    }).parse(req.query);
    const [vis, params] = taskVisibility(a, 1);
    const where = [vis]; const vals: unknown[] = [...params];
    const add = (sql: string, v: unknown) => { vals.push(v); where.push(sql.replace('$?', `$${vals.length}`)); };
    if (q.status) add(`t.status = any($?::text[])`, q.status.split(','));
    else if (q.includeDone !== '1') where.push(`(t.status not in ('done','cancelled') or t.updated_at > now() - interval '7 days')`);
    if (q.projectId) add(`t.project_id = $?`, q.projectId);
    if (q.milestoneId) add(`t.milestone_id = $?`, q.milestoneId);
    if (q.mine === '1') add(`(t.owner_id = $? or exists (select 1 from task_collaborators c where c.task_id = t.id and c.user_id = $?))`.replace('$?', `$${vals.length + 1}`), a.id);
    if (q.ownerId) add(`t.owner_id = any($?::uuid[])`, q.ownerId.split(','));
    if (q.priority) add(`t.priority = any($?::text[])`, q.priority.split(','));
    if (q.category) add(`t.category = any($?::text[])`, q.category.split(','));
    if (q.tag) add(`$? = any(t.tags)`, q.tag);
    if (q.q) add(`(to_tsvector('simple', t.title || ' ' || t.description) @@ plainto_tsquery('simple', $?) or t.title ilike '%' || $? || '%')`.replace(/\$\?/g, `$${vals.length + 1}`), q.q);
    const today = localToday(a.timezone);
    if (q.due === 'overdue') add(`t.due_date < $? and t.status not in ('done','cancelled')`, today);
    if (q.due === 'today') add(`t.due_date = $?`, today);
    if (q.due === 'week') add(`t.due_date between $? and ($?::date + 7)`.replace(/\$\?/g, `$${vals.length + 1}`), today);
    if (q.due === 'none') where.push('t.due_date is null');
    vals.push(q.limit);
    const customer = has(a, 'customer');
    return many(db, `select t.id, t.number, t.title, t.status, t.priority, t.category, t.due_date, t.estimate_minutes, t.tags, t.version, t.sort_order,
        t.owner_id, ${customer ? 'null' : 'u.name'} owner_name, t.project_id, p.name project_name, p.key project_key, t.milestone_id, t.requires_review, t.requires_evidence,
        t.reopen_count, t.source_type, t.updated_at, t.created_at, t.done_at, t.customer_visible,
        (select count(*) from checklist_items c where c.task_id = t.id)::int checklist_total,
        (select count(*) from checklist_items c where c.task_id = t.id and c.done)::int checklist_done,
        (select count(*) from task_dependencies d join tasks dt on dt.id = d.depends_on_task_id where d.task_id = t.id and dt.status not in ('done','cancelled'))::int open_dependencies,
        (select b.reason from blockers b where b.task_id = t.id and b.resolved_at is null order by b.raised_at desc limit 1) blocker_reason
      from tasks t left join projects p on p.id = t.project_id left join users u on u.id = t.owner_id
      where ${where.join(' and ')}
      order by t.sort_order desc, t.created_at desc limit $${vals.length}`, vals);
  }));

  app.post('/api/tasks', async (req) => tx(req, async (db, a) => {
    const b = createSchema.parse(req.body);
    const r = await createTask(db, a, a.tenantId, { ...b, sourceType: b.sourceType ?? 'manual' }, { correlationId: req.id });
    if (b.addToMyDay) {
      const today = localToday(a.timezone);
      const plan = await one(db, `select dp.id, (select array_agg(task_id order by position) from daily_plan_items where plan_id = dp.id and removed_at is null) ids
        from daily_plans dp where user_id = $1 and date = $2`, [a.id, today]);
      const ids: string[] = plan?.ids ?? [];
      if (ids.length >= 3) return { ...r.task, planFull: true };
      await setPlan(db, a, today, [...ids, r.task.id]);
    }
    if (b.captureMs) await db.query(`insert into ux_timings (tenant_id, user_id, flow, duration_ms, date) values ($1,$2,'quick_capture',$3,$4)`, [a.tenantId, a.id, b.captureMs, localToday(a.timezone)]);
    return r.task;
  }));

  app.get('/api/tasks/:id', async (req) => tx(req, async (db, a) => {
    const t = await loadVisibleTask(db, a, (req.params as any).id);
    if (has(a, 'customer')) {
      return { task: { id: t.id, title: t.title, status: t.status, due_date: t.due_date, accepted_at: t.accepted_at, project_id: t.project_id }, customerView: true };
    }
    const [owner, reviewer, project, milestone, checklist, deps, dependents, collaborators, evidence, blockers, comments, history, reviews, time] = await Promise.all([
      one(db, `select id, name from users where id = $1`, [t.owner_id]),
      t.reviewer_id ? one(db, `select id, name from users where id = $1`, [t.reviewer_id]) : null,
      t.project_id ? one(db, `select id, key, name, visibility, customer_id from projects where id = $1`, [t.project_id]) : null,
      t.milestone_id ? one(db, `select id, name, due_date from milestones where id = $1`, [t.milestone_id]) : null,
      many(db, `select * from checklist_items where task_id = $1 order by position, id`, [t.id]),
      many(db, `select dt.id, dt.title, dt.status, dt.number from task_dependencies d join tasks dt on dt.id = d.depends_on_task_id where d.task_id = $1`, [t.id]),
      many(db, `select dt.id, dt.title, dt.status, dt.number from task_dependencies d join tasks dt on dt.id = d.task_id where d.depends_on_task_id = $1`, [t.id]),
      many(db, `select u.id, u.name from task_collaborators c join users u on u.id = c.user_id where c.task_id = $1`, [t.id]),
      many(db, `select e.*, u.name added_by_name, f.filename, f.size_bytes from evidence_links e left join users u on u.id = e.added_by left join stored_files f on f.id = e.file_id
        where e.task_id = $1 order by e.created_at`, [t.id]),
      many(db, `select b.*, u.name raised_by_name, w.name waiting_on_name, r.name resolved_by_name from blockers b left join users u on u.id = b.raised_by
        left join users w on w.id = b.waiting_on_user_id left join users r on r.id = b.resolved_by where b.task_id = $1 order by b.raised_at desc`, [t.id]),
      many(db, `select c.*, u.name author_name from comments c left join users u on u.id = c.author_id where c.task_id = $1 order by c.created_at`, [t.id]),
      many(db, `select h.*, u.name actor_name from task_state_history h left join users u on u.id = h.actor_id where h.task_id = $1 order by h.at, h.id`, [t.id]),
      many(db, `select r.*, u.name reviewer_name from task_reviews r join users u on u.id = r.reviewer_id where r.task_id = $1 order by r.created_at`, [t.id]),
      many(db, `select te.id, te.started_at, te.ended_at, te.source, te.category, te.user_id, u.name user_name from time_entries te join users u on u.id = te.user_id
        where te.task_id = $1 and te.deleted_at is null order by te.started_at desc limit 50`, [t.id]),
    ]);
    const visibleEvidence = evidence.map((e) => canSeeRestrictedEvidence(a, e, t) ? e
      : { id: e.id, kind: e.kind, label: 'Restricted reference', restricted: true, source_module: e.source_module, created_at: e.created_at, hidden: true });
    const { project_owner_id, project_customer_id, ...task } = t;
    return { task, owner, reviewer, project, milestone, checklist, dependencies: deps, dependents, collaborators, evidence: visibleEvidence, blockers, comments,
      history, reviews, time, canEdit: await canEditCheck(db, a, t) };
  }));
  async function canEditCheck(db: any, a: any, t: any) { try { await assertContribute(db, a, t); return true; } catch { return false; } }

  app.patch('/api/tasks/:id', async (req) => tx(req, async (db, a) => {
    const t = await loadVisibleTask(db, a, (req.params as any).id);
    const b = createSchema.partial().omit({ ownerId: true, status: true, collaboratorIds: true, checklist: true, addToMyDay: true }).extend({
      version: z.number().int(), sortOrder: z.number().optional(), scopeNote: z.string().max(500).optional(),
    }).parse(req.body);
    const { version, ...patch } = b;
    return updateTask(db, a, t, patch, version, req.id);
  }));

  app.post('/api/tasks/:id/status', async (req) => tx(req, async (db, a) => {
    const t = await loadVisibleTask(db, a, (req.params as any).id);
    const b = z.object({
      to: z.enum(STATUSES), version: z.number().int().optional(), reason: z.string().max(1000).optional(), resolution: z.string().max(1000).optional(),
      blocker: z.object({ reason: z.string().min(1).max(1000), cause: z.enum(['dependency', 'client', 'requirement', 'access', 'technical', 'capacity', 'other']).optional(),
        waitingOnUserId: uuid.nullable().optional(), waitingOnText: z.string().max(200).optional(), nextFollowUp: date.nullable().optional() }).optional(),
      elapsedMs: z.number().int().min(0).max(600000).optional(),
    }).parse(req.body);
    const row = await transition(db, a, t, b.to, { ...b, correlationId: req.id });
    if (b.elapsedMs) await db.query(`insert into ux_timings (tenant_id, user_id, flow, duration_ms, date) values ($1,$2,'status_update',$3,$4)`, [a.tenantId, a.id, b.elapsedMs, localToday(a.timezone)]);
    return row;
  }));
  app.post('/api/tasks/:id/review', async (req) => tx(req, async (db, a) => {
    const t = await loadVisibleTask(db, a, (req.params as any).id);
    const b = z.object({ decision: z.enum(['accepted', 'changes_requested']), note: z.string().max(2000).default('') }).parse(req.body);
    return reviewTask(db, a, t, b.decision, b.note, req.id);
  }));
  app.post('/api/tasks/:id/reopen', async (req) => tx(req, async (db, a) => {
    const t = await loadVisibleTask(db, a, (req.params as any).id);
    return reopenTask(db, a, t, z.object({ reason: z.string().min(1).max(1000) }).parse(req.body).reason, req.id);
  }));
  app.post('/api/tasks/:id/reassign', async (req) => tx(req, async (db, a) => {
    const t = await loadVisibleTask(db, a, (req.params as any).id);
    const b = z.object({ ownerId: uuid, reason: z.string().min(1).max(1000) }).parse(req.body);
    return reassignTask(db, a, t, b.ownerId, b.reason, req.id);
  }));
  app.post('/api/blockers/:id/follow-up', async (req) => tx(req, async (db, a) => {
    const b = z.object({ nextFollowUp: date, note: z.string().max(1000).optional() }).parse(req.body);
    const bl = await one(db, `select * from blockers where id = $1 and resolved_at is null`, [(req.params as any).id]);
    if (!bl) throw notFound('Open blocker not found');
    const t = await loadVisibleTask(db, a, bl.task_id);
    await assertContribute(db, a, t);
    await db.query(`update blockers set next_follow_up = $2 where id = $1`, [bl.id, b.nextFollowUp]);
    if (b.note) await db.query(`insert into comments (tenant_id, task_id, author_id, body) values ($1,$2,$3,$4)`, [a.tenantId, t.id, a.id, `Blocker follow-up: ${b.note}`]);
    await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'blocker.follow_up', resourceType: 'blocker', resourceId: bl.id, details: { next: b.nextFollowUp } });
    return { ok: true };
  }));

  app.post('/api/tasks/:id/comments', async (req) => tx(req, async (db, a) => {
    const t = await loadVisibleTask(db, a, (req.params as any).id);
    requireStaff(a);
    const { body } = z.object({ body: z.string().trim().min(1).max(10000) }).parse(req.body);
    const c = await one(db, `insert into comments (tenant_id, task_id, author_id, body) values ($1,$2,$3,$4) returning *`, [a.tenantId, t.id, a.id, body]);
    if (t.owner_id !== a.id) await notify(db, a.tenantId, t.owner_id, 'comment', `${a.name} commented on "${t.title}"`, body.slice(0, 200), `/tasks/${t.id}`);
    return c;
  }));

  // Evidence: link, restricted source reference, or private file upload.
  app.post('/api/tasks/:id/evidence', async (req) => tx(req, async (db, a) => {
    const t = await loadVisibleTask(db, a, (req.params as any).id);
    await assertContribute(db, a, t);
    if (req.isMultipart()) {
      const file = await req.file();
      if (!file) throw badRequest('No file');
      const buf = await file.toBuffer();
      if (file.file.truncated) throw badRequest('File is larger than 15 MB');
      const label = (file.fields as any).label?.value || file.filename;
      const stored = await storeFile(db, a.tenantId, buf, file.filename, file.mimetype || 'application/octet-stream', 'evidence', a.id);
      const e = await one(db, `insert into evidence_links (tenant_id, task_id, kind, label, file_id, added_by) values ($1,$2,'file',$3,$4,$5) returning *`,
        [a.tenantId, t.id, String(label).slice(0, 200), stored.id, a.id]);
      await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'evidence.add', resourceType: 'task', resourceId: t.id, details: { kind: 'file', size: buf.length } });
      return e;
    }
    const b = z.object({ label: z.string().min(1).max(200), url: z.string().url().refine((u) => /^https?:\/\//i.test(u), 'Only http(s) links').optional(),
      sourceModule: z.string().max(40).optional(), sourceReference: z.string().max(200).optional(), restricted: z.boolean().optional() }).parse(req.body);
    if (!b.url && !b.sourceReference) throw badRequest('Provide a link or a source reference');
    const e = await one(db, `insert into evidence_links (tenant_id, task_id, kind, label, url, source_module, source_reference, restricted, allowed_user_ids, added_by)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
      [a.tenantId, t.id, b.url ? 'link' : 'source_ref', b.label, b.url ?? null, b.sourceModule ?? null, b.sourceReference ?? null, b.restricted ?? false, [a.id, t.owner_id], a.id]);
    await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'evidence.add', resourceType: 'task', resourceId: t.id, details: { kind: e.kind, restricted: e.restricted } });
    return e;
  }));
  app.get('/api/evidence/:id/file', async (req, reply) => {
    const out = await tx(req, async (db, a) => {
      const e = await one(db, `select * from evidence_links where id = $1 and kind = 'file'`, [(req.params as any).id]);
      if (!e) throw notFound();
      const t = await loadVisibleTask(db, a, e.task_id);
      if (!canSeeRestrictedEvidence(a, e, t) || has(a, 'customer')) throw forbidden();
      const f = await one(db, `select * from stored_files where id = $1`, [e.file_id]);
      return { f, data: await readStored(f) };
    });
    reply.header('content-type', out.f.mime).header('content-disposition', `attachment; filename="${out.f.filename}"`);
    return reply.send(out.data);
  });
  // Evidence is never silently removed: only the person who added it can withdraw it, and the audit trail keeps the record.
  app.delete('/api/evidence/:id', async (req) => tx(req, async (db, a) => {
    const e = await one(db, `select * from evidence_links where id = $1`, [(req.params as any).id]);
    if (!e) throw notFound();
    if (e.added_by !== a.id) throw forbidden('Only the person who added evidence can withdraw it');
    const t = await one(db, `select status from tasks where id = $1`, [e.task_id]);
    if (t.status === 'done') throw badRequest('Evidence on an accepted task cannot be withdrawn — reopen the task first');
    await db.query(`delete from evidence_links where id = $1`, [e.id]);
    await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'evidence.withdraw', resourceType: 'task', resourceId: e.task_id, details: { label: e.label } });
    return { ok: true };
  }));

  // Checklist
  app.post('/api/tasks/:id/checklist', async (req) => tx(req, async (db, a) => {
    const t = await loadVisibleTask(db, a, (req.params as any).id); await assertContribute(db, a, t);
    const { text } = z.object({ text: z.string().trim().min(1).max(300) }).parse(req.body);
    return one(db, `insert into checklist_items (tenant_id, task_id, text, position) values ($1,$2,$3,(select coalesce(max(position),0)+1 from checklist_items where task_id = $2)) returning *`, [a.tenantId, t.id, text]);
  }));
  app.patch('/api/checklist/:id', async (req) => tx(req, async (db, a) => {
    const item = await one(db, `select * from checklist_items where id = $1`, [(req.params as any).id]);
    if (!item) throw notFound();
    const t = await loadVisibleTask(db, a, item.task_id); await assertContribute(db, a, t);
    const b = z.object({ done: z.boolean().optional(), text: z.string().trim().min(1).max(300).optional() }).parse(req.body);
    return one(db, `update checklist_items set done = coalesce($2, done), text = coalesce($3, text),
      done_by = case when $2 then $4 else null end, done_at = case when $2 then now() else null end where id = $1 returning *`, [item.id, b.done ?? null, b.text ?? null, a.id]);
  }));
  app.delete('/api/checklist/:id', async (req) => tx(req, async (db, a) => {
    const item = await one(db, `select * from checklist_items where id = $1`, [(req.params as any).id]);
    if (!item) throw notFound();
    const t = await loadVisibleTask(db, a, item.task_id); await assertContribute(db, a, t);
    await db.query(`delete from checklist_items where id = $1`, [item.id]);
    return { ok: true };
  }));

  // Dependencies (cycle-checked)
  app.post('/api/tasks/:id/dependencies', async (req) => tx(req, async (db, a) => {
    const t = await loadVisibleTask(db, a, (req.params as any).id); await assertContribute(db, a, t);
    const { dependsOnTaskId } = z.object({ dependsOnTaskId: uuid }).parse(req.body);
    await loadVisibleTask(db, a, dependsOnTaskId);
    const cycle = await one(db, `with recursive chain(id) as (select depends_on_task_id from task_dependencies where task_id = $1
      union select d.depends_on_task_id from task_dependencies d join chain c on d.task_id = c.id) select 1 from chain where id = $2`, [dependsOnTaskId, t.id]);
    if (cycle || dependsOnTaskId === t.id) throw badRequest('That would create a circular dependency');
    await db.query(`insert into task_dependencies (tenant_id, task_id, depends_on_task_id) values ($1,$2,$3) on conflict do nothing`, [a.tenantId, t.id, dependsOnTaskId]);
    return { ok: true };
  }));
  app.delete('/api/tasks/:id/dependencies/:dep', async (req) => tx(req, async (db, a) => {
    const t = await loadVisibleTask(db, a, (req.params as any).id); await assertContribute(db, a, t);
    await db.query(`delete from task_dependencies where task_id = $1 and depends_on_task_id = $2`, [t.id, (req.params as any).dep]);
    return { ok: true };
  }));
  app.post('/api/tasks/:id/collaborators', async (req) => tx(req, async (db, a) => {
    const t = await loadVisibleTask(db, a, (req.params as any).id); await assertContribute(db, a, t);
    const { userId } = z.object({ userId: uuid }).parse(req.body);
    if (userId === t.owner_id) throw badRequest('The owner is already accountable for this task');
    await db.query(`insert into task_collaborators (tenant_id, task_id, user_id) values ($1,$2,$3) on conflict do nothing`, [a.tenantId, t.id, userId]);
    await notify(db, a.tenantId, userId, 'collaborator', `Added as collaborator: ${t.title}`, `By ${a.name}`, `/tasks/${t.id}`);
    return { ok: true };
  }));
  app.delete('/api/tasks/:id/collaborators/:uid', async (req) => tx(req, async (db, a) => {
    const t = await loadVisibleTask(db, a, (req.params as any).id); await assertContribute(db, a, t);
    await db.query(`delete from task_collaborators where task_id = $1 and user_id = $2`, [t.id, (req.params as any).uid]);
    return { ok: true };
  }));

  // Permission-scoped search across tasks and projects
  app.get('/api/search', async (req) => tx(req, async (db, a) => {
    const { q } = z.object({ q: z.string().min(1).max(200) }).parse(req.query);
    const [vis, params] = taskVisibility(a, 2);
    const tasks = await many(db, `select t.id, t.number, t.title, t.status, p.key project_key from tasks t left join projects p on p.id = t.project_id
      where ${vis} and (t.title ilike '%' || $1 || '%' or to_tsvector('simple', t.title || ' ' || t.description) @@ plainto_tsquery('simple', $1) or t.number::text = $1)
      order by (t.status in ('done','cancelled')), t.updated_at desc limit 12`, [q, ...params]);
    const projects = isStaff(a) ? await many(db, `select p.id, p.key, p.name from projects p where (p.name ilike '%' || $1 || '%' or p.key ilike $1 || '%')
      and (p.visibility = 'company' or p.owner_id = $2 or exists (select 1 from project_members m where m.project_id = p.id and m.user_id = $2) or $3::boolean) limit 6`,
      [q, a.id, has(a, 'routine_admin')]) : [];
    return { tasks, projects };
  }));

  // Saved filters
  app.get('/api/saved-filters', async (req) => tx(req, (db, a) => many(db, `select * from saved_filters where user_id = $1 order by created_at`, [a.id])));
  app.post('/api/saved-filters', async (req) => tx(req, async (db, a) => {
    const b = z.object({ name: z.string().min(1).max(60), view: z.enum(['list', 'board']), query: z.record(z.string(), z.string()) }).parse(req.body);
    return one(db, `insert into saved_filters (tenant_id, user_id, name, view, query) values ($1,$2,$3,$4,$5) returning *`, [a.tenantId, a.id, b.name, b.view, b.query]);
  }));
  app.delete('/api/saved-filters/:id', async (req) => tx(req, async (db, a) => {
    await db.query(`delete from saved_filters where id = $1 and user_id = $2`, [(req.params as any).id, a.id]); return { ok: true };
  }));

  // Recurring templates
  app.get('/api/recurring', async (req) => tx(req, async (db, a) => {
    requireStaff(a);
    return many(db, `select r.*, u.name owner_name, p.name project_name from recurring_templates r join users u on u.id = r.owner_id left join projects p on p.id = r.project_id
      where r.owner_id = $1 or r.created_by = $1 or r.owner_id = any($2::uuid[]) or $3::boolean order by r.title`, [a.id, a.managedUserIds, has(a, 'routine_admin')]);
  }));
  const recurringSchema = z.object({
    title: z.string().min(1).max(300), description: z.string().max(5000).default(''), projectId: uuid.nullable().optional(), ownerId: uuid.optional(),
    category: z.enum(CATEGORIES).default('admin'), priority: z.enum(PRIORITIES).default('medium'), estimateMinutes: z.number().int().min(1).max(10000).nullable().optional(),
    checklist: z.array(z.string().max(300)).max(30).default([]), rule: z.enum(['daily', 'weekdays', 'weekly', 'monthly']),
    weekday: z.number().int().min(1).max(7).nullable().optional(), monthDay: z.number().int().min(1).max(28).nullable().optional(), active: z.boolean().default(true),
  });
  app.post('/api/recurring', async (req) => tx(req, async (db, a) => {
    requireStaff(a);
    const b = recurringSchema.parse(req.body);
    const owner = b.ownerId ?? a.id;
    if (owner !== a.id && !a.managedUserIds.includes(owner) && !has(a, 'routine_admin')) throw forbidden('You can create recurring work for yourself or your team');
    const r = await one(db, `insert into recurring_templates (tenant_id, title, description, project_id, owner_id, category, priority, estimate_minutes, checklist, rule, weekday, month_day, active, created_by, last_generated_date)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, $15::date - 1) returning *`,
      [a.tenantId, b.title, b.description, b.projectId ?? null, owner, b.category, b.priority, b.estimateMinutes ?? null, JSON.stringify(b.checklist), b.rule, b.weekday ?? null, b.monthDay ?? null, b.active, a.id, localToday(a.timezone)]);
    const { enqueue } = await import('../lib/jobs.js');
    await enqueue(db, { tenantId: a.tenantId, kind: 'recurring.generate', payload: {} });
    await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'recurring.create', resourceType: 'recurring_template', resourceId: r.id });
    return r;
  }));
  app.patch('/api/recurring/:id', async (req) => tx(req, async (db, a) => {
    const cur = await one(db, `select * from recurring_templates where id = $1`, [(req.params as any).id]);
    if (!cur) throw notFound();
    if (![cur.owner_id, cur.created_by].includes(a.id) && !a.managedUserIds.includes(cur.owner_id) && !has(a, 'routine_admin')) throw forbidden();
    const b = recurringSchema.partial().parse(req.body);
    return one(db, `update recurring_templates set title = coalesce($2,title), description = coalesce($3,description), rule = coalesce($4,rule),
      weekday = coalesce($5,weekday), month_day = coalesce($6,month_day), active = coalesce($7,active), estimate_minutes = coalesce($8, estimate_minutes),
      priority = coalesce($9, priority), category = coalesce($10, category) where id = $1 returning *`,
      [cur.id, b.title ?? null, b.description ?? null, b.rule ?? null, b.weekday ?? null, b.monthDay ?? null, b.active ?? null, b.estimateMinutes ?? null, b.priority ?? null, b.category ?? null]);
  }));
}
