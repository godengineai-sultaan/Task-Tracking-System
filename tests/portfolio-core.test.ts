import { beforeAll, describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { drainJobs, login, makeOrg, PASSWORD, pools, withOwner, type Client, type Org } from './helpers.js';
import { hashPassword } from '../server/src/lib/crypto.js';
import { withTenant } from '../server/src/lib/db.js';
import { loadActor, productScopeSetting } from '../server/src/services/access.js';

let org: Org;
let admin: Client; let manager: Client; let emp: Client; let emp2: Client; let outsider: Client; let founder: Client; let customer: Client;
const P: Record<string, string> = {};           // product ids by key
let A: string; let B: string; let C: string;    // VIDYA_AI (members), HRMS (members), SHARED_RUNTIME (company-visible)
let PA: any; let PB: any; let PC: any;          // projects: product A, product B, company-wide
let TA1: any; let TA2: any; let TB1: any; let TC: any;
const today = () => DateTime.now().setZone(org.tz).toISODate()!;

/** Run SQL as the application role with the given tenant and product scope (what a request would set). */
async function asApp<T>(scope: string, fn: (q: (sql: string, p?: unknown[]) => Promise<any[]>) => Promise<T>, focus = '') {
  const c = await pools().app.connect();
  try {
    await c.query('begin');
    await c.query("select set_config('app.tenant_id', $1, true), set_config('app.product_scope', $2, true), set_config('app.product_focus', $3, true)", [org.tenantId, scope, focus]);
    return await fn(async (sql, p = []) => (await c.query(sql, p)).rows);
  } finally { await c.query('rollback').catch(() => {}); c.release(); }
}
const scopeOf = async (key: string) => productScopeSetting((await withTenant(org.tenantId, (db) => loadActor(db, org.tenantId, org.users[key])))!);
const ids = (rows: any[]) => rows.map((r) => r.id);
async function counts() {
  return withOwner(async (db) => (await db.query(`select (select count(*) from companies where tenant_id = $1)::int companies, (select count(*) from products where tenant_id = $1)::int products,
    (select count(*) from product_kpis where tenant_id = $1)::int kpis, (select count(*) from task_templates where tenant_id = $1 and product_id is not null)::int templates,
    (select count(*) from task_template_versions v join task_templates t on t.id = v.template_id where t.tenant_id = $1 and t.product_id is not null)::int versions`, [org.tenantId])).rows[0]);
}

beforeAll(async () => {
  org = await makeOrg();
  const h = await hashPassword(PASSWORD);
  await withOwner(async (db) => {
    const cu = (await db.query(`insert into customers (tenant_id, name) values ($1, 'Client Co') returning id`, [org.tenantId])).rows[0];
    org.users.client = (await db.query(`insert into users (tenant_id, email, name, password_hash, roles, customer_id) values ($1,$2,'Client',$3,$4,$5) returning id`,
      [org.tenantId, `client@${org.slug}.test`, h, ['customer'], cu.id])).rows[0].id;
    org.users.customerId = cu.id;
  });
  [admin, manager, emp, emp2, outsider, founder, customer] = await Promise.all(['admin', 'manager', 'emp', 'emp2', 'outsider', 'founder', 'client'].map((k) => login(org, k)));
});

describe('catalog provisioning', () => {
  it('is for system admins only', async () => {
    expect((await emp.post('/api/admin/portfolio/provision')).status).toBe(403);
    expect((await founder.get('/api/admin/portfolio/provision')).status).toBe(403);
  });
  it('previews without writing, then creates 2 companies, 32 products, their KPIs and 96 product playbooks', async () => {
    const preview = await admin.get('/api/admin/portfolio/provision');
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ dryRun: true, companies: { created: 2 }, products: { created: 32 }, templates: { created: 96 } });
    expect(preview.body.missingProducts).toHaveLength(32);
    expect(await counts()).toMatchObject({ companies: 0, products: 0, kpis: 0, templates: 0 });

    const r = await admin.post('/api/admin/portfolio/provision');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ dryRun: false, companies: { created: 2, existing: 0 }, products: { created: 32, updated: 0 }, templates: { created: 96 } });
    expect(r.body.kpis.created).toBe(r.body.totals.kpis);
    const c = await counts();
    expect(c).toMatchObject({ companies: 2, products: 32, kpis: r.body.totals.kpis, templates: 96, versions: 96 });
    // Every product starts without a company (ownership is assigned by an administrator), member-only and active.
    const rows = await withOwner(async (db) => (await db.query(`select key, company_id, company_confirmed, visibility, status, catalog from products where tenant_id = $1`, [org.tenantId])).rows);
    expect(rows.every((p) => p.company_id === null && p.company_confirmed === false && p.visibility === 'members' && p.status === 'active')).toBe(true);
    expect(rows.find((p) => p.key === 'VIDYA_AI').catalog.workstreams.length).toBeGreaterThan(0);
    const companies = await withOwner(async (db) => (await db.query(`select code, legal_name, cin, gstin from companies where tenant_id = $1 order by code`, [org.tenantId])).rows);
    expect(companies).toEqual([{ code: 'ASK', legal_name: null, cin: null, gstin: null }, { code: 'GOD', legal_name: null, cin: null, gstin: null }]);
    // Playbooks are stored like starter templates: steps, offsets, checklists, dependencies and review flags.
    const tpl = await withOwner(async (db) => (await db.query(`select t.*, (select json_agg(i order by i.position) from task_template_items i where i.template_id = t.id) items
      from task_templates t where t.tenant_id = $1 and t.starter_key = 'catalog:VIDYA_AI:1'`, [org.tenantId])).rows[0]);
    expect(tpl).toMatchObject({ is_starter: true, visibility: 'company', name: 'School pilot to deployment' });
    expect(tpl.items.length).toBe(8);
    expect(tpl.items[1].depends_on).toEqual([1]);
    expect(tpl.items[0].requires_review).toBe(true);
    expect(tpl.items[0].checklist.length).toBeGreaterThan(0);
    for (const p of (await admin.get('/api/portfolio')).body.products) P[p.key] = p.id;
    [A, B, C] = [P.VIDYA_AI, P.HRMS, P.SHARED_RUNTIME];
    expect(tpl.product_id).toBe(A);
  });
  it('is idempotent: re-provisioning updates what changed and never duplicates', async () => {
    const again = await admin.post('/api/admin/portfolio/provision');
    expect(again.body).toMatchObject({ companies: { created: 0, existing: 2 }, products: { created: 0, updated: 0, unchanged: 32 }, kpis: { created: 0, updated: 0 },
      templates: { created: 0, updated: 0, unchanged: 96, customized: 0 } });
    const before = await counts();
    // A drifted catalog fact is refreshed; a playbook edited in the app is reported and left alone.
    await withOwner((db) => db.query(`update products set layer = 'Drifted' where id = $1`, [A]));
    const t = (await admin.get('/api/templates')).body.templates.find((x: any) => x.name === 'Curriculum corpus and model release');
    const full = (await admin.get(`/api/templates/${t.id}`)).body;
    const items = full.items.map((i: any) => ({ title: i.title, category: i.category, priority: i.priority, estimateMinutes: i.estimate_minutes, dueOffsetDays: i.due_offset_days,
      ownerHint: i.owner_hint, checklist: i.checklist, requiresReview: i.requires_review, dependsOn: i.depends_on }));
    expect((await admin.put(`/api/templates/${t.id}`, { name: t.name, description: 'Our own version', category: t.category, visibility: 'company', items, version: t.version })).status).toBe(200);
    const third = await admin.post('/api/admin/portfolio/provision');
    expect(third.body.products).toMatchObject({ updated: 1, created: 0 });
    expect(third.body.templates).toMatchObject({ customized: 1, updated: 0, created: 0 });
    expect(third.body.customizedTemplates[0]).toContain('Vidya AI');
    expect((await admin.get(`/api/templates/${t.id}`)).body.template.description).toBe('Our own version');
    const after = await counts();
    expect({ ...after, versions: 0 }).toEqual({ ...before, versions: 0 });
  });
});

describe('product administration and membership', () => {
  it('only system admins change products; versioned and audited; company assignment is provisional until confirmed', async () => {
    const prod = (await admin.get(`/api/products/${C}`)).body.product;
    expect((await emp.patch(`/api/products/${C}`, { version: prod.version, visibility: 'company' })).status).toBe(403);
    expect((await admin.patch(`/api/products/${C}`, { version: prod.version + 5, visibility: 'company' })).status).toBe(409);
    const companies = (await admin.get('/api/portfolio')).body.companies;
    const ask = companies.find((c: any) => c.code === 'ASK');
    expect((await admin.patch(`/api/products/${C}`, { version: prod.version, companyConfirmed: true })).status).toBe(400);
    const r = await admin.patch(`/api/products/${C}`, { version: prod.version, visibility: 'company', companyId: ask.id, websiteUrl: 'https://runtime.example' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ visibility: 'company', company_id: ask.id, company_confirmed: false, version: prod.version + 1 });
    const c2 = await admin.patch(`/api/products/${C}`, { version: r.body.version, companyConfirmed: true });
    expect(c2.body).toMatchObject({ company_confirmed: true, version: prod.version + 2 });
    expect((await admin.patch(`/api/products/${C}`, { version: c2.body.version, websiteUrl: 'javascript:alert(1)' })).status).toBe(400);
    const audit = await withOwner(async (db) => (await db.query(`select details from audit_events where tenant_id = $1 and action = 'product.update' and resource_id = $2 order by id`, [org.tenantId, C])).rows);
    expect(audit.length).toBe(2);
    expect(audit[1].details.changed.company_confirmed).toEqual({ from: false, to: true });
  });
  it('companies: legal details are entered by a system admin, validated, versioned and audited', async () => {
    const god = (await admin.get('/api/portfolio')).body.companies.find((c: any) => c.code === 'GOD');
    expect((await emp.patch(`/api/companies/${god.id}`, { version: god.version, legalName: 'X' })).status).toBe(403);
    expect((await admin.patch(`/api/companies/${god.id}`, { version: god.version, cin: 'not-a-cin' })).status).toBe(400);
    const r = await admin.patch(`/api/companies/${god.id}`, { version: god.version, legalName: 'God Engine Private Limited', cin: 'u72900mh2020ptc123456', gstin: null });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ legal_name: 'God Engine Private Limited', cin: 'U72900MH2020PTC123456', gstin: null, version: god.version + 1 });
    expect((await admin.patch(`/api/companies/${god.id}`, { version: god.version, legalName: 'Stale' })).status).toBe(409);
    const ev = await withOwner(async (db) => (await db.query(`select 1 from audit_events where tenant_id = $1 and action = 'company.update' and resource_id = $2`, [org.tenantId, god.id])).rows);
    expect(ev.length).toBe(1);
  });
  it('system admins and product leads manage members; leads cannot remove the last lead; added people are notified', async () => {
    expect((await emp.post(`/api/products/${A}/members`, { userId: org.users.emp, role: 'lead' })).status).toBe(404); // emp cannot see A yet
    expect((await admin.post(`/api/products/${A}/members`, { userId: org.users.emp, role: 'lead' })).status).toBe(200);
    expect((await admin.post(`/api/products/${B}/members`, { userId: org.users.emp2, role: 'member' })).status).toBe(200);
    // emp's session now includes product A (scope is computed per request).
    expect((await emp.post(`/api/products/${A}/members`, { userId: org.users.emp2, role: 'viewer' })).status).toBe(200);
    expect((await emp2.post(`/api/products/${A}/members`, { userId: org.users.outsider, role: 'member' })).status).toBe(403);
    expect((await emp2.get(`/api/products/${A}/members`)).status).toBe(403);
    expect((await outsider.get(`/api/products/${A}/members`)).status).toBe(404);
    const members = (await emp.get(`/api/products/${A}/members`)).body;
    expect(members.map((m: any) => [m.name, m.role])).toEqual([['Emp', 'lead'], ['Emp2', 'viewer']]);
    expect((await emp.del(`/api/products/${A}/members/${org.users.emp}`)).status).toBe(400);
    expect((await emp.post(`/api/products/${A}/members`, { userId: org.users.emp, role: 'member' })).status).toBe(400);
    expect((await emp.post(`/api/products/${A}/members`, { userId: org.users.client, role: 'member' })).status).toBe(400);
    const n = (await emp2.get('/api/notifications')).body.map((x: any) => x.title);
    expect(n).toContain('Added to Vidya AI as viewer (read only)');
    const ev = await withOwner(async (db) => (await db.query(`select action from audit_events where tenant_id = $1 and resource_type = 'product' and action like 'product.member%'`, [org.tenantId])).rows);
    expect(ev.length).toBe(3);
  });
  it('the portfolio lists only products in scope, with my role, leads and counts', async () => {
    const all = (await admin.get('/api/portfolio')).body;
    expect(all).toMatchObject({ canManage: true, scope: 'all', tenantHasProducts: true });
    expect(all.products).toHaveLength(32);
    const mine = (await emp.get('/api/portfolio')).body;
    expect(mine).toMatchObject({ canManage: false, scope: 'members' });
    expect(mine.products.map((p: any) => p.key).sort()).toEqual(['SHARED_RUNTIME', 'VIDYA_AI']);
    expect(mine.products.find((p: any) => p.key === 'VIDYA_AI')).toMatchObject({ my_role: 'lead', member_count: 2, leads: [{ name: 'Emp' }] });
    expect((await outsider.get('/api/portfolio')).body.products.map((p: any) => p.key)).toEqual(['SHARED_RUNTIME']);
    expect((await founder.get('/api/portfolio')).body.products).toHaveLength(32); // leadership sees every product
    expect((await outsider.get(`/api/products/${A}`)).status).toBe(404);
    expect((await customer.get('/api/portfolio')).status).toBe(403);
    expect((await emp.get('/api/me')).body.portfolio).toEqual({ enabled: true, allProducts: false, leadOf: [A] });
  });
});

describe('product work and partitions', () => {
  it('projects need a product (or an explicit company-wide choice) once the organization has products', async () => {
    expect((await admin.post('/api/projects', { key: 'NOPE', name: 'Nope' })).status).toBe(400);
    PC = (await admin.post('/api/projects', { key: 'OPS', name: 'Operations', companyWide: true })).body;
    expect(PC.product_id).toBeNull();
    expect((await admin.post('/api/projects', { key: 'BOTH', name: 'Both', productId: A, companyWide: true })).status).toBe(400);
    // The project owner must be able to see the product.
    expect((await admin.post('/api/projects', { key: 'VIDX', name: 'Vidya X', productId: A, ownerId: org.users.outsider })).status).toBe(400);
    PA = (await admin.post('/api/projects', { key: 'VID', name: 'Vidya corpus', productId: A, ownerId: org.users.emp })).body;
    expect(PA.product_id).toBe(A);
    PB = (await admin.post('/api/projects', { key: 'HRP', name: 'Payroll', productId: B, ownerId: org.users.emp2 })).body;
    // Managers can create projects only in products they can see.
    expect((await manager.post('/api/projects', { key: 'MGR', name: 'Manager project', productId: A })).body.message).toBe('Product not found');
  });
  it('tasks take their project\'s product; product work needs a member owner; viewers cannot add work', async () => {
    TA1 = (await emp.post('/api/tasks', { title: 'Partition probe alpha', projectId: PA.id, checklist: ['step one'] })).body;
    expect(TA1.product_id).toBe(A);
    expect((await emp.post('/api/tasks', { title: 'Mismatch', projectId: PA.id, productId: C })).status).toBe(400);
    TA2 = (await emp.post('/api/tasks', { title: 'Partition probe beta', productId: A })).body;
    expect(TA2).toMatchObject({ product_id: A, project_id: null });
    expect((await emp.post('/api/tasks', { title: 'For outsider', productId: A, ownerId: org.users.outsider })).body.message).toMatch(/not a member of Vidya AI/);
    expect((await emp2.post('/api/tasks', { title: 'Viewer work', productId: A })).status).toBe(403);
    TB1 = (await emp2.post('/api/tasks', { title: 'Partition probe gamma', projectId: PB.id })).body;
    expect(TB1.product_id).toBe(B);
    TC = (await emp.post('/api/tasks', { title: 'Partition probe delta', projectId: PC.id })).body;
    expect(TC.product_id).toBeNull();
    expect((await emp.post(`/api/tasks/${TA1.id}/comments`, { body: 'Only product members read this' })).status).toBe(200);
    expect((await emp.post(`/api/tasks/${TA1.id}/evidence`, { label: 'Spec', url: 'https://example.com/spec' })).status).toBe(200);
    expect((await emp.post(`/api/tasks/${TA1.id}/collaborators`, { userId: org.users.outsider })).status).toBe(400);
    expect((await emp.post(`/api/tasks/${TA1.id}/status`, { to: 'in_progress' })).status).toBe(200);
    expect((await emp.post(`/api/tasks/${TA1.id}/status`, { to: 'blocked', blocker: { reason: 'Waiting on licence' } })).status).toBe(200);
  });
  it('a non-member cannot see another product\'s work through lists, detail, search, board or child records', async () => {
    const list = ids((await outsider.get('/api/tasks?includeDone=1&limit=500')).body);
    expect(list).toContain(TC.id);
    for (const t of [TA1, TA2, TB1]) expect(list).not.toContain(t.id);
    expect(ids((await outsider.get('/api/tasks?includeDone=0')).body)).not.toContain(TA1.id); // board query
    expect((await outsider.get(`/api/tasks/${TA1.id}`)).status).toBe(404);
    expect((await outsider.post(`/api/tasks/${TA1.id}/comments`, { body: 'hi' })).status).toBe(404);
    expect(ids((await outsider.get('/api/projects')).body)).toEqual(expect.not.arrayContaining([PA.id, PB.id]));
    expect((await outsider.get(`/api/projects/${PA.id}`)).status).toBe(404);
    const s = (await outsider.get('/api/search?q=Partition%20probe')).body;
    expect(s.tasks.map((t: any) => t.id)).toEqual([TC.id]);
    expect((await outsider.get('/api/search?q=VID')).body.projects).toEqual([]);
    // emp2 is a member of B and a viewer of A: sees both; the manager of emp/emp2 is in neither product.
    const e2 = ids((await emp2.get('/api/tasks?includeDone=1')).body);
    expect(e2).toEqual(expect.arrayContaining([TA1.id, TB1.id]));
    const m = ids((await manager.get('/api/tasks?includeDone=1')).body);
    expect(m).toContain(TC.id);
    for (const t of [TA1, TA2, TB1]) expect(m).not.toContain(t.id);
    // Admins (all products) and leadership see product work as their role allows.
    expect(ids((await admin.get('/api/tasks?includeDone=1')).body)).toEqual(expect.arrayContaining([TA1.id, TA2.id, TB1.id, TC.id]));
    expect((await founder.get(`/api/tasks/${TA1.id}`)).status).toBe(200);
  });
  it('the database enforces it for the app role, including task children, milestones, templates and objectives', async () => {
    const ms = (await emp.post(`/api/projects/${PA.id}/milestones`, { name: 'Beta' }));
    expect(ms.status).toBe(200);
    const obj = (await admin.post('/api/objectives/create', { title: 'Vidya adoption', productId: A })).body;
    expect(obj.product_id).toBe(A);
    const probe = async (scope: string) => asApp(scope, async (q) => ({
      tasks: (await q(`select id from tasks where id = any($1::uuid[])`, [[TA1.id, TA2.id, TB1.id, TC.id]])).length,
      projects: (await q(`select id from projects where id = any($1::uuid[])`, [[PA.id, PB.id, PC.id]])).length,
      checklist: (await q(`select 1 from checklist_items where task_id = $1`, [TA1.id])).length,
      comments: (await q(`select 1 from comments where task_id = $1`, [TA1.id])).length,
      evidence: (await q(`select 1 from evidence_links where task_id = $1`, [TA1.id])).length,
      blockers: (await q(`select 1 from blockers where task_id = $1`, [TA1.id])).length,
      history: (await q(`select 1 from task_state_history where task_id = $1`, [TA1.id])).length,
      milestones: (await q(`select 1 from milestones where project_id = $1`, [PA.id])).length,
      templates: (await q(`select 1 from task_templates where product_id = $1`, [A])).length,
      objectives: (await q(`select 1 from objectives where id = $1`, [obj.id])).length,
      kpis: (await q(`select 1 from product_kpis where product_id = $1`, [A])).length,
      products: (await q(`select key from products order by key`)).map((r) => r.key),
    }));
    const out = await probe(await scopeOf('outsider'));
    expect(out).toEqual({ tasks: 1, projects: 1, checklist: 0, comments: 0, evidence: 0, blockers: 0, history: 0, milestones: 0, templates: 0, objectives: 0, kpis: 0, products: ['SHARED_RUNTIME'] });
    const mem = await probe(await scopeOf('emp'));
    expect(mem).toMatchObject({ tasks: 3, projects: 2, checklist: 1, comments: 1, evidence: 1, blockers: 1, milestones: 1, templates: 3, objectives: 1 });
    expect(mem.history).toBeGreaterThan(0);
    expect((await probe('all')).tasks).toBe(4);
    // Writes are checked too: the app role cannot file work into a product outside its scope.
    await expect(asApp(await scopeOf('outsider'), (q) => q(`insert into tasks (tenant_id, title, owner_id, product_id) values ($1,'x',$2,$3)`, [org.tenantId, org.users.outsider, A])))
      .rejects.toThrow(/row-level security/);
    await expect(asApp(await scopeOf('outsider'), (q) => q(`insert into comments (tenant_id, task_id, body) values ($1,$2,'x')`, [org.tenantId, TA1.id])))
      .rejects.toThrow(/row-level security/);
    expect((await outsider.get(`/api/objectives/${obj.id}`)).status).toBe(404);
    expect(ids((await outsider.get('/api/objectives')).body)).not.toContain(obj.id);
    // A company-wide objective linked to product milestones: outsiders still open it, without the product's milestone names.
    const wide = (await admin.post('/api/objectives/create', { title: 'Group-wide adoption' })).body;
    expect((await admin.post(`/api/objectives/${wide.id}/milestones`, { milestoneId: ms.body.id })).status).toBe(200);
    const seen = await outsider.get(`/api/objectives/${wide.id}`);
    expect(seen.status).toBe(200);
    expect(JSON.stringify(seen.body)).not.toContain('"Beta"');
    expect((await outsider.get('/api/objectives/overview')).status).toBe(200);
    expect(JSON.stringify((await emp.get(`/api/objectives/${wide.id}`)).body)).toContain('Beta');
  });
  it('templates: product playbooks are visible to that product\'s members only', async () => {
    const names = async (c: Client) => (await c.get('/api/templates')).body.templates.filter((t: any) => t.product_id).map((t: any) => t.product_id);
    expect(new Set(await names(outsider))).toEqual(new Set([C]));
    expect(new Set(await names(emp))).toEqual(new Set([A, C]));
    const tpl = (await emp.get('/api/templates')).body.templates.find((t: any) => t.product_id === A);
    expect((await outsider.get(`/api/templates/${tpl.id}`)).status).toBe(404);
    // Applying a product playbook files the work in its product; a project of another product is refused.
    expect((await emp.post(`/api/templates/${tpl.id}/preview`, { startDate: today(), projectId: PC.id })).status).toBe(400);
    const applied = await emp.post(`/api/templates/${tpl.id}/apply`, { startDate: today(), applyKey: 'portfolio-core-apply-1' });
    expect(applied.status).toBe(200);
    const created = await withOwner(async (db) => (await db.query(`select distinct product_id from tasks where id = any($1::uuid[])`, [applied.body.application.task_ids])).rows);
    expect(created).toEqual([{ product_id: A }]);
  });
  it('recurring generation files product work that non-members never see', async () => {
    expect((await outsider.post('/api/recurring', { title: 'Sneaky', rule: 'daily', productId: A })).body.message).toBe('Product not found');
    const r = await emp.post('/api/recurring', { title: 'Daily corpus sync check', rule: 'daily', productId: A, category: 'research' });
    expect(r.status).toBe(200);
    expect(r.body.product_id).toBe(A);
    await drainJobs(500);
    const generated = await withOwner(async (db) => (await db.query(`select id, product_id from tasks where recurring_template_id = $1`, [r.body.id])).rows);
    expect(generated.length).toBeGreaterThan(0);
    expect(generated.every((t) => t.product_id === A)).toBe(true);
    expect(ids((await outsider.get('/api/tasks?q=corpus%20sync&includeDone=1')).body)).toEqual([]);
    expect(ids((await emp.get('/api/tasks?q=corpus%20sync&includeDone=1')).body).length).toBe(generated.length);
    expect(ids((await outsider.get('/api/recurring')).body)).not.toContain(r.body.id);
  });
  it('exports run with the requester\'s product scope and an optional product focus', async () => {
    expect((await emp.put('/api/my-day/plan', { taskIds: [TA2.id, TC.id] })).status).toBe(200);
    expect((await outsider.post('/api/exports', { format: 'csv', report: 'individual', params: { userId: org.users.outsider, start: today(), end: today(), productId: A } })).status).toBe(403);
    const mine = await manager.post('/api/exports', { format: 'csv', report: 'team_daily', params: { date: today() } });
    const adm = await admin.post('/api/exports', { format: 'csv', report: 'team_daily', params: { date: today() } });
    const focused = await admin.post('/api/exports', { format: 'csv', report: 'team_daily', params: { date: today(), productId: 'none' } });
    expect([mine.status, adm.status, focused.status]).toEqual([200, 200, 200]);
    await drainJobs(500);
    const file = async (c: Client, id: string) => { const r = await c.get(`/api/exports/${id}/file`); expect(r.status).toBe(200); return r.raw.toString('utf8'); };
    const m = await file(manager, mine.body.id); const a = await file(admin, adm.body.id); const f = await file(admin, focused.body.id);
    expect(a).toContain('Partition probe beta');
    expect(a).toContain('Partition probe delta');
    expect(m).not.toContain('Partition probe beta');   // the manager is not in product A
    expect(m).toContain('Partition probe delta');
    expect(f).not.toContain('Partition probe beta');   // focus 'none' = company-wide work only
    expect(f).toContain('Partition probe delta');
  });
});

describe('product focus', () => {
  it('filters list views: strict for tasks and projects, loose for templates; "none" = company-wide work', async () => {
    const focA = ids((await emp.focus(A).get('/api/tasks?includeDone=1&limit=500')).body);
    expect(focA).toEqual(expect.arrayContaining([TA1.id, TA2.id]));
    expect(focA).not.toContain(TC.id);
    const none = ids((await emp.focus('none').get('/api/tasks?includeDone=1&limit=500')).body);
    expect(none).toContain(TC.id);
    expect(none).not.toContain(TA1.id);
    expect(ids((await emp.focus(A).get('/api/projects')).body)).toEqual([PA.id]);
    expect(ids((await emp.focus('none').get('/api/projects')).body)).toContain(PC.id);
    const tpls = (await emp.focus(A).get('/api/templates')).body.templates;
    expect(new Set(tpls.map((t: any) => t.product_id))).toEqual(new Set([A, null])); // generic playbooks stay visible
    expect((await emp.focus(A).get('/api/search?q=Partition%20probe')).body.tasks.map((t: any) => t.id)).not.toContain(TC.id);
    expect(ids((await emp.focus('none').get('/api/recurring')).body)).toEqual([]);
  });
  it('never applies to single records, personal pages or writes', async () => {
    expect((await emp.focus('none').get(`/api/tasks/${TA1.id}`)).status).toBe(200);
    expect((await emp.focus('none').get(`/api/projects/${PA.id}`)).status).toBe(200);
    const day = (await emp.focus(C).get('/api/my-day')).body;
    expect(JSON.stringify(day)).toContain('Partition probe beta');
    const at = DateTime.now().minus({ hours: 2 });
    const te = await emp.focus('none').post('/api/time-entries', { taskId: TA2.id, category: 'task', startedAt: at.toISO(), endedAt: at.plus({ minutes: 30 }).toISO() });
    expect(te.status).toBe(200);
    expect(te.body.entry.product_id).toBe(A);
    const listed = (await emp.focus('none').get(`/api/time-entries?from=${encodeURIComponent(at.minus({ hours: 1 }).toISO()!)}&to=${encodeURIComponent(DateTime.now().toISO()!)}`)).body;
    expect(listed.map((e: any) => e.id)).toContain(te.body.entry.id);
    const created = await emp.focus('none').post('/api/tasks', { title: 'Written under focus', productId: A });
    expect(created.body.product_id).toBe(A);
  });
  it('every list endpoint that follows the focus answers under a product focus and under "none"', async () => {
    const { FOCUS_PATHS } = await import('../server/src/services/ext/portfolio-scope.js');
    const query: Record<string, string> = { '/api/search': '?q=Partition' };
    for (const path of FOCUS_PATHS) for (const f of [A, 'none']) {
      const r = await admin.focus(f).get(path + (query[path] ?? ''));
      expect([path, f, r.status < 500]).toEqual([path, f, true]);
    }
  });
  it('a focus outside the actor\'s scope is refused, never widened', async () => {
    const r = await outsider.focus(A).get('/api/tasks');
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('focus_out_of_scope');
    expect((await outsider.focus('nonsense').get('/api/tasks')).status).toBe(400);
    expect((await outsider.focus(A).get('/api/my-day')).status).toBe(200); // ignored outside list views
    expect((await customer.focus(B).get('/api/tasks')).status).toBe(403);
  });
});

describe('consistency triggers', () => {
  it('a task\'s product follows its project, and its time follows the task', async () => {
    await expect(withOwner((db) => db.query(`insert into tasks (tenant_id, project_id, product_id, title, owner_id) values ($1,$2,$3,'bad',$4)`, [org.tenantId, PA.id, B, org.users.admin])))
      .rejects.toThrow(/must match the project/);
    const t = (await emp.post('/api/tasks', { title: 'Mover', projectId: PA.id })).body;
    const at = DateTime.now().minus({ hours: 5 });
    const te = (await emp.post('/api/time-entries', { taskId: t.id, category: 'task', startedAt: at.toISO(), endedAt: at.plus({ minutes: 20 }).toISO() })).body.entry;
    expect(te.product_id).toBe(A);
    // Moving the task to a company-wide project makes it (and its time) company-wide.
    const moved = await emp.patch(`/api/tasks/${t.id}`, { version: t.version, projectId: PC.id });
    expect(moved.status).toBe(200);
    expect(moved.body.product_id).toBeNull();
    const row = async () => withOwner(async (db) => (await db.query(`select product_id from time_entries where id = $1`, [te.id])).rows[0].product_id);
    expect(await row()).toBeNull();
    // Without a project, a task can move to another product its owner belongs to.
    const back = await emp.patch(`/api/tasks/${t.id}`, { version: moved.body.version, projectId: null, productId: A });
    expect(back.body.product_id).toBe(A);
    expect(await row()).toBe(A);
    // Moving a whole project to another product moves its tasks and their time.
    const p = (await admin.post('/api/projects', { key: 'MOVE', name: 'Movable', productId: A, ownerId: org.users.emp })).body;
    const t2 = (await emp.post('/api/tasks', { title: 'Follows project', projectId: p.id })).body;
    const te2 = (await emp.post('/api/time-entries', { taskId: t2.id, category: 'task', startedAt: at.plus({ hours: 1 }).toISO(), endedAt: at.plus({ hours: 1, minutes: 10 }).toISO() })).body.entry;
    expect((await admin.patch(`/api/projects/${p.id}`, { productId: C })).status).toBe(200);
    const after = await withOwner(async (db) => (await db.query(`select (select product_id from tasks where id = $1) task, (select product_id from time_entries where id = $2) time`, [t2.id, te2.id])).rows[0]);
    expect(after).toEqual({ task: C, time: C });
    const ev = await withOwner(async (db) => (await db.query(`select details from audit_events where tenant_id = $1 and action = 'project.update' and resource_id = $2`, [org.tenantId, p.id])).rows);
    expect(ev[0].details).toMatchObject({ productFrom: A, productTo: C });
  });
});

describe('preferences', () => {
  it('stores a product focus the person can actually use', async () => {
    expect((await emp.get('/api/me/preferences')).body).toEqual({ productFocus: 'all' });
    expect((await emp.put('/api/me/preferences', { productFocus: A })).body).toEqual({ productFocus: A });
    expect((await emp.get('/api/me/preferences')).body).toEqual({ productFocus: A });
    expect((await emp.put('/api/me/preferences', { productFocus: 'none' })).body).toEqual({ productFocus: 'none' });
    expect((await outsider.put('/api/me/preferences', { productFocus: A })).status).toBe(403);
    expect((await admin.put('/api/me/preferences', { productFocus: '00000000-0000-4000-8000-000000000000' })).status).toBe(400);
    expect((await admin.put('/api/me/preferences', { productFocus: 'sideways' })).status).toBe(400);
    // A stored focus on a product the person later leaves reads back as "all".
    expect((await emp2.put('/api/me/preferences', { productFocus: B })).status).toBe(200);
    expect((await admin.del(`/api/products/${B}/members/${org.users.emp2}`)).status).toBe(200);
    expect((await emp2.get('/api/me/preferences')).body).toEqual({ productFocus: 'all' });
  });
});

describe('customers', () => {
  it('keep seeing only their own client work inside product projects', async () => {
    const cp = (await admin.post('/api/projects', { key: 'CLI', name: 'Client rollout', productId: A, customerId: org.users.customerId })).body;
    const shared = (await admin.post('/api/tasks', { title: 'Client-visible milestone task', projectId: cp.id, customerVisible: true })).body;
    const internal = (await admin.post('/api/tasks', { title: 'Internal product task', projectId: cp.id })).body;
    const portal = (await customer.get('/api/customer/portal')).body;
    expect(portal.projects.map((p: any) => p.id)).toEqual([cp.id]);
    expect(portal.tasks.map((t: any) => t.id)).toEqual([shared.id]);
    const list = ids((await customer.get('/api/tasks?includeDone=1')).body);
    expect(list).toEqual([shared.id]);
    expect((await customer.get(`/api/tasks/${internal.id}`)).status).toBe(404);
    expect((await customer.get(`/api/tasks/${TA1.id}`)).status).toBe(404);
    expect((await customer.get(`/api/products/${A}`)).status).toBe(403);
    // Their database scope is the products of their own client projects, nothing more.
    expect(await scopeOf('client')).toBe(A);
  });
});

describe('organizations without products', () => {
  it('work exactly as before: no product needed, scope and focus are inert', async () => {
    const other = await makeOrg();
    const oa = await login(other, 'admin'); const oe = await login(other, 'emp');
    const p = await oa.post('/api/projects', { key: 'PLAIN', name: 'Plain project' });
    expect(p.status).toBe(200);
    expect(p.body.product_id).toBeNull();
    const t = await oe.post('/api/tasks', { title: 'Plain task', projectId: p.body.id });
    expect(t.status).toBe(200);
    expect(ids((await oe.get('/api/tasks')).body)).toContain(t.body.id);
    expect((await oe.get('/api/portfolio')).body).toMatchObject({ tenantHasProducts: false, products: [] });
    expect((await oe.get('/api/me')).body.portfolio.enabled).toBe(false);
  });
});
