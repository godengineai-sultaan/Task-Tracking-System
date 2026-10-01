import { DateTime } from 'luxon';
import { beforeAll, describe, expect, it } from 'vitest';
import { drainJobs, localIso, login, makeOrg, withOwner, type Org } from './helpers.js';
import { focusMinutes, quantile, resolvePeriod } from '../server/src/services/ext/orgdash.js';

/**
 * Fixed fixture (synthetic): two weeks 2025-03-03..2025-03-16 (Asia/Kolkata, Mon-Fri 09:00-17:00, 60m break = 420m/day),
 * holiday on Fri 2025-03-07, emp2 on leave Fri 2025-03-14. Previous period: 2025-02-17..2025-03-02.
 */
const P = 'start=2025-03-03&end=2025-03-16';
let org: Org; let admin: any; let mgr: any; let emp: any; let founder: any; let outsider: any;
const D: Record<string, string> = {};

async function fixture(o: Org) {
  const T = o.tenantId, U = o.users;
  const at = (d: string, hm: string) => localIso(o.tz, d, hm);
  await withOwner(async (db) => {
    const ins = async (table: string, row: Record<string, unknown>) => {
      const keys = Object.keys(row);
      return (await db.query(`insert into ${table} (tenant_id, ${keys.join(',')}) values ($1, ${keys.map((_, i) => `$${i + 2}`).join(',')}) returning *`, [T, ...keys.map((k) => row[k])])).rows[0];
    };
    D.eng = (await ins('departments', { name: 'Eng' })).id;
    D.ops = (await ins('departments', { name: 'Ops' })).id;
    await db.query(`update users set department_id = $1 where id = any($2::uuid[])`, [D.eng, [U.emp, U.emp2, U.manager]]);
    await db.query(`update users set department_id = $1 where id = $2`, [D.ops, U.outsider]);
    D.otherTeam = (await ins('teams', { name: 'Other team', manager_id: U.admin })).id;
    await ins('team_members', { team_id: D.otherTeam, user_id: U.outsider });
    D.team = (await db.query(`select id from teams where tenant_id = $1 and name = 'Team'`, [T])).rows[0].id;
    await ins('holidays', { date: '2025-03-07', name: 'Fixture holiday' });
    await ins('leave_entries', { user_id: U.emp2, start_date: '2025-03-14', end_date: '2025-03-14', portion: 'full', kind: 'leave' });

    // Recaps: emp confirms Mon-Thu wk1 (+ the holiday, which must not count) and Mon-Tue wk2; emp2 Mon-Thu wk1, Mon-Wed wk2 (+ a draft Thu).
    for (const d of ['2025-03-03', '2025-03-04', '2025-03-05', '2025-03-06', '2025-03-07', '2025-03-10', '2025-03-11'])
      await ins('daily_reviews', { user_id: U.emp, date: d, status: 'confirmed', version: 1, confirmed_at: at(d, '17:00') });
    for (const d of ['2025-03-03', '2025-03-04', '2025-03-05', '2025-03-06', '2025-03-10', '2025-03-11', '2025-03-12'])
      await ins('daily_reviews', { user_id: U.emp2, date: d, status: d === '2025-03-12' ? 'manager_reviewed' : 'confirmed', version: 1, confirmed_at: at(d, '17:00') });
    await ins('daily_reviews', { user_id: U.emp2, date: '2025-03-13', status: 'draft' });

    const task = async (owner: string, title: string, o2: { category?: string; estimate?: number; due?: string; history: [string, string][] }) => {
      const [last, lastAt] = o2.history[o2.history.length - 1];
      const t = await ins('tasks', { title, owner_id: owner, created_by: owner, status: last, category: o2.category ?? 'delivery', estimate_minutes: o2.estimate ?? null,
        due_date: o2.due ?? null, started_at: o2.history.find((h) => h[0] === 'in_progress')?.[1] ?? null, done_at: last === 'done' ? lastAt : null,
        accepted_at: last === 'done' ? lastAt : null, cancelled_at: last === 'cancelled' ? lastAt : null, created_at: o2.history[0][1] });
      let from: string | null = null;
      for (const [s, when] of o2.history) { await ins('task_state_history', { task_id: t.id, from_status: from, to_status: s, actor_id: owner, at: when }); from = s; }
      return t;
    };
    const A = await task(U.emp, 'A', { estimate: 120, due: '2025-03-03', history: [['planned', at('2025-02-28', '10:00')], ['in_progress', at('2025-03-03', '09:00')], ['done', at('2025-03-03', '15:00')]] });
    const B = await task(U.emp, 'B', { estimate: 60, due: '2025-03-04', history: [['planned', at('2025-02-28', '10:00')], ['in_progress', at('2025-03-03', '10:00')], ['done', at('2025-03-05', '12:00')]] });
    const C = await task(U.emp, 'C', { estimate: 100, due: '2025-03-12', history: [['planned', at('2025-03-07', '10:00')], ['in_progress', at('2025-03-10', '10:00')], ['done', at('2025-03-12', '11:00')]] });
    const Dt = await task(U.emp2, 'D', { category: 'research', history: [['planned', at('2025-02-28', '10:00')], ['in_progress', at('2025-03-04', '10:00')], ['in_review', at('2025-03-06', '10:00')],
      ['in_progress', at('2025-03-07', '10:00')], ['in_review', at('2025-03-10', '09:00')], ['done', at('2025-03-11', '10:00')]] });
    await ins('task_reviews', { task_id: Dt.id, reviewer_id: U.manager, decision: 'changes_requested', note: 'Add tests', created_at: at('2025-03-07', '10:00') });
    await task(U.emp2, 'E', { category: 'admin', estimate: 30, history: [['planned', at('2025-02-28', '10:00')], ['done', at('2025-03-13', '10:00')]] });
    await task(U.emp, 'F', { history: [['planned', at('2025-02-17', '10:00')], ['in_progress', at('2025-02-18', '10:00')], ['done', at('2025-02-20', '10:00')]] });
    const G = await task(U.emp2, 'G', { estimate: 240, due: '2025-03-06', history: [['planned', at('2025-02-28', '10:00')], ['in_progress', at('2025-03-04', '09:00')],
      ['blocked', at('2025-03-05', '10:00')], ['in_progress', at('2025-03-06', '10:00')], ['blocked', at('2025-03-10', '10:00')]] });
    const H = await task(U.emp, 'H', { due: '2025-03-14', history: [['planned', at('2025-02-28', '10:00')], ['cancelled', at('2025-03-08', '10:00')]] });
    await task(U.emp, 'I', { estimate: 600, history: [['planned', new Date().toISOString()]] });

    // Time: emp Mon 3 Mar (timer overlaps a meeting by 30m; counted once), one entry outside schedule; emp2 Tue 4 Mar.
    const te = (user: string, d: string, s: string, e: string, category: string, source: string, taskId: string | null = null) =>
      ins('time_entries', { user_id: user, task_id: taskId, category, source, started_at: at(d, s), ended_at: at(d, e), created_at: at(d, s) });
    await te(U.emp, '2025-03-03', '09:00', '11:00', 'task', 'timer', A.id);
    await te(U.emp, '2025-03-03', '11:00', '11:30', 'meeting', 'calendar');
    await te(U.emp, '2025-03-03', '11:30', '12:00', 'task', 'manual');
    await te(U.emp, '2025-03-03', '14:00', '15:30', 'task', 'timer', B.id);
    await te(U.emp, '2025-03-03', '15:00', '16:00', 'meeting', 'calendar');
    await te(U.emp, '2025-03-04', '18:00', '19:00', 'task', 'manual');
    await te(U.emp2, '2025-03-04', '10:00', '12:00', 'meeting', 'calendar');
    await te(U.emp2, '2025-03-04', '13:00', '13:45', 'task', 'manual', Dt.id);

    // Plans: emp Mon 3 Mar A+B (H removed = scope change), Mon 10 Mar C.
    const p1 = await ins('daily_plans', { user_id: U.emp, date: '2025-03-03' });
    await ins('daily_plan_items', { plan_id: p1.id, task_id: A.id, position: 1 });
    await ins('daily_plan_items', { plan_id: p1.id, task_id: B.id, position: 2 });
    await ins('daily_plan_items', { plan_id: p1.id, task_id: H.id, position: 3, removed_at: at('2025-03-03', '12:00'), removed_reason: 'Re-scoped' });
    const p2 = await ins('daily_plans', { user_id: U.emp, date: '2025-03-10' });
    await ins('daily_plan_items', { plan_id: p2.id, task_id: C.id, position: 1 });

    // Blockers
    await ins('blockers', { task_id: G.id, reason: 'Client sign-off', cause: 'client', raised_by: U.emp2, raised_at: at('2025-03-05', '10:00'), resolved_at: at('2025-03-06', '10:00') });
    await ins('blockers', { task_id: G.id, reason: 'Client data', cause: 'client', raised_by: U.emp2, raised_at: at('2025-03-10', '10:00') });
    await ins('blockers', { task_id: Dt.id, reason: 'VPN', cause: 'access', raised_by: U.emp2, raised_at: at('2025-03-04', '12:00'), resolved_at: at('2025-03-04', '18:00') });

    // emp2 is away for the whole workload horizon: capacity zero -> Not Applicable.
    const today = DateTime.now().setZone(o.tz).toISODate()!;
    await ins('leave_entries', { user_id: U.emp2, start_date: today, end_date: DateTime.fromISO(today).plus({ days: 40 }).toISODate(), portion: 'full', kind: 'leave' });
  });
}

const keysDeep = (v: any, out = new Set<string>()): Set<string> => {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); keysDeep(x, out); }
  return out;
};

beforeAll(async () => {
  org = await makeOrg();
  await fixture(org);
  [admin, mgr, emp, founder, outsider] = await Promise.all(['admin', 'manager', 'emp', 'founder', 'outsider'].map((k) => login(org, k)));
});

describe('insights metrics on a fixed fixture (manager team scope: emp + emp2)', () => {
  let r: any;
  beforeAll(async () => { r = (await mgr.get(`/api/insights?${P}`)).body; });

  it('resolves the period, weekly buckets and the comparison period', () => {
    expect(r.period).toMatchObject({ start: '2025-03-03', end: '2025-03-16', days: 14, previous: { start: '2025-02-17', end: '2025-03-02' } });
    expect(r.weeks.map((w: any) => [w.start, w.end, w.complete])).toEqual([['2025-03-03', '2025-03-09', true], ['2025-03-10', '2025-03-16', true]]);
    expect(r.scope).toMatchObject({ mode: 'team', perPerson: true, people: 2 });
  });
  it('recap adoption = confirmed recaps / working person-days (holiday, leave and drafts excluded)', () => {
    const [w1, w2] = r.weeks.map((w: any) => w.metrics.recapAdoption);
    expect(w1).toMatchObject({ num: 8, den: 8, value: 1, status: 'ok' });
    expect(w2).toMatchObject({ num: 5, den: 9, status: 'ok' });
    expect(r.totals.current.recapAdoption).toMatchObject({ num: 13, den: 17 });
    expect(r.totals.previous.recapAdoption).toMatchObject({ num: 0, den: 20, value: 0 });
  });
  it('logging coverage counts overlaps once, ignores time outside the schedule and reports unknown time', () => {
    const c = r.totals.current;
    expect(c.loggingCoverage).toMatchObject({ num: 465, den: 7140, unknownMinutes: 6675 });
    expect(c.byCategory).toMatchObject({ task: 285, meeting: 180 });
    expect(r.weeks[1].metrics.loggingCoverage).toMatchObject({ num: 0, den: 3780, value: 0 });
    expect(r.timeComposition).toMatchObject({ availableMinutes: 7140, unknownMinutes: 6675, focusMinutes: 180 });
  });
  it('meeting load and focus time (blocks of 60m+ with meetings cut out)', () => {
    expect(r.totals.current.meetingShare).toMatchObject({ num: 180, den: 7140 });
    expect(r.totals.current.focusShare).toMatchObject({ num: 180, den: 7140 });
  });
  it('planned-commitment completion uses status at the end of each planned day and ignores removed items', () => {
    expect(r.weeks[0].metrics.plannedCompletion).toMatchObject({ num: 1, den: 2, value: 0.5 });
    expect(r.weeks[1].metrics.plannedCompletion).toMatchObject({ num: 0, den: 1, value: 0 });
  });
  it('accepted outcomes, rework rate and cycle time (median/p75 by category)', () => {
    expect(r.weeks.map((w: any) => w.metrics.acceptedOutcomes)).toEqual([2, 3]);
    expect(r.totals.current.acceptedOutcomes).toBe(5);
    expect(r.totals.previous.acceptedOutcomes).toBe(1);
    expect(r.totals.current.reworkRate).toMatchObject({ num: 1, den: 5, value: 0.2 });
    expect(r.totals.current.cycleTime).toMatchObject({ n: 4, accepted: 5, medianHours: 49.5, p75Hours: 79.5 });
    expect(r.cycleTime.byCategory).toEqual([
      { category: 'admin', accepted: 1, n: 0, medianHours: null, p75Hours: null },
      { category: 'delivery', accepted: 3, n: 3, medianHours: 49, p75Hours: 49.5 },
      { category: 'research', accepted: 1, n: 1, medianHours: 168, p75Hours: 168 },
    ]);
    expect(Object.fromEntries(r.cycleTime.distribution.map((b: any) => [b.key, b.count]))).toEqual({ lt1d: 1, '1to3d': 2, '3to7d': 0, '1to2w': 1, gt2w: 0 });
  });
  it('deadline reliability = met / (met + late + overdue); cancelled work excluded', () => {
    expect(r.totals.current.deadlineReliability).toMatchObject({ met: 2, late: 1, overdue: 1, open: 0, value: 0.5 });
    expect(r.weeks[0].metrics.deadlineReliability).toMatchObject({ met: 1, late: 1, overdue: 1 });
    expect(r.weeks[1].metrics.deadlineReliability).toMatchObject({ met: 1, value: 1 });
  });
  it('blockers: counts, median age and breakdown by cause', () => {
    expect(r.totals.current.blockers).toMatchObject({ raised: 3, active: 3, openAtEnd: 1, medianAgeHours: 24 });
    expect(r.weeks[0].metrics.blockers).toMatchObject({ raised: 2, active: 2, medianAgeHours: 15 });
    expect(r.weeks[1].metrics.blockers).toMatchObject({ raised: 1, active: 1, openAtEnd: 1, medianAgeHours: 158 });
    expect(r.blockersByCause).toEqual([
      { cause: 'client', active: 2, raised: 2, openAtEnd: 1, medianAgeHours: 91 },
      { cause: 'access', active: 1, raised: 1, openAtEnd: 0, medianAgeHours: 6 },
    ]);
  });
  it('work in progress snapshots from status history', () => {
    expect(r.weeks.map((w: any) => w.metrics.wip)).toEqual([{ value: 2, blocked: 0, inReview: 0 }, { value: 1, blocked: 1, inReview: 0 }]);
    expect(r.totals.previous.wip.value).toBe(0);
  });
  it('estimate accuracy uses only accepted work with an estimate and confirmed time, with coverage', () => {
    expect(r.totals.current.estimateAccuracy).toMatchObject({ n: 2, accepted: 5, actualMinutes: 210, estimateMinutes: 180, medianRatio: 1.25, withinBand: 0.5 });
    expect(r.totals.current.estimateAccuracy.value).toBeCloseTo(210 / 180, 3);
  });
  it('workload: open estimated work vs the next 10 working days; zero capacity is Not Applicable', () => {
    const [e1, e2] = r.workload.rows;
    expect(e1).toMatchObject({ name: 'Emp', openTasks: 1, estimatedMinutes: 600, availableMinutes: 4200, horizonWorkingDays: 10 });
    expect(e1.load.value).toBeCloseTo(600 / 4200, 3);
    expect(e2).toMatchObject({ name: 'Emp2', openTasks: 1, estimatedMinutes: 240, availableMinutes: 0, overdue: 1, blocked: 1 });
    expect(e2.load).toMatchObject({ value: null, status: 'not_applicable' });
  });
  it('ships definitions and an explainable rule-based observation with its facts', () => {
    expect(Object.keys(r.definitions)).toEqual(expect.arrayContaining(['recapAdoption', 'loggingCoverage', 'focusShare', 'estimateAccuracy', 'workload']));
    expect(r.definitions.loggingCoverage.definition).toMatch(/not productivity/);
    expect(r.observations.map((o: any) => o.id)).toEqual(['recap:all']);
    const o = r.observations[0];
    expect(o.title).toBe('Recap adoption fell from 100% to 56% in your teams over 1 week');
    expect(o.facts[0]).toMatch(/8 of 8 working person-days/);
    expect(o.facts[1]).toMatch(/5 of 9 working person-days/);
    expect(o.assumptions.length).toBeGreaterThan(0);
  });
});

describe('Not Applicable handling', () => {
  it('a period with zero scheduled capacity reports ratios as not applicable, never as zero', async () => {
    const r = (await mgr.get('/api/insights?start=2025-03-07&end=2025-03-09')).body;
    const m = r.totals.current;
    expect(m.workingPersonDays).toBe(0);
    for (const k of ['recapAdoption', 'loggingCoverage', 'plannedCompletion', 'meetingShare', 'focusShare']) expect(m[k]).toMatchObject({ value: null, status: 'not_applicable' });
    expect(m.recapAdoption.num).toBe(0); // the recap written on the holiday is not counted
  });
});

describe('scope enforcement', () => {
  it('employees without a team cannot open insights or export them', async () => {
    expect((await emp.get(`/api/insights?${P}`)).status).toBe(403);
    expect((await outsider.get('/api/insights/options')).status).toBe(403);
    expect((await emp.post('/api/exports', { format: 'csv', report: 'insights', params: { start: '2025-03-03', end: '2025-03-16' } })).status).toBe(403);
  });
  it('managers see only their teams and cannot widen the scope', async () => {
    expect((await mgr.get(`/api/insights?${P}&scope=company`)).status).toBe(403);
    expect((await mgr.get(`/api/insights?${P}&teamId=${D.otherTeam}`)).status).toBe(403);
    const r = (await mgr.get(`/api/insights?${P}&teamId=${D.team}`)).body;
    expect(r.workload.rows.map((x: any) => x.name)).toEqual(['Emp', 'Emp2']);
    const opts = (await mgr.get('/api/insights/options')).body;
    expect(opts.scopes).toEqual(['team']);
    expect(opts.teams.map((t: any) => t.name)).toEqual(['Team']);
  });
  it('the main admin sees the whole company with per-person rows and department groups', async () => {
    const r = (await admin.get(`/api/insights?${P}`)).body;
    expect(r.scope).toMatchObject({ mode: 'company', perPerson: true, people: 6 });
    expect(r.workload.rows.map((x: any) => x.name)).toEqual(['Admin', 'Emp', 'Emp2', 'Founder', 'Manager', 'Outsider']);
    expect(r.groups.map((g: any) => [g.name, g.people, g.suppressed])).toEqual([['Eng', 3, false], ['No department', 2, false], ['Ops', 1, false]]);
    const eng = r.observations.find((o: any) => o.id === 'recap:Eng');
    expect(eng.title).toBe('Recap adoption fell from 67% to 36% in Eng over 1 week');
    const dept = (await admin.get(`/api/insights?${P}&departmentId=${D.eng}`)).body;
    expect(dept.scope.people).toBe(3);
  });
  it('leadership without routine admin gets aggregates only: no per-person rows, small groups withheld', async () => {
    const r = (await founder.get(`/api/insights?${P}`)).body;
    expect(r.scope).toMatchObject({ mode: 'company', perPerson: false, people: 6 });
    expect(r.workload.rows).toBeNull();
    expect(r.groups.map((g: any) => [g.name, g.suppressed, g.metrics === null])).toEqual([['Eng', false, false], ['No department', true, true], ['Ops', true, true]]);
    expect(r.workload.byGroup.find((g: any) => g.name === 'Ops')).toEqual({ id: D.ops, name: 'Ops', people: 1, suppressed: true });
    const small = (await founder.get(`/api/insights?${P}&departmentId=${D.ops}`)).body;
    expect(small.suppressed).toMatch(/fewer than 3 people/);
    expect(small.totals).toBeNull();
    expect((await founder.get(`/api/insights?${P}&scope=team`)).status).toBe(403);
  });
  it('founders follow the founders_visible_to_routine_admin policy', async () => {
    const o2 = await makeOrg({ settings: { founders_visible_to_routine_admin: false } });
    const [a2, f2] = await Promise.all([login(o2, 'admin'), login(o2, 'founder')]);
    const ra = (await a2.get(`/api/insights?${P}`)).body;
    expect(ra.scope).toMatchObject({ people: 5, foundersExcluded: true });
    expect(ra.workload.rows.map((x: any) => x.name)).not.toContain('Founder');
    expect(ra.scope.notes.join(' ')).toMatch(/Founders are excluded/);
    const rf = (await f2.get(`/api/insights?${P}`)).body;
    expect(rf.scope).toMatchObject({ people: 6, foundersExcluded: false });
  });
  it('validates input', async () => {
    expect((await admin.get('/api/insights?weeks=5')).status).toBe(400);
    expect((await admin.get('/api/insights?start=2025-03-10&end=2025-03-01')).status).toBe(400);
    expect((await admin.get('/api/insights?start=2024-01-01&end=2025-03-01')).status).toBe(400);
    expect((await admin.get('/api/insights?departmentId=not-a-uuid')).status).toBe(400);
    expect((await admin.get(`/api/insights?weeks=8`)).body.weeks).toHaveLength(8);
  });
});

describe('no ranking', () => {
  it('has no rank or score fields and orders people alphabetically, not by load', async () => {
    const r = (await admin.get(`/api/insights?${P}`)).body;
    expect([...keysDeep(r)].filter((k) => /rank|score|percentile/i.test(k))).toEqual([]);
    const names = r.workload.rows.map((x: any) => x.name);
    expect(names).toEqual([...names].sort((a: string, b: string) => a.localeCompare(b)));
    expect(r.workload.note).toMatch(/Load, not performance/);
    expect(r.groups.map((g: any) => g.name)).toEqual([...r.groups.map((g: any) => g.name)].sort((a: string, b: string) => a.localeCompare(b)));
  });
});

describe('CSV export', () => {
  it('renders the insights CSV for an authorized requester; PDF is not offered', async () => {
    const ex = await mgr.post('/api/exports', { format: 'csv', report: 'insights', params: { start: '2025-03-03', end: '2025-03-16', teamId: D.team } });
    expect(ex.status).toBe(200);
    await drainJobs();
    expect((await mgr.get(`/api/exports/${ex.body.id}`)).body.status).toBe('ready');
    const f = await mgr.get(`/api/exports/${ex.body.id}/file`);
    const text = f.raw.toString('utf8');
    expect(text).toContain('week_start,week_end,partial,working_person_days,recap_adoption');
    expect(text).toContain('2025-03-03,2025-03-09,no,8,100.0%');
    expect(text).toMatch(/Load, not performance/);
    expect(text).toContain('Emp2');
    expect((await mgr.post('/api/exports', { format: 'pdf', report: 'insights', params: {} })).status).toBe(400);
  });
});

describe('helpers', () => {
  it('quantile interpolates like percentile_cont', () => {
    expect(quantile([6, 49, 50, 168], 0.5)).toBe(49.5);
    expect(quantile([], 0.5)).toBeNull();
  });
  it('focus time needs 60 contiguous minutes and excludes meeting overlap', () => {
    const w = [{ start: '2025-03-03T03:30:00.000Z', end: '2025-03-03T11:30:00.000Z' }];
    const e = (s: string, en: string, category: string) => ({ category, started_at: new Date(s), ended_at: new Date(en) });
    expect(focusMinutes([e('2025-03-03T04:00:00Z', '2025-03-03T04:50:00Z', 'task')], w, Date.now())).toBe(0);
    expect(focusMinutes([e('2025-03-03T04:00:00Z', '2025-03-03T05:30:00Z', 'task'), e('2025-03-03T05:00:00Z', '2025-03-03T05:30:00Z', 'meeting')], w, Date.now())).toBe(60);
  });
  it('default periods are whole ISO weeks ending today', () => {
    const p = resolvePeriod({ weeks: 4 }, '2026-10-01');
    expect(p).toMatchObject({ start: '2026-09-07', end: '2026-10-01', prevStart: '2026-08-13', prevEnd: '2026-09-06' });
    expect(p.weeks.at(-1)).toMatchObject({ start: '2026-09-28', partial: true, complete: false });
  });
});
