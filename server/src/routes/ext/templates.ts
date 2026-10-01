import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tx } from '../../app.js';
import { many, one } from '../../lib/db.js';
import { forbidden, notFound } from '../../lib/errors.js';
import { has, requireStaff } from '../../services/access.js';
import {
  TEMPLATE_CATEGORIES, appliedTasks, applySchema, applyTemplate, assignableUsers, canEdit, canPublish, computePlan, createTemplate,
  duplicateTemplate, ensureStarterTemplates, fromProjectSchema, itemsOf, loadTemplate, loadVisibleProject, previewSchema, setArchived,
  templateFromProject, templateSchema, updateSchema, updateTemplate,
} from '../../services/ext/templates.js';

const uuid = z.string().uuid();
const idParam = z.object({ id: uuid });

/** Routes for the 'templates' feature area: reusable task playbooks. */
export default async function (app: FastifyInstance) {
  app.get('/api/templates', async (req) => tx(req, async (db, a) => {
    requireStaff(a);
    const q = z.object({ q: z.string().trim().max(100).optional(), category: z.enum(TEMPLATE_CATEGORIES).optional(), archived: z.enum(['0', '1']).optional() }).parse(req.query);
    await ensureStarterTemplates(db, a.tenantId, a.id);
    const like = q.q ? `%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
    const rows = await many(db, `select t.id, t.name, t.description, t.category, t.visibility, t.is_starter, t.version, t.created_by, t.archived_at, t.updated_at,
        u.name created_by_name,
        (select count(*) from task_template_items i where i.template_id = t.id)::int item_count,
        (select coalesce(sum(i.estimate_minutes), 0) from task_template_items i where i.template_id = t.id)::int total_estimate_minutes,
        (select max(i.due_offset_days) from task_template_items i where i.template_id = t.id) span_days,
        (select count(*) from task_template_applications ap where ap.template_id = t.id)::int times_applied,
        (select max(ap.created_at) from task_template_applications ap where ap.template_id = t.id) last_applied_at
      from task_templates t left join users u on u.id = t.created_by
      where (t.visibility = 'company' or t.created_by = $1)
        and ($2::text is null or t.category = $2)
        and ($3::text is null or t.name ilike $3 or t.description ilike $3
          or exists (select 1 from task_template_items i where i.template_id = t.id and i.title ilike $3))
        and (case when $4 then t.archived_at is not null else t.archived_at is null end)
      order by t.is_starter, t.name`, [a.id, q.category ?? null, like, q.archived === '1']);
    return { templates: rows.map((t) => ({ ...t, can_edit: canEdit(a, t) })), canPublish: canPublish(a) };
  }));

  app.post('/api/templates', async (req) => tx(req, async (db, a) => {
    const t = await createTemplate(db, a, templateSchema.parse(req.body));
    return { ...t, can_edit: canEdit(a, t) };
  }));

  app.post('/api/templates/from-project', async (req) => tx(req, async (db, a) => templateFromProject(db, a, fromProjectSchema.parse(req.body))));

  app.get('/api/templates/assignees', async (req) => tx(req, async (db, a) => {
    requireStaff(a);
    const { projectId } = z.object({ projectId: uuid.optional() }).parse(req.query);
    const project = projectId ? await loadVisibleProject(db, a, projectId) : null;
    return assignableUsers(db, a, project);
  }));

  app.get('/api/templates/:id', async (req) => tx(req, async (db, a) => {
    const t = await loadTemplate(db, a, idParam.parse(req.params).id);
    const [items, versions, usage, mine, author] = await Promise.all([
      itemsOf(db, t.id),
      many(db, `select v.version, v.change_note, v.created_at, u.name created_by_name, jsonb_array_length(v.snapshot->'items') item_count
        from task_template_versions v left join users u on u.id = v.created_by where v.template_id = $1 order by v.version desc limit 20`, [t.id]),
      one(db, `select count(*)::int count, max(created_at) last_applied_at from task_template_applications where template_id = $1`, [t.id]),
      many(db, `select ap.id, ap.created_at, ap.start_date, ap.template_version, cardinality(ap.task_ids) task_count, p.key project_key, p.name project_name
        from task_template_applications ap left join projects p on p.id = ap.project_id where ap.template_id = $1 and ap.applied_by = $2
        order by ap.created_at desc limit 5`, [t.id, a.id]),
      one(db, `select name from users where id = $1`, [t.created_by]),
    ]);
    return { template: { ...t, created_by_name: author?.name ?? null, can_edit: canEdit(a, t) }, items, versions, usage, myApplications: mine, canPublish: canPublish(a) };
  }));

  app.get('/api/templates/:id/versions/:version', async (req) => tx(req, async (db, a) => {
    const p = z.object({ id: uuid, version: z.coerce.number().int().min(1) }).parse(req.params);
    const t = await loadTemplate(db, a, p.id);
    const v = await one(db, `select version, snapshot, change_note, created_at from task_template_versions where template_id = $1 and version = $2`, [t.id, p.version]);
    if (!v) throw notFound('Version not found');
    return v;
  }));

  app.put('/api/templates/:id', async (req) => tx(req, async (db, a) => {
    const t = await loadTemplate(db, a, idParam.parse(req.params).id);
    const row = await updateTemplate(db, a, t, updateSchema.parse(req.body));
    return { ...row, can_edit: canEdit(a, row) };
  }));

  app.post('/api/templates/:id/duplicate', async (req) => tx(req, async (db, a) => {
    const t = await loadTemplate(db, a, idParam.parse(req.params).id);
    const b = z.object({ name: z.string().trim().min(1).max(120).optional(), visibility: z.enum(['company', 'private']).optional() }).parse(req.body);
    const row = await duplicateTemplate(db, a, t, b);
    return { ...row, can_edit: canEdit(a, row) };
  }));

  app.post('/api/templates/:id/archive', async (req) => tx(req, async (db, a) => {
    const t = await loadTemplate(db, a, idParam.parse(req.params).id);
    const { archived } = z.object({ archived: z.boolean() }).parse(req.body);
    return setArchived(db, a, t, archived);
  }));

  app.post('/api/templates/:id/preview', async (req) => tx(req, async (db, a) => {
    const t = await loadTemplate(db, a, idParam.parse(req.params).id);
    return computePlan(db, a, await itemsOf(db, t.id), previewSchema.parse(req.body));
  }));

  app.post('/api/templates/:id/apply', async (req) => tx(req, async (db, a) => {
    const t = await loadTemplate(db, a, idParam.parse(req.params).id);
    return applyTemplate(db, a, t, applySchema.parse(req.body), req.id);
  }));

  app.get('/api/template-applications/:id', async (req) => tx(req, async (db, a) => {
    requireStaff(a);
    const ap = await one(db, `select ap.*, t.name template_name from task_template_applications ap join task_templates t on t.id = ap.template_id where ap.id = $1`,
      [idParam.parse(req.params).id]);
    if (!ap) throw notFound('Not found');
    if (ap.applied_by !== a.id && !has(a, 'routine_admin')) throw forbidden();
    return { application: ap, tasks: await appliedTasks(db, ap.task_ids) };
  }));
}
