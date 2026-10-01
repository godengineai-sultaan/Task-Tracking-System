import { beforeAll, describe, expect, it } from 'vitest';
import { drainJobs, login, makeOrg, withOwner, type Org } from './helpers.js';
import { withTenant } from '../server/src/lib/db.js';
import { enqueue } from '../server/src/lib/jobs.js';
import type { CalendarData } from '../server/src/services/calendar.js';
import { DEFAULT_POLICY, assessBlocker, dateAfterWorkingDays, runEscalation, workingDaysBetween } from '../server/src/services/ext/escalation.js';

// Fixed historic week (Asia/Kolkata): Fri 2026-09-18, holiday Mon 2026-09-21, Sat/Sun 26-27.
const RAISED_FRI = '2026-09-18T10:00:00+05:30';
const POLICY = { enabled: true, remindOwner: true, waitingOnAfterDays: 2, managerAfterDays: 3, adminAfterDays: 5, quietWhenOwnerOnLeave: true };

type C = Awaited<ReturnType<typeof login>>;
async function blocked(c: C, title: string, blocker: Record<string, unknown>, raisedAt?: string) {
  const t = (await c.post('/api/tasks', { title })).body;
  const r = await c.post(`/api/tasks/${t.id}/status`, { to: 'blocked', blocker: { cause: 'dependency', ...blocker } });
  expect(r.status).toBe(200);
  const blockerId = (await c.get(`/api/tasks/${t.id}`)).body.blockers[0].id as string;
  if (raisedAt) await withOwner((db) => db.query(`update blockers set raised_at = $2 where id = $1`, [blockerId, raisedAt]));
  return { taskId: t.id as string, blockerId };
}
const run = (org: Org, today: string) => withTenant(org.tenantId, (db) => runEscalation(db, org.tenantId, { today }));
const levels = (blockerId: string) => withOwner(async (db) =>
  (await db.query(`select level, follow_up_date, working_days, outcome, recipient_ids from blocker_escalations where blocker_id = $1 order by created_at, level`, [blockerId])).rows);
const notes = (org: Org, userId: string, kind: string, taskId: string) => withOwner(async (db) =>
  (await db.query(`select * from notifications where tenant_id = $1 and user_id = $2 and kind = $3 and link = $4`, [org.tenantId, userId, kind, `/tasks/${taskId}`])).rows);
async function setPolicy(admin: C, policy: object) {
  const cur = (await admin.get('/api/escalation/policy')).body;
  const r = await admin.put('/api/escalation/policy', { policy: { ...POLICY, ...policy }, version: cur.version });
  expect(r.status).toBe(200);
  return r.body;
}

// Login is rate-limited (10/minute per app), so describes share three orgs: A (policy, ladder, jobs), B (leave), C (nudge, aging scope).
let orgA: Org; let orgB: Org; let orgC: Org;
let adminA: C; let empA: C; let adminB: C; let emp2B: C; let adminC: C; let mgrC: C; let empC: C; let outsiderC: C; let founderC: C;
beforeAll(async () => {
  [orgA, orgB, orgC] = await Promise.all([makeOrg(), makeOrg(), makeOrg()]);
  [adminA, empA, adminB, emp2B, adminC, mgrC, empC, outsiderC, founderC] = await Promise.all([
    login(orgA, 'admin'), login(orgA, 'emp'), login(orgB, 'admin'), login(orgB, 'emp2'),
    login(orgC, 'admin'), login(orgC, 'manager'), login(orgC, 'emp'), login(orgC, 'outsider'), login(orgC, 'founder')]);
});

describe('working-day arithmetic (pure)', () => {
  const sched = { start_minute: 540, end_minute: 1020, break_minutes: 60 };
  const cal = (leave: CalendarData['leave'] = []): CalendarData => ({
    timezone: 'Asia/Kolkata', schedule: new Map([1, 2, 3, 4, 5].map((d) => [d, sched])), holidays: new Map([['2026-09-21', 'Holiday']]), leave,
  });
  it('skips weekends and holidays when counting blocker age', () => {
    expect(workingDaysBetween(cal(), '2026-09-18', '2026-09-21', true)).toBe(0); // Sat, Sun, holiday Mon
    expect(workingDaysBetween(cal(), '2026-09-18', '2026-09-22', true)).toBe(1);
    expect(workingDaysBetween(cal(), '2026-09-18', '2026-09-28', true)).toBe(5);
    expect(dateAfterWorkingDays(cal(), '2026-09-18', 2, true)).toBe('2026-09-23');
    expect(dateAfterWorkingDays(cal(), '2026-09-18', 5, true)).toBe('2026-09-28');
  });
  it('pauses the clock on full-day leave only when quieting is on', () => {
    const lv = cal([{ start_date: '2026-09-23', end_date: '2026-09-24', portion: 'full', kind: 'leave' }]);
    expect(workingDaysBetween(lv, '2026-09-18', '2026-09-25', true)).toBe(2);
    expect(workingDaysBetween(lv, '2026-09-18', '2026-09-25', false)).toBe(4);
    const half = cal([{ start_date: '2026-09-23', end_date: '2026-09-23', portion: 'half_am', kind: 'leave' }]);
    expect(workingDaysBetween(half, '2026-09-18', '2026-09-23', true)).toBe(2);
  });
  it('lists due steps, the current level and the next step with its date', () => {
    const p = { ...DEFAULT_POLICY, ...POLICY };
    const a = assessBlocker(cal(), p, { raised_at: RAISED_FRI, next_follow_up: null }, '2026-09-24', [{ level: 'waiting_on', follow_up_date: null, outcome: 'notified' }]);
    expect(a).toMatchObject({ raisedOn: '2026-09-18', ageWorkingDays: 3, currentLevel: 'waiting_on', actsToday: true });
    expect(a.due.map((d) => d.level)).toEqual(['manager']);
    expect(a.next).toMatchObject({ level: 'admin', afterDays: 5, date: '2026-09-28' });
    expect(a.ownerReminderDue).toEqual({ followUpDate: null });
    const weekend = assessBlocker(cal(), p, { raised_at: RAISED_FRI, next_follow_up: null }, '2026-09-26', []);
    expect(weekend.actsToday).toBe(false);
  });
});

describe('escalation policy', () => {
  let org: Org; let admin: C; let emp: C;
  beforeAll(() => { org = orgA; admin = adminA; emp = empA; });
  it('defaults to off, is admin-only to change, validates order and uses optimistic versioning', async () => {
    const cur = (await emp.get('/api/escalation/policy')).body;
    expect(cur).toMatchObject({ enabled: false, version: 0 });
    expect((await emp.put('/api/escalation/policy', { policy: POLICY, version: 0 })).status).toBe(403);
    expect((await admin.put('/api/escalation/policy', { policy: { ...POLICY, managerAfterDays: 1 }, version: 0 })).status).toBe(400);
    const ok = await admin.put('/api/escalation/policy', { policy: POLICY, version: 0 });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ...POLICY, version: 1 });
    expect((await admin.put('/api/escalation/policy', { policy: POLICY, version: 0 })).status).toBe(409);
    expect((await admin.get('/api/escalation/policy')).body.version).toBe(1);
    const auditRows = await withOwner(async (db) => (await db.query(`select * from audit_events where tenant_id = $1 and action = 'escalation.policy.update'`, [org.tenantId])).rows);
    expect(auditRows).toHaveLength(1);
    // Other tenant settings survive the policy write
    const t = await withOwner(async (db) => (await db.query(`select settings from tenants where id = $1`, [org.tenantId])).rows[0]);
    expect(t.settings.coverage_threshold).toBe(0.5);
  });
});

describe('escalation ladder in working days', () => {
  let org: Org; let admin: C; let emp: C; let b: { taskId: string; blockerId: string };
  beforeAll(async () => {
    org = orgA; admin = adminA; emp = empA;
    await withOwner((db) => db.query(`insert into holidays (tenant_id, date, name) values ($1,'2026-09-21','Test holiday')`, [org.tenantId]));
    await setPolicy(admin, {});
    b = await blocked(emp, 'Waiting for schema', { reason: 'Need the new schema', waitingOnUserId: org.users.emp2 }, RAISED_FRI);
  });
  it('does nothing on a holiday or before the first working day passes', async () => {
    await run(org, '2026-09-21');
    expect(await levels(b.blockerId)).toEqual([]);
  });
  it('reminds the owner after one working day, then the person waited on after two', async () => {
    await run(org, '2026-09-22');
    expect((await levels(b.blockerId)).map((l) => l.level)).toEqual(['owner']);
    expect(await notes(org, org.users.emp, 'blocker_reminder', b.taskId)).toHaveLength(1);
    await run(org, '2026-09-23');
    const ls = await levels(b.blockerId);
    expect(ls.map((l) => l.level)).toEqual(['owner', 'waiting_on']);
    expect(ls[1]).toMatchObject({ working_days: 2, outcome: 'notified', recipient_ids: [org.users.emp2] });
    const n = await notes(org, org.users.emp2, 'blocker_escalation', b.taskId);
    expect(n).toHaveLength(1);
    expect(n[0].body).toMatch(/2 working days/);
  });
  it('fires each level once (idempotent across repeated ticks)', async () => {
    await run(org, '2026-09-23'); await run(org, '2026-09-23');
    expect(await levels(b.blockerId)).toHaveLength(2);
    expect(await notes(org, org.users.emp2, 'blocker_escalation', b.taskId)).toHaveLength(1);
    await expect(withOwner((db) => db.query(`insert into blocker_escalations (tenant_id, blocker_id, level, working_days) values ($1,$2,'waiting_on',9)`, [org.tenantId, b.blockerId])))
      .rejects.toThrow(/blocker_escalations_once/);
  });
  it('notifies the team manager, skips the weekend, then notifies main admins', async () => {
    await run(org, '2026-09-24');
    expect((await levels(b.blockerId)).map((l) => l.level)).toContain('manager');
    expect(await notes(org, org.users.manager, 'blocker_escalation', b.taskId)).toHaveLength(1);
    await run(org, '2026-09-26'); // Saturday: age stays 4, nothing fires
    expect((await levels(b.blockerId)).map((l) => l.level)).not.toContain('admin');
    await run(org, '2026-09-28');
    const admin = (await levels(b.blockerId)).find((l) => l.level === 'admin');
    expect(admin).toMatchObject({ working_days: 5, outcome: 'notified', recipient_ids: [org.users.admin] });
    expect(await notes(org, org.users.admin, 'blocker_escalation', b.taskId)).toHaveLength(1);
    const audits = await withOwner(async (db) => (await db.query(`select details from audit_events where tenant_id = $1 and action = 'blocker.escalated' and resource_id = $2`, [org.tenantId, b.blockerId])).rows);
    expect(audits.map((x) => x.details.level).sort()).toEqual(['admin', 'manager', 'waiting_on']);
  });
  it('records an external waiting-on as skipped instead of notifying anyone', async () => {
    const ext = await blocked(emp, 'Client sign-off', { reason: 'Client legal review', cause: 'client', waitingOnText: 'Client legal' }, RAISED_FRI);
    await run(org, '2026-09-23');
    expect((await levels(ext.blockerId)).find((l) => l.level === 'waiting_on')).toMatchObject({ outcome: 'skipped', recipient_ids: [] });
    const h = (await emp.get(`/api/blockers/${ext.blockerId}/escalation`)).body;
    expect(h.currentLevel).toBeNull(); // a skipped step is not shown as an escalation
    expect(h.history.find((x: any) => x.level === 'waiting_on')).toMatchObject({ outcome: 'skipped' });
  });
  it('reminds the owner once per follow-up date', async () => {
    const f = await blocked(emp, 'Vendor quote', { reason: 'Quote pending', waitingOnText: 'Vendor', nextFollowUp: '2026-09-29' }, RAISED_FRI);
    await withOwner((db) => db.query(`delete from notifications where tenant_id = $1`, [org.tenantId]));
    await run(org, '2026-09-28');
    expect((await levels(f.blockerId)).filter((l) => l.level === 'owner')).toHaveLength(0);
    await run(org, '2026-09-29'); await run(org, '2026-09-29');
    expect((await levels(f.blockerId)).filter((l) => l.level === 'owner').map((l) => l.follow_up_date)).toEqual(['2026-09-29']);
    expect((await emp.post(`/api/blockers/${f.blockerId}/follow-up`, { nextFollowUp: '2026-10-01' })).status).toBe(200);
    await withOwner((db) => db.query(`delete from notifications where tenant_id = $1`, [org.tenantId]));
    await run(org, '2026-10-01');
    expect((await levels(f.blockerId)).filter((l) => l.level === 'owner').map((l) => l.follow_up_date)).toEqual(['2026-09-29', '2026-10-01']);
    expect(await notes(org, org.users.emp, 'blocker_reminder', f.taskId)).toHaveLength(1);
  });
  it('stops escalating once the blocker is resolved', async () => {
    const r = await blocked(emp, 'Resolved soon', { reason: 'Waiting', waitingOnUserId: org.users.emp2 }, RAISED_FRI);
    await emp.post(`/api/tasks/${r.taskId}/status`, { to: 'in_progress', resolution: 'Unblocked' });
    const out = await run(org, '2026-10-01');
    expect(await levels(r.blockerId)).toEqual([]);
    expect(out.evaluated).toBeGreaterThan(0);
  });
  it('does nothing when the policy is off', async () => {
    await setPolicy(admin, { enabled: false });
    const x = await blocked(emp, 'Policy off', { reason: 'Waiting', waitingOnUserId: org.users.emp2 }, RAISED_FRI);
    expect(await run(org, '2026-10-01')).toMatchObject({ evaluated: 0 });
    expect(await levels(x.blockerId)).toEqual([]);
  });
});

describe('quiet while the owner is on leave', () => {
  let org: Org; let admin: C; let emp2: C;
  beforeAll(async () => {
    org = orgB; admin = adminB; emp2 = emp2B;
    await withOwner((db) => db.query(`insert into leave_entries (tenant_id, user_id, start_date, end_date, portion, kind) values ($1,$2,'2026-09-16','2026-09-17','full','leave')`,
      [org.tenantId, org.users.emp2]));
  });
  it('pauses the clock and sends nothing on full-day leave', async () => {
    await setPolicy(admin, { managerAfterDays: null, adminAfterDays: null, remindOwner: false });
    const b = await blocked(emp2, 'On leave case', { reason: 'Waiting', waitingOnUserId: org.users.emp }, '2026-09-14T10:00:00+05:30');
    await run(org, '2026-09-16'); await run(org, '2026-09-17');
    expect(await levels(b.blockerId)).toEqual([]);
    await run(org, '2026-09-18');
    expect(await levels(b.blockerId)).toMatchObject([{ level: 'waiting_on', working_days: 2 }]);
  });
  it('counts leave days and acts when quieting is off', async () => {
    await setPolicy(admin, { managerAfterDays: null, adminAfterDays: null, remindOwner: false, quietWhenOwnerOnLeave: false });
    const b = await blocked(emp2, 'Not quiet case', { reason: 'Waiting', waitingOnUserId: org.users.emp }, '2026-09-14T10:00:00+05:30');
    await run(org, '2026-09-16');
    expect(await levels(b.blockerId)).toMatchObject([{ level: 'waiting_on', working_days: 2 }]);
  });
});

describe('nudge', () => {
  let org: Org; let emp: C; let mgr: C; let outsider: C; let b: { taskId: string; blockerId: string };
  beforeAll(async () => {
    org = orgC; emp = empC; mgr = mgrC; outsider = outsiderC;
    b = await blocked(emp, 'Needs access', { reason: 'Need staging access', cause: 'access', waitingOnUserId: org.users.emp2 });
  });
  it('notifies the person waited on and records the nudge', async () => {
    const r = await emp.post(`/api/blockers/${b.blockerId}/nudge`, { note: 'Could you look today?' });
    expect(r.status).toBe(200);
    expect(r.body.nextAllowedOn).toBeTruthy();
    const n = await notes(org, org.users.emp2, 'blocker_nudge', b.taskId);
    expect(n).toHaveLength(1);
    expect(n[0].body).toMatch(/Could you look today/);
    const audit = await withOwner(async (db) => (await db.query(`select * from audit_events where tenant_id = $1 and action = 'blocker.nudge'`, [org.tenantId])).rows);
    expect(audit).toHaveLength(1);
  });
  it('is rate-limited to once per day per blocker per person', async () => {
    const again = await emp.post(`/api/blockers/${b.blockerId}/nudge`, {});
    expect(again.status).toBe(429);
    expect((await mgr.post(`/api/blockers/${b.blockerId}/nudge`, {})).status).toBe(200); // a different person may nudge
    expect(await notes(org, org.users.emp2, 'blocker_nudge', b.taskId)).toHaveLength(2);
  });
  it('requires access to the task and an internal person to nudge', async () => {
    expect((await outsider.post(`/api/blockers/${b.blockerId}/nudge`, {})).status).toBe(404);
    expect((await outsider.get(`/api/blockers/${b.blockerId}/escalation`)).status).toBe(404);
    const ext = await blocked(emp, 'Client wait', { reason: 'Client', cause: 'client', waitingOnText: 'Client IT' });
    expect((await emp.post(`/api/blockers/${ext.blockerId}/nudge`, {})).status).toBe(400);
    const self = await blocked(emp, 'Self wait', { reason: 'Me', waitingOnUserId: org.users.emp });
    expect((await emp.post(`/api/blockers/${self.blockerId}/nudge`, {})).status).toBe(400);
    const done = await blocked(emp, 'Resolved', { reason: 'X', waitingOnUserId: org.users.emp2 });
    await emp.post(`/api/tasks/${done.taskId}/status`, { to: 'in_progress', resolution: 'ok' });
    expect((await emp.post(`/api/blockers/${done.blockerId}/nudge`, {})).status).toBe(409);
    expect((await emp.post(`/api/blockers/not-a-uuid/nudge`, {})).status).toBe(400);
  });
  it('shows escalation history with nudges and the nudge state', async () => {
    const h = await emp.get(`/api/blockers/${b.blockerId}/escalation`);
    expect(h.status).toBe(200);
    expect(h.body.history.filter((x: any) => x.type === 'nudge')).toHaveLength(2);
    expect(h.body.history[0]).toMatchObject({ type: 'nudge' });
    expect(h.body.nudge).toMatchObject({ allowed: false, nudgedToday: true });
    expect(h.body).toMatchObject({ ageWorkingDays: 0, currentLevel: null, waitingOn: 'Emp2' });
  });
});

describe('blocker-aging view scope', () => {
  let org: Org; let admin: C; let mgr: C; let emp: C; let ids: Record<string, string>;
  beforeAll(async () => {
    org = orgC; admin = adminC; mgr = mgrC; emp = empC;
    const [e, f, o] = [empC, founderC, outsiderC];
    ids = {
      emp: (await blocked(e, 'Team blocker', { reason: 'Team', waitingOnUserId: org.users.emp2 }, RAISED_FRI)).blockerId,
      founder: (await blocked(f, 'Founder blocker', { reason: 'Founder', waitingOnText: 'Bank' })).blockerId,
      outsider: (await blocked(o, 'Other team blocker', { reason: 'Other', waitingOnUserId: org.users.emp })).blockerId,
    };
  });
  it('team managers see their team only', async () => {
    const r = await mgr.get('/api/escalation/blockers');
    expect(r.status).toBe(200);
    expect(r.body.scope).toBe('team');
    const seen = r.body.items.map((i: any) => i.blockerId);
    expect(seen).toContain(ids.emp);
    expect(seen).not.toContain(ids.founder);
    expect(seen).not.toContain(ids.outsider);
    expect(r.body.items.every((i: any) => i.ownerId === org.users.emp || i.ownerId === org.users.emp2 || i.ownerId === org.users.manager)).toBe(true);
    expect(r.body.items.find((i: any) => i.blockerId === ids.emp).ageWorkingDays).toBeGreaterThanOrEqual(5);
  });
  it('admins see the whole company; no per-person ranking is returned', async () => {
    const r = await admin.get('/api/escalation/blockers');
    expect(r.body.scope).toBe('company');
    const seen = r.body.items.map((i: any) => i.blockerId);
    for (const id of Object.values(ids)) expect(seen).toContain(id);
    expect(Object.keys(r.body.summary).sort()).toEqual(['escalated', 'external', 'medianAgeWorkingDays', 'open']);
    expect(r.body.summary.open).toBe(r.body.items.length);
    expect(r.body.items.find((i: any) => i.blockerId === ids.founder)).toMatchObject({ waitingOn: 'Bank', waitingOnInternal: false, level: null });
  });
  it('members cannot open the aging view', async () => {
    expect((await emp.get('/api/escalation/blockers')).status).toBe(403);
  });
});

describe('scheduled jobs', () => {
  let org: Org; let admin: C; let emp: C;
  beforeAll(() => { org = orgA; admin = adminA; emp = empA; });
  const remind = (key: string) => withTenant(org.tenantId, (db) => enqueue(db, { tenantId: org.tenantId, kind: 'blockers.remind', payload: {}, idempotencyKey: `test-remind:${org.tenantId}:${key}` }));
  it('the legacy reminder job does not remind owners twice when escalation is enabled', async () => {
    const b = await blocked(emp, 'Old follow-up', { reason: 'Waiting', waitingOnText: 'Vendor', nextFollowUp: '2026-01-05' });
    await setPolicy(admin, {});
    await remind('on'); await drainJobs();
    expect(await notes(org, org.users.emp, 'blocker_reminder', b.taskId)).toHaveLength(0);
    await setPolicy(admin, { enabled: false });
    await remind('off'); await drainJobs();
    expect(await notes(org, org.users.emp, 'blocker_reminder', b.taskId)).toHaveLength(1);
  });
  it('the hourly escalation tick is registered and runs per tenant', async () => {
    await setPolicy(admin, {});
    const id = await withTenant(org.tenantId, (db) => enqueue(db, { tenantId: org.tenantId, kind: 'escalation.evaluate', payload: {}, idempotencyKey: `test-esc:${org.tenantId}` }));
    await drainJobs();
    const job = await withOwner(async (db) => (await db.query(`select status, last_error from jobs where id = $1`, [id])).rows[0]);
    expect(job).toMatchObject({ status: 'succeeded', last_error: null });
  });
});
