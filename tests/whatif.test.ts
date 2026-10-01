import { beforeAll, describe, expect, it } from 'vitest';
import { login, makeOrg, withOwner, type Org } from './helpers.js';
import { schedule, type SimDay, type SimTask } from '../server/src/services/ext/whatif.js';

/*
 * Fixed fixture. Schedules are Mon-Fri 09:00-17:00 with a 60 minute break = 420 available minutes per working day.
 * Horizon: Mon 2030-01-07 .. Sun 2030-01-20 (10 working days, 4200 minutes per person).
 *   emp:  A 840m due Tue 01-08 (high) | B 420m due Thu 01-10 | C no estimate, due Fri 01-11
 *   emp2: E 1260m due Tue 01-08 (late by 1 day in the baseline) | F 300m, 120m logged, undated | G 60m, 90m logged, undated
 */
const START = '2030-01-07';
let org: Org; let emp: any; let emp2: any; let mgr: any; let admin: any; let outsider: any; let founder: any;
const T: Record<string, any> = {};
const sim = (c: any, body: any) => c.post('/api/whatif/simulate', { start: START, horizonDays: 14, ...body });
const task = (r: any, key: string) => r.body.tasks.find((t: any) => t.id === T[key].id);
const person = (r: any, key: string) => r.body.people.find((p: any) => p.id === org.users[key]);

beforeAll(async () => {
  org = await makeOrg();
  [emp, emp2, mgr, admin, outsider, founder] = await Promise.all(['emp', 'emp2', 'manager', 'admin', 'outsider', 'founder'].map((k) => login(org, k)));
  T.A = (await emp.post('/api/tasks', { title: 'Task A', estimateMinutes: 840, dueDate: '2030-01-08', priority: 'high' })).body;
  T.B = (await emp.post('/api/tasks', { title: 'Task B', estimateMinutes: 420, dueDate: '2030-01-10', priority: 'medium' })).body;
  T.C = (await emp.post('/api/tasks', { title: 'Task C', dueDate: '2030-01-11', priority: 'medium' })).body;
  T.E = (await emp2.post('/api/tasks', { title: 'Task E', estimateMinutes: 1260, dueDate: '2030-01-08', priority: 'medium' })).body;
  T.F = (await emp2.post('/api/tasks', { title: 'Task F', estimateMinutes: 300 })).body;
  T.G = (await emp2.post('/api/tasks', { title: 'Task G', estimateMinutes: 60 })).body;
  T.done = (await emp.post('/api/tasks', { title: 'Finished thing', estimateMinutes: 30 })).body;
  await emp.post(`/api/tasks/${T.done.id}/status`, { to: 'done' });
  await emp.post('/api/tasks', { title: 'Someday idea', estimateMinutes: 9000, status: 'backlog' });
  await withOwner(async (db) => {
    for (const [k, min] of [['F', 120], ['G', 90]] as const)
      await db.query(`insert into time_entries (tenant_id, user_id, task_id, category, started_at, ended_at, source) values ($1,$2,$3,'task', now() - make_interval(mins => $4), now(), 'manual')`,
        [org.tenantId, org.users.emp2, T[k].id, min]);
  });
});

describe('what-if simulation correctness', () => {
  it('baseline fills each person greedily by due date then priority', async () => {
    const r = await sim(mgr, { people: [org.users.emp, org.users.emp2] });
    expect(r.status).toBe(200);
    expect(r.body.end).toBe('2030-01-20');
    expect(task(r, 'A').baseline).toMatchObject({ finish: '2030-01-08', late: false });
    expect(task(r, 'B').baseline).toMatchObject({ finish: '2030-01-09', late: false });
    expect(task(r, 'C').baseline).toMatchObject({ finish: '2030-01-10', late: false });
    expect(task(r, 'E').baseline).toMatchObject({ finish: '2030-01-09', late: true, lateDays: 1 });
    expect(r.body.tasks.map((t: any) => t.title)).not.toContain('Finished thing');
    expect(r.body.tasks.map((t: any) => t.title)).not.toContain('Someday idea');
    const e = person(r, 'emp');
    expect(e.baseline).toMatchObject({ availableMinutes: 4200, workingDays: 10, demandMinutes: 840 + 420 + 60, scheduledMinutes: 1320, spareMinutes: 2880, overflowMinutes: 0, lateTasks: 0 });
    expect(e.baseline.days.find((d: any) => d.date === '2030-01-12')).toMatchObject({ status: 'non_working', capacity: 0 });
    expect(person(r, 'emp2').baseline.lateTasks).toBe(1);
    // No changes: scenario equals baseline.
    expect(r.body.summary).toMatchObject({ newlyLate: 0, recovered: 0, baselineLate: 1, scenarioLate: 1 });
    expect(r.body.findings[0]).toMatch(/No changes/);
    expect(r.body.assumptions.join(' ')).toMatch(/not a performance measure/);
  });

  it('remaining work subtracts logged time; an exhausted estimate falls back to the explicit assumption', async () => {
    const r = await sim(emp2, {});
    expect(task(r, 'F')).toMatchObject({ remainingMinutes: 180, assumption: null });
    expect(task(r, 'G')).toMatchObject({ remainingMinutes: 60, assumption: 'estimate_used_up' });
    expect(r.body.unestimated.map((u: any) => u.id)).toContain(T.G.id);
  });

  it('simulated leave removes working days and pushes deadlines out', async () => {
    const r = await sim(mgr, { people: [org.users.emp, org.users.emp2], changes: [{ type: 'leave', userId: org.users.emp, start: '2030-01-07', end: '2030-01-08' }] });
    expect(r.status).toBe(200);
    expect(task(r, 'A').scenario).toMatchObject({ finish: '2030-01-10', late: true, lateDays: 2 });
    expect(task(r, 'A')).toMatchObject({ change: 'newly_late', shiftDays: 2 });
    expect(task(r, 'B').change).toBe('newly_late');
    expect(task(r, 'C').change).toBe('newly_late');
    expect(r.body.summary.newlyLate).toBe(3);
    const e = person(r, 'emp');
    expect(e.simulatedLeaveDays).toBe(2);
    expect(e.scenario.availableMinutes).toBe(4200 - 840);
    expect(e.scenario.days[0]).toMatchObject({ date: '2030-01-07', status: 'simulated_leave', capacity: 0 });
    expect(r.body.findings.join(' ')).toMatch(/Leave for Emp from .* removes 14h of working time across 2 working days/);
    expect(r.body.findings.join(' ')).toMatch(/3 tasks would become late: "Task A" \(due Tue 8 Jan, projected Thu 10 Jan\)/);
  });

  it('reassigning the slipping task to someone with room brings it back on time', async () => {
    const r = await sim(mgr, { people: [org.users.emp], changes: [
      { type: 'leave', userId: org.users.emp, start: '2030-01-07', end: '2030-01-08' },
      { type: 'reassign', taskId: T.A.id, toUserId: org.users.emp2 },
    ] });
    expect(r.status).toBe(200);
    // emp2 was pulled into the simulation automatically because the change references them.
    expect(person(r, 'emp2')).toBeTruthy();
    expect(task(r, 'A')).toMatchObject({ ownerId: org.users.emp2, baselineOwnerId: org.users.emp, change: 'same' });
    expect(task(r, 'A').scenario).toMatchObject({ finish: '2030-01-08', late: false });
    expect(task(r, 'B').scenario).toMatchObject({ finish: '2030-01-09', late: false });
    // E now waits behind A (same due date, higher priority) and slips further.
    expect(task(r, 'E')).toMatchObject({ change: 'later', shiftDays: 2 });
    expect(task(r, 'E').scenario).toMatchObject({ finish: '2030-01-11', lateDays: 3 });
    expect(r.body.summary.newlyLate).toBe(0);
    expect(r.body.findings.join(' ')).toMatch(/"Task A" moves from Emp to Emp2 \(14h of remaining work\)/);
  });

  it('a moved deadline recovers a late task', async () => {
    const r = await sim(emp2, { changes: [{ type: 'deadline', taskId: T.E.id, dueDate: '2030-01-10' }] });
    expect(task(r, 'E')).toMatchObject({ change: 'recovered', dueDate: '2030-01-10', baselineDueDate: '2030-01-08' });
    expect(r.body.summary.recovered).toBe(1);
    expect(r.body.findings.join(' ')).toMatch(/back on time/);
  });

  it('allocation scales daily capacity', async () => {
    const r = await sim(emp, { changes: [{ type: 'allocation', userId: org.users.emp, percent: 50 }] });
    const e = person(r, 'emp');
    expect(e.allocationPercent).toBe(50);
    expect(e.scenario.availableMinutes).toBe(2100);
    expect(e.scenario.days[0].capacity).toBe(210);
    expect(task(r, 'A').scenario).toMatchObject({ finish: '2030-01-10', late: true });
    expect(task(r, 'B').scenario.finish).toBe('2030-01-14');
    expect(r.body.findings.join(' ')).toMatch(/Emp at 50% allocation: available time in the horizon goes from 70h to 35h/);
  });

  it('the unestimated-work assumption is explicit and changes the projection', async () => {
    const r1 = await sim(emp, { unestimatedMinutes: 480 });
    expect(r1.body.unestimated).toEqual([expect.objectContaining({ id: T.C.id, assumedMinutes: 480, assumption: 'unestimated', reason: 'No estimate on the task' })]);
    expect(task(r1, 'C').scenario).toMatchObject({ finish: '2030-01-11', late: false });
    expect(r1.body.assumptions.join(' ')).toMatch(/assumed to need 8h each/);
    const r2 = await sim(emp, { unestimatedMinutes: 900 });
    expect(task(r2, 'C').scenario).toMatchObject({ finish: '2030-01-14', late: true });
  });

  it('adds hypothetical work and reports work that does not fit the horizon', async () => {
    const r = await sim(emp2, { changes: [{ type: 'add_task', ownerId: org.users.emp2, title: 'Urgent client fix', estimateMinutes: 420, dueDate: '2030-01-07' }] });
    const added = r.body.tasks.find((t: any) => t.hypothetical);
    expect(added).toMatchObject({ id: null, change: 'added', title: 'Urgent client fix' });
    expect(added.scenario).toMatchObject({ finish: '2030-01-07', late: false });
    expect(task(r, 'E').scenario.finish).toBe('2030-01-10');
    const big = await sim(emp2, { horizonDays: 5, changes: [{ type: 'add_task', ownerId: org.users.emp2, title: 'Huge', estimateMinutes: 3000, dueDate: '2030-01-09' }] });
    const h = big.body.tasks.find((t: any) => t.hypothetical);
    expect(h.scenario).toMatchObject({ finish: null, beyondHorizon: true, late: true });
    expect(person(big, 'emp2').scenario.overflowMinutes).toBeGreaterThan(0);
    expect(big.body.findings.join(' ')).toMatch(/does not fit before/);
  });

  it('pure scheduler: zero-capacity days are skipped and finish dates are deterministic', () => {
    const days = new Map<string, SimDay[]>([['p', [
      { date: '2030-01-07', status: 'working', capacity: 100, simulatedLeave: false },
      { date: '2030-01-08', status: 'holiday', capacity: 0, simulatedLeave: false },
      { date: '2030-01-09', status: 'working', capacity: 100, simulatedLeave: false }]]]);
    const mk = (key: string, remaining: number, dueDate: string | null, priority = 'medium'): SimTask => ({ key, id: key, number: 1, title: key, visible: true, ownerId: 'p', status: 'planned',
      priority, dueDate, estimateMinutes: remaining, loggedMinutes: 0, remaining, assumption: null, hypothetical: false });
    const run = schedule(days, [mk('later', 50, null), mk('x', 150, '2030-01-09', 'low'), mk('y', 20, '2030-01-09', 'urgent')], '2030-01-07');
    expect(run.finish.get('y')).toBe('2030-01-07');
    expect(run.finish.get('x')).toBe('2030-01-09');
    expect(run.finish.get('later')).toBe(null);
    expect(run.people.get('p')).toMatchObject({ scheduled: 200, demand: 220, used: [100, 0, 100] });
  });
});

describe('what-if scope', () => {
  it('employees can only simulate themselves', async () => {
    expect((await sim(emp, {})).status).toBe(200);
    expect((await sim(emp, { people: [org.users.emp2] })).status).toBe(403);
    expect((await sim(emp, { changes: [{ type: 'leave', userId: org.users.emp2, start: START, end: START }] })).status).toBe(403);
    expect((await sim(emp, { changes: [{ type: 'reassign', taskId: T.A.id, toUserId: org.users.emp2 }] })).status).toBe(403);
    // A task the employee cannot see is not found, not leaked.
    expect((await sim(emp, { changes: [{ type: 'deadline', taskId: T.E.id, dueDate: '2030-01-10' }] })).status).toBe(404);
    const ctx = await emp.get('/api/whatif/context');
    expect(ctx.body.people.map((p: any) => p.id)).toEqual([org.users.emp]);
  });
  it('managers simulate their team only; leadership and admins anyone', async () => {
    expect((await sim(mgr, { people: [org.users.manager, org.users.emp, org.users.emp2] })).status).toBe(200);
    expect((await sim(mgr, { people: [org.users.outsider] })).status).toBe(403);
    expect((await sim(outsider, { people: [org.users.emp] })).status).toBe(403);
    expect((await sim(admin, { people: [org.users.outsider, org.users.emp] })).status).toBe(200);
    expect((await sim(founder, { people: [org.users.emp2] })).status).toBe(200);
    const ctx = await mgr.get('/api/whatif/context');
    expect(ctx.body.people.map((p: any) => p.id).sort()).toEqual([org.users.manager, org.users.emp, org.users.emp2].sort());
  });
  it('rejects closed tasks and invalid input', async () => {
    expect((await sim(emp, { changes: [{ type: 'deadline', taskId: T.done.id, dueDate: '2030-01-10' }] })).status).toBe(400);
    expect((await sim(emp, { horizonDays: 4 })).status).toBe(400);
    expect((await sim(emp, { horizonDays: 61 })).status).toBe(400);
    expect((await sim(emp, { changes: [{ type: 'leave', userId: org.users.emp, start: '2030-01-09', end: '2030-01-08' }] })).status).toBe(400);
    expect((await sim(emp, { changes: [{ type: 'leave', userId: org.users.emp, start: '2030-02-31', end: '2030-03-01' }] })).status).toBe(400);
    expect((await sim(emp, { changes: [{ type: 'allocation', userId: org.users.emp, percent: 150 }] })).status).toBe(400);
  });
});

describe('what-if is read-only', () => {
  it('a simulation with every change type modifies nothing', async () => {
    const snap = () => withOwner(async (db) => ({
      tasks: (await db.query(`select id, owner_id, due_date, status, version, updated_at, estimate_minutes from tasks where tenant_id = $1 order by id`, [org.tenantId])).rows,
      leave: (await db.query(`select count(*)::int n from leave_entries where tenant_id = $1`, [org.tenantId])).rows[0].n,
      alloc: (await db.query(`select count(*)::int n from capacity_allocations where tenant_id = $1`, [org.tenantId])).rows[0].n,
      history: (await db.query(`select count(*)::int n from task_state_history where tenant_id = $1`, [org.tenantId])).rows[0].n,
      audit: (await db.query(`select count(*)::int n from audit_events where tenant_id = $1`, [org.tenantId])).rows[0].n,
      notifications: (await db.query(`select count(*)::int n from notifications where tenant_id = $1`, [org.tenantId])).rows[0].n,
      jobs: (await db.query(`select count(*)::int n from jobs where tenant_id = $1`, [org.tenantId])).rows[0].n,
      scenarios: (await db.query(`select count(*)::int n from whatif_scenarios where tenant_id = $1`, [org.tenantId])).rows[0].n,
    }));
    const before = await snap();
    const r = await sim(admin, { people: [org.users.emp, org.users.emp2], changes: [
      { type: 'leave', userId: org.users.emp, start: '2030-01-07', end: '2030-01-09' },
      { type: 'reassign', taskId: T.B.id, toUserId: org.users.emp2 },
      { type: 'allocation', userId: org.users.emp2, percent: 60 },
      { type: 'deadline', taskId: T.E.id, dueDate: '2030-01-15' },
      { type: 'add_task', ownerId: org.users.emp, title: 'Hypothetical', estimateMinutes: 120, dueDate: '2030-01-10' },
    ] });
    expect(r.status).toBe(200);
    expect(await snap()).toEqual(before);
  });
});

describe('saved scenarios', () => {
  it('create, list, load, update with version, delete; own scenarios only; audited', async () => {
    const changes = [{ type: 'leave', userId: org.users.emp, start: '2030-01-07', end: '2030-01-08' }];
    const c = await mgr.post('/api/whatif/scenarios', { name: 'Emp out Mon-Tue', horizonDays: 14, people: [org.users.emp], changes, unestimatedMinutes: 90 });
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ name: 'Emp out Mon-Tue', horizon_days: 14, unestimated_minutes: 90, version: 1, changes });
    expect((await mgr.post('/api/whatif/scenarios', { name: 'Emp out Mon-Tue', changes: [] })).status).toBe(409);
    expect((await mgr.get('/api/whatif/scenarios')).body.map((s: any) => s.id)).toContain(c.body.id);
    expect((await mgr.get(`/api/whatif/scenarios/${c.body.id}`)).body.people).toEqual([org.users.emp]);
    // Other people cannot see or delete it.
    expect((await emp.get(`/api/whatif/scenarios/${c.body.id}`)).status).toBe(404);
    expect((await emp.get('/api/whatif/scenarios')).body).toEqual([]);
    expect((await emp.del(`/api/whatif/scenarios/${c.body.id}`)).status).toBe(404);
    // Optimistic versioning.
    const u = await mgr.put(`/api/whatif/scenarios/${c.body.id}`, { name: 'Emp out', horizonDays: 28, people: [org.users.emp], changes, version: 1 });
    expect(u.body).toMatchObject({ name: 'Emp out', horizon_days: 28, version: 2 });
    expect((await mgr.put(`/api/whatif/scenarios/${c.body.id}`, { name: 'Stale', changes, version: 1 })).status).toBe(409);
    expect((await mgr.del(`/api/whatif/scenarios/${c.body.id}`)).status).toBe(200);
    expect((await mgr.get(`/api/whatif/scenarios/${c.body.id}`)).status).toBe(404);
    const actions = await withOwner(async (db) => (await db.query(`select action from audit_events where tenant_id = $1 and resource_id = $2 order by id`, [org.tenantId, c.body.id])).rows.map((x) => x.action));
    expect(actions).toEqual(['whatif.scenario.create', 'whatif.scenario.update', 'whatif.scenario.delete']);
  });
  it('cannot save scenarios about people outside your scope', async () => {
    expect((await emp.post('/api/whatif/scenarios', { name: 'Peek', changes: [{ type: 'leave', userId: org.users.emp2, start: START, end: START }] })).status).toBe(403);
    expect((await mgr.post('/api/whatif/scenarios', { name: 'Peek', people: [org.users.outsider], changes: [] })).status).toBe(403);
  });
});

describe('what-if review fixes', () => {
  it('a deactivated team member does not break the manager simulation or the capacity projection', async () => {
    const o = await makeOrg();
    const m = await login(o, 'manager');
    await withOwner((db) => db.query(`update users set status = 'deactivated' where id = $1`, [o.users.emp2]));
    const cap = await m.get(`/api/team/capacity?start=${START}&days=10`);
    expect(cap.status).toBe(200);
    const ids = cap.body.people.map((p: any) => p.user.id);
    const r = await m.post('/api/whatif/simulate', { start: START, horizonDays: 14, people: ids, changes: [] });
    expect(r.status).toBe(200);
    expect(r.body.people.map((p: any) => p.id).sort()).toEqual(ids.filter((id: string) => id !== o.users.emp2).sort());
    expect(r.body.findings.join(' ')).toMatch(/not active and (was|were) left out/);
    expect((await m.post('/api/whatif/simulate', { start: START, horizonDays: 14, changes: [] })).status).toBe(200);
    // A change that names the inactive person is still rejected.
    expect((await m.post('/api/whatif/simulate', { start: START, horizonDays: 14, changes: [{ type: 'allocation', userId: o.users.emp2, percent: 50 }] })).status).toBe(400);
  });

  it('tasks in review need no owner time and are not listed as unestimated', async () => {
    const o = await makeOrg();
    const e = await login(o, 'emp');
    const t = (await e.post('/api/tasks', { title: 'Awaiting review', dueDate: '2030-01-10' })).body;
    await withOwner((db) => db.query(`update tasks set status = 'in_review' where id = $1`, [t.id]));
    const r = await e.post('/api/whatif/simulate', { start: START, horizonDays: 14, unestimatedMinutes: 300 });
    expect(r.status).toBe(200);
    expect(r.body.tasks.find((x: any) => x.id === t.id)).toMatchObject({ remainingMinutes: 0, assumption: null, awaitingReview: true });
    expect(r.body.unestimated).toEqual([]);
    expect(r.body.findings.join(' ')).not.toMatch(/no usable estimate/);
  });

  it('a task is only "back on time" when its scenario finish is inside the horizon', async () => {
    // Horizon Mon 01-07..Fri 01-11. At 10% allocation emp2 has 210 minutes, so E (1260m) cannot finish in the horizon.
    const r = await sim(emp2, { horizonDays: 5, changes: [
      { type: 'allocation', userId: org.users.emp2, percent: 10 },
      { type: 'deadline', taskId: T.E.id, dueDate: '2030-01-31' },
    ] });
    expect(r.status).toBe(200);
    expect(task(r, 'E').baseline).toMatchObject({ finish: '2030-01-09', late: true });
    expect(task(r, 'E').scenario).toMatchObject({ finish: null, beyondHorizon: true });
    expect(task(r, 'E').change).not.toBe('recovered');
    expect(r.body.summary.recovered).toBe(0);
  });

  it('tasks the viewer cannot open hide their estimate and logged time', async () => {
    // Founder has leadership (may plan for anyone) but cannot open emp2's tasks.
    const r = await sim(founder, { people: [org.users.emp2] });
    expect(r.status).toBe(200);
    const hidden = r.body.tasks.filter((t: any) => !t.visible);
    expect(hidden).toHaveLength(3);
    for (const t of hidden) expect(t).toMatchObject({ id: null, number: null, title: 'Private task', estimateMinutes: null, loggedMinutes: null });
    expect(JSON.stringify(r.body)).not.toContain(T.E.id);
    expect(r.body.unestimated).toEqual([expect.objectContaining({ id: null, title: 'Private task', reason: 'Estimate already used up by logged time' })]);
  });

  it('saved scenarios reject leave that ends before it starts', async () => {
    const r = await mgr.post('/api/whatif/scenarios', { name: 'Backwards leave', changes: [{ type: 'leave', userId: org.users.emp, start: '2030-01-09', end: '2030-01-08' }] });
    expect(r.status).toBe(400);
  });
});
