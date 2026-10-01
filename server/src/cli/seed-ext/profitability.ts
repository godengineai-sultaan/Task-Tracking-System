import type { SeedCtx } from './types.js';

/** Fictional DEMO fixtures for the 'profitability' feature area: budgets sized against the seeded time so each status shows. */
const BUDGET_START = '2026-08-01';

export default async function seed(ctx: SeedCtx) {
  const { q, ins, U, P, today } = ctx;
  // Rate history: Rahul's (fictional) raise two weeks ago, so older entries price at the old rate.
  await ins('cost_rates', { user_id: U.rahul, hourly_rate: 1950, currency: 'INR', effective_from: today.minus({ days: 14 }).toISODate() });
  const used = await q(`select t.project_id, sum(extract(epoch from te.ended_at - te.started_at)) / 3600 hours,
      sum(extract(epoch from te.ended_at - te.started_at)) / 3600 * avg(coalesce(r.hourly_rate, 0)) approx_cost
    from time_entries te join tasks t on t.id = te.task_id
    left join lateral (select hourly_rate from cost_rates c where c.user_id = te.user_id and c.effective_from <= te.started_at::date order by effective_from desc limit 1) r on true
    where t.tenant_id = $1 and te.deleted_at is null and te.ended_at is not null and t.project_id is not null
      and te.started_at >= $2::date group by 1`, [ctx.T, BUDGET_START]); // same window the app prices
  const u = (key: string) => {
    const r = used.find((x) => x.project_id === P[key].id);
    return { hours: Math.max(Number(r?.hours ?? 0), 8), cost: Math.max(Number(r?.approx_cost ?? 0), 15000) };
  };
  const round = (v: number, step: number) => Math.max(step, Math.round(v / step) * step);
  const web = u('WEB'), ops = u('OPS'), fin = u('FIN'), hire = u('HIRE');
  await ins('project_budgets', { project_id: P.WEB.id, billing_type: 'fixed_fee', budget_amount: round(web.cost / 0.78, 10000), currency: 'INR', budget_hours: round(web.hours / 0.6, 10),
    start_date: BUDGET_START, end_date: '2026-11-20', notes: 'Fixed fee per the Globex portal v2 statement of work (fictional DEMO figure).', created_by: U.asha, updated_by: U.asha });
  await ins('project_budgets', { project_id: P.OPS.id, billing_type: 'internal', budget_amount: round(ops.cost / 0.92, 1000), currency: 'INR', budget_hours: round(ops.hours / 0.85, 5),
    start_date: BUDGET_START, end_date: '2026-10-31', notes: 'Internal procurement effort budget for October joiners.', created_by: U.asha, updated_by: U.asha });
  await ins('project_budgets', { project_id: P.FIN.id, billing_type: 'internal', budget_amount: round(fin.cost / 1.08, 1000), currency: 'INR', budget_hours: round(fin.hours / 0.95, 5),
    start_date: BUDGET_START, end_date: '2026-10-15', alert_thresholds: [80, 100], notes: 'Q3 close effort budget; reconciliations ran long.', created_by: U.asha, updated_by: U.asha });
  await ins('project_budgets', { project_id: P.HIRE.id, billing_type: 'internal', budget_hours: round(hire.hours / 0.4, 5), currency: 'INR',
    start_date: BUDGET_START, end_date: '2026-12-15', notes: 'Leadership time only; no amount tracked.', created_by: U.asha, updated_by: U.asha });
}
