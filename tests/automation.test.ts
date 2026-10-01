import { DateTime } from 'luxon';
import { beforeAll, describe, expect, it } from 'vitest';
import { client, drainJobs, makeOrg, withOwner, type Org } from './helpers.js';
import { enqueue } from '../server/src/lib/jobs.js';
import { newToken, sha256 } from '../server/src/lib/crypto.js';
import { SESSION_COOKIE } from '../server/src/app.js';

type C = ReturnType<typeof client>;
/** Sign in by issuing a session directly (login itself and its rate limit are covered by the security tests). */
async function login(org: Org, key: string): Promise<C> {
  const token = newToken(32);
  await withOwner((db) => db.query(`insert into sessions (token_hash, tenant_id, user_id, expires_at) values ($1,$2,$3, now() + interval '1 day')`,
    [sha256(token), org.tenantId, org.users[key]]));
  return client(`${SESSION_COOKIE}=${token}`);
}
const q = (sql: string, p: unknown[] = []) => withOwner(async (db) => (await db.query(sql, p)).rows);
const notes = (userId: string, kind = 'automation') => q(`select * from notifications where user_id = $1 and kind = $2 order by created_at`, [userId, kind]);
const runsOf = (ruleId: string) => q(`select * from automation_runs where rule_id = $1 order by created_at, id`, [ruleId]);
const today = (org: Org) => DateTime.now().setZone(org.tz).startOf('day');

async function setup() {
  const org = await makeOrg();
  const [admin, mgr, emp, emp2, outsider] = await Promise.all(['admin', 'manager', 'emp', 'emp2', 'outsider'].map((k) => login(org, k)));
  return { org, admin, mgr, emp, emp2, outsider };
}
async function rule(c: C, body: Record<string, unknown>) {
  const r = await c.post('/api/automations', { name: 'Rule', scope: 'company', conditions: {}, ...body });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
}

describe('rule permissions', () => {
  let s: Awaited<ReturnType<typeof setup>>;
  beforeAll(async () => { s = await setup(); });
  const def = { name: 'Notify on create', trigger: { type: 'task.created' }, actions: [{ type: 'notify', target: 'owner' }] };

  it('only system admins create company rules; managers create team rules; others view only', async () => {
    expect((await s.emp.post('/api/automations', { ...def, scope: 'company' })).status).toBe(403);
    expect((await s.emp.post('/api/automations', { ...def, scope: 'team' })).status).toBe(403);
    expect((await s.mgr.post('/api/automations', { ...def, scope: 'company' })).status).toBe(403);
    const team = await s.mgr.post('/api/automations', { ...def, scope: 'team' });
    expect(team.status).toBe(200);
    const company = await s.admin.post('/api/automations', { ...def, scope: 'company' });
    expect(company.status).toBe(200);
    const view = await s.emp.get('/api/automations');
    expect(view.status).toBe(200);
    expect(view.body.permissions).toEqual({ company: false, team: false });
    expect(view.body.rules.every((r: any) => r.can_edit === false)).toBe(true);
    expect(view.body.presets.length).toBeGreaterThanOrEqual(4);
    // Managers cannot change company rules; admins can change any rule; owners can change their team rule.
    expect((await s.mgr.patch(`/api/automations/${company.body.id}/enabled`, { enabled: false, version: 1 })).status).toBe(403);
    expect((await s.emp.patch(`/api/automations/${team.body.id}/enabled`, { enabled: false, version: 1 })).status).toBe(403);
    expect((await s.mgr.patch(`/api/automations/${team.body.id}/enabled`, { enabled: false, version: 1 })).body.enabled).toBe(false);
    expect((await s.mgr.patch(`/api/automations/${team.body.id}/enabled`, { enabled: true, version: 1 })).status).toBe(409);
    expect((await s.admin.patch(`/api/automations/${team.body.id}/enabled`, { enabled: true, version: 2 })).body.enabled).toBe(true);
    const audits = await q(`select action, authority from audit_events where resource_id = $1 order by id`, [team.body.id]);
    expect(audits.map((x) => x.action)).toEqual(['automation_rule.create', 'automation_rule.disable', 'automation_rule.enable']);
  });

  it('team rules may only reference the manager and their team; inputs are validated', async () => {
    const bad = await s.mgr.post('/api/automations', { ...def, scope: 'team', conditions: { ownerIds: [s.org.users.outsider] } });
    expect(bad.status).toBe(400);
    const badAssign = await s.mgr.post('/api/automations', { ...def, scope: 'team', actions: [{ type: 'assign', userId: s.org.users.outsider }] });
    expect(badAssign.status).toBe(400);
    expect((await s.admin.post('/api/automations', { ...def, actions: [{ type: 'notify', target: 'user' }] })).status).toBe(400);
    expect((await s.admin.post('/api/automations', { ...def, actions: [] })).status).toBe(400);
    expect((await s.admin.post('/api/automations', { ...def, trigger: { type: 'task.exploded' } })).status).toBe(400);
  });

  it('edits use optimistic versions, scope is fixed, and archiving keeps history', async () => {
    const r = await rule(s.admin, { ...def, name: 'Editable' });
    const up = await s.admin.put(`/api/automations/${r.id}`, { ...def, scope: 'company', name: 'Edited', version: 1 });
    expect(up.body).toMatchObject({ name: 'Edited', version: 2 });
    expect((await s.admin.put(`/api/automations/${r.id}`, { ...def, scope: 'company', name: 'Stale', version: 1 })).status).toBe(409);
    expect((await s.admin.put(`/api/automations/${r.id}`, { ...def, scope: 'team', version: 2 })).status).toBe(400);
    expect((await s.admin.del(`/api/automations/${r.id}`)).status).toBe(200);
    const list = (await s.admin.get('/api/automations')).body.rules;
    expect(list.find((x: any) => x.id === r.id)).toBeUndefined();
    expect((await q(`select archived_at from automation_rules where id = $1`, [r.id]))[0].archived_at).toBeTruthy();
  });
});

describe('event triggers and actions', () => {
  let s: Awaited<ReturnType<typeof setup>>;
  beforeAll(async () => { s = await setup(); });

  it('task.created: set reviewer to the owner\'s manager and add a checklist item, audited as the rule', async () => {
    const r = await rule(s.admin, { name: 'Urgent work gets a reviewer', trigger: { type: 'task.created' }, conditions: { priorities: ['urgent'], tags: ['t-created'] },
      actions: [{ type: 'set_reviewer', target: 'manager' }, { type: 'add_checklist_item', text: 'Second pair of eyes before closing' }] });
    const plain = (await s.emp.post('/api/tasks', { title: 'Not urgent', tags: ['t-created'] })).body;
    const t = (await s.emp.post('/api/tasks', { title: 'Hotfix checkout', priority: 'urgent', tags: ['t-created'] })).body;
    const d = (await s.emp.get(`/api/tasks/${t.id}`)).body;
    expect(d.task).toMatchObject({ reviewer_id: s.org.users.manager, requires_review: true });
    expect(d.checklist.map((c: any) => c.text)).toEqual(['Second pair of eyes before closing']);
    expect((await s.emp.get(`/api/tasks/${plain.id}`)).body.task.reviewer_id).toBeNull();
    const runs = await runsOf(r.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'success', task_id: t.id, trigger: 'task.created' });
    const audits = await q(`select action from audit_events where authority = $1 order by id`, [`automation_rule:${r.id}`]);
    expect(audits.map((x) => x.action)).toEqual(['task.update', 'checklist.add']);
  });

  it('task.status_changed with from/to filters: notify the owner\'s manager and comment', async () => {
    const r = await rule(s.admin, { name: 'Escalate blocked finance', trigger: { type: 'task.status_changed', from: 'in_progress', to: 'blocked' },
      conditions: { categories: ['finance'] }, actions: [{ type: 'notify', target: 'manager', message: 'Blocked: {task.title}' }, { type: 'add_comment', text: 'Escalated.' }] });
    const fromPlanned = (await s.emp.post('/api/tasks', { title: 'Vendor payment (planned)', category: 'finance' })).body;
    await s.emp.post(`/api/tasks/${fromPlanned.id}/status`, { to: 'blocked', blocker: { reason: 'Waiting on bank' } });
    expect(await runsOf(r.id)).toHaveLength(0);
    const t = (await s.emp.post('/api/tasks', { title: 'Vendor payment', category: 'finance', status: 'in_progress' })).body;
    const res = await s.emp.post(`/api/tasks/${t.id}/status`, { to: 'blocked', blocker: { reason: 'Waiting on bank' } });
    expect(res.body.status).toBe('blocked');
    const n = (await notes(s.org.users.manager)).filter((x) => x.link === `/tasks/${t.id}`);
    expect(n.map((x) => x.title)).toEqual(['Blocked: Vendor payment']);
    const d = (await s.emp.get(`/api/tasks/${t.id}`)).body;
    expect(d.comments.some((c: any) => c.kind === 'system' && c.body === 'Automation · Escalate blocked finance: Escalated.')).toBe(true);
    expect((await runsOf(r.id)).map((x) => x.status)).toEqual(['success']);
  });

  it('blocker.raised: notify a specific person', async () => {
    const r = await rule(s.admin, { name: 'Blockers to emp2', trigger: { type: 'blocker.raised' }, conditions: { tags: ['t-blocker'] },
      actions: [{ type: 'notify', target: 'user', userId: s.org.users.emp2 }] });
    const t = (await s.emp.post('/api/tasks', { title: 'API integration', tags: ['t-blocker'] })).body;
    await s.emp.post(`/api/tasks/${t.id}/status`, { to: 'blocked', blocker: { reason: 'Need staging access' } });
    expect((await notes(s.org.users.emp2)).filter((x) => x.link === `/tasks/${t.id}`)).toHaveLength(1);
    expect((await runsOf(r.id))[0]).toMatchObject({ status: 'success', trigger: 'blocker.raised' });
  });

  it('task.reviewed (changes requested): create a follow-up task from the title template; accepted reviews do not fire', async () => {
    const r = await rule(s.admin, { name: 'Follow up review', trigger: { type: 'task.reviewed', decision: 'changes_requested' }, conditions: { tags: ['t-review'] },
      actions: [{ type: 'create_follow_up', title: 'Address review feedback: {task.title}', owner: 'owner', dueInDays: 2 }, { type: 'notify', target: 'reviewer' }] });
    const t = (await s.emp.post('/api/tasks', { title: 'Feature X', tags: ['t-review'], requiresReview: true, reviewerId: s.org.users.emp2 })).body;
    await s.emp.post(`/api/tasks/${t.id}/status`, { to: 'in_review' });
    const rev = await s.emp2.post(`/api/tasks/${t.id}/review`, { decision: 'changes_requested', note: 'Add tests' });
    expect(rev.body.status).toBe('in_progress');
    const fu = await q(`select * from tasks where source_type = 'automation' and tenant_id = $1 and title = $2`, [s.org.tenantId, 'Address review feedback: Feature X']);
    expect(fu).toHaveLength(1);
    expect(fu[0]).toMatchObject({ owner_id: s.org.users.emp, due_date: today(s.org).plus({ days: 2 }).toISODate(), source_ref: { ruleId: r.id, taskId: t.id } });
    expect((await notes(s.org.users.emp, 'task_assigned')).some((x) => x.link === `/tasks/${fu[0].id}`)).toBe(true);
    expect((await q(`select authority from audit_events where action = 'task.create' and resource_id = $1`, [fu[0].id]))[0].authority).toBe(`automation_rule:${r.id}`);
    await s.emp.post(`/api/tasks/${t.id}/status`, { to: 'in_review' });
    await s.emp2.post(`/api/tasks/${t.id}/review`, { decision: 'accepted', note: 'Good' });
    expect(await runsOf(r.id)).toHaveLength(1);
  });

  it('task.reopened: set priority (no-op actions are recorded as skipped)', async () => {
    const r = await rule(s.admin, { name: 'Reopened is urgent', trigger: { type: 'task.reopened' }, conditions: { tags: ['t-reopen'] }, actions: [{ type: 'set_priority', priority: 'urgent' }] });
    const t = (await s.emp.post('/api/tasks', { title: 'Close books', tags: ['t-reopen'] })).body;
    await s.emp.post(`/api/tasks/${t.id}/status`, { to: 'done' });
    const re = await s.emp.post(`/api/tasks/${t.id}/reopen`, { reason: 'Numbers were wrong' });
    expect(re.status).toBe(200);
    expect((await s.emp.get(`/api/tasks/${t.id}`)).body.task.priority).toBe('urgent');
    await s.emp.post(`/api/tasks/${t.id}/status`, { to: 'done' });
    await s.emp.post(`/api/tasks/${t.id}/reopen`, { reason: 'Again' });
    expect((await runsOf(r.id)).map((x) => x.status)).toEqual(['success', 'skipped']);
  });

  it('assign to a user and post a comment', async () => {
    const r = await rule(s.admin, { name: 'Intake to emp2', trigger: { type: 'task.created' }, conditions: { tags: ['t-intake'] },
      actions: [{ type: 'assign', userId: s.org.users.emp2 }] });
    const t = (await s.emp.post('/api/tasks', { title: 'Office access request', tags: ['t-intake'] })).body;
    const row = (await q(`select owner_id, version from tasks where id = $1`, [t.id]))[0];
    expect(row.owner_id).toBe(s.org.users.emp2);
    expect((await notes(s.org.users.emp2, 'task_assigned')).some((x) => x.link === `/tasks/${t.id}`)).toBe(true);
    expect((await q(`select 1 from audit_events where action = 'task.reassign' and authority = $1`, [`automation_rule:${r.id}`]))).toHaveLength(1);
  });

  it('disabled rules do not fire', async () => {
    const r = await rule(s.admin, { name: 'Off', enabled: false, trigger: { type: 'task.created' }, conditions: { tags: ['t-off'] }, actions: [{ type: 'notify', target: 'owner' }] });
    await s.emp.post('/api/tasks', { title: 'Nothing happens', tags: ['t-off'] });
    expect(await runsOf(r.id)).toHaveLength(0);
  });
});

describe('engine safety', () => {
  let s: Awaited<ReturnType<typeof setup>>;
  beforeAll(async () => { s = await setup(); });

  it('loop guard: automation chains stop at depth 3 and record a skipped run', async () => {
    const [p] = await q(`insert into projects (tenant_id, key, name) values ($1,'LOOP','Loop test') returning id`, [s.org.tenantId]);
    const r = await rule(s.admin, { name: 'Follow-up on every new task', trigger: { type: 'task.created' }, conditions: { projectIds: [p.id] },
      actions: [{ type: 'create_follow_up', title: 'Next: {task.title}', owner: 'owner' }] });
    const t = await s.emp.post('/api/tasks', { title: 'Seed', projectId: p.id });
    expect(t.status).toBe(200);
    const tasks = await q(`select title from tasks where project_id = $1 order by number`, [p.id]);
    expect(tasks.map((x) => x.title)).toEqual(['Seed', 'Next: Seed', 'Next: Next: Seed', 'Next: Next: Next: Seed']);
    const runs = (await runsOf(r.id)).sort((x, y) => x.depth - y.depth);
    expect(runs.map((x) => [x.status, x.depth])).toEqual([['success', 0], ['success', 1], ['success', 2], ['skipped', 3]]);
    expect(runs[3].message).toMatch(/Loop guard/);
  });

  it('a failing rule records a failed run, rolls back its own partial work, and never breaks the original action', async () => {
    const r = await rule(s.admin, { name: 'Broken template', trigger: { type: 'task.created' }, conditions: { tags: ['t-fail'] },
      actions: [{ type: 'add_comment', text: 'This comment must be rolled back' }, { type: 'create_follow_up', title: '{project.key}', owner: 'owner' }] });
    const ok = await rule(s.admin, { name: 'Still works', trigger: { type: 'task.created' }, conditions: { tags: ['t-fail'] }, actions: [{ type: 'add_checklist_item', text: 'Later rule ran' }] });
    const t = await s.emp.post('/api/tasks', { title: 'Task without project', tags: ['t-fail'] });
    expect(t.status).toBe(200);
    const d = (await s.emp.get(`/api/tasks/${t.body.id}`)).body;
    expect(d.task.title).toBe('Task without project');
    expect(d.comments.filter((c: any) => c.kind === 'system')).toHaveLength(0);
    expect(d.checklist.map((c: any) => c.text)).toEqual(['Later rule ran']);
    const runs = await runsOf(r.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('failed');
    expect(runs[0].message).toMatch(/Action 2 \(create follow up\)/);
    expect((await runsOf(ok.id))[0].status).toBe('success');
    // The person's next action keeps working in the same session.
    expect((await s.emp.post(`/api/tasks/${t.body.id}/status`, { to: 'in_progress' })).body.status).toBe('in_progress');
  });

  it('team rules only match tasks owned by the manager\'s team, enforced at evaluation time', async () => {
    const r = await rule(s.mgr, { name: 'Team intake', scope: 'team', trigger: { type: 'task.created' }, conditions: { tags: ['t-team'] },
      actions: [{ type: 'add_comment', text: 'Team rule ran' }] });
    const ping = await rule(s.mgr, { name: 'Team ping', scope: 'team', trigger: { type: 'task.created' }, conditions: { tags: ['t-team2'] },
      actions: [{ type: 'notify', target: 'user', userId: s.org.users.emp2 }] });
    const mine = (await s.emp.post('/api/tasks', { title: 'Team member task', tags: ['t-team'] })).body;
    await s.outsider.post('/api/tasks', { title: 'Outsider task', tags: ['t-team'] });
    expect((await runsOf(r.id)).map((x) => x.task_id)).toEqual([mine.id]);
    // emp2 leaves the team: the saved rule no longer reaches them, even as a notification target.
    await q(`delete from team_members where user_id = $1`, [s.org.users.emp2]);
    const t2 = (await s.emp.post('/api/tasks', { title: 'Ping emp2', tags: ['t-team2'] })).body;
    const pr = await runsOf(ping.id);
    expect(pr).toHaveLength(1);
    expect(pr[0]).toMatchObject({ status: 'skipped', task_id: t2.id });
    expect(pr[0].message).toMatch(/no longer on the rule owner's team/);
    expect((await notes(s.org.users.emp2)).filter((x) => x.link === `/tasks/${t2.id}`)).toHaveLength(0);
    // emp leaves the team: their new tasks are out of scope for the manager's rules.
    await q(`delete from team_members where user_id = $1`, [s.org.users.emp]);
    await s.emp.post('/api/tasks', { title: 'After leaving the team', tags: ['t-team'] });
    expect(await runsOf(r.id)).toHaveLength(1);
  });
});

describe('dry run', () => {
  let s: Awaited<ReturnType<typeof setup>>;
  beforeAll(async () => { s = await setup(); });
  const counts = (tenantId: string) => q(`select (select count(*) from notifications where tenant_id = $1)::int n, (select count(*) from comments where tenant_id = $1)::int c,
    (select count(*) from checklist_items where tenant_id = $1)::int ci, (select count(*) from tasks where tenant_id = $1)::int t,
    (select count(*) from automation_runs where tenant_id = $1)::int r, (select count(*) from audit_events where tenant_id = $1)::int a,
    (select sum(version) from tasks where tenant_id = $1)::int v`, [tenantId]).then((r) => r[0]);

  it('reports what would happen without changing anything', async () => {
    const t = (await s.emp.post('/api/tasks', { title: 'Reconcile bank', category: 'finance', status: 'in_progress', reviewerId: s.org.users.emp2 })).body;
    const draft = { name: 'Everything', scope: 'company', trigger: { type: 'task.status_changed', to: 'blocked' }, conditions: { categories: ['finance'] },
      actions: [{ type: 'notify', target: 'manager' }, { type: 'create_follow_up', title: 'Unblock: {task.title}', owner: 'manager', dueInDays: 1 },
        { type: 'set_priority', priority: 'urgent' }, { type: 'set_reviewer', target: 'manager' }, { type: 'add_checklist_item', text: 'Escalate' },
        { type: 'add_comment', text: 'Heads up' }] };
    const before = await counts(s.org.tenantId);
    const r = await s.admin.post('/api/automations/test', { taskId: t.id, rule: draft });
    expect(r.status).toBe(200);
    expect(r.body.wouldRun).toBe(true);
    expect(r.body.actions.map((x: any) => x.summary)).toEqual([
      'Notify Manager (the owner\'s manager)', `Create follow-up "Unblock: Reconcile bank" for Manager, due ${today(s.org).plus({ days: 1 }).toISODate()}`,
      'Set priority medium to urgent', 'Make Manager the reviewer (review required)', 'Add checklist item "Escalate"', 'Post a comment on the task']);
    expect(await counts(s.org.tenantId)).toEqual(before);
    // Saved rule + non-matching task: explains which check failed.
    const saved = await rule(s.admin, { ...draft, name: 'Saved' });
    const other = (await s.emp.post('/api/tasks', { title: 'Design review', category: 'delivery' })).body;
    const before2 = await counts(s.org.tenantId);
    const r2 = await s.emp.post('/api/automations/test', { taskId: other.id, ruleId: saved.id });
    expect(r2.body.wouldRun).toBe(false);
    expect(r2.body.checks.find((c: any) => c.label === 'Category')).toMatchObject({ ok: false });
    expect(await counts(s.org.tenantId)).toEqual(before2);
  });

  it('only rule authors can test drafts, and only on tasks they can see', async () => {
    const t = (await s.emp.post('/api/tasks', { title: 'Private-ish' })).body;
    const draft = { name: 'D', scope: 'company', trigger: { type: 'task.created' }, actions: [{ type: 'notify', target: 'owner' }] };
    expect((await s.emp.post('/api/automations/test', { taskId: t.id, rule: draft })).status).toBe(403);
    expect((await s.outsider.post('/api/automations/test', { taskId: t.id, rule: { ...draft, scope: 'team' } })).status).toBe(403);
    const saved = await rule(s.admin, draft);
    expect((await s.outsider.post('/api/automations/test', { taskId: t.id, ruleId: saved.id })).status).toBe(404);
  });
});

describe('time-based triggers', () => {
  let s: Awaited<ReturnType<typeof setup>>;
  beforeAll(async () => { s = await setup(); });
  const tick = async (org: Org, key: string) => {
    await withOwner((db) => enqueue(db, { tenantId: org.tenantId, kind: 'automation.time_rules', idempotencyKey: `test-${org.tenantId}-${key}` }));
    await drainJobs();
  };

  it('due soon and overdue fire once per rule, task and due date, however often the tick runs', async () => {
    const d0 = today(s.org);
    const soon = await rule(s.admin, { name: 'Due tomorrow', trigger: { type: 'task.due_soon', days: 1 }, conditions: { tags: ['t-time'] },
      actions: [{ type: 'notify', target: 'owner', message: 'Due {task.due}: {task.title}' }] });
    const late = await rule(s.admin, { name: 'Overdue', trigger: { type: 'task.overdue', days: 1 }, conditions: { tags: ['t-time'] },
      actions: [{ type: 'notify', target: 'manager', message: 'Overdue: {task.title}' }] });
    const tomorrow = (await s.emp.post('/api/tasks', { title: 'Due tomorrow', tags: ['t-time'], dueDate: d0.plus({ days: 1 }).toISODate() })).body;
    const nextWeek = (await s.emp.post('/api/tasks', { title: 'Due next week', tags: ['t-time'], dueDate: d0.plus({ days: 7 }).toISODate() })).body;
    const overdue = (await s.emp.post('/api/tasks', { title: 'Overdue report', tags: ['t-time'], dueDate: d0.minus({ days: 2 }).toISODate() })).body;
    const doneLate = (await s.emp.post('/api/tasks', { title: 'Done already', tags: ['t-time'], dueDate: d0.minus({ days: 2 }).toISODate() })).body;
    await s.emp.post(`/api/tasks/${doneLate.id}/status`, { to: 'done' });
    await tick(s.org, 'a');
    await tick(s.org, 'b');
    await tick(s.org, 'c');
    expect((await runsOf(soon.id)).map((x) => x.task_id)).toEqual([tomorrow.id]);
    expect((await runsOf(late.id)).map((x) => x.task_id)).toEqual([overdue.id]);
    const empNotes = (await notes(s.org.users.emp)).filter((x) => x.link === `/tasks/${tomorrow.id}`);
    expect(empNotes).toHaveLength(1);
    expect(empNotes[0].title).toBe(`Due ${d0.plus({ days: 1 }).toFormat('d LLL')}: Due tomorrow`);
    expect((await notes(s.org.users.manager)).filter((x) => x.link === `/tasks/${overdue.id}`)).toHaveLength(1);
    expect((await notes(s.org.users.emp)).filter((x) => x.link === `/tasks/${nextWeek.id}`)).toHaveLength(0);
    // Moving the due date gives the task a fresh reminder for the new date.
    const cur = (await q(`select version from tasks where id = $1`, [tomorrow.id]))[0];
    await s.emp.patch(`/api/tasks/${tomorrow.id}`, { dueDate: d0.toISODate(), version: cur.version });
    await tick(s.org, 'd');
    expect(await runsOf(soon.id)).toHaveLength(2);
  });

  it('time rules respect team scope too', async () => {
    const r = await rule(s.mgr, { name: 'Team due soon', scope: 'team', trigger: { type: 'task.due_soon', days: 0 }, conditions: { tags: ['t-time-team'] },
      actions: [{ type: 'notify', target: 'owner' }] });
    const d0 = today(s.org).toISODate();
    const mine = (await s.emp2.post('/api/tasks', { title: 'Team due today', tags: ['t-time-team'], dueDate: d0 })).body;
    await s.outsider.post('/api/tasks', { title: 'Outsider due today', tags: ['t-time-team'], dueDate: d0 });
    await tick(s.org, 'team');
    expect((await runsOf(r.id)).map((x) => x.task_id)).toEqual([mine.id]);
  });
});

describe('run log', () => {
  it('lists runs with task titles only for tasks the viewer can see', async () => {
    const s = await setup();
    const r = await rule(s.admin, { name: 'Log me', trigger: { type: 'task.created' }, conditions: { tags: ['t-log'] }, actions: [{ type: 'add_comment', text: 'Logged' }] });
    const t = (await s.emp.post('/api/tasks', { title: 'Visible to emp', tags: ['t-log'] })).body;
    const mine = await s.emp.get(`/api/automations/runs?ruleId=${r.id}`);
    expect(mine.body[0]).toMatchObject({ rule_name: 'Log me', status: 'success', task_id: t.id, task_title: 'Visible to emp', task_visible: true });
    const other = await s.outsider.get(`/api/automations/runs?ruleId=${r.id}`);
    expect(other.body[0]).toMatchObject({ task_title: null, task_visible: false });
    const list = (await s.admin.get('/api/automations')).body.rules.find((x: any) => x.id === r.id);
    expect(list).toMatchObject({ last_status: 'success', success_7d: 1 });
  });
});
