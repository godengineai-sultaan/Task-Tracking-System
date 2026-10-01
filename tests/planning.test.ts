import { beforeAll, describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { drainJobs, localIso, login, makeOrg, withOwner, type Org } from './helpers.js';
import { withTenant } from '../server/src/lib/db.js';
import { nudgeUser, runNudges } from '../server/src/services/ext/planning.js';

const TZ = 'Asia/Kolkata';
/** A local weekday at least `minDays` ahead whose ISO weekday is <= maxWeekday (test orgs work Mon-Fri 09:00-17:00, no holidays). */
function weekdayAhead(minDays: number, maxWeekday = 5) {
  let d = DateTime.now().setZone(TZ).startOf('day').plus({ days: minDays });
  while (d.weekday > maxWeekday) d = d.plus({ days: 1 });
  return d;
}
const iso = (d: DateTime) => d.toISODate()!;

async function insertPlan(org: Org, userKey: string, date: string, taskIds: string[]) {
  await withOwner(async (db) => {
    const p = (await db.query(`insert into daily_plans (tenant_id, user_id, date) values ($1,$2,$3) returning id`, [org.tenantId, org.users[userKey], date])).rows[0];
    for (let i = 0; i < taskIds.length; i++)
      await db.query(`insert into daily_plan_items (tenant_id, plan_id, task_id, position) values ($1,$2,$3,$4)`, [org.tenantId, p.id, taskIds[i], i + 1]);
  });
}

describe('suggest my day: ranking, reasons and exclusions', () => {
  let org: Org; let emp: any; const D = weekdayAhead(8); const date = iso(D);
  const t: Record<string, any> = {};
  beforeAll(async () => {
    org = await makeOrg({ tz: TZ });
    emp = await login(org, 'emp');
    const mk = async (k: string, body: any) => { t[k] = (await emp.post('/api/tasks', body)).body; expect(t[k].id).toBeTruthy(); };
    await mk('overdue', { title: 'Overdue vendor reply', dueDate: iso(D.minus({ days: 2 })), priority: 'medium', estimateMinutes: 60 });
    await mk('due', { title: 'Ship release notes', dueDate: date, priority: 'low', estimateMinutes: 30 });
    await mk('inprog', { title: 'Refactor importer', status: 'in_progress', priority: 'medium' });
    await mk('high', { title: 'Customer escalation follow-up', priority: 'high', estimateMinutes: 120 });
    await mk('carry', { title: 'Migrate old reports', priority: 'none', estimateMinutes: 600 });
    await mk('blocked', { title: 'Integrate payment API', priority: 'urgent', dueDate: date });
    await emp.post(`/api/tasks/${t.blocked.id}/status`, { to: 'blocked', blocker: { reason: 'Need sandbox keys', cause: 'access', waitingOnUserId: org.users.manager } });
    await mk('review', { title: 'Pricing page copy', requiresReview: true, reviewerId: org.users.emp2, priority: 'urgent' });
    await emp.post(`/api/tasks/${t.review.id}/status`, { to: 'in_review' });
    await mk('dep', { title: 'Announce release', priority: 'urgent', dueDate: date });
    expect((await emp.post(`/api/tasks/${t.dep.id}/dependencies`, { dependsOnTaskId: t.due.id })).status).toBe(200);
    await mk('done', { title: 'Close sprint board', priority: 'high' });
    // Carry-over: planned on two earlier days and never accepted. The done task was planned too.
    await insertPlan(org, 'emp', iso(D.minus({ days: 4 })), [t.carry.id, t.done.id]);
    await insertPlan(org, 'emp', iso(D.minus({ days: 3 })), [t.carry.id]);
    expect((await emp.post(`/api/tasks/${t.done.id}/status`, { to: 'done' })).body.status).toBe('done');
  });

  it('ranks with explainable score parts and a deterministic tie-break', async () => {
    const r = await emp.get(`/api/planning/suggest?date=${date}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ applicable: true, date, slots: 3, capacity: { status: 'working', availableMinutes: 420, remainingMinutes: 420 } });
    expect(r.body.candidates.map((c: any) => c.title)).toEqual(['Overdue vendor reply', 'Ship release notes', 'Customer escalation follow-up', 'Refactor importer', 'Migrate old reports']);
    const by = (title: string) => r.body.candidates.find((c: any) => c.title === title);
    expect(by('Overdue vendor reply')).toMatchObject({ rank: 1, score: 57, proposed: true });
    expect(by('Overdue vendor reply').reasons[0]).toMatch(/^Overdue by 2 days/);
    expect(by('Ship release notes').parts.map((p: any) => [p.key, p.points])).toEqual([['due', 35], ['estimate_fit', 8]]);
    // Equal scores (20): the high-priority task wins the tie over the medium one.
    expect(by('Customer escalation follow-up').score).toBe(20);
    expect(by('Refactor importer')).toMatchObject({ score: 20, proposed: false });
    expect(by('Refactor importer').reasons).toContain('Already in progress');
    expect(by('Refactor importer').reasons.join(' ')).toMatch(/No estimate/);
    const carry = by('Migrate old reports');
    expect(carry.parts.find((p: any) => p.key === 'carried_over')).toMatchObject({ points: 13 });
    expect(carry.reasons.join(' ')).toMatch(/planned on 2 earlier days/);
    expect(carry.parts.find((p: any) => p.key === 'estimate_fit')).toMatchObject({ points: -10 });
    expect(r.body.rules.length).toBeGreaterThan(5);
    expect(r.body.assumptions.join(' ')).toMatch(/never people/);
  });

  it('sets aside blocked, in-review, dependency-waiting and done work with reasons', async () => {
    const r = await emp.get(`/api/planning/suggest?date=${date}`);
    const ex = Object.fromEntries(r.body.excluded.map((e: any) => [e.title, e]));
    expect(ex['Integrate payment API']).toMatchObject({ reason: 'blocked' });
    expect(ex['Integrate payment API'].label).toMatch(/Need sandbox keys.*waiting on Manager/);
    expect(ex['Pricing page copy']).toMatchObject({ reason: 'in_review' });
    expect(ex['Announce release']).toMatchObject({ reason: 'dependencies' });
    expect(ex['Announce release'].label).toContain('"Ship release notes"');
    expect(ex['Close sprint board']).toMatchObject({ reason: 'done' });
    const rankedIds = r.body.candidates.map((c: any) => c.id);
    for (const k of ['blocked', 'review', 'dep', 'done']) expect(rankedIds).not.toContain(t[k].id);
    expect(r.body.rationale).toMatch(/Set aside: 1 blocked, 1 in review, 1 waiting on dependencies, 1 already done\./);
  });

  it('checks the proposed top three against available time', async () => {
    const r = await emp.get(`/api/planning/suggest?date=${date}`);
    expect(r.body.proposal.add).toEqual([t.overdue.id, t.due.id, t.high.id]);
    expect(r.body.capacityCheck).toMatchObject({ state: 'fits', outcomes: 3, estimateMinutes: 210, unestimated: 0, remainingMinutes: 420 });
    expect(r.body.capacityCheck.text).toMatch(/3h 30m of the 7h of scheduled time/);
  });

  it('keeps already-chosen outcomes, and applying uses the existing plan endpoint (max 3)', async () => {
    expect((await emp.put('/api/my-day/plan', { date, taskIds: [t.inprog.id] })).status).toBe(200);
    const r = await emp.get(`/api/planning/suggest?date=${date}`);
    expect(r.body.current.map((c: any) => c.id)).toEqual([t.inprog.id]);
    expect(r.body.slots).toBe(2);
    expect(r.body.proposal).toMatchObject({ keep: [t.inprog.id], add: [t.overdue.id, t.due.id], canApply: true });
    expect(r.body.proposal.taskIds).toEqual([t.inprog.id, t.overdue.id, t.due.id]);
    // Capacity check covers kept + added outcomes; the kept one has no estimate.
    expect(r.body.capacityCheck).toMatchObject({ state: 'partial', estimateMinutes: 90, unestimated: 1 });
    const applied = await emp.put('/api/my-day/plan', { date, taskIds: r.body.proposal.taskIds });
    expect(applied.status).toBe(200);
    expect(applied.body.intendedOutcomes.map((x: any) => x.id)).toEqual(r.body.proposal.taskIds);
    const full = await emp.get(`/api/planning/suggest?date=${date}`);
    expect(full.body).toMatchObject({ slots: 0, proposal: { add: [], canApply: false } });
    expect(full.body.rationale).toMatch(/All three outcome slots are used/);
  });

  it('only ranks the signed-in person\'s own work and validates the date', async () => {
    const emp2 = await login(org, 'emp2');
    const r = await emp2.get(`/api/planning/suggest?date=${date}`);
    expect(r.body.candidates).toEqual([]);
    expect(r.body.capacityCheck.state).toBe('empty');
    expect((await emp.get(`/api/planning/suggest?date=${iso(DateTime.now().setZone(TZ).minus({ days: 3 }))}`)).status).toBe(400);
    expect((await emp.get('/api/planning/suggest?date=2026-02-31')).status).toBe(400);
    expect((await emp.get(`/api/planning/suggest?date=${iso(DateTime.now().setZone(TZ).plus({ days: 60 }))}`)).status).toBe(400);
  });
});

describe('suggest my day: capacity', () => {
  let org: Org; let emp: any;
  beforeAll(async () => { org = await makeOrg({ tz: TZ }); emp = await login(org, 'emp'); });

  it('flags a proposal whose estimates exceed available time and counts unestimated outcomes', async () => {
    const date = iso(weekdayAhead(9));
    for (const [title, est] of [['Big design doc', 300], ['Data migration', 200], ['Unsized spike', null]] as const)
      await emp.post('/api/tasks', { title, estimateMinutes: est, priority: 'high', dueDate: date });
    const r = await emp.get(`/api/planning/suggest?date=${date}`);
    expect(r.body.capacityCheck).toMatchObject({ state: 'over', outcomes: 3, estimateMinutes: 500, unestimated: 1, remainingMinutes: 420 });
    expect(r.body.capacityCheck.text).toMatch(/more than the 7h of scheduled time/);
    expect(r.body.candidates.find((c: any) => c.title === 'Big design doc').parts.find((p: any) => p.key === 'estimate_fit').points).toBe(8);
  });

  it('returns Not Applicable with no suggestions on weekends, holidays and leave', async () => {
    let sat = DateTime.now().setZone(TZ).startOf('day').plus({ days: 1 });
    while (sat.weekday !== 6) sat = sat.plus({ days: 1 });
    const weekend = await emp.get(`/api/planning/suggest?date=${iso(sat)}`);
    expect(weekend.body).toMatchObject({ applicable: false, label: 'not_applicable', candidates: [], excluded: [], proposal: null, capacity: { availableMinutes: 0 } });
    expect(weekend.body.rationale).toMatch(/Not a scheduled working day/);
    const hol = iso(weekdayAhead(17)), lv = iso(weekdayAhead(24));
    await withOwner(async (db) => {
      await db.query(`insert into holidays (tenant_id, date, name) values ($1,$2,'Founders Day')`, [org.tenantId, hol]);
      await db.query(`insert into leave_entries (tenant_id, user_id, start_date, end_date, portion, kind) values ($1,$2,$3,$3,'full','sick')`, [org.tenantId, org.users.emp, lv]);
    });
    const h = await emp.get(`/api/planning/suggest?date=${hol}`);
    expect(h.body).toMatchObject({ applicable: false, label: 'not_applicable', candidates: [] });
    expect(h.body.rationale).toMatch(/Holiday \(Founders Day\)/);
    const l = await emp.get(`/api/planning/suggest?date=${lv}`);
    expect(l.body).toMatchObject({ applicable: false, candidates: [] });
    expect(l.body.rationale).toMatch(/You are on sick leave/);
  });
});

describe('nudges: idempotent, opt-out, working days only', () => {
  let org: Org; const W = weekdayAhead(14, 4); const date = iso(W); const W2 = iso(W.plus({ days: 1 }));
  const at = (d: string, hhmm: string) => Date.parse(localIso(TZ, d, hhmm));
  const run = (now: number) => withTenant(org.tenantId, (db) => runNudges(db, org.tenantId, now));
  const count = (kind: string, userKey?: string) => withOwner(async (db) => (await db.query(
    `select count(*)::int n from notifications where tenant_id = $1 and kind = $2 and ($3::uuid is null or user_id = $3)`, [org.tenantId, kind, userKey ? org.users[userKey] : null])).rows[0].n);

  beforeAll(async () => {
    org = await makeOrg({ tz: TZ });
    // Fixtures go straight to the database here: the preference and plan endpoints are covered elsewhere (and logins are rate limited).
    let ft = '';
    await withOwner(async (db) => {
      await db.query(`insert into planning_preferences (tenant_id, user_id, plan_nudge, recap_nudge) values ($1,$2,false,true), ($1,$3,true,false)`,
        [org.tenantId, org.users.emp2, org.users.manager]);
      ft = (await db.query(`insert into tasks (tenant_id, title, owner_id, created_by) values ($1,'Board prep',$2,$2) returning id`, [org.tenantId, org.users.founder])).rows[0].id;
      await db.query(`insert into leave_entries (tenant_id, user_id, start_date, end_date, portion, kind) values ($1,$2,$3,$3,'full','leave')`, [org.tenantId, org.users.outsider, date]);
      await db.query(`insert into daily_reviews (tenant_id, user_id, date, status, summary, version, confirmed_at) values ($1,$2,$3,'confirmed','Done for the day',1,now())`,
        [org.tenantId, org.users.emp, date]);
    });
    await insertPlan(org, 'founder', date, [ft]);
  });

  it('sends one "Plan your day" nudge after the scheduled start, skipping planned, opted-out and on-leave people', async () => {
    const early = await run(at(date, '09:05'));
    expect(early.sent).toBe(0);
    const s = await run(at(date, '09:20'));
    expect(s.sent).toBe(3); // admin, manager, emp
    expect(s.skippedNoCapacity).toBe(1); // outsider on leave
    expect(await count('planning_plan_nudge', 'emp')).toBe(1);
    for (const k of ['emp2', 'founder', 'outsider']) expect(await count('planning_plan_nudge', k)).toBe(0);
    const again = await run(at(date, '10:20'));
    expect(again.sent).toBe(0);
    expect(await count('planning_plan_nudge')).toBe(3);
  });

  it('sends one "Confirm your recap" nudge in the last 45 minutes when the recap is not confirmed', async () => {
    expect((await run(at(date, '16:00'))).sent).toBe(0); // no recap window yet; plan nudges already sent
    const s = await run(at(date, '16:20'));
    expect(s.sent).toBe(3); // admin, emp2, founder (emp confirmed, manager opted out, outsider on leave)
    for (const k of ['admin', 'emp2', 'founder']) expect(await count('planning_recap_nudge', k)).toBe(1);
    for (const k of ['emp', 'manager', 'outsider']) expect(await count('planning_recap_nudge', k)).toBe(0);
    expect((await run(at(date, '16:50'))).sent).toBe(0);
    expect((await run(at(date, '17:10'))).sent).toBe(0);
    const n = await withOwner(async (db) => (await db.query(`select title, link from notifications where tenant_id = $1 and kind = 'planning_recap_nudge' limit 1`, [org.tenantId])).rows[0]);
    expect(n).toMatchObject({ title: 'Confirm your recap', link: '/recap' });
  });

  it('schedules a one-off job when a window opens before the next hourly tick; the job re-checks and stays idempotent', async () => {
    const s = await run(at(W2, '08:30'));
    expect(s.sent).toBe(0);
    expect(s.scheduled).toBe(5); // plan nudges for admin, manager, emp, outsider (leave was only the day before) and founder; emp2 opted out
    const job = await withOwner(async (db) => (await db.query(`select run_at, payload from jobs where idempotency_key = $1`, [`planning.nudge:plan:${org.users.emp}:${W2}`])).rows[0]);
    expect(new Date(job.run_at).toISOString()).toBe(new Date(at(W2, '09:15')).toISOString());
    expect(job.payload).toMatchObject({ userId: org.users.emp, kind: 'plan', date: W2 });
    expect((await run(at(W2, '08:40'))).scheduled).toBe(0); // same idempotency keys
    const send = (now: number) => withTenant(org.tenantId, (db) => nudgeUser(db, org.tenantId, org.users.emp, 'plan', W2, now));
    expect(await send(at(W2, '09:15'))).toBe(true);
    expect(await send(at(W2, '09:20'))).toBe(false);
    expect(await withTenant(org.tenantId, (db) => nudgeUser(db, org.tenantId, org.users.emp2, 'plan', W2, at(W2, '09:15')))).toBe(false); // opted out
  });

  it('runs as a registered tenant tick job', async () => {
    const { enqueue } = await import('../server/src/lib/jobs.js');
    await withTenant(org.tenantId, (db) => enqueue(db, { tenantId: org.tenantId, kind: 'planning.nudges', payload: {}, idempotencyKey: `test-planning-tick:${org.tenantId}` }));
    await drainJobs();
    const j = await withOwner(async (db) => (await db.query(`select status, last_error from jobs where idempotency_key = $1`, [`test-planning-tick:${org.tenantId}`])).rows[0]);
    expect(j).toMatchObject({ status: 'succeeded', last_error: null });
  });
});

describe('nudge preferences', () => {
  it('defaults to on, saves per user, audits changes and rejects unknown fields', async () => {
    const org = await makeOrg({ tz: TZ });
    const emp = await login(org, 'emp');
    expect((await emp.get('/api/planning/preferences')).body).toMatchObject({ planNudge: true, recapNudge: true });
    expect((await emp.put('/api/planning/preferences', { recapNudge: false })).body).toMatchObject({ planNudge: true, recapNudge: false });
    expect((await emp.get('/api/planning/preferences')).body.recapNudge).toBe(false);
    expect((await (await login(org, 'emp2')).get('/api/planning/preferences')).body.recapNudge).toBe(true);
    expect((await emp.put('/api/planning/preferences', { recapNudge: 'no' })).status).toBe(400);
    expect((await emp.put('/api/planning/preferences', { userId: org.users.emp2, planNudge: false })).status).toBe(400);
    const a = await withOwner(async (db) => (await db.query(`select details from audit_events where tenant_id = $1 and action = 'planning.preferences.update'`, [org.tenantId])).rows);
    expect(a).toHaveLength(1);
    expect(a[0].details).toMatchObject({ before: { recapNudge: true }, after: { recapNudge: false } });
  });
});

describe('weekly self-summary', () => {
  let org: Org; let emp: any; let mgr: any; let admin: any;
  const lastWeek = DateTime.now().setZone(TZ).minus({ weeks: 1 }).startOf('week'); // Monday of last week
  const day = (n: number) => iso(lastWeek.plus({ days: n }));
  beforeAll(async () => {
    org = await makeOrg({ tz: TZ });
    [emp, mgr, admin] = await Promise.all([login(org, 'emp'), login(org, 'manager'), login(org, 'admin')]);
    const done = (await emp.post('/api/tasks', { title: 'Publish onboarding guide', priority: 'high' })).body;
    await emp.post(`/api/tasks/${done.id}/status`, { to: 'done' });
    const blocked = (await emp.post('/api/tasks', { title: 'Connect billing export' })).body;
    await emp.post(`/api/tasks/${blocked.id}/status`, { to: 'blocked', blocker: { reason: 'Need finance sign-off', cause: 'dependency', waitingOnUserId: org.users.manager } });
    const carried = (await emp.post('/api/tasks', { title: 'Clean up test fixtures', dueDate: day(2) })).body;
    await withOwner(async (db) => {
      const acceptedAt = localIso(TZ, day(2), '15:00');
      await db.query(`update tasks set accepted_at = $2, done_at = $2 where id = $1`, [done.id, acceptedAt]);
      await db.query(`update blockers set raised_at = $2 where task_id = $1`, [blocked.id, localIso(TZ, day(1), '11:00')]);
      await db.query(`insert into time_entries (tenant_id, user_id, task_id, category, started_at, ended_at, source) values ($1,$2,$3,'task',$4,$5,'manual')`,
        [org.tenantId, org.users.emp, carried.id, localIso(TZ, day(2), '10:00'), localIso(TZ, day(2), '12:00')]);
      // The carried task existed (status planned) before it was planned on Tuesday.
      await db.query(`update task_state_history set at = $2 where task_id = $1`, [carried.id, localIso(TZ, day(0), '09:00')]);
    });
    await insertPlan(org, 'emp', day(1), [carried.id]);
  });

  it('builds a deterministic text summary with outcomes, carry-overs, blockers, neutral unknown time, deadlines and next-week focus', async () => {
    const r = await emp.get(`/api/planning/weekly-summary?date=${day(3)}`);
    expect(r.status).toBe(200);
    expect(r.body.period).toEqual({ start: day(0), end: day(6) });
    const text: string = r.body.text;
    expect(text).toMatch(/^Weekly summary: Mon /);
    expect(text).toContain('Accepted outcomes (1)');
    expect(text).toContain('- Publish onboarding guide: accepted');
    expect(text).toContain('Carried over (1)');
    expect(text).toMatch(/- Clean up test fixtures: planned on 1 day without being accepted; now Planned/);
    expect(text).toMatch(/- Connect billing export: Need finance sign-off; waiting on Manager \(open; no follow-up date\)/);
    expect(text).toContain('2h recorded of 35h scheduled (logging coverage 6%; this measures how much time was recorded, not productivity)');
    expect(text).toContain('33h of scheduled time has no time entry. Unrecorded time is unknown; it is not treated as idle.');
    expect(text).toMatch(/Deadlines this week \(1\)\n- 0 met, 0 met late, 1 overdue, 0 still open\./);
    expect(text).toContain('Suggested focus for next week');
    expect(text).toContain('- Follow up on "Connect billing export" with Manager.');
    expect(text).toContain('- Finish "Clean up test fixtures".');
    expect(text).not.toMatch(/\bidle\b(?!\.)/); // "idle" only appears in the neutral "not treated as idle." sentence
    expect(r.body.facts).toMatchObject({ acceptedOutcomes: 1, carryovers: 1, openBlockers: 1, workingDays: 5, availableMinutes: 2100, explainedMinutes: 120 });
    const again = await emp.get(`/api/planning/weekly-summary?date=${day(0)}`);
    expect(again.body.text).toBe(text);
  });

  it('is only available to the person it describes', async () => {
    expect((await emp.get(`/api/planning/weekly-summary?userId=${org.users.emp}`)).status).toBe(200);
    expect((await mgr.get(`/api/planning/weekly-summary?userId=${org.users.emp}`)).status).toBe(403);
    expect((await admin.get(`/api/planning/weekly-summary?userId=${org.users.emp}`)).status).toBe(403);
    const mine = await mgr.get(`/api/planning/weekly-summary?date=${day(3)}`);
    expect(mine.status).toBe(200);
    expect(mine.body.text).not.toContain('Publish onboarding guide');
    expect((await emp.get(`/api/planning/weekly-summary?date=${iso(DateTime.now().setZone(TZ).plus({ weeks: 2 }))}`)).status).toBe(400);
  });
});
