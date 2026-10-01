import { beforeAll, describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { drainJobs, login, makeOrg, PASSWORD, withOwner, type Org } from './helpers.js';
import { hashPassword } from '../server/src/lib/crypto.js';
import { enqueue } from '../server/src/lib/jobs.js';
import { assess, keyResultProgress, rollUp, taskStats, weightedProgress } from '../server/src/services/ext/objectives.js';

let org: Org; let admin: any; let emp: any; let emp2: any; let founder: any; let customer: any; let mgr: any;
let projectId: string;
const day = (n: number) => DateTime.now().setZone(org.tz).plus({ days: n }).toISODate()!;

async function addCustomer(o: Org) {
  const h = await hashPassword(PASSWORD);
  await withOwner(async (db) => {
    const c = (await db.query(`insert into customers (tenant_id, name) values ($1, 'Client Co') returning id`, [o.tenantId])).rows[0];
    await db.query(`insert into users (tenant_id, email, name, password_hash, roles, customer_id) values ($1,$2,'Client',$3,$4,$5)`,
      [o.tenantId, `client@${o.slug}.test`, h, ['customer'], c.id]);
  });
}
async function milestone(name: string) {
  return (await admin.post(`/api/projects/${projectId}/milestones`, { name })).body.id as string;
}
/** Insert a task directly (deterministic status/estimate/acceptance time). */
async function task(milestoneId: string, o: { est?: number | null; done?: boolean; acceptedDaysAgo?: number; status?: string } = {}) {
  return withOwner(async (db) => {
    const status = o.done ? 'done' : (o.status ?? 'planned');
    const acc = o.done ? DateTime.now().minus({ days: o.acceptedDaysAgo ?? 3 }).toJSDate() : null;
    return (await db.query(`insert into tasks (tenant_id, project_id, milestone_id, title, owner_id, created_by, status, estimate_minutes, done_at, accepted_at)
      values ($1,$2,$3,'Fixture task',$4,$4,$5,$6,$7,$7) returning id`, [org.tenantId, projectId, milestoneId, org.users.emp, status, o.est ?? null, acc])).rows[0].id as string;
  });
}
async function objective(body: Record<string, unknown>) {
  const r = await admin.post('/api/objectives/create', { title: 'Objective', ownerId: org.users.emp, ...body });
  expect(r.status).toBe(200);
  return r.body;
}
async function link(objectiveId: string, milestoneId: string) {
  expect((await admin.post(`/api/objectives/${objectiveId}/milestones`, { milestoneId })).status).toBe(200);
}
const detail = async (id: string, who = admin) => (await who.get(`/api/objectives/${id}`)).body;

beforeAll(async () => {
  org = await makeOrg();
  await addCustomer(org);
  [admin, emp, emp2, founder, customer, mgr] = await Promise.all([login(org, 'admin'), login(org, 'emp'), login(org, 'emp2'), login(org, 'founder'), login(org, 'client'), login(org, 'manager')]);
  projectId = (await admin.post('/api/projects', { key: 'OKR', name: 'Objective work' })).body.id;
});

describe('roll-up math', () => {
  it('weights by estimates when estimate coverage is good, otherwise by count, and says which', async () => {
    const o = await objective({ title: 'Weighting', periodStart: day(-28), periodEnd: day(28) });
    const ms = await milestone('Weighting milestone');
    await link(o.id, ms);
    await task(ms, { est: 60, done: true });
    for (const est of [180, 120, 240]) await task(ms, { est });
    await task(ms, { est: 500, status: 'cancelled' }); // cancelled work is not counted
    let d = await detail(o.id);
    expect(d.work.basis).toBe('estimate');
    expect(d.work.value).toBeCloseTo(60 / 600, 3);
    expect(d.work.explanation).toMatch(/Weighted by estimates/);
    expect(d.progress.value).toBeCloseTo(0.1, 3);
    // Two unestimated tasks drop coverage to 4/6 (< 80%): fall back to counting tasks.
    await task(ms, {}); await task(ms, {});
    d = await detail(o.id);
    expect(d.work.basis).toBe('count');
    expect(d.work.coverage).toBeCloseTo(4 / 6, 3);
    expect(d.work.value).toBeCloseTo(1 / 6, 3);
    expect(d.work.explanation).toMatch(/Weighted by task count: 1 of 6 tasks.*only 4 of 6 \(67%\)/);
    expect(d.tasks).toHaveLength(6);
  });

  it('pure helpers: estimate coverage threshold, key results and equal-weight roll-up', () => {
    const rows = (spec: [number | null, string][]) => spec.map(([e, s], i) => ({ id: String(i), milestone_id: 'm', project_id: 'p', status: s, estimate_minutes: e, accepted_at: null }));
    // 4 of 5 estimated = 80% -> estimate weighting; unestimated task left out of the weighting
    const p1 = weightedProgress(taskStats(rows([[100, 'done'], [100, 'planned'], [100, 'planned'], [100, 'planned'], [null, 'done']])));
    expect(p1).toMatchObject({ basis: 'estimate', value: 0.25 });
    expect(p1.explanation).toMatch(/1 without one is left out/);
    const p2 = weightedProgress(taskStats(rows([[100, 'done'], [null, 'planned'], [null, 'planned']])));
    expect(p2).toMatchObject({ basis: 'count' }); expect(p2.value).toBeCloseTo(1 / 3, 5);
    expect(weightedProgress(taskStats([]))).toMatchObject({ value: null, basis: 'none' });
    const manual = keyResultProgress({ id: 'k', title: 'Signed contracts', kind: 'manual', unit: 'contracts', target_value: 4, current_value: 3 }, new Map(), []);
    expect(manual.progress).toBe(0.75);
    const empty = keyResultProgress({ id: 'k2', title: 'NPS', kind: 'manual', unit: '', target_value: 50, current_value: null }, new Map(), []);
    expect(empty.progress).toBeNull();
    const r = rollUp({ value: 0.5, basis: 'count', coverage: 0, explanation: '' }, [manual, empty]);
    expect(r.value).toBeCloseTo(0.625, 5);
    expect(r.explanation).toMatch(/linked work and 1 key result.*1 key result without data is left out/);
    expect(rollUp({ value: null, basis: 'none', coverage: null, explanation: '' }, []).value).toBeNull();
  });

  it('includes key results in the roll-up (milestone completion and manual)', async () => {
    const o = await objective({ title: 'With key results', periodStart: day(-10), periodEnd: day(50) });
    const m1 = await milestone('KR m1'); const m2 = await milestone('KR m2');
    await admin.patch(`/api/milestones/${m1}`, { status: 'done' });
    const kr1 = await emp.post(`/api/objectives/${o.id}/key-results`, { title: 'Both milestones done', kind: 'milestone_completion', milestoneIds: [m1, m2] });
    expect(kr1.status).toBe(200);
    const kr2 = await emp.post(`/api/objectives/${o.id}/key-results`, { title: 'Pilot customers', kind: 'manual', targetValue: 10, currentValue: 2, unit: 'customers' });
    expect(kr2.status).toBe(200);
    expect((await emp.post(`/api/objectives/${o.id}/key-results`, { title: 'Bad', kind: 'manual' })).status).toBe(400);
    expect((await emp.post(`/api/objectives/${o.id}/key-results`, { title: 'Bad', kind: 'milestone_completion', milestoneIds: [] })).status).toBe(400);
    const d = await detail(o.id);
    expect(d.keyResults.map((k: any) => k.progress)).toEqual([0.5, 0.2]);
    expect(d.work.value).toBeNull();
    expect(d.progress.value).toBeCloseTo(0.35, 3);
    // Optimistic versioning on key-result updates
    const up = await emp.patch(`/api/objectives/${o.id}/key-results/${kr2.body.id}`, { currentValue: 5, version: kr2.body.version });
    expect(up.status).toBe(200);
    expect((await emp.patch(`/api/objectives/${o.id}/key-results/${kr2.body.id}`, { currentValue: 6, version: kr2.body.version })).status).toBe(409);
    expect((await detail(o.id)).keyResults[1].progress).toBe(0.5);
  });
});

describe('forecast statuses', () => {
  it('insufficient_data when nothing is linked or there is no end date — never invents numbers', async () => {
    const bare = await objective({ title: 'Nothing linked', periodStart: day(-14), periodEnd: day(14) });
    let f = (await detail(bare.id)).forecast;
    expect(f.status).toBe('insufficient_data');
    expect(f.progress).toBeNull(); expect(f.expected).toBeNull(); expect(f.velocityPerWeek).toBeNull();
    expect(f.reasons.join(' ')).toMatch(/Progress cannot be measured/);
    const noEnd = await objective({ title: 'No end date', periodStart: day(-14) });
    const ms = await milestone('No end milestone'); await link(noEnd.id, ms); await task(ms, { est: 60 });
    f = (await detail(noEnd.id)).forecast;
    expect(f.status).toBe('insufficient_data');
    expect(f.reasons.join(' ')).toMatch(/No period end date/);
  });

  it('on_track when progress keeps up with elapsed time and pace covers the remaining estimate', async () => {
    const o = await objective({ title: 'On track', periodStart: day(-28), periodEnd: day(28) });
    const ms = await milestone('On track milestone'); await link(o.id, ms);
    await task(ms, { est: 360, done: true, acceptedDaysAgo: 7 }); await task(ms, { est: 240 });
    const f = (await detail(o.id)).forecast;
    expect(f.status).toBe('on_track');
    expect(f.expected).toBeCloseTo(28 / 57, 3);
    expect(f.historyWeeks).toBe(4);
    expect(f.velocityPerWeek).toBe(90);
    expect(f.signals.map((s: any) => [s.key, s.used, s.status])).toEqual([['elapsed', true, 'on_track'], ['velocity', true, 'on_track']]);
    expect(f.assumptions.join(' ')).toMatch(/pace of the last 4 weeks continues/);
  });

  it('at_risk from the velocity forecast even when elapsed-time progress looks fine', async () => {
    const o = await objective({ title: 'At risk', periodStart: day(-28), periodEnd: day(28) });
    const ms = await milestone('At risk milestone'); await link(o.id, ms);
    await task(ms, { est: 450, done: true, acceptedDaysAgo: 3 }); await task(ms, { est: 550 });
    const f = (await detail(o.id)).forecast;
    expect(f.signals[0]).toMatchObject({ key: 'elapsed', status: 'on_track' });
    expect(f.signals[1]).toMatchObject({ key: 'velocity', status: 'at_risk' });
    expect(f.status).toBe('at_risk');
    expect(f.projectedWeeks).toBeCloseTo(4.9, 1);
    expect(f.reasons.join(' ')).toMatch(/needs about 4.9 weeks, but only 4.1 weeks remain/);
  });

  it('off_track when far behind elapsed time; velocity is skipped with too little history or estimate coverage', async () => {
    const o = await objective({ title: 'Off track', periodStart: day(-60), periodEnd: day(10) });
    const ms = await milestone('Off track milestone'); await link(o.id, ms);
    await task(ms, { est: 60, done: true, acceptedDaysAgo: 40 });
    for (let i = 0; i < 4; i++) await task(ms, {}); // 1 of 5 estimated
    let f = (await detail(o.id)).forecast;
    expect(f.status).toBe('off_track');
    expect(f.signals[1]).toMatchObject({ key: 'velocity', used: false });
    expect(f.assumptions.join(' ')).toMatch(/Velocity forecast not used: only 0 of 4 open tasks/);
    const young = await objective({ title: 'Young', periodStart: day(-7), periodEnd: day(60) });
    const ms2 = await milestone('Young milestone'); await link(young.id, ms2); await task(ms2, { est: 60 });
    f = (await detail(young.id)).forecast;
    expect(f.historyWeeks).toBe(1);
    expect(f.velocityPerWeek).toBeNull();
    expect(f.assumptions.join(' ')).toMatch(/only 1 week of history/);
  });

  it('pure assess: ended period is off_track; complete work is on_track; check-in confidence is context only', () => {
    const base = { today: '2026-06-10', periodStart: '2026-05-01', periodEnd: '2026-06-30', createdDate: '2026-04-20', progressExplanation: '',
      open: { tasks: 0, estimated: 0, minutes: 0 }, accepted: { minutes: 0, tasks: 0, unestimated: 0 } };
    expect(assess({ ...base, today: '2026-07-02', progress: 0.9 }).status).toBe('off_track');
    expect(assess({ ...base, progress: 1 }).status).toBe('on_track');
    expect(assess({ ...base, today: '2026-04-25', progress: 0 }).status).toBe('insufficient_data');
    const f = assess({ ...base, progress: 0.7, latestCheckin: { confidence: 1, created_at: '2026-06-09T10:00:00Z' } });
    expect(f.status).toBe('on_track');
    expect(f.facts.join(' ')).toMatch(/confidence: 1\/5.*does not change the computed status/);
    const noStart = assess({ ...base, periodStart: null, progress: 0.5 });
    expect(noStart.assumptions[0]).toMatch(/creation date \(2026-04-20\)/);
  });

  it('pure assess: accepted work without estimates is an unknown pace, not a zero pace', () => {
    const base = { today: '2026-06-10', periodStart: '2026-05-01', periodEnd: '2026-06-30', createdDate: '2026-04-20', progressExplanation: '', progress: 0.7,
      open: { tasks: 2, estimated: 2, minutes: 600 } };
    // 5 tasks accepted in the window, none estimated: velocity cannot be measured, so it is not used (elapsed time alone says on track).
    const f = assess({ ...base, accepted: { minutes: 0, tasks: 5, unestimated: 5 } });
    expect(f.signals[1]).toMatchObject({ key: 'velocity', used: false, status: null });
    expect(f.velocityPerWeek).toBeNull();
    expect(f.status).toBe('on_track');
    expect(f.assumptions.join(' ')).toMatch(/only 0 of 5 tasks accepted in the last 4 weeks have an estimate/);
    // Nothing accepted at all is a measured zero pace and still counts.
    expect(assess({ ...base, accepted: { minutes: 0, tasks: 0, unestimated: 0 } }).status).toBe('off_track');
    // Mostly estimated accepted work is still used.
    expect(assess({ ...base, accepted: { minutes: 1200, tasks: 5, unestimated: 1 } }).signals[1]).toMatchObject({ used: true });
  });
});

describe('permissions', () => {
  let o: any;
  beforeAll(async () => { o = await objective({ title: 'Permission objective', periodStart: day(-5), periodEnd: day(30) }); });

  it('leadership and system admins create and edit; others cannot', async () => {
    expect((await emp.post('/api/objectives/create', { title: 'Nope' })).status).toBe(403);
    expect((await mgr.post('/api/objectives/create', { title: 'Nope' })).status).toBe(403);
    expect((await founder.post('/api/objectives/create', { title: 'Founder objective' })).status).toBe(200);
    expect((await emp.put(`/api/objectives/${o.id}`, { title: 'Owner edit', version: o.version })).status).toBe(403);
    const ed = await admin.put(`/api/objectives/${o.id}`, { title: 'Renamed objective', periodEnd: day(40), version: o.version });
    expect(ed.status).toBe(200); expect(ed.body.version).toBe(o.version + 1);
    expect((await admin.put(`/api/objectives/${o.id}`, { title: 'Stale', version: o.version })).status).toBe(409);
    expect((await admin.put(`/api/objectives/${o.id}`, { periodStart: day(50), version: ed.body.version })).status).toBe(400);
    expect((await emp.post(`/api/objectives/${o.id}/milestones`, { milestoneId: await milestone('Perm ms') })).status).toBe(403);
    const audit = await withOwner(async (db) => (await db.query(`select action from audit_events where tenant_id = $1 and resource_id = $2 order by id`, [org.tenantId, o.id])).rows.map((r) => r.action));
    expect(audit).toEqual(expect.arrayContaining(['objective.created', 'objective.updated']));
  });

  it('the owner maintains key results and posts check-ins; other staff read only', async () => {
    expect((await emp.post(`/api/objectives/${o.id}/key-results`, { title: 'Owner KR', kind: 'manual', targetValue: 5 })).status).toBe(200);
    expect((await emp2.post(`/api/objectives/${o.id}/key-results`, { title: 'Not owner', kind: 'manual', targetValue: 5 })).status).toBe(403);
    expect((await emp2.post(`/api/objectives/${o.id}/checkins`, { confidence: 4 })).status).toBe(403);
    const key = 'checkin-key-0001';
    const c1 = await emp.post(`/api/objectives/${o.id}/checkins`, { confidence: 3, note: 'Waiting on vendor', idempotencyKey: key });
    expect(c1.status).toBe(200);
    const c2 = await emp.post(`/api/objectives/${o.id}/checkins`, { confidence: 3, note: 'Waiting on vendor', idempotencyKey: key });
    expect(c2.body.id).toBe(c1.body.id);
    expect((await emp.post(`/api/objectives/${o.id}/checkins`, { confidence: 6 })).status).toBe(400);
    const d = await detail(o.id, emp2);
    expect(d.checkins).toHaveLength(1);
    expect(d.checkins[0]).toMatchObject({ confidence: 3, note: 'Waiting on vendor', author_name: 'Emp' });
    expect(d.permissions).toEqual({ canEdit: false, canMaintain: false, canCheckIn: false });
    expect((await detail(o.id, emp)).permissions).toEqual({ canEdit: false, canMaintain: true, canCheckIn: true });
    expect((await emp2.get('/api/objectives/overview')).status).toBe(200);
  });

  it('a check-in by someone other than the owner is not reported as the owner\'s confidence', async () => {
    expect((await admin.post(`/api/objectives/${o.id}/checkins`, { confidence: 2, note: 'Leadership view' })).status).toBe(200);
    const facts = (await detail(o.id)).forecast.facts.join(' ');
    expect(facts).toMatch(new RegExp(`Latest check-in confidence: 2/5 \\(${day(0)}, by Admin\\)`));
    expect(facts).not.toMatch(/Owner's/);
    const row = (await admin.get('/api/objectives/overview')).body.items.find((x: any) => x.id === o.id);
    expect(row.latestCheckin).toMatchObject({ confidence: 2, author_name: 'Admin', by_owner: false });
  });

  it('cannot link milestones or projects from private projects the actor cannot see', async () => {
    const priv = (await mgr.post('/api/projects', { key: 'PRIV', name: 'Private work', visibility: 'private' })).body;
    const pms = (await mgr.post(`/api/projects/${priv.id}/milestones`, { name: 'Private milestone' })).body.id;
    expect((await emp.post(`/api/objectives/${o.id}/key-results`, { title: 'Peek', kind: 'milestone_completion', milestoneIds: [pms] })).status).toBe(400);
    expect((await emp.post(`/api/objectives/${o.id}/key-results`, { title: 'Peek', kind: 'task_completion', projectIds: [priv.id] })).status).toBe(400);
    expect((await founder.post(`/api/objectives/${o.id}/milestones`, { milestoneId: pms })).status).toBe(404);
  });

  it('customers never see objectives', async () => {
    expect((await customer.get('/api/objectives/overview')).status).toBe(403);
    expect((await customer.get(`/api/objectives/${o.id}`)).status).toBe(403);
    expect((await customer.post(`/api/objectives/${o.id}/checkins`, { confidence: 3 })).status).toBe(403);
  });

  it('linking a milestone already linked elsewhere needs explicit confirmation; unlink works', async () => {
    const other = await objective({ title: 'Other objective', periodEnd: day(30) });
    const ms = await milestone('Shared milestone');
    await link(other.id, ms);
    const r = await admin.post(`/api/objectives/${o.id}/milestones`, { milestoneId: ms });
    expect(r.status).toBe(409); expect(r.body.message).toMatch(/Other objective/);
    expect((await admin.post(`/api/objectives/${o.id}/milestones`, { milestoneId: ms, move: true })).status).toBe(200);
    expect((await detail(o.id)).milestones.map((m: any) => m.id)).toContain(ms);
    expect((await admin.del(`/api/objectives/${o.id}/milestones/${ms}`)).status).toBe(200);
    expect((await detail(o.id)).milestones).toHaveLength(0);
  });
});

describe('weekly early-warning notifications', () => {
  let org2: Org; let a2: any; let o: any; let ms: string; const tasks: string[] = [];
  const run = async (periodKey?: string) => {
    await withOwner((db) => enqueue(db, { tenantId: org2.tenantId, kind: 'objectives.weekly_status', payload: periodKey ? { periodKey } : {} }));
    await drainJobs();
  };
  const notes = () => withOwner(async (db) => (await db.query(`select * from notifications where tenant_id = $1 and kind = 'objective_status' and link = $2 order by created_at`,
    [org2.tenantId, `/objectives/${o.id}`])).rows);
  beforeAll(async () => {
    org2 = await makeOrg();
    a2 = await login(org2, 'admin');
    const d = (n: number) => DateTime.now().setZone(org2.tz).plus({ days: n }).toISODate()!;
    const p = (await a2.post('/api/projects', { key: 'WK', name: 'Weekly' })).body.id;
    ms = (await a2.post(`/api/projects/${p}/milestones`, { name: 'Weekly ms' })).body.id;
    o = (await a2.post('/api/objectives/create', { title: 'Weekly objective', ownerId: org2.users.emp, periodStart: d(-60), periodEnd: d(10) })).body;
    await a2.post(`/api/objectives/${o.id}/milestones`, { milestoneId: ms });
    for (let i = 0; i < 3; i++) tasks.push(await withOwner(async (db) => (await db.query(`insert into tasks (tenant_id, project_id, milestone_id, title, owner_id, estimate_minutes)
      values ($1,$2,$3,'Weekly task',$4,60) returning id`, [org2.tenantId, p, ms, org2.users.emp])).rows[0].id));
  });

  it('notifies the owner once per status change to at_risk/off_track and is idempotent per week', async () => {
    await run(); await run(); // the real tick path: same ISO week twice
    let n = await notes();
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ user_id: org2.users.emp, title: 'Objective off track: Weekly objective' });
    expect(n[0].body).toMatch(/points behind/);
    const hist = await withOwner(async (db) => (await db.query(`select * from objective_status_history where objective_id = $1`, [o.id])).rows);
    expect(hist).toHaveLength(1); expect(hist[0]).toMatchObject({ status: 'off_track', notified: true });
    await run('test-week-2'); // same status next week: no new notification
    expect(await notes()).toHaveLength(1);
    await withOwner((db) => db.query(`update tasks set status = 'done', done_at = now(), accepted_at = now() where id = any($1)`, [tasks]));
    await run('test-week-3'); // complete -> on_track, no notification
    expect(await notes()).toHaveLength(1);
    await withOwner((db) => db.query(`update tasks set status = 'planned', done_at = null, accepted_at = null where id = any($1)`, [tasks]));
    await run('test-week-4'); // back to off_track: a new change, a new notification
    n = await notes();
    expect(n).toHaveLength(2);
    const statuses = await withOwner(async (db) => (await db.query(`select status, previous_status from objective_status_history where objective_id = $1 order by evaluated_at`, [o.id])).rows);
    expect(statuses.map((s) => s.status)).toEqual(['off_track', 'off_track', 'on_track', 'off_track']);
    expect(statuses[3].previous_status).toBe('on_track');
    const d = (await a2.get(`/api/objectives/${o.id}`)).body;
    expect(d.statusHistory[0]).toMatchObject({ period_key: 'test-week-4', status: 'off_track', notified: true });
  });

  it('an objective created later in the week still gets this week\'s snapshot; existing ones are not re-recorded', async () => {
    const week = (await withOwner(async (db) => (await db.query(`select period_key from objective_status_history where objective_id = $1 and period_key like '%-W%'`, [o.id])).rows))[0].period_key;
    const late = (await a2.post('/api/objectives/create', { title: 'Late objective', ownerId: org2.users.emp })).body;
    await run(); await run();
    const rows = await withOwner(async (db) => (await db.query(`select objective_id, status from objective_status_history where tenant_id = $1 and period_key = $2`, [org2.tenantId, week])).rows);
    expect(rows.filter((r) => r.objective_id === o.id)).toHaveLength(1);
    expect(rows.filter((r) => r.objective_id === late.id)).toEqual([{ objective_id: late.id, status: 'insufficient_data' }]);
  });
});

describe('isolation and scale', () => {
  it('another tenant cannot read, edit, check in on or link into an objective', async () => {
    const other = await makeOrg();
    const oa = await login(other, 'admin');
    const o = await objective({ title: 'Tenant A objective', periodEnd: day(30) });
    const ms = await milestone('Tenant A milestone');
    expect((await oa.get(`/api/objectives/${o.id}`)).status).toBe(404);
    expect((await oa.put(`/api/objectives/${o.id}`, { title: 'Hijack', version: o.version })).status).toBe(404);
    expect((await oa.post(`/api/objectives/${o.id}/checkins`, { confidence: 3 })).status).toBe(404);
    expect((await oa.get('/api/objectives/overview')).body.items.map((x: any) => x.id)).not.toContain(o.id);
    const own = (await oa.post('/api/objectives/create', { title: 'Tenant B objective' })).body;
    expect((await oa.post(`/api/objectives/${own.id}/key-results`, { title: 'Cross', kind: 'milestone_completion', milestoneIds: [ms] })).status).toBe(400);
    expect((await oa.post(`/api/objectives/${own.id}/milestones`, { milestoneId: ms })).status).toBe(404);
  });

  it('hidden-task count is not inflated when the visible task list is capped', async () => {
    const o = await objective({ title: 'Large objective', periodStart: day(-7), periodEnd: day(30) });
    const ms = await milestone('Large milestone'); await link(o.id, ms);
    await withOwner((db) => db.query(`insert into tasks (tenant_id, project_id, milestone_id, title, owner_id, created_by, status)
      select $1, $2, $3, 'Bulk task ' || g, $4, $4, 'planned' from generate_series(1, 505) g`, [org.tenantId, projectId, ms, org.users.emp]));
    const d = await detail(o.id); // admin is a routine admin and can see every task
    expect(d.work.stats.tasks).toBe(505);
    expect(d.tasks).toHaveLength(500);
    expect(d.hiddenTasks).toBe(0);
  });
});
