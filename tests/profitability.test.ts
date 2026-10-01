import { beforeAll, describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { drainJobs, localIso, login, makeOrg, pastWorkday, withOwner, type Org } from './helpers.js';
import { withTenant } from '../server/src/lib/db.js';
import { checkBudgetAlerts } from '../server/src/services/ext/profitability.js';

let org: Org; let admin: any; let mgr: any; let emp: any; let founder: any; let outsider: any;
let d10: string; let d1: string; let rateChange: string;
const P: Record<string, any> = {};

/** A project owned by the manager with identical, known time records (see expectations below). */
async function seedProject(key: string, name = `Project ${key}`, visibility = 'company') {
  const p = (await mgr.post('/api/projects', { key, name, visibility })).body;
  const U = org.users, T = org.tenantId;
  await withOwner(async (db) => {
    const task = async (owner: string, status: string, est: number | null) => (await db.query(`insert into tasks (tenant_id, title, owner_id, created_by, project_id, status, estimate_minutes)
      values ($1,$2,$3,$3,$4,$5,$6) returning id`, [T, `${key} ${status}`, owner, p.id, status, est])).rows[0].id;
    const t1 = await task(U.emp, 'in_progress', 600), t2 = await task(U.emp2, 'planned', null);
    await task(U.emp, 'done', 300);
    const te = (user: string, taskId: string, date: string, from: string, to: string, deleted = false) => db.query(`insert into time_entries (tenant_id, user_id, task_id, category, started_at, ended_at, source, deleted_at)
      values ($1,$2,$3,'task',$4,$5,'manual',$6)`, [T, user, taskId, localIso(org.tz, date, from), localIso(org.tz, date, to), deleted ? new Date() : null]);
    await te(U.emp, t1, d10, '09:00', '11:00');          // 2h at the old rate 1000
    await te(U.emp, t1, d1, '10:00', '13:00');           // 3h at the new rate 1500
    await te(U.emp, t1, d1, '10:00', '11:00');           // overlaps the block above: counted once
    await te(U.emp2, t2, d1, '14:00', '15:30');          // 1.5h, emp2 has no cost rate
    await te(U.manager, t2, d1, '09:00', '10:00');       // 1h, manager's rate is in USD
    await te(U.emp, t1, d1, '15:00', '19:00', true);     // deleted: excluded
  });
  return p;
}
const budget = (c: any, id: string, body: any) => c.put(`/api/projects/${id}/budget`, body);
const notes = (link: string) => withOwner(async (db) => (await db.query(`select user_id, title, body from notifications where tenant_id = $1 and link = $2 and kind = 'budget_alert'`, [org.tenantId, link])).rows);

beforeAll(async () => {
  org = await makeOrg();
  [admin, mgr, emp, founder, outsider] = await Promise.all(['admin', 'manager', 'emp', 'founder', 'outsider'].map((k) => login(org, k)));
  d10 = pastWorkday(org.tz, 10).toISODate()!; d1 = pastWorkday(org.tz, 1).toISODate()!; rateChange = pastWorkday(org.tz, 3).toISODate()!;
  await withOwner(async (db) => {
    const r = (u: string, rate: number, cur: string, from: string) => db.query(`insert into cost_rates (tenant_id, user_id, hourly_rate, currency, effective_from) values ($1,$2,$3,$4,$5)`, [org.tenantId, u, rate, cur, from]);
    await r(org.users.emp, 1000, 'INR', '2020-01-01');
    await r(org.users.emp, 1500, 'INR', rateChange);
    await r(org.users.manager, 20, 'USD', '2020-01-01');
  });
  P.fixed = await seedProject('FIX');
  P.tm = await seedProject('TAM');
  P.internal = await seedProject('INT');
  P.usd = await seedProject('USD', '=Danger cell');
  P.none = await seedProject('NOB');
  P.priv = await seedProject('PRV', 'Private work', 'private');
});

describe('cost math', () => {
  it('prices each entry at the rate effective on its date, merges overlaps and reports unpriced hours separately', async () => {
    const r = await budget(admin, P.fixed.id, { billingType: 'fixed_fee', budgetAmount: 10000, currency: 'INR', budgetHours: 10, alertThresholds: [50, 75, 100] });
    expect(r.status).toBe(200);
    const { hours: h, money: m, estimates: e } = r.body;
    expect(h.toDate).toBeCloseTo(7.5);                    // 2 + 3 (overlap once) + 1.5 + 1; deleted 4h excluded
    expect(m.pricedHours).toBeCloseTo(5);
    expect(m.costToDate).toBeCloseTo(2 * 1000 + 3 * 1500); // rate history
    expect(m.unpricedHours).toBeCloseTo(2.5);
    expect(m.unpriced).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: org.users.emp2, hours: 1.5, reason: 'no_rate' }),
      expect.objectContaining({ userId: org.users.manager, hours: 1, reason: 'currency' })]));
    expect(h.burnPerWeek).toBeCloseTo(7.5 / 4);
    expect(e).toMatchObject({ openTasks: 2, estimatedOpenTasks: 1, coverage: 0.5 });
    expect(h.remainingEstimate).toBeCloseTo(4);           // 10h estimate - 6h logged on that task
    expect(h.forecastAtCompletion).toBeCloseTo(11.5);
    expect(m.blendedRate).toBeCloseTo(1300);
    expect(m.forecastCost).toBeCloseTo(6500 + 4 * 1300);
    expect(r.body.facts.join(' ')).toMatch(/unpriced.*not priced at zero/);
  });

  it('fixed fee: revenue is the fee, consumption compares cost to the fee', async () => {
    const r = (await admin.get(`/api/projects/${P.fixed.id}/budget`)).body;
    expect(r.money).toMatchObject({ revenue: 10000, margin: 3500, consumptionBasis: 'cost' });
    expect(r.money.marginPct).toBeCloseTo(0.35);
    expect(r.money.consumption).toBeCloseTo(0.65);
    expect(r.money.forecastConsumption).toBeCloseTo(1.17);
    expect(r.hours.consumption).toBeCloseTo(0.75);
    expect(r.status).toMatchObject({ label: 'at_risk', forecastOver: true });
  });

  it('time and materials: revenue = billable hours x bill rate against the cap', async () => {
    expect((await budget(admin, P.tm.id, { billingType: 'time_and_materials', budgetAmount: 20000, currency: 'INR' })).status).toBe(400); // bill rate required
    const r = (await budget(admin, P.tm.id, { billingType: 'time_and_materials', budgetAmount: 20000, currency: 'INR', billRate: 2000 })).body;
    expect(r.money.revenue).toBeCloseTo(15000);
    expect(r.money.margin).toBeCloseTo(8500);
    expect(r.money.consumptionBasis).toBe('billable_value');
    expect(r.money.consumption).toBeCloseTo(0.75);
    expect(r.money.forecastRevenue).toBeCloseTo(23000);
    expect(r.money.forecastMargin).toBeCloseTo(23000 - 11700);
  });

  it('internal: no revenue or margin; budget start date excludes earlier time', async () => {
    const r = (await budget(admin, P.internal.id, { billingType: 'internal', budgetAmount: 8000, currency: 'INR' })).body;
    expect(r.money).toMatchObject({ revenue: null, margin: null, marginPct: null });
    expect(r.money.consumption).toBeCloseTo(6500 / 8000);
    const r2 = await budget(admin, P.internal.id, { billingType: 'internal', budgetAmount: 8000, currency: 'INR', startDate: rateChange, version: r.budget.version });
    expect(r2.status).toBe(200);
    expect(r2.body.hours.toDate).toBeCloseTo(5.5);
    expect(r2.body.money.costToDate).toBeCloseTo(4500);
    expect(r2.body.assumptions.join(' ')).toContain(rateChange);
  });

  it('prices only rates in the budget currency and never mixes currencies in totals', async () => {
    const r = (await budget(admin, P.usd.id, { billingType: 'internal', budgetAmount: 500, currency: 'USD' })).body;
    expect(r.money.costToDate).toBeCloseTo(20);
    expect(r.money.unpricedHours).toBeCloseTo(6.5);
    const pf = (await admin.get('/api/profitability/portfolio')).body;
    expect(pf.access).toBe('money');
    const cur = pf.totals.byCurrency.map((t: any) => t.currency).sort();
    expect(cur).toEqual(['INR', 'USD']);
    const usd = pf.totals.byCurrency.find((t: any) => t.currency === 'USD');
    expect(usd).toMatchObject({ projects: 1, budgetAmount: 500 });
    expect(usd.costToDate).toBeCloseTo(20);
    expect(pf.rows.find((x: any) => x.project.id === P.none.id).status.label).toBe('no_budget');
  });

  it('validates input and rejects stale versions', async () => {
    expect((await budget(admin, P.none.id, { billingType: 'internal', currency: 'INR' })).status).toBe(400);
    expect((await budget(admin, P.none.id, { billingType: 'fixed_fee', budgetHours: 10, currency: 'INR' })).status).toBe(400);
    expect((await budget(admin, P.none.id, { billingType: 'internal', budgetHours: 10, currency: 'inr' })).status).toBe(400);
    expect((await budget(admin, P.none.id, { billingType: 'internal', budgetHours: 10, currency: 'INR', startDate: '2026-05-01', endDate: '2026-04-01' })).status).toBe(400);
    const cur = (await admin.get(`/api/projects/${P.tm.id}/budget`)).body.budget.version;
    expect((await budget(admin, P.tm.id, { billingType: 'time_and_materials', budgetAmount: 1, currency: 'INR', billRate: 1, version: cur + 5 })).status).toBe(409);
    expect((await budget(admin, P.tm.id, { billingType: 'time_and_materials', budgetAmount: 1, currency: 'INR', billRate: 1 })).status).toBe(409);
  });
});

describe('confidentiality', () => {
  it('cost viewers see money; owner and leadership see hours only; everyone else nothing', async () => {
    const m = await mgr.get(`/api/projects/${P.fixed.id}/budget`);
    expect(m.status).toBe(200);
    expect(m.body).toMatchObject({ access: 'hours', money: null, canEdit: false });
    expect(m.body.budget).not.toHaveProperty('budgetAmount');
    expect(m.body.budget).not.toHaveProperty('billRate');
    expect(m.body.hours.toDate).toBeCloseTo(7.5);
    const text = JSON.stringify(m.body);
    for (const leak of ['costToDate', 'revenue', 'margin', 'INR', '6500', '10000', '"amount"']) expect(text).not.toContain(leak);
    const f = await founder.get(`/api/projects/${P.fixed.id}/budget`);
    expect(f.body).toMatchObject({ access: 'hours', money: null });
    expect((await emp.get(`/api/projects/${P.fixed.id}/budget`)).status).toBe(403);
    expect((await outsider.get(`/api/projects/${P.fixed.id}/budget`)).status).toBe(403);
    expect((await founder.get(`/api/projects/${P.priv.id}/budget`)).status).toBe(404); // private project, not a member
    expect((await admin.get(`/api/projects/${P.fixed.id}/budget`)).body).toMatchObject({ access: 'money', canEdit: true });
  });

  it('only cost viewers responsible for the project can set budgets', async () => {
    const body = { billingType: 'internal', budgetHours: 40, currency: 'INR' };
    expect((await budget(mgr, P.none.id, body)).status).toBe(403);      // owner without cost_viewer
    expect((await budget(founder, P.none.id, body)).status).toBe(403);  // leadership without cost_viewer
    expect((await budget(emp, P.none.id, body)).status).toBe(403);
    expect((await mgr.del(`/api/projects/${P.fixed.id}/budget`, { version: 1, reason: 'not mine' })).status).toBe(403);
  });

  it('portfolio and badges are filtered per role', async () => {
    expect((await emp.get('/api/profitability/portfolio')).status).toBe(403);
    expect((await emp.get('/api/profitability/badges')).body).toEqual([]);
    const pm = (await mgr.get('/api/profitability/portfolio')).body;
    expect(pm.access).toBe('hours');
    expect(pm.totals.byCurrency).toEqual([]);
    expect(pm.rows.every((r: any) => r.money === null)).toBe(true);
    expect(pm.rows.map((r: any) => r.project.id)).toContain(P.priv.id);
    const pf = (await founder.get('/api/profitability/portfolio')).body;
    expect(pf.rows.map((r: any) => r.project.id)).not.toContain(P.priv.id);
    const bm = (await mgr.get('/api/profitability/badges')).body;
    expect(bm.find((b: any) => b.projectId === P.fixed.id)).toMatchObject({ basis: 'hours' });
    expect(bm.find((b: any) => b.projectId === P.fixed.id).consumption).toBeCloseTo(0.75);
    const filtered = (await admin.get('/api/profitability/portfolio?billingType=time_and_materials')).body.rows;
    expect(filtered.map((r: any) => r.project.id)).toEqual([P.tm.id]);
  });
});

describe('threshold alerts', () => {
  const run = () => withTenant(org.tenantId, (db) => checkBudgetAlerts(db, org.tenantId));
  it('alerts owner (hours) and cost viewers (money) once per threshold', async () => {
    await drainJobs();   // the save enqueued a check for this project
    await run();
    const link = `/projects/${P.fixed.id}`;
    const n1 = await notes(link);
    const forUser = (k: string) => n1.filter((n: any) => n.user_id === org.users[k]);
    expect(forUser('admin').map((n: any) => n.title).sort()).toEqual([
      'FIX budget: 50% of the budget amount used', 'FIX budget: 75% of budgeted hours used', 'FIX: forecast cost exceeds the budget', 'FIX: forecast hours exceed the budget']);
    expect(forUser('manager').map((n: any) => n.title).sort()).toEqual(['FIX budget: 75% of budgeted hours used', 'FIX: forecast hours exceed the budget']);
    expect(JSON.stringify(forUser('manager'))).not.toContain('INR');
    expect(forUser('founder')).toHaveLength(0);
    expect(forUser('emp')).toHaveLength(0);
    await run(); await run();
    expect(await notes(link)).toHaveLength(n1.length); // idempotent
  });

  it('a new threshold fires once; changing the budget amount re-arms alerts', async () => {
    const link = `/projects/${P.fixed.id}`;
    const before = (await notes(link)).length;
    const cur = (await admin.get(`/api/projects/${P.fixed.id}/budget`)).body.budget;
    await budget(admin, P.fixed.id, { billingType: 'fixed_fee', budgetAmount: 10000, currency: 'INR', budgetHours: 10, alertThresholds: [50, 60, 75, 100], version: cur.version });
    await run();
    const after = await notes(link);
    expect(after.length).toBe(before + 1);
    expect(after.map((n: any) => n.title)).toContain('FIX budget: 60% of the budget amount used');
    await budget(admin, P.fixed.id, { billingType: 'fixed_fee', budgetAmount: 6000, currency: 'INR', budgetHours: 10, alertThresholds: [50, 60, 75, 100], version: cur.version + 1 });
    await run();
    const rearmed = await notes(link);
    expect(rearmed.filter((n: any) => n.title === 'FIX budget: 100% of the budget amount used' && n.user_id === org.users.admin)).toHaveLength(1);
    expect(rearmed.filter((n: any) => n.title.includes('budget amount') && n.user_id === org.users.manager)).toHaveLength(0);
    await run();
    expect(await notes(link)).toHaveLength(rearmed.length);
    const d = (await admin.get(`/api/projects/${P.fixed.id}/budget`)).body;
    expect(d.status.label).toBe('over_budget');
    expect(d.alerts.some((x: any) => x.kind === 'amount' && x.threshold === 100)).toBe(true);
    expect((await mgr.get(`/api/projects/${P.fixed.id}/budget`)).body.alerts.every((x: any) => x.kind.startsWith('hours') || x.kind === 'forecast_hours')).toBe(true);
  });

  it('records budget changes in the audit trail without amounts', async () => {
    const rows = await withOwner(async (db) => (await db.query(`select action, details from audit_events where tenant_id = $1 and resource_type = 'project_budget' order by id`, [org.tenantId])).rows);
    expect(rows.map((r: any) => r.action)).toEqual(expect.arrayContaining(['project_budget.create', 'project_budget.update']));
    expect(JSON.stringify(rows)).not.toContain('10000');
  });

  it('removing a budget needs the current version and a reason', async () => {
    const v = (await admin.get(`/api/projects/${P.usd.id}/budget`)).body.budget.version;
    expect((await admin.del(`/api/projects/${P.usd.id}/budget`, { version: v })).status).toBe(400);
    expect((await admin.del(`/api/projects/${P.usd.id}/budget`, { version: v + 1, reason: 'Wrong currency' })).status).toBe(409);
    expect((await admin.del(`/api/projects/${P.usd.id}/budget`, { version: v, reason: 'Wrong currency' })).status).toBe(200);
    expect((await admin.get(`/api/projects/${P.usd.id}/budget`)).body.budget).toBeNull();
  });
});

describe('profitability export', () => {
  const exportAs = async (c: any, format: string, params: any = {}) => {
    const ex = await c.post('/api/exports', { format, report: 'profitability', params });
    if (ex.status !== 200) return { status: ex.status, text: '' };
    await drainJobs();
    expect((await c.get(`/api/exports/${ex.body.id}`)).body.status).toBe('ready');
    const f = await c.get(`/api/exports/${ex.body.id}/file`);
    return { status: 200, text: Buffer.from(f.raw).toString('utf8'), type: f.headers['content-type'] };
  };
  it('is authorized and redacted per role', async () => {
    expect((await exportAs(emp, 'csv')).status).toBe(403);
    expect((await exportAs(outsider, 'csv', { projectId: P.fixed.id })).status).toBe(403);
    const m = await exportAs(mgr, 'csv');
    expect(m.text).toContain('hours_to_date');
    expect(m.text).not.toContain('cost_to_date');
    expect(m.text).not.toContain('INR');
    const a = await exportAs(admin, 'csv');
    expect(a.text).toContain('cost_to_date');
    expect(a.text).toContain('Totals per currency');
    expect(a.text).toContain("'=Danger cell"); // formula injection guard
    const pdf = await exportAs(admin, 'pdf', { projectId: P.fixed.id });
    expect(pdf.type).toBe('application/pdf');
    expect(pdf.text.slice(0, 5)).toBe('%PDF-');
  });

  it('writes negative margins as numbers, not formula-guarded text', async () => {
    expect((await admin.get(`/api/projects/${P.fixed.id}/budget`)).body.money.margin).toBeCloseTo(-500); // fee 6000, cost 6500
    const a = await exportAs(admin, 'csv', { projectId: P.fixed.id });
    const line = a.text.split('\n').find((l) => l.startsWith('FIX,'))!;
    expect(line).toContain(',-500,');
    expect(line).not.toContain("'-");
  });
});

describe('review fixes', () => {
  let o: Org; let oAdmin: any; let oMgr: any;
  const project = async (key: string, entries: [string, string, string, string][]) => {
    const p = (await oMgr.post('/api/projects', { key, name: `Project ${key}` })).body;
    await withOwner(async (db) => {
      const t = (await db.query(`insert into tasks (tenant_id, title, owner_id, created_by, project_id, status) values ($1,$2,$3,$3,$4,'in_progress') returning id`,
        [o.tenantId, `${key} task`, o.users.emp, p.id])).rows[0].id;
      for (const [user, zone, date, from] of entries) {
        const s = DateTime.fromISO(`${date}T${from}`, { zone });
        await db.query(`insert into time_entries (tenant_id, user_id, task_id, category, started_at, ended_at, source) values ($1,$2,$3,'task',$4,$5,'manual')`,
          [o.tenantId, o.users[user], t, s.toUTC().toISO(), s.plus({ hours: 1 }).toUTC().toISO()]);
      }
    });
    return p;
  };
  beforeAll(async () => {
    o = await makeOrg();
    [oAdmin, oMgr] = await Promise.all([login(o, 'admin'), login(o, 'manager')]);
  });

  it("prices time at the rate effective on the person's own local date, not the tenant's", async () => {
    const LA = 'America/Los_Angeles';
    const d = pastWorkday(LA, 3), dayBefore = d.minus({ days: 1 }).toISODate()!;
    await withOwner(async (db) => {
      await db.query(`update users set timezone = $2 where id = $1`, [o.users.emp2, LA]);
      for (const [rate, from] of [[100, '2020-01-01'], [200, d.toISODate()!]] as const)
        await db.query(`insert into cost_rates (tenant_id, user_id, hourly_rate, currency, effective_from) values ($1,$2,$3,'INR',$4)`, [o.tenantId, o.users.emp2, rate, from]);
    });
    // 20:00-21:00 in Los Angeles on the day before the raise is already the raise day in the tenant timezone (Asia/Kolkata).
    const p = await project('TZR', [['emp2', LA, dayBefore, '20:00']]);
    const r = (await oAdmin.put(`/api/projects/${p.id}/budget`, { billingType: 'internal', budgetAmount: 1000, currency: 'INR' })).body;
    expect(r.money.costToDate).toBeCloseTo(100);
  });

  it('time that cannot be priced at all makes cost figures not measurable instead of zero', async () => {
    const p = await project('UNP', [['emp', o.tz, pastWorkday(o.tz, 2).toISODate()!, '10:00']]); // emp has no cost rate in this org
    const r = (await oAdmin.put(`/api/projects/${p.id}/budget`, { billingType: 'fixed_fee', budgetAmount: 10000, currency: 'INR' })).body;
    expect(r.money).toMatchObject({ costToDate: 0, unpricedHours: 1, consumption: null, margin: null, marginPct: null, forecastCost: null });
    expect(r.status.label).toBe('not_measurable');
    expect(r.status.reasons.join(' ')).toMatch(/unpriced/);
    const badge = (await oAdmin.get('/api/profitability/badges')).body.find((b: any) => b.projectId === p.id);
    expect(badge.consumption).toBeNull();
    const inr = (await oAdmin.get('/api/profitability/portfolio')).body.totals.byCurrency.find((t: any) => t.currency === 'INR');
    expect(inr).toMatchObject({ revenue: 0, margin: 0 }); // the unmeasurable fixed fee is not counted as pure margin
  });

  it('re-saving the same amount does not re-arm alerts; moving the start date does', async () => {
    const p = await project('ARM', []);
    const put = (body: any) => oAdmin.put(`/api/projects/${p.id}/budget`, { billingType: 'internal', currency: 'INR', ...body });
    const r1 = (await put({ budgetAmount: 1234.567 })).body;
    expect(r1.budget).toMatchObject({ budgetAmount: 1234.57, alertEpoch: 1 });
    const r2 = (await put({ budgetAmount: 1234.567, notes: 'Clarified scope', version: r1.budget.version })).body;
    expect(r2.budget.alertEpoch).toBe(1);
    const r3 = (await put({ budgetAmount: 1234.567, notes: 'Clarified scope', startDate: pastWorkday(o.tz, 1).toISODate(), version: r2.budget.version })).body;
    expect(r3.budget.alertEpoch).toBe(2);
    const audits = await withOwner(async (db) => (await db.query(`select details from audit_events where tenant_id = $1 and resource_id = $2 and action = 'project_budget.update' order by id`,
      [o.tenantId, r1.budget.id])).rows.map((x: any) => x.details));
    expect(audits[0]).toMatchObject({ fields: ['notes'], alertsRearmed: false });
    expect(audits[1]).toMatchObject({ fields: ['start_date'], alertsRearmed: true });
  });

  it('rejects amounts too large for the stored columns with a 400', async () => {
    const p = await project('BIG', []);
    expect((await oAdmin.put(`/api/projects/${p.id}/budget`, { billingType: 'time_and_materials', budgetAmount: 1000, billRate: 5e10, currency: 'INR' })).status).toBe(400);
    expect((await oAdmin.put(`/api/projects/${p.id}/budget`, { billingType: 'internal', budgetAmount: 5e12, currency: 'INR' })).status).toBe(400);
  });
});
