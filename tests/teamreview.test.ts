import { DateTime } from 'luxon';
import { beforeAll, describe, expect, it } from 'vitest';
import { drainJobs, localIso, login, makeOrg, withOwner, type Org } from './helpers.js';
import { withTenant } from '../server/src/lib/db.js';
import { remindWeeklyReviewers } from '../server/src/services/ext/teamreview.js';

type C = Awaited<ReturnType<typeof login>>;
let org: Org; let admin: C; let mgr: C; let emp: C; let emp2: C; let outsider: C; let founder: C;
let week: string; let day: (n: number) => string;

const allKeys = (v: any, out = new Set<string>()): Set<string> => {
  if (Array.isArray(v)) v.forEach((x) => allKeys(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); allKeys(x, out); }
  return out;
};

beforeAll(async () => {
  org = await makeOrg();
  // These people have worked here for a while: their records start before the periods reviewed below.
  await withOwner((db) => db.query(`update users set created_at = now() - interval '1 year' where tenant_id = $1`, [org.tenantId]));
  [admin, mgr, emp, emp2, outsider, founder] = await Promise.all(['admin', 'manager', 'emp', 'emp2', 'outsider', 'founder'].map((k) => login(org, k)));
  week = DateTime.now().setZone(org.tz).minus({ days: 7 }).startOf('week').toISODate()!;
  day = (n: number) => DateTime.fromISO(week).plus({ days: n }).toISODate()!;
  // Fixture data for last week: Emp has an open blocker; Emp2 logged 4h and confirmed Monday's recap.
  await withOwner(async (db) => {
    const t = (await db.query(`insert into tasks (tenant_id, title, owner_id, created_by, status, created_at) values ($1,'Vendor API access',$2,$2,'blocked',$3) returning id`,
      [org.tenantId, org.users.emp, localIso(org.tz, day(0), '09:00')])).rows[0];
    await db.query(`insert into blockers (tenant_id, task_id, reason, cause, raised_by, raised_at) values ($1,$2,'Waiting for vendor credentials','access',$3,$4)`,
      [org.tenantId, t.id, org.users.emp, localIso(org.tz, day(1), '10:00')]);
    await db.query(`insert into time_entries (tenant_id, user_id, category, started_at, ended_at, source) values ($1,$2,'task',$3,$4,'manual')`,
      [org.tenantId, org.users.emp2, localIso(org.tz, day(0), '09:00'), localIso(org.tz, day(0), '13:00')]);
    await db.query(`insert into daily_reviews (tenant_id, user_id, date, status, summary, version, confirmed_at) values ($1,$2,$3,'confirmed','Shipped the import fix',1,now())`,
      [org.tenantId, org.users.emp2, day(0)]);
  });
});

describe('weekly team review: scope and order', () => {
  it('manager sees only their team, admin sees everyone, employees and non-reviewers are refused', async () => {
    const m = await mgr.get(`/api/team-review?week=${day(3)}`);
    expect(m.status).toBe(200);
    expect(m.body.week).toMatchObject({ start: week, end: day(6) });
    expect(m.body.scope).toBe('team');
    expect(m.body.people.map((p: any) => p.user.name)).toEqual(['Emp', 'Emp2']);
    const withMe = await mgr.get(`/api/team-review?week=${week}&includeMe=1`);
    expect(withMe.body.people.map((p: any) => p.user.name)).toEqual(['Emp', 'Emp2', 'Manager']);
    expect(withMe.body.people.find((p: any) => p.user.name === 'Manager').isSelf).toBe(true);
    const a = await admin.get(`/api/team-review?week=${week}`);
    expect(a.body.scope).toBe('company');
    expect(a.body.people.map((p: any) => p.user.name)).toEqual(['Emp', 'Emp2', 'Founder', 'Manager', 'Outsider']);
    for (const c of [emp, emp2, outsider, founder]) expect((await c.get(`/api/team-review?week=${week}`)).status).toBe(403);
    expect((await mgr.get(`/api/team-review?week=${DateTime.now().plus({ days: 14 }).toISODate()}`)).status).toBe(400);
    expect((await mgr.get('/api/team-review?week=2026-13-45')).status).toBe(400);
  });

  it('summarises each week from recorded facts, alphabetical and never ranked', async () => {
    const r = (await mgr.get(`/api/team-review?week=${week}`)).body;
    const [e, e2] = r.people;
    expect(r.order).toBe('alphabetical');
    expect(r.people.map((p: any) => p.user.name)).toEqual([...r.people.map((p: any) => p.user.name)].sort((x: string, y: string) => x.localeCompare(y)));
    // Emp2 has more recorded work than Emp, yet the order stays by name.
    expect(e2.time.confirmedMinutes).toBe(240);
    expect(e.time.confirmedMinutes).toBe(0);
    expect(e2.time.availableMinutes).toBe(5 * 420);
    expect(e2.time.unknownMinutes).toBe(5 * 420 - 240);
    expect(e2.recaps).toMatchObject({ required: 5, confirmed: 1, missing: 4 });
    expect(e.blockers.open).toBe(1);
    expect(e.blockers.items[0]).toMatchObject({ task: 'Vendor API access', reason: 'Waiting for vendor credentials', cause: 'access' });
    expect(e.time.blockedMinutes).toBeGreaterThan(0);
    expect(e.flags).toMatchObject({ blocked: true, missingRecaps: true, unreviewed: true });
    for (const p of r.people) {
      expect(['on_track', 'needs_attention', 'insufficient_data', 'not_applicable']).toContain(p.assessment.label);
      expect(p.assessment.reasons.length).toBeGreaterThan(0);
      expect(p.assessment.facts.length).toBeGreaterThan(0);
      expect(p.assessment.assumptions.length).toBeGreaterThan(0);
    }
    // Too few confirmed recaps and low logging coverage: unknown time is not treated as idle, so this is insufficient data, not "needs attention".
    expect(e2.assessment.label).toBe('insufficient_data');
    expect(r.totals).toMatchObject({ people: 2, openBlockers: 1, attention: { blocked: 1, missingRecaps: 2, unreviewed: 2 } });
    expect(r.totals.time.confirmedMinutes).toBe(240);
    expect(r.note).toMatch(/not a ranking/);
    const keys = [...allKeys(r)].map((k) => k.toLowerCase());
    expect(keys.filter((k) => /rank|score|productivity/.test(k))).toEqual([]);
  });
});

describe('weekly team review: lifecycle', () => {
  let reviewId: string;
  it('acknowledge, discuss and request a follow-up with optimistic versions; notifies and audits; never edits recaps or time', async () => {
    const before = await withOwner(async (db) => ({
      recap: (await db.query(`select status, version, summary from daily_reviews where user_id = $1`, [org.users.emp2])).rows[0],
      time: (await db.query(`select started_at, ended_at, version from time_entries where user_id = $1`, [org.users.emp2])).rows,
    }));
    const ack = await mgr.post('/api/team-review/reviews', { subjectUserId: org.users.emp2, week: day(2), action: 'acknowledge', note: 'Thanks for confirming Monday.' });
    expect(ack.status).toBe(200);
    expect(ack.body).toMatchObject({ status: 'acknowledged', version: 1, weekStart: week, note: 'Thanks for confirming Monday.', reviewer: { name: 'Manager' } });
    reviewId = ack.body.id;
    // Retries / stale writes cannot overwrite or duplicate.
    expect((await mgr.post('/api/team-review/reviews', { subjectUserId: org.users.emp2, week, action: 'discussed' })).status).toBe(409);
    expect((await mgr.post('/api/team-review/reviews', { subjectUserId: org.users.emp2, week, action: 'discussed', version: 7 })).status).toBe(409);
    const disc = await mgr.post('/api/team-review/reviews', { subjectUserId: org.users.emp2, week, action: 'discussed', note: 'Talked through logging gaps.', version: 1 });
    expect(disc.body).toMatchObject({ id: reviewId, status: 'discussed', version: 2, note: 'Talked through logging gaps.' });
    const fu = await mgr.post('/api/team-review/reviews', { subjectUserId: org.users.emp2, week, action: 'needs_follow_up', note: 'Agree a daily recap routine.', version: 2,
      followUp: { title: 'Set a daily recap reminder', dueDate: DateTime.now().setZone(org.tz).plus({ days: 3 }).toISODate() } });
    expect(fu.status).toBe(200);
    expect(fu.body).toMatchObject({ status: 'needs_follow_up', version: 3, followUpTask: { title: 'Set a daily recap reminder', status: 'planned' } });
    const task = (await emp2.get(`/api/tasks/${fu.body.followUpTask.id}`)).body.task;
    expect(task).toMatchObject({ owner_id: org.users.emp2, source_type: 'follow_up' });
    expect(task.source_ref).toMatchObject({ weekly_review_id: reviewId, week_start: week });

    const n = (await emp2.get('/api/notifications')).body.filter((x: any) => x.kind === 'weekly_review');
    expect(n).toHaveLength(3);
    expect(n.map((x: any) => x.title).join(' ')).toMatch(/acknowledged your week/);
    expect(n[0].link).toBe(`/team-review?tab=mine&week=${week}`);
    const audits = await withOwner(async (db) => (await db.query(`select action, authority, resource_version from audit_events where resource_id = $1 order by id`, [reviewId])).rows);
    expect(audits.map((x) => x.action)).toEqual(['weekly_review.acknowledged', 'weekly_review.discussed', 'weekly_review.needs_follow_up']);
    expect(audits.every((x) => x.authority === 'team_manager')).toBe(true);

    const after = await withOwner(async (db) => ({
      recap: (await db.query(`select status, version, summary from daily_reviews where user_id = $1`, [org.users.emp2])).rows[0],
      time: (await db.query(`select started_at, ended_at, version from time_entries where user_id = $1`, [org.users.emp2])).rows,
    }));
    expect(after).toEqual(before);

    const team = (await mgr.get(`/api/team-review?week=${week}`)).body;
    expect(team.people.find((p: any) => p.user.name === 'Emp2')).toMatchObject({ review: { status: 'needs_follow_up', version: 3 }, flags: { unreviewed: false } });
    expect(team.totals.reviewedByYou).toBe(1);
    const asAdmin = (await admin.get(`/api/team-review?week=${week}`)).body.people.find((p: any) => p.user.name === 'Emp2');
    expect(asAdmin.review).toBeNull();
    expect(asAdmin.otherReviews.map((x: any) => [x.reviewer.name, x.status])).toEqual([['Manager', 'needs_follow_up']]);
  });

  it('enforces who may review what', async () => {
    const body = (subjectUserId: string, extra: object = {}) => ({ subjectUserId, week, action: 'acknowledge', ...extra });
    expect((await mgr.post('/api/team-review/reviews', body(org.users.manager))).status).toBe(403);
    expect((await mgr.post('/api/team-review/reviews', body(org.users.outsider))).status).toBe(403);
    expect((await emp.post('/api/team-review/reviews', body(org.users.emp2))).status).toBe(403);
    expect((await founder.post('/api/team-review/reviews', body(org.users.emp))).status).toBe(403);
    expect((await mgr.post('/api/team-review/reviews', { ...body(org.users.emp), week: DateTime.now().plus({ days: 14 }).toISODate() })).status).toBe(400);
    expect((await mgr.post('/api/team-review/reviews', { ...body(org.users.emp), action: 'needs_follow_up' })).status).toBe(400);
    expect((await mgr.post('/api/team-review/reviews', { ...body(org.users.emp), followUp: { title: 'x' } })).status).toBe(400);
    expect((await mgr.post('/api/team-review/reviews', { ...body(org.users.emp), rank: 1 })).status).toBe(400);
    const other = await makeOrg();
    const rows = await withTenant(other.tenantId, (db) => db.query(`select id from weekly_reviews where id = $1`, [reviewId]));
    expect(rows.rowCount).toBe(0);
  });

  it('does not create a second follow-up task (orphaning the first) while one is still open', async () => {
    const emp2Review = async () => (await mgr.get(`/api/team-review?week=${week}`)).body.people.find((p: any) => p.user.name === 'Emp2').review;
    const cur = await emp2Review();
    const dup = await mgr.post('/api/team-review/reviews', { subjectUserId: org.users.emp2, week, action: 'needs_follow_up', note: cur.note, version: cur.version,
      followUp: { title: 'Another reminder task' } });
    expect(dup.status).toBe(409);
    expect(await emp2Review()).toMatchObject({ version: cur.version, followUpTask: { id: cur.followUpTask.id } });
    const n = await withOwner(async (db) => (await db.query(`select count(*)::int n from tasks where tenant_id = $1 and source_type = 'follow_up'`, [org.tenantId])).rows[0].n);
    expect(n).toBe(1);
  });

  it('employees see only their own reviews and can respond; the reviewer is notified', async () => {
    const mine = (await emp2.get('/api/team-review/mine')).body;
    expect(mine.map((r: any) => r.id)).toEqual([reviewId]);
    expect(mine[0]).toMatchObject({ note: 'Agree a daily recap routine.', reviewer: { name: 'Manager' }, status: 'needs_follow_up' });
    expect((await emp.get('/api/team-review/mine')).body).toEqual([]);
    expect((await emp.post(`/api/team-review/reviews/${reviewId}/respond`, { response: 'Not mine', version: 3 })).status).toBe(404);
    expect((await mgr.post(`/api/team-review/reviews/${reviewId}/respond`, { response: 'Self reply', version: 3 })).status).toBe(404);
    expect((await emp2.post(`/api/team-review/reviews/${reviewId}/respond`, { response: '   ', version: 3 })).status).toBe(400);
    const res = await emp2.post(`/api/team-review/reviews/${reviewId}/respond`, { response: 'Will set a 17:30 reminder.', version: 3 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ employeeResponse: 'Will set a 17:30 reminder.', version: 4, status: 'needs_follow_up' });
    expect(res.body.employeeRespondedAt).toBeTruthy();
    expect((await emp2.post(`/api/team-review/reviews/${reviewId}/respond`, { response: 'Again', version: 3 })).status).toBe(409);
    const n = (await mgr.get('/api/notifications')).body.find((x: any) => x.kind === 'weekly_review_response');
    expect(n).toMatchObject({ body: 'Will set a 17:30 reminder.', link: `/team-review?week=${week}` });
    // A second reviewer keeps a separate review of the same week.
    const adminRev = await admin.post('/api/team-review/reviews', { subjectUserId: org.users.emp2, week, action: 'acknowledge', note: 'Seen.' });
    expect(adminRev.body.version).toBe(1);
    expect((await emp2.get('/api/team-review/mine')).body).toHaveLength(2);
    expect((await mgr.get(`/api/team-review?week=${week}`)).body.people.find((p: any) => p.user.name === 'Emp2').review.employeeResponse).toBe('Will set a 17:30 reminder.');
  });

  it('tells the reviewer when the follow-up task is done', async () => {
    const r = (await emp2.get('/api/team-review/mine')).body.find((x: any) => x.id === reviewId);
    const done = await emp2.post(`/api/tasks/${r.followUpTask.id}/status`, { to: 'done' });
    expect(done.body.status).toBe('done');
    const n = (await mgr.get('/api/notifications')).body.filter((x: any) => x.kind === 'weekly_review_follow_up_done');
    expect(n).toHaveLength(1);
    expect(n[0].title).toBe('Follow-up done: Set a daily recap reminder');
    // Once the earlier follow-up is closed, a new one may be created and linked.
    const cur = (await mgr.get(`/api/team-review?week=${week}`)).body.people.find((p: any) => p.user.name === 'Emp2').review;
    const again = await mgr.post('/api/team-review/reviews', { subjectUserId: org.users.emp2, week, action: 'needs_follow_up', version: cur.version, followUp: { title: 'Review the reminder after a week' } });
    expect(again.status).toBe(200);
    expect(again.body.followUpTask).toMatchObject({ title: 'Review the reminder after a week', status: 'planned' });
    expect(again.body.followUpTask.id).not.toBe(r.followUpTask.id);
  });

  it('reminds team managers on Monday once per week', async () => {
    const monday = DateTime.fromISO(week, { zone: org.tz }).plus({ days: 7 }).set({ hour: 10 });
    expect(await withTenant(org.tenantId, (db) => remindWeeklyReviewers(db, org.tenantId, monday.plus({ days: 1 })))).toBe(0);
    expect(await withTenant(org.tenantId, (db) => remindWeeklyReviewers(db, org.tenantId, monday))).toBe(1);
    expect(await withTenant(org.tenantId, (db) => remindWeeklyReviewers(db, org.tenantId, monday.plus({ hours: 1 })))).toBe(0);
    const n = (await mgr.get('/api/notifications')).body.find((x: any) => x.kind === 'weekly_review_ready');
    expect(n.body).toMatch(/^1 team member/);
  });
});

describe('weekly team review: export', () => {
  it('exports the team week as CSV/PDF only for the same scope', async () => {
    expect((await emp.post('/api/exports', { format: 'csv', report: 'team_weekly', params: { date: week } })).status).toBe(403);
    expect((await founder.post('/api/exports', { format: 'pdf', report: 'team_weekly', params: { date: week } })).status).toBe(403);
    expect((await mgr.post('/api/exports', { format: 'csv', report: 'team_weekly', params: {} })).status).toBe(400);
    // A week the page would refuse must be refused up front, not left as an export that never finishes.
    expect((await mgr.post('/api/exports', { format: 'csv', report: 'team_weekly', params: { date: DateTime.now().plus({ days: 14 }).toISODate() } })).status).toBe(400);
    expect((await mgr.post('/api/exports', { format: 'pdf', report: 'team_weekly', params: { date: '2026-02-30' } })).status).toBe(400);
    await admin.post('/api/team-review/reviews', { subjectUserId: org.users.emp, week, action: 'acknowledge', note: '=HYPERLINK("x")' });
    const m = await mgr.post('/api/exports', { format: 'csv', report: 'team_weekly', params: { date: day(4) } });
    const a = await admin.post('/api/exports', { format: 'csv', report: 'team_weekly', params: { date: week } });
    const pdf = await mgr.post('/api/exports', { format: 'pdf', report: 'team_weekly', params: { date: week } });
    expect([m.status, a.status, pdf.status]).toEqual([200, 200, 200]);
    await drainJobs();
    for (const [c, id] of [[mgr, m.body.id], [admin, a.body.id], [mgr, pdf.body.id]] as const) expect((await c.get(`/api/exports/${id}`)).body.status).toBe('ready');
    const mCsv = String((await mgr.get(`/api/exports/${m.body.id}/file`)).body);
    expect(mCsv).toMatch(/Alphabetical \(not a ranking\)/);
    // Every exported assessment carries the facts and assumptions it rests on, not just a label.
    expect(mCsv).toContain('assessment,assessment_reasons,assessment_facts,assessment_assumptions,');
    const names = mCsv.split('\n').filter((l) => /^(Emp|Emp2|Founder|Manager|Outsider),/.test(l)).map((l) => l.split(',')[0]);
    expect(names).toEqual(['Emp', 'Emp2']);
    expect(mCsv).toContain('Needs follow-up,Agree a daily recap routine.,Will set a 17:30 reminder.');
    const aCsv = String((await admin.get(`/api/exports/${a.body.id}/file`)).body);
    expect(aCsv.split('\n').filter((l) => /^(Emp|Emp2|Founder|Manager|Outsider),/.test(l)).map((l) => l.split(',')[0])).toEqual(['Emp', 'Emp2', 'Founder', 'Manager', 'Outsider']);
    expect(aCsv).toContain(`"'=HYPERLINK(""x"")"`);
    const f = await mgr.get(`/api/exports/${pdf.body.id}/file`);
    expect(f.headers['content-type']).toBe('application/pdf');
    expect(Buffer.from(f.raw).subarray(0, 5).toString()).toBe('%PDF-');
    // Generation re-authorizes: a manager who loses their team cannot receive the file.
    const late = await mgr.post('/api/exports', { format: 'csv', report: 'team_weekly', params: { date: week } });
    await withOwner((db) => db.query(`update teams set manager_id = $2 where tenant_id = $1`, [org.tenantId, org.users.admin]));
    await drainJobs();
    expect((await mgr.get(`/api/exports/${late.body.id}`)).body.status).toBe('failed');
  });
});

describe('weekly team review: founder visibility policy', () => {
  it('a non-founder main admin neither sees, reviews nor exports founders when the tenant hides them', async () => {
    const o = await makeOrg({ settings: { founders_visible_to_routine_admin: false } });
    const adm = await login(o, 'admin');
    const w = DateTime.now().setZone(o.tz).minus({ days: 7 }).startOf('week').toISODate()!;
    const r = await adm.get(`/api/team-review?week=${w}&includeMe=1`);
    expect(r.status).toBe(200);
    expect(r.body.people.map((p: any) => p.user.name)).toEqual(['Admin', 'Emp', 'Emp2', 'Manager', 'Outsider']);
    expect((await adm.post('/api/team-review/reviews', { subjectUserId: o.users.founder, week: w, action: 'acknowledge' })).status).toBe(403);
    const ex = await adm.post('/api/exports', { format: 'csv', report: 'team_weekly', params: { date: w } });
    await drainJobs();
    const csv = String((await adm.get(`/api/exports/${ex.body.id}/file`)).body);
    expect(csv).toMatch(/^Emp2,/m);
    expect(csv).not.toMatch(/^Founder,/m);
  });
});

describe('weekly team review: client accounts', () => {
  it('a client account added to a team is never listed, reviewed or counted as a team member', async () => {
    const o = await makeOrg();
    const m = await login(o, 'manager');
    const w = DateTime.now().setZone(o.tz).minus({ days: 7 }).startOf('week').toISODate()!;
    const clientId = await withOwner(async (db) => {
      const u = (await db.query(`insert into users (tenant_id, email, name, roles) values ($1,$2,'Aaron Client',array['customer']) returning id`, [o.tenantId, `client@${o.tenantId}.test`])).rows[0];
      await db.query(`insert into team_members (tenant_id, team_id, user_id) select tenant_id, id, $2 from teams where tenant_id = $1`, [o.tenantId, u.id]);
      return u.id as string;
    });
    const r = await m.get(`/api/team-review?week=${w}`);
    expect(r.body.people.map((p: any) => p.user.name)).toEqual(['Emp', 'Emp2']);
    expect((await m.post('/api/team-review/reviews', { subjectUserId: clientId, week: w, action: 'acknowledge', note: 'x' })).status).toBe(403);
    const monday = DateTime.fromISO(w, { zone: o.tz }).plus({ days: 7 }).set({ hour: 10 });
    expect(await withTenant(o.tenantId, (db) => remindWeeklyReviewers(db, o.tenantId, monday))).toBe(1);
    expect((await m.get('/api/notifications')).body.find((x: any) => x.kind === 'weekly_review_ready').body).toMatch(/^2 team member/);
  });
});
