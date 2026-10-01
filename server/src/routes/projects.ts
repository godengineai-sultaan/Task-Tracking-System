import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tx } from '../app.js';
import { many, one } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { forbidden, notFound } from '../lib/errors.js';
import { has, requireStaff } from '../services/access.js';
import { customerView } from '../services/oversight.js';

const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export async function projectRoutes(app: FastifyInstance) {
  const visible = `(p.visibility = 'company' or p.owner_id = $1 or exists (select 1 from project_members m where m.project_id = p.id and m.user_id = $1) or $2::boolean)`;

  app.get('/api/projects', async (req) => tx(req, async (db, a) => {
    if (has(a, 'customer')) return (await customerView(db, a)).projects;
    return many(db, `select p.*, u.name owner_name, c.name customer_name, d.name department_name,
        (select count(*) from tasks t where t.project_id = p.id and t.status not in ('done','cancelled'))::int open_tasks,
        (select count(*) from tasks t where t.project_id = p.id and t.status = 'done')::int done_tasks,
        exists (select 1 from project_members m where m.project_id = p.id and m.user_id = $1) is_member
      from projects p left join users u on u.id = p.owner_id left join customers c on c.id = p.customer_id left join departments d on d.id = p.department_id
      where ${visible} order by p.status = 'archived', p.name`, [a.id, has(a, 'routine_admin')]);
  }));

  const projectSchema = z.object({
    key: z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/, '2–10 capital letters/digits, starting with a letter'), name: z.string().min(1).max(120),
    description: z.string().max(5000).default(''), departmentId: uuid.nullable().optional(), customerId: uuid.nullable().optional(),
    visibility: z.enum(['company', 'private']).default('company'), status: z.enum(['active', 'on_hold', 'completed', 'archived']).default('active'),
    ownerId: uuid.nullable().optional(), businessOutcome: z.string().max(1000).default(''), startDate: date.nullable().optional(), targetDate: date.nullable().optional(),
  });
  app.post('/api/projects', async (req) => tx(req, async (db, a) => {
    if (!has(a, 'system_admin') && !has(a, 'leadership') && !has(a, 'manager')) throw forbidden('Managers, leadership or admins create projects');
    const b = projectSchema.parse(req.body);
    const p = await one(db, `insert into projects (tenant_id, key, name, description, department_id, customer_id, visibility, status, owner_id, business_outcome, start_date, target_date)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
      [a.tenantId, b.key, b.name, b.description, b.departmentId ?? null, b.customerId ?? null, b.visibility, b.status, b.ownerId ?? a.id, b.businessOutcome, b.startDate ?? null, b.targetDate ?? null]);
    await db.query(`insert into project_members (tenant_id, project_id, user_id) values ($1,$2,$3) on conflict do nothing`, [a.tenantId, p.id, b.ownerId ?? a.id]);
    await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'project.create', resourceType: 'project', resourceId: p.id });
    return p;
  }));
  async function loadEditable(db: any, a: any, id: string) {
    const p = await one(db, `select * from projects where id = $1`, [id]);
    if (!p) throw notFound('Project not found');
    if (p.owner_id !== a.id && !has(a, 'system_admin') && !has(a, 'leadership')) throw forbidden('Only the project owner, leadership or an admin can change this project');
    return p;
  }
  app.patch('/api/projects/:id', async (req) => tx(req, async (db, a) => {
    const p = await loadEditable(db, a, (req.params as any).id);
    const b = projectSchema.partial().parse(req.body);
    const r = await one(db, `update projects set name = coalesce($2,name), description = coalesce($3,description), visibility = coalesce($4,visibility), status = coalesce($5,status),
        owner_id = coalesce($6,owner_id), business_outcome = coalesce($7,business_outcome), target_date = case when $9 then $8 else target_date end,
        customer_id = case when $11 then $10 else customer_id end, department_id = case when $13 then $12 else department_id end where id = $1 returning *`,
      [p.id, b.name ?? null, b.description ?? null, b.visibility ?? null, b.status ?? null, b.ownerId ?? null, b.businessOutcome ?? null,
       b.targetDate ?? null, 'targetDate' in b, b.customerId ?? null, 'customerId' in b, b.departmentId ?? null, 'departmentId' in b]);
    await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'project.update', resourceType: 'project', resourceId: p.id, details: { fields: Object.keys(b) } });
    return r;
  }));
  app.get('/api/projects/:id', async (req) => tx(req, async (db, a) => {
    requireStaff(a);
    const p = await one(db, `select p.*, u.name owner_name, c.name customer_name from projects p left join users u on u.id = p.owner_id left join customers c on c.id = p.customer_id
      where p.id = $3 and ${visible}`, [a.id, has(a, 'routine_admin'), (req.params as any).id]);
    if (!p) throw notFound('Project not found');
    const [members, milestones, allocations] = await Promise.all([
      many(db, `select u.id, u.name, u.title from project_members m join users u on u.id = m.user_id where m.project_id = $1 order by u.name`, [p.id]),
      many(db, `select m.*, o.title objective_title, (select count(*) from tasks t where t.milestone_id = m.id)::int tasks,
        (select count(*) from tasks t where t.milestone_id = m.id and t.status = 'done')::int done from milestones m left join objectives o on o.id = m.objective_id
        where m.project_id = $1 order by m.due_date nulls last`, [p.id]),
      many(db, `select ca.*, u.name user_name from capacity_allocations ca join users u on u.id = ca.user_id where ca.project_id = $1 order by u.name`, [p.id]),
    ]);
    return { project: p, members, milestones, allocations };
  }));
  app.post('/api/projects/:id/members', async (req) => tx(req, async (db, a) => {
    const p = await loadEditable(db, a, (req.params as any).id);
    const { userId } = z.object({ userId: uuid }).parse(req.body);
    await db.query(`insert into project_members (tenant_id, project_id, user_id) values ($1,$2,$3) on conflict do nothing`, [a.tenantId, p.id, userId]);
    return { ok: true };
  }));
  app.delete('/api/projects/:id/members/:uid', async (req) => tx(req, async (db, a) => {
    const p = await loadEditable(db, a, (req.params as any).id);
    await db.query(`delete from project_members where project_id = $1 and user_id = $2`, [p.id, (req.params as any).uid]);
    return { ok: true };
  }));

  app.post('/api/projects/:id/milestones', async (req) => tx(req, async (db, a) => {
    const p = await loadEditable(db, a, (req.params as any).id);
    const b = z.object({ name: z.string().min(1).max(200), dueDate: date.nullable().optional(), objectiveId: uuid.nullable().optional() }).parse(req.body);
    return one(db, `insert into milestones (tenant_id, project_id, name, due_date, objective_id) values ($1,$2,$3,$4,$5) returning *`, [a.tenantId, p.id, b.name, b.dueDate ?? null, b.objectiveId ?? null]);
  }));
  app.patch('/api/milestones/:id', async (req) => tx(req, async (db, a) => {
    const m = await one(db, `select * from milestones where id = $1`, [(req.params as any).id]);
    if (!m) throw notFound();
    await loadEditable(db, a, m.project_id);
    const b = z.object({ name: z.string().min(1).max(200).optional(), dueDate: date.nullable().optional(), status: z.enum(['open', 'done', 'cancelled']).optional(), objectiveId: uuid.nullable().optional() }).parse(req.body);
    return one(db, `update milestones set name = coalesce($2,name), due_date = case when $4 then $3 else due_date end, status = coalesce($5,status),
      objective_id = case when $7 then $6 else objective_id end where id = $1 returning *`,
      [m.id, b.name ?? null, b.dueDate ?? null, 'dueDate' in b, b.status ?? null, b.objectiveId ?? null, 'objectiveId' in b]);
  }));
  app.get('/api/milestones', async (req) => tx(req, async (db, a) => {
    requireStaff(a);
    return many(db, `select m.id, m.name, m.due_date, m.status, m.project_id, p.key project_key from milestones m join projects p on p.id = m.project_id where m.status = 'open' order by m.due_date nulls last`);
  }));

  app.get('/api/objectives', async (req) => tx(req, async (db, a) => {
    requireStaff(a);
    return many(db, `select o.*, u.name owner_name from objectives o left join users u on u.id = o.owner_id order by o.status, o.period_end nulls last`);
  }));
  app.post('/api/objectives', async (req) => tx(req, async (db, a) => {
    if (!has(a, 'leadership') && !has(a, 'system_admin')) throw forbidden('Leadership sets objectives');
    const b = z.object({ title: z.string().min(1).max(300), description: z.string().max(5000).default(''), ownerId: uuid.nullable().optional(),
      periodStart: date.nullable().optional(), periodEnd: date.nullable().optional() }).parse(req.body);
    return one(db, `insert into objectives (tenant_id, title, description, owner_id, period_start, period_end) values ($1,$2,$3,$4,$5,$6) returning *`,
      [a.tenantId, b.title, b.description, b.ownerId ?? a.id, b.periodStart ?? null, b.periodEnd ?? null]);
  }));
  app.patch('/api/objectives/:id', async (req) => tx(req, async (db, a) => {
    if (!has(a, 'leadership') && !has(a, 'system_admin')) throw forbidden();
    const b = z.object({ status: z.enum(['active', 'achieved', 'missed', 'dropped']).optional(), title: z.string().min(1).max(300).optional() }).parse(req.body);
    return one(db, `update objectives set status = coalesce($2,status), title = coalesce($3,title) where id = $1 returning *`, [(req.params as any).id, b.status ?? null, b.title ?? null]);
  }));

  app.get('/api/customer/portal', async (req) => tx(req, (db, a) => customerView(db, a)));
}
