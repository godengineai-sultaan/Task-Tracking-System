import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tx } from '../app.js';
import { many, one } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { type Actor, has, requireStaff } from '../services/access.js';
import { customerView } from '../services/oversight.js';
import { assertProductUsable, assertUsersInProduct, tenantHasProducts } from '../services/ext/portfolio-scope.js';
import type { Db } from '../lib/db.js';

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
    /** Product the project belongs to. When the organization has products, a project needs one unless companyWide is chosen explicitly. */
    productId: uuid.nullable().optional(), companyWide: z.boolean().optional(),
  });
  /** Validate a project's product choice; returns the product id (null = company-wide). */
  async function projectProduct(db: Db, a: Actor, productId: string | null | undefined, companyWide: boolean | undefined, ownerId: string) {
    if (productId) {
      if (companyWide) throw badRequest('Choose a product or company-wide work, not both');
      await assertProductUsable(db, a, productId);
      await assertUsersInProduct(db, productId, [ownerId]);
      return productId;
    }
    if (companyWide !== true && (await tenantHasProducts(db))) throw badRequest('Choose the product this project belongs to, or mark it as company-wide work');
    return null;
  }
  app.post('/api/projects', async (req) => tx(req, async (db, a) => {
    if (!has(a, 'system_admin') && !has(a, 'leadership') && !has(a, 'manager')) throw forbidden('Managers, leadership or admins create projects');
    const b = projectSchema.parse(req.body);
    const productId = await projectProduct(db, a, b.productId, b.companyWide, b.ownerId ?? a.id);
    const p = await one(db, `insert into projects (tenant_id, key, name, description, department_id, customer_id, visibility, status, owner_id, business_outcome, start_date, target_date, product_id)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *`,
      [a.tenantId, b.key, b.name, b.description, b.departmentId ?? null, b.customerId ?? null, b.visibility, b.status, b.ownerId ?? a.id, b.businessOutcome, b.startDate ?? null, b.targetDate ?? null, productId]);
    await db.query(`insert into project_members (tenant_id, project_id, user_id) values ($1,$2,$3) on conflict do nothing`, [a.tenantId, p.id, b.ownerId ?? a.id]);
    await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'project.create', resourceType: 'project', resourceId: p.id, details: { productId } });
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
    const productChange = 'productId' in b && (b.productId ?? null) !== p.product_id;
    if (productChange) await projectProduct(db, a, b.productId, b.companyWide, b.ownerId ?? p.owner_id);
    else if (b.ownerId && p.product_id) await assertUsersInProduct(db, p.product_id, [b.ownerId]);
    const r = await one(db, `update projects set name = coalesce($2,name), description = coalesce($3,description), visibility = coalesce($4,visibility), status = coalesce($5,status),
        owner_id = coalesce($6,owner_id), business_outcome = coalesce($7,business_outcome), target_date = case when $9 then $8 else target_date end,
        customer_id = case when $11 then $10 else customer_id end, department_id = case when $13 then $12 else department_id end,
        product_id = case when $15::boolean then $14::uuid else product_id end where id = $1 returning *`,
      [p.id, b.name ?? null, b.description ?? null, b.visibility ?? null, b.status ?? null, b.ownerId ?? null, b.businessOutcome ?? null,
       b.targetDate ?? null, 'targetDate' in b, b.customerId ?? null, 'customerId' in b, b.departmentId ?? null, 'departmentId' in b, b.productId ?? null, productChange]);
    await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'project.update', resourceType: 'project', resourceId: p.id,
      details: { fields: Object.keys(b), ...(productChange ? { productFrom: p.product_id, productTo: b.productId ?? null } : {}) } });
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

  /** Linking milestones to objectives is leadership's call (as in the objectives area), checked and audited the same way. */
  async function linkObjective(db: any, a: any, m: { id: string; name: string; objective_id: string | null }, objectiveId: string | null, move?: boolean) {
    if ((m.objective_id ?? null) === objectiveId) return;
    if (!has(a, 'leadership') && !has(a, 'system_admin')) throw forbidden('Only leadership or a system admin can link milestones to objectives');
    if (objectiveId && !(await one(db, `select 1 from objectives where id = $1`, [objectiveId]))) throw notFound('Objective not found');
    if (m.objective_id && objectiveId && !move) {
      const cur = await one(db, `select title from objectives where id = $1`, [m.objective_id]);
      throw conflict(`This milestone is linked to "${cur?.title ?? 'another objective'}". Confirm to move it to this objective.`, { objectiveId: m.objective_id });
    }
    if (m.objective_id) await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'objective.milestone_unlinked', resourceType: 'objective', resourceId: m.objective_id, details: { milestoneId: m.id, milestone: m.name } });
    if (objectiveId) await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'objective.milestone_linked', resourceType: 'objective', resourceId: objectiveId,
      details: { milestoneId: m.id, milestone: m.name, movedFrom: m.objective_id ?? null } });
  }
  app.post('/api/projects/:id/milestones', async (req) => tx(req, async (db, a) => {
    const p = await loadEditable(db, a, (req.params as any).id);
    const b = z.object({ name: z.string().min(1).max(200), dueDate: date.nullable().optional(), objectiveId: uuid.nullable().optional() }).parse(req.body);
    const m = await one(db, `insert into milestones (tenant_id, project_id, name, due_date) values ($1,$2,$3,$4) returning *`, [a.tenantId, p.id, b.name, b.dueDate ?? null]);
    await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'milestone.create', resourceType: 'milestone', resourceId: m.id, details: { projectId: p.id, name: m.name } });
    if (b.objectiveId) {
      await linkObjective(db, a, m, b.objectiveId);
      return one(db, `update milestones set objective_id = $2 where id = $1 returning *`, [m.id, b.objectiveId]);
    }
    return m;
  }));
  app.patch('/api/milestones/:id', async (req) => tx(req, async (db, a) => {
    const m = await one(db, `select * from milestones where id = $1`, [(req.params as any).id]);
    if (!m) throw notFound();
    await loadEditable(db, a, m.project_id);
    const b = z.object({ name: z.string().min(1).max(200).optional(), dueDate: date.nullable().optional(), status: z.enum(['open', 'done', 'cancelled']).optional(),
      objectiveId: uuid.nullable().optional(), move: z.boolean().optional() }).parse(req.body);
    if ('objectiveId' in b) await linkObjective(db, a, m, b.objectiveId ?? null, b.move);
    const r = await one(db, `update milestones set name = coalesce($2,name), due_date = case when $4 then $3 else due_date end, status = coalesce($5,status),
      objective_id = case when $7 then $6 else objective_id end where id = $1 returning *`,
      [m.id, b.name ?? null, b.dueDate ?? null, 'dueDate' in b, b.status ?? null, b.objectiveId ?? null, 'objectiveId' in b]);
    const changed = Object.fromEntries((['name', 'due_date', 'status', 'objective_id'] as const).filter((k) => m[k] !== r[k]).map((k) => [k, { from: m[k], to: r[k] }]));
    if (Object.keys(changed).length) await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'milestone.update', resourceType: 'milestone', resourceId: m.id, details: { changed } });
    return r;
  }));
  app.get('/api/milestones', async (req) => tx(req, async (db, a) => {
    requireStaff(a);
    return many(db, `select m.id, m.name, m.due_date, m.status, m.project_id, p.key project_key from milestones m join projects p on p.id = m.project_id
      where m.status = 'open' and ${visible} order by m.due_date nulls last`, [a.id, has(a, 'routine_admin')]);
  }));

  app.get('/api/objectives', async (req) => tx(req, async (db, a) => {
    requireStaff(a);
    return many(db, `select o.*, u.name owner_name from objectives o left join users u on u.id = o.owner_id order by o.status, o.period_end nulls last`);
  }));
  // Objectives are created and edited only through the objectives area (POST /api/objectives/create, PUT /api/objectives/:id):
  // one validated, versioned and audited write path.

  app.get('/api/customer/portal', async (req) => tx(req, (db, a) => customerView(db, a)));
}
