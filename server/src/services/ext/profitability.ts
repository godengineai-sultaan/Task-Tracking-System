import PDFDocument from 'pdfkit';
import { drawPdfBrandHeader, type PdfBrand } from './clientbrand-brand.js';
import type { Db } from '../../lib/db.js';
import { many, one } from '../../lib/db.js';
import { audit } from '../../lib/audit.js';
import { enqueue } from '../../lib/jobs.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';
import { type Actor, has, isStaff } from '../access.js';
import { notify } from '../notify.js';
import { csvCell, registerExportReport } from '../exports.js';

/**
 * Project budgets, burn and profitability.
 * Confidentiality: money values only for cost viewers; project owners and leadership without cost_viewer get hours-only burn;
 * everyone else gets nothing. Hours are recorded work evidence, never a productivity score.
 */
export type Access = 'money' | 'hours' | 'none';
export type BillingType = 'fixed_fee' | 'time_and_materials' | 'internal';
export type StatusLabel = 'no_budget' | 'not_measurable' | 'on_track' | 'watch' | 'at_risk' | 'over_budget';
export const DEFAULT_THRESHOLDS = [75, 90, 100];
export const ALERT_JOB = 'profitability.alerts';

const VISIBLE = `(p.visibility = 'company' or p.owner_id = $1 or exists (select 1 from project_members m where m.project_id = p.id and m.user_id = $1) or $2::boolean)`;
const r2 = (n: number) => Math.round(n * 100) / 100;
const ratio = (a: number | null, b: number | null) => (a === null || b === null || !b ? null : a / b);
const fh = (h: number) => `${(Math.round(h * 10) / 10).toFixed(1)}h`;
const pc = (v: number | null) => (v === null ? 'N/A' : `${Math.round(v * 100)}%`);
const fm = (cur: string, v: number | null) => (v === null ? 'N/A' : `${cur} ${new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(v)}`);

export function accessFor(a: Actor, p: { owner_id: string | null }): Access {
  if (!isStaff(a)) return 'none';
  if (has(a, 'cost_viewer')) return 'money';
  if (p.owner_id === a.id || has(a, 'leadership')) return 'hours';
  return 'none';
}
/** Budgets contain money, so editing needs cost_viewer plus responsibility for the project. */
export function canEditBudget(a: Actor, p: { owner_id: string | null }) {
  return isStaff(a) && has(a, 'cost_viewer') && (p.owner_id === a.id || has(a, 'leadership') || has(a, 'system_admin'));
}

async function loadProjects(db: Db, a: Actor | null, projectId?: string) {
  const params: unknown[] = [];
  let where = projectId ? 'true' : `p.status <> 'archived'`;
  if (a) { params.push(a.id, has(a, 'routine_admin')); where += ` and ${VISIBLE}`; }
  if (projectId) { params.push(projectId); where += ` and p.id = $${params.length}`; }
  return many(db, `select p.id, p.key, p.name, p.status, p.owner_id, p.target_date, u.name owner_name, c.name customer_name,
      b.id budget_id, b.billing_type, b.budget_amount, b.currency, b.budget_hours, b.bill_rate, b.start_date, b.end_date, b.alert_thresholds,
      b.notes, b.alert_epoch, b.version budget_version, b.updated_at budget_updated_at
    from projects p left join users u on u.id = p.owner_id left join customers c on c.id = p.customer_id left join project_budgets b on b.project_id = p.id
    where ${where} order by p.name`, params);
}

interface Seg { project_id: string; user_id: string; user_name: string; hourly_rate: number | null; currency: string | null; hours: number; recent_hours: number }

/** Full (money-level) financials for the given project rows. Callers redact with present(). */
async function computeFinancials(db: Db, projects: any[]) {
  const ids = projects.map((p) => p.id);
  const out = new Map<string, any>();
  if (!ids.length) return out;
  const tz = (await one(db, `select t.timezone from tenants t where t.id = nullif(current_setting('app.tenant_id', true), '')::uuid`))?.timezone ?? 'UTC';
  const defaultCurrency = (await one(db, `select currency from cost_rates group by 1 order by count(*) desc, 1 limit 1`))?.currency ?? 'INR';
  // Confirmed time: finished, non-deleted entries on the project's tasks. Overlaps by one person within a project merge (counted once).
  // Each merged span is priced at that person's rate effective on its start date in the person's own timezone (as elsewhere in the app).
  const segs = await many<Seg>(db, `with e as (
      select t.project_id, te.user_id, tstzrange(te.started_at, te.ended_at) r from time_entries te join tasks t on t.id = te.task_id
      where t.project_id = any($1::uuid[]) and te.deleted_at is null and te.ended_at is not null
    ), m as (select project_id, user_id, unnest(range_agg(r)) r from e group by 1, 2),
    d as (select m.project_id, m.user_id, (lower(m.r) at time zone coalesce(uz.timezone, $2))::date as day, extract(epoch from upper(m.r) - lower(m.r)) / 3600.0 hours,
      lower(m.r) >= now() - interval '28 days' recent from m join users uz on uz.id = m.user_id)
    select d.project_id, d.user_id, u.name user_name, rate.hourly_rate, rate.currency,
      sum(d.hours)::float hours, coalesce(sum(d.hours) filter (where d.recent), 0)::float recent_hours
    from d join users u on u.id = d.user_id left join project_budgets b on b.project_id = d.project_id
    left join lateral (select c.hourly_rate, c.currency from cost_rates c where c.user_id = d.user_id and c.effective_from <= d.day
      order by c.effective_from desc limit 1) rate on true
    where b.start_date is null or d.day >= b.start_date
    group by 1, 2, 3, 4, 5`, [ids, tz]);
  // Logged time per open task in one grouped pass (not one scan of time_entries per task).
  const est = await many(db, `with open as (select id, project_id, estimate_minutes from tasks where project_id = any($1::uuid[]) and status not in ('done','cancelled')),
    logged as (select te.task_id, sum(extract(epoch from te.ended_at - te.started_at)) / 60 logged from time_entries te join open o on o.id = te.task_id
      where te.deleted_at is null and te.ended_at is not null group by 1)
    select o.project_id, count(*)::int open_tasks, count(o.estimate_minutes)::int estimated,
      coalesce(sum(greatest(o.estimate_minutes - coalesce(l.logged, 0), 0)), 0)::float remaining_minutes
    from open o left join logged l on l.task_id = o.id group by 1`, [ids]);
  const memberRates = await many(db, `select pm.project_id, r.currency, avg(r.hourly_rate)::float rate from project_members pm
    join lateral (select c.hourly_rate, c.currency from cost_rates c where c.user_id = pm.user_id and c.effective_from <= current_date
      order by c.effective_from desc limit 1) r on true where pm.project_id = any($1::uuid[]) group by 1, 2`, [ids]);

  for (const p of projects) {
    const currency: string = p.currency ?? defaultCurrency;
    let hours = 0, recentHours = 0, pricedHours = 0, cost = 0, recentCost = 0;
    const unpriced = new Map<string, { userId: string; name: string; hours: number; reason: 'no_rate' | 'currency' }>();
    for (const s of segs.filter((x) => x.project_id === p.id)) {
      hours += s.hours; recentHours += s.recent_hours;
      if (s.hourly_rate !== null && s.currency === currency) { pricedHours += s.hours; cost += s.hours * s.hourly_rate; recentCost += s.recent_hours * s.hourly_rate; continue; }
      const reason = s.hourly_rate === null ? 'no_rate' : 'currency';
      const k = `${s.user_id}:${reason}`;
      const u = unpriced.get(k) ?? { userId: s.user_id, name: s.user_name, hours: 0, reason };
      u.hours += s.hours; unpriced.set(k, u);
    }
    const e = est.find((x) => x.project_id === p.id) ?? { open_tasks: 0, estimated: 0, remaining_minutes: 0 };
    const remainingHours = e.remaining_minutes / 60;
    const forecastHours = hours + remainingHours;
    const memberRate = memberRates.find((x) => x.project_id === p.id && x.currency === currency)?.rate ?? null;
    const blendedRate = pricedHours > 0 ? cost / pricedHours : memberRate;
    const blendedRateSource = pricedHours > 0 ? 'actual_mix' : memberRate !== null ? 'member_rates' : null;
    // Time recorded but none of it priceable: cost is unknown, not zero, so cost-based figures are not measurable.
    const costKnown = pricedHours > 0 || hours === 0;
    const forecastCost = !costKnown ? null : blendedRate !== null ? cost + remainingHours * blendedRate : remainingHours === 0 ? cost : null;

    const b = p.budget_id ? {
      id: p.budget_id as string, billingType: p.billing_type as BillingType, currency, budgetAmount: p.budget_amount as number | null, budgetHours: p.budget_hours as number | null,
      billRate: p.bill_rate as number | null, startDate: p.start_date, endDate: p.end_date, alertThresholds: [...(p.alert_thresholds ?? DEFAULT_THRESHOLDS)].sort((x, y) => x - y),
      notes: p.notes, version: p.budget_version, alertEpoch: p.alert_epoch, updatedAt: p.budget_updated_at,
    } : null;
    let revenue: number | null = null, forecastRevenue: number | null = null;
    if (b?.billingType === 'fixed_fee') revenue = forecastRevenue = b.budgetAmount;
    if (b?.billingType === 'time_and_materials' && b.billRate !== null) { revenue = hours * b.billRate; forecastRevenue = forecastHours * b.billRate; }
    const margin = revenue !== null && costKnown ? revenue - cost : null;
    const forecastMargin = forecastRevenue !== null && forecastCost !== null ? forecastRevenue - forecastCost : null;
    const tm = b?.billingType === 'time_and_materials';
    const consumed = tm ? revenue : costKnown ? cost : null, forecastConsumed = tm ? forecastRevenue : forecastCost;
    const amountBurn = tm ? (b!.billRate ?? 0) * recentHours / 4 : recentCost / 4;
    const budgetAmount = b?.budgetAmount ?? null, budgetHours = b?.budgetHours ?? null;
    out.set(p.id, {
      project: { id: p.id, key: p.key, name: p.name, status: p.status, ownerId: p.owner_id, ownerName: p.owner_name, customerName: p.customer_name, targetDate: p.target_date },
      budget: b,
      hours: {
        toDate: r2(hours), last4Weeks: r2(recentHours), burnPerWeek: r2(recentHours / 4), remainingEstimate: r2(remainingHours), forecastAtCompletion: r2(forecastHours),
        budget: budgetHours, consumption: ratio(hours, budgetHours), forecastConsumption: ratio(forecastHours, budgetHours),
        runwayWeeks: budgetHours !== null && recentHours > 0 ? r2(Math.max(0, budgetHours - hours) / (recentHours / 4)) : null,
      },
      estimates: { openTasks: e.open_tasks, estimatedOpenTasks: e.estimated, coverage: e.open_tasks ? e.estimated / e.open_tasks : null },
      money: {
        currency, costToDate: r2(cost), costKnown, pricedHours: r2(pricedHours), unpricedHours: r2(hours - pricedHours),
        unpriced: [...unpriced.values()].map((u) => ({ ...u, hours: r2(u.hours) })).sort((x, y) => y.hours - x.hours),
        blendedRate: blendedRate === null ? null : r2(blendedRate), blendedRateSource, burnPerWeek: r2(recentCost / 4),
        revenue: revenue === null ? null : r2(revenue), revenueBasis: b?.billingType ?? null, margin: margin === null ? null : r2(margin), marginPct: revenue && margin !== null ? margin / revenue : null,
        forecastCost: forecastCost === null ? null : r2(forecastCost), forecastRevenue: forecastRevenue === null ? null : r2(forecastRevenue),
        forecastMargin: forecastMargin === null ? null : r2(forecastMargin), budgetAmount, consumptionBasis: tm ? 'billable_value' : 'cost',
        consumption: ratio(consumed, budgetAmount), forecastConsumption: ratio(forecastConsumed, budgetAmount),
        runwayWeeks: budgetAmount !== null && consumed !== null && amountBurn > 0 ? r2(Math.max(0, budgetAmount - consumed) / amountBurn) : null,
      },
    });
  }
  return out;
}

function statusOf(b: any, cons: (number | null)[], forecastOver: boolean): StatusLabel {
  if (!b) return 'no_budget';
  const vals = cons.filter((v): v is number => v !== null);
  if (!vals.length) return 'not_measurable';
  const c = Math.max(...vals) * 100;
  if (c >= 100) return 'over_budget';
  const crossed = (b.alertThresholds as number[]).filter((t) => t < 100 && c >= t).length;
  if (forecastOver || crossed >= 2) return 'at_risk';
  return crossed === 1 ? 'watch' : 'on_track';
}

/** Redact one project's financials to what the actor may see, and explain the figures. */
function present(f: any, a: Actor) {
  const access = accessFor(a, { owner_id: f.project.ownerId });
  const money = access === 'money';
  const { hours: h, money: m, budget: b, estimates: e } = f;
  const forecastOver = (h.forecastConsumption ?? 0) > 1 || (money && (m.forecastConsumption ?? 0) > 1);
  const label = statusOf(b, money ? [m.consumption, h.consumption] : [h.consumption], forecastOver);
  const facts = [`${fh(h.toDate)} of confirmed time on this project's tasks (${fh(h.last4Weeks)} in the last 4 weeks, ${fh(h.burnPerWeek)}/week).`];
  if (b?.budgetHours != null) facts.push(`${pc(h.consumption)} of ${fh(b.budgetHours)} budgeted hours used; forecast at completion ${fh(h.forecastAtCompletion)} (${pc(h.forecastConsumption)}).`);
  facts.push(e.openTasks ? `${e.estimatedOpenTasks} of ${e.openTasks} open tasks have estimates (${pc(e.coverage)} estimate coverage); ${fh(h.remainingEstimate)} remaining. Open work without an estimate is not in the forecast.`
    : 'No open tasks: the forecast equals time to date.');
  const assumptions = ['Confirmed time = finished, non-deleted time entries linked to this project\'s tasks. Overlapping entries by one person on this project count once.',
    'Hours are recorded work evidence. They are not a productivity measure and unlogged time is not assumed idle.',
    'Burn rate = the last 28 days divided by 4.'];
  if (b?.startDate) assumptions.push(`Time before the budget start date (${b.startDate}) is excluded.`);
  if (money) {
    facts.push(`Cost to date ${fm(m.currency, m.costToDate)} from ${fh(m.pricedHours)} priced at each person's cost rate effective on the entry date.`);
    if (m.unpricedHours > 0) facts.push(`${fh(m.unpricedHours)} unpriced (${m.unpriced.map((u: any) => `${u.name} ${fh(u.hours)}${u.reason === 'currency' ? ', rate in another currency' : ', no cost rate'}`).join('; ')}). Excluded from cost, not priced at zero: cost and forecast are understated.`);
    if (!m.costKnown) facts.push(`None of the recorded time could be priced in ${m.currency}: cost-based consumption, margin and forecast cost are not measurable until cost rates exist.`);
    if (b?.billingType === 'fixed_fee') facts.push(`Revenue is the fixed fee of ${fm(m.currency, b.budgetAmount)}; consumption compares cost to the fee.`);
    if (b?.billingType === 'time_and_materials') facts.push(b.billRate === null ? 'No bill rate set: revenue cannot be computed.' : `Revenue = ${fh(h.toDate)} billable hours x bill rate ${fm(m.currency, b.billRate)}; consumption compares billable value to the ${fm(m.currency, b.budgetAmount)} cap.`);
    if (b?.billingType === 'internal') facts.push('Internal project: no revenue, so margin does not apply; consumption compares cost to the budget.');
    if (m.forecastCost !== null) facts.push(`Forecast cost at completion ${fm(m.currency, m.forecastCost)} = cost to date + ${fh(h.remainingEstimate)} remaining estimate x blended rate ${fm(m.currency, m.blendedRate)}/h.`);
    else if (m.costKnown) facts.push('Forecast cost unavailable: nobody on this project has a cost rate in the budget currency yet.');
    if (m.blendedRateSource === 'member_rates') assumptions.push('No priced time yet: the blended rate is the average current rate of project members.');
    else if (m.blendedRateSource === 'actual_mix') assumptions.push('Blended rate = cost to date / priced hours (the actual mix of people so far).');
    if (!b) assumptions.push(`No budget: costs shown in ${m.currency}, the most common cost-rate currency.`);
  }
  const reasons: string[] = [];
  if (label === 'no_budget') reasons.push('No budget set for this project.');
  if (label === 'not_measurable') reasons.push(money ? 'The budget has no amount or hours that can be measured yet.' : 'No hours budget is set; amount figures are visible to cost viewers only.');
  if (forecastOver) reasons.push('The forecast at completion exceeds the budget.');
  if (money && b && m.unpricedHours > 0) reasons.push(`${fh(m.unpricedHours)} unpriced: ${m.costKnown ? 'cost-based figures are understated' : 'cost-based figures are not measurable'}.`);
  if (['watch', 'at_risk', 'over_budget'].includes(label)) reasons.push(`Consumption ${pc(Math.max(...(money ? [m.consumption, h.consumption] : [h.consumption]).filter((x: any) => x !== null)))} against alert thresholds ${b.alertThresholds.join('/')}%.`);
  return {
    project: f.project, access, canEdit: canEditBudget(a, { owner_id: f.project.ownerId }),
    budget: b && (money ? b : { id: b.id, billingType: b.billingType, budgetHours: b.budgetHours, startDate: b.startDate, endDate: b.endDate, alertThresholds: b.alertThresholds, version: b.version, updatedAt: b.updatedAt }),
    hours: h, estimates: e, money: money ? m : null,
    status: { label, basis: money ? 'amount_and_hours' : 'hours', forecastOver, reasons },
    facts, assumptions,
  };
}

const NO_ACCESS = 'Budgets are visible to cost viewers, leadership and project owners only';

export async function portfolio(db: Db, a: Actor, f: { projectId?: string; status?: string; billingType?: string } = {}) {
  if (!isStaff(a)) throw forbidden(NO_ACCESS);
  const permitted = (await loadProjects(db, a, f.projectId)).filter((p) => accessFor(a, p) !== 'none');
  if (!permitted.length && (f.projectId || (!has(a, 'cost_viewer') && !has(a, 'leadership')))) throw forbidden(NO_ACCESS);
  const fin = await computeFinancials(db, permitted);
  const rows = permitted.map((p) => present(fin.get(p.id), a))
    .filter((r) => (!f.status || r.status.label === f.status) && (!f.billingType || r.budget?.billingType === f.billingType));
  const access: Access = has(a, 'cost_viewer') ? 'money' : 'hours';
  const byCurrency = new Map<string, any>();
  if (access === 'money') for (const r of rows) {
    const m = r.money!;
    const t = byCurrency.get(m.currency) ?? { currency: m.currency, projects: 0, budgetAmount: 0, costToDate: 0, revenue: 0, margin: 0, unpricedHours: 0 };
    t.projects++; t.costToDate += m.costToDate; t.unpricedHours += m.unpricedHours;
    if (m.budgetAmount !== null) t.budgetAmount += m.budgetAmount;
    if (m.revenue !== null && m.margin !== null) { t.revenue += m.revenue; t.margin += m.margin; }
    byCurrency.set(m.currency, t);
  }
  return {
    access, generatedAt: new Date().toISOString(), rows,
    totals: {
      hoursToDate: r2(rows.reduce((s, r) => s + r.hours.toDate, 0)), budgetHours: r2(rows.reduce((s, r) => s + (r.hours.budget ?? 0), 0)),
      budgeted: rows.filter((r) => r.budget).length,
      byCurrency: [...byCurrency.values()].map((t) => ({ currency: t.currency, projects: t.projects, budgetAmount: r2(t.budgetAmount), costToDate: r2(t.costToDate),
        revenue: r2(t.revenue), margin: r2(t.margin), marginPct: t.revenue ? t.margin / t.revenue : null, unpricedHours: r2(t.unpricedHours) })),
    },
    note: access === 'money'
      ? 'Money totals are per currency and never mixed. Revenue and margin totals include only projects with revenue and a measurable cost. Unpriced hours are excluded from cost, not priced at zero.'
      : 'Hours-only view: money values are visible to cost viewers. Hours are recorded work evidence, not a productivity measure.',
  };
}

/** Lightweight status chips for the Projects list (empty for people without budget access). */
export async function badges(db: Db, a: Actor) {
  if (!isStaff(a) || (!has(a, 'cost_viewer') && !has(a, 'leadership') && !(await one(db, `select 1 from projects where owner_id = $1 limit 1`, [a.id])))) return [];
  const data = await portfolio(db, a).catch(() => null);
  return (data?.rows ?? []).filter((r) => r.budget).map((r) => ({
    projectId: r.project.id, label: r.status.label, basis: r.status.basis,
    consumption: ((v) => (v.length ? Math.max(...v) : null))((r.money ? [r.money.consumption, r.hours.consumption] : [r.hours.consumption]).filter((x): x is number => x !== null)),
  }));
}

export async function projectBudget(db: Db, a: Actor, projectId: string) {
  if (!isStaff(a)) throw forbidden(NO_ACCESS);
  const [p] = await loadProjects(db, a, projectId);
  if (!p) throw notFound('Project not found');
  if (accessFor(a, p) === 'none') throw forbidden(NO_ACCESS);
  const row = present((await computeFinancials(db, [p])).get(p.id), a);
  const kinds = row.access === 'money' ? ['amount', 'hours', 'forecast_amount', 'forecast_hours'] : ['hours', 'forecast_hours'];
  const alerts = p.budget_id ? await many(db, `select id, kind, threshold, consumption::float, epoch, created_at from project_budget_alerts
    where budget_id = $1 and kind = any($2) order by created_at desc, threshold desc limit 20`, [p.budget_id, kinds]) : [];
  return { ...row, alerts };
}

export interface BudgetInput {
  billingType: BillingType; budgetAmount?: number | null; currency: string; budgetHours?: number | null; billRate?: number | null;
  startDate?: string | null; endDate?: string | null; alertThresholds: number[]; notes: string; version?: number;
}

async function loadEditable(db: Db, a: Actor, projectId: string) {
  const p = await one(db, `select p.id, p.key, p.owner_id from projects p where p.id = $3 and ${VISIBLE}`, [a.id, has(a, 'routine_admin'), projectId]);
  if (!p) throw notFound('Project not found');
  if (!canEditBudget(a, p)) throw forbidden('Only cost viewers who own or lead this project, or admins with cost access, can change its budget');
  return p;
}

export async function saveBudget(db: Db, a: Actor, projectId: string, b: BudgetInput) {
  const p = await loadEditable(db, a, projectId);
  const existing = await one(db, `select * from project_budgets where project_id = $1 for update`, [p.id]);
  const next = { billing_type: b.billingType, budget_amount: b.budgetAmount ?? null, currency: b.currency, budget_hours: b.budgetHours ?? null,
    bill_rate: b.billingType === 'time_and_materials' ? b.billRate ?? null : null, start_date: b.startDate ?? null, end_date: b.endDate ?? null,
    alert_thresholds: [...new Set(b.alertThresholds)].sort((x, y) => x - y), notes: b.notes };
  let row: any;
  if (!existing) {
    row = await one(db, `insert into project_budgets (tenant_id, project_id, billing_type, budget_amount, currency, budget_hours, bill_rate, start_date, end_date, alert_thresholds, notes, created_by, updated_by)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) returning *`,
      [a.tenantId, p.id, next.billing_type, next.budget_amount, next.currency, next.budget_hours, next.bill_rate, next.start_date, next.end_date, next.alert_thresholds, next.notes, a.id]);
    await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'project_budget.create', resourceType: 'project_budget', resourceId: row.id, resourceVersion: 1,
      details: { projectId: p.id, billingType: next.billing_type } }); // amounts intentionally not logged (confidential)
  } else {
    if (b.version !== existing.version) throw conflict('This budget was changed by someone else. Reload to see the latest version.', { currentVersion: existing.version });
    // Re-arm compares the stored (rounded) values in SQL, so re-saving an amount with extra decimals does not re-send every alert.
    row = await one(db, `update project_budgets set billing_type = $3, budget_amount = $4, currency = $5, budget_hours = $6, bill_rate = $7, start_date = $8, end_date = $9,
        alert_thresholds = $10, notes = $11, updated_by = $12, updated_at = now(), version = version + 1,
        alert_epoch = alert_epoch + case when (billing_type, budget_amount, currency, budget_hours, bill_rate, start_date)
          is distinct from ($3::text, $4::numeric(14,2), $5::text, $6::numeric(10,2), $7::numeric(12,2), $8::date) then 1 else 0 end
      where id = $1 and version = $2 returning *`,
      [existing.id, existing.version, next.billing_type, next.budget_amount, next.currency, next.budget_hours, next.bill_rate, next.start_date, next.end_date,
       next.alert_thresholds, next.notes, a.id]);
    if (!row) throw conflict('This budget was changed by someone else. Reload to see the latest version.');
    const changed = (Object.keys(next) as (keyof typeof next)[]).filter((k) => JSON.stringify(row[k]) !== JSON.stringify(existing[k]));
    const rearm = row.alert_epoch !== existing.alert_epoch;
    await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'project_budget.update', resourceType: 'project_budget', resourceId: row.id, resourceVersion: row.version,
      details: { projectId: p.id, fields: changed, alertsRearmed: rearm } });
  }
  await enqueue(db, { tenantId: a.tenantId, kind: ALERT_JOB, payload: { projectId: p.id }, idempotencyKey: `${ALERT_JOB}:${row.id}:${row.version}` });
  return projectBudget(db, a, p.id);
}

export async function deleteBudget(db: Db, a: Actor, projectId: string, version: number, reason: string) {
  const p = await loadEditable(db, a, projectId);
  const existing = await one(db, `select * from project_budgets where project_id = $1 for update`, [p.id]);
  if (!existing) throw notFound('No budget set for this project');
  if (existing.version !== version) throw conflict('This budget was changed by someone else. Reload to see the latest version.', { currentVersion: existing.version });
  await db.query(`delete from project_budgets where id = $1`, [existing.id]);
  await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'project_budget.delete', resourceType: 'project_budget', resourceId: existing.id, resourceVersion: existing.version,
    reason, details: { projectId: p.id } });
  return { ok: true };
}

// ---------- Alerts (tenant tick) ----------
const ALERT_TEXT: Record<string, (k: string, t: number) => string> = {
  amount: (k, t) => `${k} budget: ${t}% of the budget amount used`,
  hours: (k, t) => `${k} budget: ${t}% of budgeted hours used`,
  forecast_amount: (k) => `${k}: forecast cost exceeds the budget`,
  forecast_hours: (k) => `${k}: forecast hours exceed the budget`,
};

/**
 * Idempotent per threshold per budget revision: a crossed threshold inserts one alert row (unique), and only newly inserted
 * rows notify. Money alerts go to cost viewers who can see the project; hours alerts also go to the project owner.
 */
export async function checkBudgetAlerts(db: Db, tenantId: string, projectId?: string) {
  const projects = (await loadProjects(db, null, projectId)).filter((p) => p.budget_id && !['completed', 'archived'].includes(p.status));
  if (!projects.length) return 0;
  const fin = await computeFinancials(db, projects);
  let sent = 0;
  for (const p of projects) {
    const f = fin.get(p.id);
    const thresholds: number[] = f.budget.alertThresholds;
    const cands: { kind: string; threshold: number; consumption: number }[] = [];
    for (const [kind, c] of [['amount', f.money.consumption], ['hours', f.hours.consumption]] as const)
      if (c !== null) for (const t of thresholds) if (c * 100 >= t) cands.push({ kind, threshold: t, consumption: c });
    if ((f.money.forecastConsumption ?? 0) > 1) cands.push({ kind: 'forecast_amount', threshold: 0, consumption: f.money.forecastConsumption });
    if ((f.hours.forecastConsumption ?? 0) > 1) cands.push({ kind: 'forecast_hours', threshold: 0, consumption: f.hours.forecastConsumption });
    // A threshold added below one already alerted on is recorded silently: it is not news.
    const prior = await many(db, `select kind, max(threshold)::int top from project_budget_alerts where budget_id = $1 and epoch = $2 group by kind`, [p.budget_id, p.alert_epoch]);
    const fresh: (typeof cands[number] & { id: string })[] = [];
    for (const c of cands) {
      const r = await one(db, `insert into project_budget_alerts (tenant_id, budget_id, project_id, epoch, kind, threshold, consumption) values ($1,$2,$3,$4,$5,$6,$7)
        on conflict (budget_id, epoch, kind, threshold) do nothing returning id`, [tenantId, p.budget_id, p.id, p.alert_epoch, c.kind, c.threshold, Math.min(c.consumption, 999)]);
      if (r) fresh.push({ ...c, id: r.id });
    }
    if (!fresh.length) continue;
    const people = await many(db, `select u.id, 'cost_viewer' = any(u.roles) cost_viewer from users u join projects p on p.id = $1
      where u.status = 'active' and not ('customer' = any(u.roles)) and (u.id = p.owner_id or ('cost_viewer' = any(u.roles) and (p.visibility = 'company' or p.owner_id = u.id
        or 'routine_admin' = any(u.roles) or exists (select 1 from project_members m where m.project_id = p.id and m.user_id = u.id))))`, [p.id]);
    const m = f.money, h = f.hours;
    for (const kind of ['amount', 'hours', 'forecast_amount', 'forecast_hours']) {
      const top = fresh.filter((x) => x.kind === kind).sort((x, y) => y.threshold - x.threshold)[0];
      if (!top || top.threshold < (prior.find((x) => x.kind === kind)?.top ?? -1)) continue;
      const isMoney = kind.endsWith('amount');
      const to = people.filter((u) => !isMoney || u.cost_viewer);
      const body = kind === 'amount' ? `${m.consumptionBasis === 'billable_value' ? 'Billable value' : 'Cost'} ${fm(m.currency, m.consumption * m.budgetAmount)} of ${fm(m.currency, m.budgetAmount)} (${pc(m.consumption)}). Forecast at completion ${pc(m.forecastConsumption)} of budget.`
        : kind === 'forecast_amount' ? `Forecast ${fm(m.currency, m.consumptionBasis === 'billable_value' ? m.forecastRevenue : m.forecastCost)} against a budget of ${fm(m.currency, m.budgetAmount)}, with ${pc(f.estimates.coverage)} estimate coverage.`
        : `${fh(h.toDate)} of ${fh(h.budget)} budgeted hours (${pc(h.consumption)}). Forecast ${fh(h.forecastAtCompletion)} with ${pc(f.estimates.coverage)} estimate coverage.`;
      for (const u of to) await notify(db, tenantId, u.id, 'budget_alert', ALERT_TEXT[kind](p.key, top.threshold), body, `/projects/${p.id}`);
      await db.query(`update project_budget_alerts set notified_user_ids = $2 where id = $1`, [top.id, to.map((u) => u.id)]);
      sent += to.length;
    }
  }
  return sent;
}

// ---------- Export ----------
// Real numbers cannot carry a formula, so they skip the guard (which would turn a negative margin into the text "'-500").
const cell = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? String(v) : csvCell(v));
const csv = (rows: unknown[][]) => rows.map((r) => r.map(cell).join(',')).join('\n') + '\n';
const num = (v: number | null | undefined) => (v === null || v === undefined ? '' : v);
const pctCell = (v: number | null | undefined) => (v === null || v === undefined ? '' : Number((v * 100).toFixed(1)));

export function profitabilityCsv(d: any) {
  const money = d.access === 'money';
  const head = ['project_key', 'project', 'status', 'billing_type', 'hours_to_date', 'budget_hours', 'hours_consumption_pct', 'forecast_hours', 'burn_hours_per_week', 'estimate_coverage_pct'];
  if (money) head.push('currency', 'budget_amount', 'cost_to_date', 'unpriced_hours', 'revenue', 'margin', 'margin_pct', 'amount_consumption_pct', 'consumption_basis', 'forecast_cost', 'forecast_margin');
  const rows: unknown[][] = [['Report', 'Project budgets and profitability'], ['Generated', d.generatedAt], ['View', money ? 'money and hours (cost viewer)' : 'hours only'], [], head];
  for (const r of d.rows) {
    const line: unknown[] = [r.project.key, r.project.name, r.status.label, r.budget?.billingType ?? '', r.hours.toDate, num(r.hours.budget), pctCell(r.hours.consumption),
      r.hours.forecastAtCompletion, r.hours.burnPerWeek, pctCell(r.estimates.coverage)];
    if (money) { const m = r.money; line.push(m.currency, num(m.budgetAmount), m.costToDate, m.unpricedHours, num(m.revenue), num(m.margin), pctCell(m.marginPct), pctCell(m.consumption), m.consumptionBasis, num(m.forecastCost), num(m.forecastMargin)); }
    rows.push(line);
  }
  if (money) {
    rows.push([], ['Totals per currency (never mixed)'], ['currency', 'projects', 'budget_amount', 'cost_to_date', 'revenue', 'margin', 'margin_pct', 'unpriced_hours']);
    for (const t of d.totals.byCurrency) rows.push([t.currency, t.projects, t.budgetAmount, t.costToDate, t.revenue, t.margin, pctCell(t.marginPct), t.unpricedHours]);
  }
  rows.push([], ['Note', d.note]);
  return csv(rows);
}

export function profitabilityPdf(d: any, a: Actor, brand?: PdfBrand): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: 'Project budgets and profitability', Author: 'Task Tracking and Productivity' } });
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    // Organization name, accent and logo, like every other exported report.
    if (brand) drawPdfBrandHeader(doc, brand);
    const money = d.access === 'money';
    const p = (t: string, color = '#374151', size = 9.5) => doc.font('Helvetica').fontSize(size).fillColor(color).text(t, { lineGap: 2 });
    doc.font('Helvetica-Bold').fontSize(18).fillColor('#111827').text('Project budgets and profitability').moveDown(0.3);
    p(`${money ? 'Money and hours view (cost viewer)' : 'Hours-only view'} - generated ${d.generatedAt}`, '#6b7280');
    if (money && d.totals.byCurrency.length) {
      doc.moveDown(0.6).font('Helvetica-Bold').fontSize(12).fillColor('#111827').text('Totals per currency').moveDown(0.2);
      for (const t of d.totals.byCurrency) p(`${t.currency}: ${t.projects} project(s), budget ${fm(t.currency, t.budgetAmount)}, cost to date ${fm(t.currency, t.costToDate)}, revenue ${fm(t.currency, t.revenue)}, margin ${fm(t.currency, t.margin)} (${pc(t.marginPct)}), unpriced ${fh(t.unpricedHours)}`);
    }
    for (const r of d.rows) {
      doc.moveDown(0.6).font('Helvetica-Bold').fontSize(12).fillColor('#111827').text(`${r.project.key} ${r.project.name} - ${r.status.label.replace(/_/g, ' ')}`).moveDown(0.2);
      if (r.budget) p(`Billing: ${r.budget.billingType.replace(/_/g, ' ')}${r.budget.startDate ? ` - from ${r.budget.startDate}` : ''}${r.budget.endDate ? ` to ${r.budget.endDate}` : ''}`);
      r.status.reasons.forEach((x: string) => p(`- ${x}`));
      r.facts.forEach((x: string) => p(`- ${x}`, '#4b5563'));
      p(`Assumptions: ${r.assumptions.join(' ')}`, '#6b7280', 8.5);
    }
    doc.moveDown(1).font('Helvetica').fontSize(7.5).fillColor('#9ca3af')
      .text(`Generated for ${a.name}. Authorized records only. ${d.note} Recorded hours are not a productivity measure; unknown time is not idle time.`);
    doc.end();
  });
}

registerExportReport('profitability', {
  async authorize(db, a, params) {
    if (!isStaff(a)) throw forbidden(NO_ACCESS);
    const ok = (await loadProjects(db, a, params.projectId)).some((p) => accessFor(a, p) !== 'none');
    if (!ok && (params.projectId || (!has(a, 'cost_viewer') && !has(a, 'leadership')))) throw forbidden(NO_ACCESS);
  },
  async build(db, a, params) {
    const data = await portfolio(db, a, { projectId: params.projectId, status: params.status, billingType: params.billingType });
    return { data, name: `profitability-${data.generatedAt.slice(0, 10)}` };
  },
  csv: profitabilityCsv,
  pdf: profitabilityPdf,
});
