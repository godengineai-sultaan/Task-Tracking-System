import { beforeAll, describe, expect, it } from 'vitest';
import { login, makeOrg, withOwner, type Org } from './helpers.js';

let org: Org; let emp: any; let emp2: any; let mgr: any; let admin: any; let outsider: any;
const key = () => `k-${crypto.randomUUID()}`;
const count = async (sql: string, p: unknown[]) => withOwner(async (db) => (await db.query(sql, p)).rows[0].n as number);

// 2030-01-07 is a Monday. 2030-01-09 (Wednesday) is a company holiday; emp2 is on leave 2030-01-08.
const MON = '2030-01-07';
const steps = [
  { title: 'Kickoff', dueOffsetDays: 0, checklist: ['Agenda', 'Invite'], estimateMinutes: 30, category: 'admin' },
  { title: 'Draft plan', dueOffsetDays: 2, dependsOn: [1], requiresReview: true, priority: 'high', ownerHint: 'Planner' },
  { title: 'Share plan', dueOffsetDays: 3, dependsOn: [1, 2] },
  { title: 'Retro', dueOffsetDays: 5, dependsOn: [3], requiresEvidence: true },
  { title: 'Undated follow-up', dueOffsetDays: null },
];

beforeAll(async () => {
  org = await makeOrg();
  [emp, emp2, mgr, admin, outsider] = await Promise.all(['emp', 'emp2', 'manager', 'admin', 'outsider'].map((k) => login(org, k)));
  await withOwner(async (db) => {
    await db.query(`insert into holidays (tenant_id, date, name) values ($1,'2030-01-09','Founders Day')`, [org.tenantId]);
    await db.query(`insert into leave_entries (tenant_id, user_id, start_date, end_date, portion, kind) values ($1,$2,'2030-01-08','2030-01-08','full','sick')`, [org.tenantId, org.users.emp2]);
  });
});

describe('starter templates', () => {
  it('are provisioned once per tenant, even under concurrent first use', async () => {
    const [a, b] = await Promise.all([emp.get('/api/templates'), mgr.get('/api/templates')]);
    expect(a.status).toBe(200); expect(b.status).toBe(200);
    await emp2.get('/api/templates');
    expect(await count(`select count(*)::int n from task_templates where tenant_id = $1 and is_starter`, [org.tenantId])).toBe(6);
    expect(await count(`select count(*)::int n from audit_events where tenant_id = $1 and action = 'template.starters_provisioned'`, [org.tenantId])).toBe(1);
    const names = a.body.templates.map((t: any) => t.name);
    for (const n of ['New employee onboarding', 'Month-end close', 'Vendor purchase', 'Client project kickoff', 'Weekly team review', 'Product release checklist'])
      expect(names).toContain(n);
    const onboarding = a.body.templates.find((t: any) => t.name === 'New employee onboarding');
    expect(onboarding).toMatchObject({ visibility: 'company', is_starter: true, item_count: 8, can_edit: false });
    expect(b.body.templates.find((t: any) => t.id === onboarding.id).can_edit).toBe(true);
  });

  it('archived starters are not re-provisioned; search and category filters work', async () => {
    const list = (await mgr.get('/api/templates')).body.templates;
    const weekly = list.find((t: any) => t.name === 'Weekly team review');
    expect((await mgr.post(`/api/templates/${weekly.id}/archive`, { archived: true })).status).toBe(200);
    const after = (await emp.get('/api/templates')).body.templates;
    expect(after.map((t: any) => t.id)).not.toContain(weekly.id);
    expect(await count(`select count(*)::int n from task_templates where tenant_id = $1 and is_starter`, [org.tenantId])).toBe(6);
    expect((await emp.get('/api/templates?archived=1')).body.templates.map((t: any) => t.id)).toContain(weekly.id);
    // archived templates cannot be applied until restored
    expect((await mgr.post(`/api/templates/${weekly.id}/apply`, { startDate: MON, applyKey: key() })).status).toBe(400);
    await mgr.post(`/api/templates/${weekly.id}/archive`, { archived: false });

    const search = (await emp.get('/api/templates?q=reconciliation')).body.templates;
    expect(search.map((t: any) => t.name)).toEqual(['Month-end close']); // matches a step title
    const fin = (await emp.get('/api/templates?category=procurement')).body.templates;
    expect(fin.map((t: any) => t.name)).toEqual(['Vendor purchase']);
    expect((await emp.get('/api/templates?q=100%25')).status).toBe(200); // wildcard characters are escaped
  });
});

describe('apply', () => {
  let tpl: any;
  beforeAll(async () => {
    const r = await mgr.post('/api/templates', { name: 'Test playbook', category: 'team', visibility: 'company', items: steps });
    expect(r.status).toBe(200);
    tpl = r.body;
  });

  it('previews due dates on working days, skipping weekends, holidays and leave', async () => {
    const p = await mgr.post(`/api/templates/${tpl.id}/preview`, { startDate: MON, defaultOwnerId: org.users.emp, assignments: { 2: org.users.emp2 } });
    expect(p.status).toBe(200);
    const due = Object.fromEntries(p.body.rows.map((r: any) => [r.position, r.dueDate]));
    expect(due).toEqual({ 1: '2030-01-07', 2: '2030-01-11', 3: '2030-01-11', 4: '2030-01-15', 5: null });
    // emp2 (leave on the 8th) and the holiday on the 9th are both explained, without disclosing the leave type
    expect(p.body.rows[1].skipped).toEqual([{ date: '2030-01-08', reason: 'Unavailable' }, { date: '2030-01-09', reason: 'Founders Day' }]);
    expect(p.body.rows[1].ownerName).toBe('Emp2');
    // the same step owned by someone without leave lands a day earlier
    const noLeave = await mgr.post(`/api/templates/${tpl.id}/preview`, { startDate: MON, defaultOwnerId: org.users.emp });
    expect(noLeave.body.rows[1].dueDate).toBe('2030-01-10');
    expect(noLeave.body.warnings).toEqual([]);
    expect(p.body.assumptions.length).toBeGreaterThan(0);
    // a Saturday start moves to the owner's next working day
    const sat = await mgr.post(`/api/templates/${tpl.id}/preview`, { startDate: '2030-01-05', defaultOwnerId: org.users.emp });
    expect(sat.body.rows[0].dueDate).toBe('2030-01-07');
  });

  it('creates tasks with dates, owners, checklists, review flags and dependencies', async () => {
    const applyKey = key();
    const r = await mgr.post(`/api/templates/${tpl.id}/apply`, { startDate: MON, defaultOwnerId: org.users.emp, assignments: { 2: org.users.emp2 }, applyKey });
    expect(r.status).toBe(200);
    expect(r.body.created).toBe(true);
    const tasks = r.body.tasks;
    expect(tasks.map((t: any) => t.title)).toEqual(steps.map((s) => s.title));
    expect(tasks.map((t: any) => t.due_date)).toEqual(['2030-01-07', '2030-01-11', '2030-01-11', '2030-01-15', null]);
    expect(tasks.map((t: any) => t.owner_id)).toEqual([org.users.emp, org.users.emp2, org.users.emp, org.users.emp, org.users.emp]);
    expect(tasks[2].depends_on_numbers).toEqual([tasks[0].number, tasks[1].number]);

    const d = (await emp2.get(`/api/tasks/${tasks[1].id}`)).body;
    expect(d.task).toMatchObject({ source_type: 'template', requires_review: true, priority: 'high', created_by: org.users.manager });
    expect(d.task.source_ref).toMatchObject({ templateId: tpl.id, version: 1, position: 2 });
    expect(d.dependencies.map((x: any) => x.id)).toEqual([tasks[0].id]);
    const k = (await emp.get(`/api/tasks/${tasks[0].id}`)).body;
    expect(k.checklist.map((c: any) => c.text)).toEqual(['Agenda', 'Invite']);
    expect(k.task.estimate_minutes).toBe(30);
    expect((await emp.get(`/api/tasks/${tasks[3].id}`)).body.task.requires_evidence).toBe(true);

    // the template records its usage; the applier can reopen the result
    const detail = (await mgr.get(`/api/templates/${tpl.id}`)).body;
    expect(detail.usage.count).toBe(1);
    expect(detail.myApplications[0]).toMatchObject({ id: r.body.application.id, task_count: 5 });
    const again = await mgr.get(`/api/template-applications/${r.body.application.id}`);
    expect(again.body.tasks.map((t: any) => t.id)).toEqual(tasks.map((t: any) => t.id));
    expect((await emp.get(`/api/template-applications/${r.body.application.id}`)).status).toBe(403);
  });

  it('is idempotent per apply key, including concurrent retries', async () => {
    const applyKey = key();
    const body = { startDate: MON, defaultOwnerId: org.users.emp, applyKey };
    const [a, b] = await Promise.all([mgr.post(`/api/templates/${tpl.id}/apply`, body), mgr.post(`/api/templates/${tpl.id}/apply`, body)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body.tasks.map((t: any) => t.id)).toEqual(b.body.tasks.map((t: any) => t.id));
    expect([a.body.created, b.body.created].sort()).toEqual([false, true]);
    const c = await mgr.post(`/api/templates/${tpl.id}/apply`, body);
    expect(c.body.created).toBe(false);
    expect(c.body.tasks.map((t: any) => t.id)).toEqual(a.body.tasks.map((t: any) => t.id));
    expect(await count(`select count(*)::int n from tasks where tenant_id = $1 and source_ref->>'applicationId' = $2`, [org.tenantId, a.body.application.id])).toBe(5);
    expect(await count(`select count(*)::int n from task_template_applications where apply_key = $1`, [applyKey])).toBe(1);
    // another user cannot replay someone else's key
    expect((await admin.post(`/api/templates/${tpl.id}/apply`, body)).status).toBe(409);
  });

  it('applies into a project and milestone; checks the milestone belongs to it', async () => {
    const p = (await admin.post('/api/projects', { key: 'TPLA', name: 'Template target' })).body;
    const m = (await admin.post(`/api/projects/${p.id}/milestones`, { name: 'Phase 1' })).body;
    const other = (await admin.post('/api/projects', { key: 'TPLB', name: 'Other project' })).body;
    const bad = await admin.post(`/api/templates/${tpl.id}/apply`, { startDate: MON, projectId: other.id, milestoneId: m.id, applyKey: key() });
    expect(bad.status).toBe(400);
    const r = await admin.post(`/api/templates/${tpl.id}/apply`, { startDate: MON, projectId: p.id, milestoneId: m.id, applyKey: key() });
    expect(r.status).toBe(200);
    const listed = (await admin.get(`/api/tasks?projectId=${p.id}`)).body;
    expect(listed.map((t: any) => t.title).sort()).toEqual(steps.map((s) => s.title).sort());
    expect((await admin.get(`/api/tasks/${r.body.tasks[0].id}`)).body.task.milestone_id).toBe(m.id);
  });
});

describe('permissions', () => {
  let priv: any; let company: any;
  beforeAll(async () => {
    priv = (await emp.post('/api/templates', { name: 'My private routine', items: [{ title: 'Private step', dueOffsetDays: 1 }] })).body;
    company = (await admin.post('/api/templates', { name: 'Company playbook', visibility: 'company', items: [{ title: 'Shared step', dueOffsetDays: 0 }] })).body;
  });

  it('private templates are visible and usable only by their creator', async () => {
    expect(priv.visibility).toBe('private');
    expect((await emp.get(`/api/templates/${priv.id}`)).status).toBe(200);
    for (const c of [emp2, mgr, admin]) {
      expect((await c.get(`/api/templates/${priv.id}`)).status).toBe(404);
      expect((await c.post(`/api/templates/${priv.id}/apply`, { startDate: MON, applyKey: key() })).status).toBe(404);
      expect((await c.get('/api/templates')).body.templates.map((t: any) => t.id)).not.toContain(priv.id);
    }
    expect((await emp.post(`/api/templates/${priv.id}/apply`, { startDate: MON, applyKey: key() })).status).toBe(200);
  });

  it('only managers and system admins publish or edit company templates; edits are versioned', async () => {
    expect((await emp.post('/api/templates', { name: 'Nope', visibility: 'company', items: [{ title: 'x' }] })).status).toBe(403);
    const edit = { name: 'Company playbook v2', category: 'operations', visibility: 'company', items: [{ title: 'Shared step' }, { title: 'New step', dependsOn: [1] }], changeNote: 'Added a step' };
    expect((await emp.put(`/api/templates/${company.id}`, { ...edit, version: 1 })).status).toBe(403);
    const ok = await mgr.put(`/api/templates/${company.id}`, { ...edit, version: 1 });
    expect(ok.status).toBe(200);
    expect(ok.body.version).toBe(2);
    expect((await admin.put(`/api/templates/${company.id}`, { ...edit, version: 1 })).status).toBe(409);
    const d = (await emp.get(`/api/templates/${company.id}`)).body;
    expect(d.items.map((i: any) => i.title)).toEqual(['Shared step', 'New step']);
    expect(d.versions.map((v: any) => v.version)).toEqual([2, 1]);
    expect(d.versions[0].change_note).toBe('Added a step');
    const v1 = (await emp.get(`/api/templates/${company.id}/versions/1`)).body;
    expect(v1.snapshot.name).toBe('Company playbook');
    // applying records the version used
    const r = await emp.post(`/api/templates/${company.id}/apply`, { startDate: MON, applyKey: key() });
    expect(r.body.tasks).toHaveLength(2);
    expect((await emp.get(`/api/tasks/${r.body.tasks[1].id}`)).body.task.source_ref.version).toBe(2);
    // creators cannot make a private copy disappear from others by flipping visibility of someone else's template
    expect((await mgr.put(`/api/templates/${company.id}`, { ...edit, visibility: 'private', version: 2 })).status).toBe(400);
    expect((await emp.post(`/api/templates/${company.id}/archive`, { archived: true })).status).toBe(403);
  });

  it('anyone can duplicate a visible template into a private copy', async () => {
    const dup = await emp.post(`/api/templates/${company.id}/duplicate`, {});
    expect(dup.status).toBe(200);
    expect(dup.body).toMatchObject({ visibility: 'private', created_by: org.users.emp, can_edit: true, name: 'Company playbook v2 (copy)' });
    expect((await emp.get(`/api/templates/${dup.body.id}`)).body.items).toHaveLength(2);
    expect((await emp2.get(`/api/templates/${dup.body.id}`)).status).toBe(404);
    expect((await emp.post(`/api/templates/${company.id}/duplicate`, { visibility: 'company' })).status).toBe(403);
  });

  it('assignment is limited to self, managed people, project members (as project owner) or anyone for admins', async () => {
    const body = (owner: string, extra: object = {}) => ({ startDate: MON, defaultOwnerId: owner, applyKey: key(), ...extra });
    expect((await emp.post(`/api/templates/${company.id}/apply`, body(org.users.emp2))).status).toBe(403);
    expect((await emp.post(`/api/templates/${company.id}/preview`, body(org.users.emp2))).status).toBe(403);
    expect((await mgr.post(`/api/templates/${company.id}/apply`, body(org.users.emp))).status).toBe(200);
    expect((await mgr.post(`/api/templates/${company.id}/apply`, body(org.users.outsider))).status).toBe(403);
    expect((await admin.post(`/api/templates/${company.id}/apply`, body(org.users.outsider))).status).toBe(200);
    // per-step assignment is checked too
    expect((await mgr.post(`/api/templates/${company.id}/apply`, body(org.users.emp, { assignments: { 2: org.users.outsider } }))).status).toBe(403);
    expect((await mgr.post(`/api/templates/${company.id}/apply`, body(org.users.emp, { assignments: { 9: org.users.emp } }))).status).toBe(400);

    // project owner may assign to project members
    const p = (await admin.post('/api/projects', { key: 'EMPP', name: 'Emp-owned project', ownerId: org.users.emp })).body;
    await admin.post(`/api/projects/${p.id}/members`, { userId: org.users.emp2 });
    expect((await emp.post(`/api/templates/${company.id}/apply`, body(org.users.emp2, { projectId: p.id }))).status).toBe(200);
    expect((await emp.post(`/api/templates/${company.id}/apply`, body(org.users.outsider, { projectId: p.id }))).status).toBe(403);
    const assignees = (await emp.get(`/api/templates/assignees?projectId=${p.id}`)).body.map((u: any) => u.id).sort();
    expect(assignees).toEqual([org.users.emp, org.users.emp2].sort());
    expect((await emp.get('/api/templates/assignees')).body.map((u: any) => u.id)).toEqual([org.users.emp]);
  });

  it('other tenants cannot see or apply templates', async () => {
    const other = await makeOrg();
    const oAdmin = await login(other, 'admin');
    expect((await oAdmin.get(`/api/templates/${company.id}`)).status).toBe(404);
    expect((await oAdmin.post(`/api/templates/${company.id}/apply`, { startDate: MON, applyKey: key() })).status).toBe(404);
    expect((await oAdmin.get('/api/templates')).body.templates.map((t: any) => t.id)).not.toContain(company.id);
  });

  it('rejects self, missing and circular dependencies', async () => {
    const mk = (items: object[]) => emp.post('/api/templates', { name: 'Bad deps', items });
    expect((await mk([{ title: 'a', dependsOn: [1] }])).status).toBe(400);
    expect((await mk([{ title: 'a', dependsOn: [3] }, { title: 'b' }])).status).toBe(400);
    const loop = await mk([{ title: 'a', dependsOn: [3] }, { title: 'b', dependsOn: [1] }, { title: 'c', dependsOn: [2] }]);
    expect(loop.status).toBe(400);
    expect(loop.body.message).toMatch(/circular/);
    expect((await mk([])).status).toBe(400);
  });

  it('outsider sees company templates but cannot edit them', async () => {
    const d = (await outsider.get(`/api/templates/${company.id}`)).body;
    expect(d.template.can_edit).toBe(false);
  });
});

describe('save as template from a project', () => {
  it('captures visible tasks with working-day offsets, checklists, review flags and dependencies', async () => {
    const p = (await mgr.post('/api/projects', { key: 'SRC', name: 'Source project', visibility: 'private' })).body;
    const mk = (b: object) => mgr.post('/api/tasks', { projectId: p.id, ...b }).then((r: any) => r.body);
    const t1 = await mk({ title: 'Brief', dueDate: '2030-01-07', checklist: ['Goals', 'Audience'], estimateMinutes: 60 });
    const t2 = await mk({ title: 'Design', dueDate: '2030-01-10', requiresReview: true, priority: 'high' }); // skips the 2030-01-09 holiday
    const t3 = await mk({ title: 'Launch', dueDate: '2030-01-14' });
    await mk({ title: 'Someday idea' });
    const dropped = await mk({ title: 'Dropped', dueDate: '2030-01-08' });
    await mgr.post(`/api/tasks/${dropped.id}/status`, { to: 'cancelled', reason: 'Out of scope' });
    await mgr.post(`/api/tasks/${t2.id}/dependencies`, { dependsOnTaskId: t1.id });
    await mgr.post(`/api/tasks/${t3.id}/dependencies`, { dependsOnTaskId: t2.id });

    // a person who cannot see the private project cannot save it
    expect((await emp.post('/api/templates/from-project', { projectId: p.id, name: 'Steal' })).status).toBe(404);

    const r = await mgr.post('/api/templates/from-project', { projectId: p.id, name: 'Launch playbook', category: 'product' });
    expect(r.status).toBe(200);
    expect(r.body.visibility).toBe('private');
    const d = (await mgr.get(`/api/templates/${r.body.id}`)).body;
    expect(d.items.map((i: any) => [i.title, i.due_offset_days])).toEqual([['Brief', 0], ['Design', 2], ['Launch', 4], ['Someday idea', null]]);
    expect(d.items[0]).toMatchObject({ checklist: ['Goals', 'Audience'], estimate_minutes: 60 });
    expect(d.items[1]).toMatchObject({ requires_review: true, priority: 'high', depends_on: [1] });
    expect(d.items[2].depends_on).toEqual([2]);
    expect(d.template.description).toMatch(/SRC/);

    // round trip: applying it on the original start date reproduces the original due dates
    const ap = await mgr.post(`/api/templates/${r.body.id}/apply`, { startDate: '2030-01-07', applyKey: key() });
    expect(ap.body.tasks.slice(0, 3).map((t: any) => t.due_date)).toEqual(['2030-01-07', '2030-01-10', '2030-01-14']);

    // a subset of tasks can be chosen
    const sub = await mgr.post('/api/templates/from-project', { projectId: p.id, name: 'Two steps', taskIds: [t1.id, t3.id] });
    expect((await mgr.get(`/api/templates/${sub.body.id}`)).body.items.map((i: any) => i.title)).toEqual(['Brief', 'Launch']);
  });
});
