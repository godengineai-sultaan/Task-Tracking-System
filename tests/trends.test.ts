import { beforeAll, describe, expect, it } from 'vitest';
import { drainJobs, localIso, login, makeOrg, withOwner, type Org } from './helpers.js';
import { DateTime } from 'luxon';
import { findPatterns, focusBlocks, primarySegments, taskSwitches } from '../server/src/services/ext/trends.js';

/*
 * Fixed fixture (Asia/Kolkata, Mon–Fri 09:00–17:00 with a 60 min break = 420 available minutes per working day).
 * Four weeks ending Sunday 2026-05-31:
 *   W1 (4 May)  — focus blocks, gap tolerance, overlap precedence, task switches; Thu 7 May is a holiday.
 *   W2 (11 May) — full-week leave -> Not Applicable.
 *   W3 (18 May) — planned outcomes, carryover, accepted tasks with estimates, recaps, a blocker.
 *   W4 (25 May) — a meeting-heavy Wednesday.
 */
let org: Org; let emp: any; let mgr: any; let admin: any; let outsider: any; let emp2: any;
const URL = (uid: string, extra = '') => `/api/trends/personal?userId=${uid}&weeks=4&end=2026-05-31${extra}`;

beforeAll(async () => {
  org = await makeOrg();
  [emp, mgr, admin, outsider, emp2] = await Promise.all(['emp', 'manager', 'admin', 'outsider', 'emp2'].map((k) => login(org, k)));
  const T = org.tenantId, U = org.users.emp, tz = org.tz;
  const at = (d: string, hm: string) => localIso(tz, d, hm);
  await withOwner(async (db) => {
    const task = async (title: string, category: string, est: number | null, status: string, acceptedAt?: string) =>
      (await db.query(`insert into tasks (tenant_id, title, owner_id, created_by, status, category, estimate_minutes, done_at, accepted_at, created_at)
        values ($1,$2,$3,$3,$4,$5,$6,$7,$7,'2026-04-30T04:00:00Z') returning id`, [T, title, U, status, category, est, acceptedAt ?? null])).rows[0].id as string;
    const hist = (id: string, from: string | null, to: string, when: string) =>
      db.query(`insert into task_state_history (tenant_id, task_id, from_status, to_status, at) values ($1,$2,$3,$4,$5)`, [T, id, from, to, when]);
    const entry = (date: string, from: string, to: string, category: string, taskId: string | null, source = 'timer') =>
      db.query(`insert into time_entries (tenant_id, user_id, task_id, category, started_at, ended_at, source, created_at) values ($1,$2,$3,$4,$5,$6,$7,$5)`,
        [T, U, taskId, category, at(date, from), at(date, to), source]);
    const plan = async (date: string, ids: string[]) => {
      const p = (await db.query(`insert into daily_plans (tenant_id, user_id, date) values ($1,$2,$3) returning id`, [T, U, date])).rows[0].id;
      for (let i = 0; i < ids.length; i++) await db.query(`insert into daily_plan_items (tenant_id, plan_id, task_id, position) values ($1,$2,$3,$4)`, [T, p, ids[i], i + 1]);
    };

    // W1
    const A = await task('Alpha feature', 'delivery', null, 'in_progress');
    const B = await task('Beta fix', 'delivery', null, 'in_progress');
    const C = await task('Gamma notes', 'admin', null, 'in_progress');
    await db.query(`insert into holidays (tenant_id, date, name) values ($1,'2026-05-07','Fixture holiday')`, [T]);
    await entry('2026-05-04', '09:00', '10:30', 'task', A);              // 90 -> focus
    await entry('2026-05-04', '10:30', '11:00', 'meeting', null, 'calendar');
    await entry('2026-05-04', '11:00', '11:40', 'task', B, 'manual');    // 40 -> not focus
    await entry('2026-05-04', '11:45', '12:15', 'task', A);              // 30 ...
    await entry('2026-05-04', '12:18', '13:00', 'task', A);              // ... + 42 after a 3 min gap = 72 -> focus
    await entry('2026-05-04', '12:50', '13:30', 'meeting', null, 'calendar'); // overlap: the timer wins 12:50–13:00
    await entry('2026-05-05', '09:00', '09:50', 'task', C);              // 50, then a 10 min gap
    await entry('2026-05-05', '10:00', '10:30', 'task', C);              // 30 -> no focus block
    await entry('2026-05-06', '09:00', '13:00', 'meeting', null, 'calendar');
    await entry('2026-05-06', '14:00', '15:00', 'task', A);              // exactly 60 -> focus

    // W2: full-week leave
    await db.query(`insert into leave_entries (tenant_id, user_id, start_date, end_date, portion, kind) values ($1,$2,'2026-05-11','2026-05-15','full','leave')`, [T, U]);

    // W3
    const acc = (d: string, hm: string) => at(d, hm);
    const R1 = await task('Research cache options', 'research', 60, 'done', acc('2026-05-18', '16:00'));
    const R2 = await task('Research queue vendors', 'research', 60, 'done', acc('2026-05-19', '16:00'));
    const R3 = await task('Research search relevance', 'research', 60, 'done', acc('2026-05-20', '12:00'));
    const D1 = await task('Deliver export button', 'delivery', 100, 'done', acc('2026-05-21', '16:00'));
    await task('Deliver copy fix', 'delivery', null, 'done', acc('2026-05-21', '16:00'));
    await task('Deliver icon swap', 'delivery', 60, 'done', acc('2026-05-22', '16:00'));
    const X = await task('Long migration', 'delivery', null, 'in_progress');
    for (const [id, d, hm] of [[R1, '2026-05-18', '16:00'], [R2, '2026-05-19', '16:00'], [R3, '2026-05-20', '12:00'], [D1, '2026-05-21', '16:00']]) {
      await hist(id, null, 'planned', '2026-04-30T04:00:00Z'); await hist(id, 'planned', 'done', at(d, hm));
    }
    await hist(X, null, 'planned', '2026-04-30T04:00:00Z'); await hist(X, 'planned', 'in_progress', at('2026-05-18', '09:00'));
    await hist(X, 'in_progress', 'blocked', at('2026-05-22', '13:00')); await hist(X, 'blocked', 'in_progress', at('2026-05-22', '15:00'));
    await db.query(`insert into blockers (tenant_id, task_id, reason, raised_at, resolved_at) values ($1,$2,'Waiting on schema',$3,$4)`, [T, X, at('2026-05-22', '13:00'), at('2026-05-22', '15:00')]);
    await plan('2026-05-18', [R1, X]); await plan('2026-05-19', [R2]); await plan('2026-05-20', [R3, X]); await plan('2026-05-21', [D1]);
    await entry('2026-05-18', '09:00', '11:00', 'task', R1);
    await entry('2026-05-19', '09:00', '10:30', 'task', R2);
    await entry('2026-05-20', '09:00', '10:00', 'task', R3);
    await entry('2026-05-20', '10:00', '11:00', 'task', R3, 'manual');
    await entry('2026-05-20', '13:00', '17:00', 'meeting', null, 'calendar');
    await entry('2026-05-21', '09:00', '09:50', 'task', D1);
    for (const d of ['2026-05-18', '2026-05-19', '2026-05-20'])
      await db.query(`insert into daily_reviews (tenant_id, user_id, date, status, version, confirmed_at) values ($1,$2,$3,'confirmed',1,now())`, [T, U, d]);

    // W4
    await entry('2026-05-27', '09:00', '13:00', 'meeting', null, 'calendar');
  });
});

describe('personal trends: series math on a fixed fixture', () => {
  let r: any;
  beforeAll(async () => {
    const res = await emp.get(URL(org.users.emp));
    expect(res.status).toBe(200);
    r = res.body;
  });

  it('returns four Monday-based weeks ending on the anchor week', () => {
    expect(r.range).toEqual({ start: '2026-05-04', end: '2026-05-31', weeks: 4 });
    expect(r.weeks.map((w: any) => w.weekStart)).toEqual(['2026-05-04', '2026-05-11', '2026-05-18', '2026-05-25']);
    expect(r.weeks.map((w: any) => w.workingDays)).toEqual([4, 0, 5, 5]);
  });

  it('computes focus blocks, gap tolerance, overlap precedence and fragmentation', () => {
    const w1 = r.weeks[0];
    expect(w1).toMatchObject({ holidayDays: 1, availableMinutes: 1680, explainedMinutes: 642, unknownMinutes: 1038, meetingMinutes: 300,
      focusMinutes: 222, focusBlocks: 3, daysWithFocusBlock: 2, taskSwitches: 5, loggedDays: 3 });
    expect(w1.switchesPerDay).toBeCloseTo(5 / 3, 5);
    expect(w1.focusShare).toBeCloseTo(222 / 1680, 5);
    expect(w1.meetingShare).toBeCloseTo(300 / 1680, 5);
    expect(w1.loggingCoverage).toBeCloseTo(642 / 1680, 5);
    const w3 = r.weeks[2];
    expect(w3).toMatchObject({ focusMinutes: 330, focusBlocks: 3, taskSwitches: 1, loggedDays: 4, meetingMinutes: 240, explainedMinutes: 620 });
  });

  it('handles an all-leave week explicitly as Not Applicable (no zero ratios)', () => {
    const w2 = r.weeks[1];
    expect(w2.status).toBe('not_applicable');
    expect(w2.leaveDays).toBe(5);
    expect(w2.naReason).toMatch(/holidays or leave/);
    for (const k of ['loggingCoverage', 'meetingShare', 'focusShare', 'plannedCompletion', 'carryoverRate', 'switchesPerDay', 'blockedShare']) expect(w2[k]).toBeNull();
    expect(w2.recaps.rate).toBeNull();
    expect(r.summary).toMatchObject({ applicableWeeks: 3, notApplicableWeeks: 1, comparableWorkingDays: 14 });
  });

  it('computes planned completion, carryover, blocked time, recaps and accepted outcomes', () => {
    const w3 = r.weeks[2];
    expect(w3).toMatchObject({ intendedOutcomes: 6, acceptedPlanned: 4, carryovers: 2, acceptedOutcomes: 6, blockedMinutes: 120 });
    expect(w3.plannedCompletion).toBeCloseTo(4 / 6, 5);
    expect(w3.carryoverRate).toBeCloseTo(2 / 6, 5);
    expect(w3.recaps).toMatchObject({ expected: 5, confirmed: 3 });
    expect(w3.recaps.rate).toBeCloseTo(0.6, 5);
    expect(r.weeks[0].plannedCompletion).toBeNull(); // nothing planned: N/A rather than 0%
  });

  it('computes estimate accuracy on accepted tasks by category and project, with coverage', () => {
    const ea = r.estimateAccuracy;
    expect(ea.overall).toMatchObject({ accepted: 6, measured: 4, estimateMinutes: 280, actualMinutes: 380 });
    expect(ea.overall.coverage).toBeCloseTo(4 / 6, 5);
    const research = ea.byCategory.find((g: any) => g.key === 'research');
    expect(research).toMatchObject({ accepted: 3, measured: 3, estimateMinutes: 180, actualMinutes: 330 });
    expect(research.ratio).toBeCloseTo(330 / 180, 5);
    const delivery = ea.byCategory.find((g: any) => g.key === 'delivery');
    expect(delivery).toMatchObject({ accepted: 3, measured: 1, actualMinutes: 50, estimateMinutes: 100 });
    expect(delivery.coverage).toBeCloseTo(1 / 3, 5);
    expect(ea.byProject).toHaveLength(1);
    expect(ea.byProject[0]).toMatchObject({ label: 'No project', measured: 4 });
    expect(r.weeks[2].estimate).toMatchObject({ accepted: 6, measured: 4 });
  });

  it('lists explainable, rule-based patterns with facts, a suggestion and assumptions', () => {
    const byId = Object.fromEntries(r.patterns.map((p: any) => [p.id, p]));
    expect(byId['meetings-weekday-3'].title).toBe('Meetings took over 50% of available time on 3 of the last 3 Wednesdays');
    expect(byId['meetings-weekday-3'].facts).toHaveLength(3);
    expect(byId['estimate-category-research'].title).toBe('Tasks in Research run 1.8x their estimates on average (3 tasks)');
    expect(byId['estimate-category-research'].facts.join(' ')).toMatch(/5h 30m logged against 3h estimated/);
    expect(byId.recaps.title).toMatch(/3 of 10 working days/);
    expect(byId.coverage.tone).toBe('info');
    for (const p of r.patterns) {
      expect(p.facts.length).toBeGreaterThan(0); expect(p.suggestion).toBeTruthy(); expect(p.assumptions.length).toBeGreaterThan(0);
      expect(JSON.stringify(p)).not.toMatch(/score|rank|team average|colleague/i);
    }
    expect(r.weekdays.find((d: any) => d.weekday === 3)).toMatchObject({ days: 3, meetingHeavyDays: 3 });
  });

  it('pure helpers: a 6-minute gap breaks a focus run; same-item gaps are not switches', () => {
    const t = (hm: string) => Date.parse(`2026-05-04T${hm}:00Z`);
    const e = (id: string, task: string | null, cat: string, a: string, b: string) => ({ id, task_id: task, category: cat, source: 'timer', started_at: new Date(t(a)).toISOString(), ended_at: new Date(t(b)).toISOString(), created_at: new Date(t(a)).toISOString() });
    const segs = primarySegments([e('1', 'A', 'task', '09:00', '09:30'), e('2', 'A', 'task', '09:36', '10:10'), e('3', 'A', 'task', '11:00', '11:20')], t('00:00'), t('23:59'), t('23:59'));
    expect(focusBlocks(segs, [[t('09:00'), t('17:00')]])).toHaveLength(0);
    expect(taskSwitches(segs)).toBe(0);
    const segs2 = primarySegments([e('1', 'A', 'task', '09:00', '09:30'), e('2', 'A', 'task', '09:35', '10:05')], t('00:00'), t('23:59'), t('23:59'));
    expect(focusBlocks(segs2, [[t('09:00'), t('17:00')]])[0].minutes).toBe(60);
  });
});

describe('personal trends: access rules (same as individual reports)', () => {
  it('self, the team manager and the main admin can view; others cannot', async () => {
    expect((await emp.get('/api/trends/personal?weeks=4')).status).toBe(200);
    expect((await mgr.get(URL(org.users.emp))).status).toBe(200);
    expect((await admin.get(URL(org.users.emp))).status).toBe(200);
    expect((await outsider.get(URL(org.users.emp))).status).toBe(403);
    expect((await emp2.get(URL(org.users.emp))).status).toBe(403);
    expect((await mgr.get(URL(org.users.outsider))).status).toBe(403);
  });
  it('validates input', async () => {
    expect((await emp.get('/api/trends/personal?weeks=40')).status).toBe(400);
    expect((await emp.get('/api/trends/personal?userId=nope')).status).toBe(400);
  });
  it('a manager sees the same figures as the person (no hidden view)', async () => {
    const a = (await emp.get(URL(org.users.emp))).body, b = (await mgr.get(URL(org.users.emp))).body;
    expect(b.weeks).toEqual(a.weeks); expect(b.patterns).toEqual(a.patterns);
  });
  it('CSV export is authorized on request and renders the weekly series', async () => {
    expect((await outsider.post('/api/exports', { format: 'csv', report: 'personal_trends', params: { userId: org.users.emp, weeks: 4, end: '2026-05-31' } })).status).toBe(403);
    expect((await emp.post('/api/exports', { format: 'pdf', report: 'personal_trends', params: { userId: org.users.emp } })).status).toBe(400);
    const ex = await mgr.post('/api/exports', { format: 'csv', report: 'personal_trends', params: { userId: org.users.emp, weeks: 4, end: '2026-05-31' } });
    expect(ex.status).toBe(200);
    await drainJobs();
    expect((await mgr.get(`/api/exports/${ex.body.id}`)).body.status).toBe('ready');
    const f = await mgr.get(`/api/exports/${ex.body.id}/file`);
    const text = Buffer.from(f.raw).toString('utf8');
    expect(text).toMatch(/Week start/);
    expect(text).toMatch(/2026-05-11,not applicable,0/);
    expect(text).toMatch(/Tasks in Research run 1\.8x/);
  });
});

describe('personal trends: review regressions', () => {
  let org2: Org; let e2: any; let a2: any; let r: any;
  const today = () => DateTime.now().setZone(org2.tz);
  beforeAll(async () => {
    org2 = await makeOrg({ settings: { founders_visible_to_routine_admin: false } });
    [e2, a2] = await Promise.all([login(org2, 'emp'), login(org2, 'admin')]);
    await withOwner(async (db) => {
      const entry = (from: string, to: string) => db.query(`insert into time_entries (tenant_id, user_id, category, started_at, ended_at, source, created_at) values ($1,$2,'task',$3,$4,'timer',$3)`,
        [org2.tenantId, org2.users.emp, from, to]);
      // The account was created today; imported history begins on Wed 20 May 2026.
      await entry(localIso(org2.tz, '2026-05-20', '09:00'), localIso(org2.tz, '2026-05-20', '11:00'));
      // Work logged today: today is still in progress and must not count yet.
      const d = today().toISODate()!;
      await entry(localIso(org2.tz, d, '00:10'), localIso(org2.tz, d, '00:50'));
    });
    r = (await e2.get('/api/trends/personal?weeks=4&end=2026-05-31')).body;
  });

  it('rejects impossible calendar dates instead of returning a garbage series (route and export)', async () => {
    expect((await e2.get('/api/trends/personal?weeks=4&end=2026-02-30')).status).toBe(400);
    expect((await e2.post('/api/exports', { format: 'csv', report: 'personal_trends', params: { userId: org2.users.emp, end: '2026-13-01' } })).status).toBe(400);
  });

  it('weeks before the person\'s records begin are Not Applicable, not unknown time or missed recaps', () => {
    expect(r.recordsStart).toBe('2026-05-20');
    expect(r.weeks.map((w: any) => w.status)).toEqual(['not_applicable', 'not_applicable', 'applicable', 'applicable']);
    expect(r.weeks[0].naReason).toMatch(/Records for this person begin on Wed 20 May; 5 scheduled day\(s\)/);
    expect(r.weeks[0]).toMatchObject({ workingDays: 0, availableMinutes: 0, unknownMinutes: 0, recaps: { expected: 0, confirmed: 0, rate: null }, loggingCoverage: null });
    expect(r.weeks[2]).toMatchObject({ workingDays: 3, availableMinutes: 3 * 420, explainedMinutes: 120, recaps: { expected: 3 } });
    expect(r.summary).toMatchObject({ applicableWeeks: 2, notApplicableWeeks: 2, comparableWorkingDays: 8 });
  });

  it('today is not counted until it is over', async () => {
    const res = await e2.get('/api/trends/personal?weeks=4');
    expect(res.status).toBe(200);
    const cur = res.body.weeks[3];
    expect(cur.partial).toBe(true);
    expect(cur.explainedMinutes).toBe(0);
    expect(cur.recaps.expected).toBe(Math.min(today().weekday - 1, 5));
    if (cur.status === 'not_applicable') expect(cur.naReason).toMatch(/Week in progress/);
  });

  it('founder policy and tenant isolation apply to trends and their export', async () => {
    expect((await a2.get(`/api/trends/personal?userId=${org2.users.founder}&weeks=4`)).status).toBe(403);
    expect((await a2.post('/api/exports', { format: 'csv', report: 'personal_trends', params: { userId: org2.users.founder } })).status).toBe(403);
    expect((await a2.get(`/api/trends/personal?userId=${org.users.emp}&weeks=4`)).status).toBe(403);
    expect((await a2.get(`/api/trends/personal?userId=${org2.users.emp}&weeks=4`)).status).toBe(200);
  });

  it('estimate pattern wording for tasks without a project', () => {
    const g = { key: 'none', label: 'No project', accepted: 4, measured: 3, ratio: 2, actualMinutes: 360, estimateMinutes: 180, tasks: [] };
    const [p] = findPatterns({ series: [], workingDays: [], estimateAccuracy: { byCategory: [], byProject: [g] }, coverageThreshold: 0.5 });
    expect(p.title).toBe('Tasks without a project run 2.0x their estimates on average (3 tasks)');
    expect(p.suggestion).toMatch(/new unassigned work/);
  });
});
