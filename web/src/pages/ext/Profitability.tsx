import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ArrowUpDown, FileDown, Wallet } from 'lucide-react';
import { api } from '../../lib/api';
import { pct } from '../../lib/format';
import { Badge, Button, Callout, Card, Empty, ErrorState, Input, PageHeader, Select, Skeleton, Stat, cx, useToast } from '../../components/ui';
import { BILLING_LABEL, BUDGET_STATUS, BarLegend, BudgetStatus, BurnBar, fmtHours, fmtMoney } from '../../components/ext/ProfitabilityParts';
import { downloadExport } from '../util';

type SortKey = 'name' | 'consumption' | 'margin' | 'hours';
const consumption = (r: any) => {
  const v = (r.money ? [r.money.consumption, r.hours.consumption] : [r.hours.consumption]).filter((x: number | null) => x !== null);
  return v.length ? Math.max(...v) : null;
};
const SORTERS: Record<SortKey, (r: any) => number | string | null> = {
  name: (r) => r.project.name.toLowerCase(), consumption, margin: (r) => r.money?.marginPct ?? null, hours: (r) => r.hours.toDate,
};

/** Portfolio of project budgets: burn, margin and forecast. Money only for cost viewers; hours-only otherwise. */
export default function Profitability() {
  const toast = useToast();
  const q = useQuery<any>({ queryKey: ['profitability'], queryFn: () => api.get('/api/profitability/portfolio'), retry: (n, e: any) => e?.status !== 403 && n < 2 });
  const [search, setSearch] = useState(''); const [status, setStatus] = useState(''); const [billing, setBilling] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'consumption', dir: 'desc' });
  const rows = useMemo(() => {
    const list = (q.data?.rows ?? []).filter((r: any) => (!status || r.status.label === status) && (!billing || r.budget?.billingType === billing)
      && (!search || `${r.project.key} ${r.project.name} ${r.project.ownerName ?? ''} ${r.project.customerName ?? ''}`.toLowerCase().includes(search.toLowerCase())));
    const get = SORTERS[sort.key];
    return [...list].sort((a, b) => {
      const x = get(a), y = get(b);
      if (x === null && y === null) return 0; if (x === null) return 1; if (y === null) return -1;
      const c = x < y ? -1 : x > y ? 1 : 0;
      return sort.dir === 'asc' ? c : -c;
    });
  }, [q.data, search, status, billing, sort]);
  const [exporting, setExporting] = useState<'csv' | 'pdf' | null>(null);
  const exp = (format: 'csv' | 'pdf') => {
    setExporting(format);
    downloadExport(api, { format, report: 'profitability', params: { ...(status && { status }), ...(billing && { billingType: billing }) } }, toast)
      .catch((e: any) => toast({ tone: 'critical', text: e.message })).finally(() => setExporting(null));
  };

  const header = <PageHeader title="Profitability" subtitle={`Project budgets, burn${q.data?.access === 'hours' ? '' : ' and margin'} from confirmed time on each project's tasks.`}
    actions={q.data && <>{(['csv', 'pdf'] as const).map((f) => <Button key={f} icon={<FileDown className="size-4" />} aria-label={`Export ${f.toUpperCase()}`} title={status || billing ? 'Exports projects matching the status and billing filters' : undefined}
      loading={exporting === f} disabled={!!exporting} onClick={() => exp(f)}>{f.toUpperCase()}</Button>)}</>} />;
  if (q.isLoading) return <div>{header}<Skeleton className="mb-4 h-24" /><Skeleton className="h-72" /></div>;
  if ((q.error as any)?.status === 403) return <div>{header}<Card><Empty icon={<Wallet className="size-5" />} title="Budgets are not shared with you">Budgets are visible to cost viewers, leadership and project owners.</Empty></Card></div>;
  if (q.error) return <div>{header}<ErrorState error={q.error} onRetry={() => q.refetch()} /></div>;
  const d = q.data, money = d.access === 'money';
  const sortBtn = (key: SortKey, label: string) => {
    const active = sort.key === key;
    const Icon = !active ? ArrowUpDown : sort.dir === 'asc' ? ArrowUp : ArrowDown;
    return <button type="button" onClick={() => setSort({ key, dir: active && sort.dir === 'desc' ? 'asc' : 'desc' })}
      className="inline-flex items-center gap-1 rounded font-medium hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent">{label}<Icon className="size-3" aria-hidden /></button>;
  };
  const ariaSort = (key: SortKey) => (sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined);
  const counts: Record<string, number> = {};
  for (const r of d.rows) counts[r.status.label] = (counts[r.status.label] ?? 0) + 1;

  return (
    <div className="min-w-0">
      {header}
      <div className="mb-4"><Callout tone={money ? 'info' : 'neutral'}>{d.note}</Callout></div>
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Projects with a budget" value={`${d.totals.budgeted} / ${d.rows.length}`} />
        <Stat label="Confirmed hours" value={fmtHours(d.totals.hoursToDate)} sub={d.totals.budgetHours ? `of ${fmtHours(d.totals.budgetHours)} budgeted (budgeted projects)` : undefined} />
        <Stat label="At risk or over" value={(counts.at_risk ?? 0) + (counts.over_budget ?? 0)} tone={(counts.over_budget ?? 0) > 0 ? 'critical' : undefined} sub={`${counts.watch ?? 0} to watch`} />
        {money && <Stat label="Unpriced hours" value={fmtHours(d.totals.byCurrency.reduce((s: number, t: any) => s + t.unpricedHours, 0))} hint="Hours by people without a cost rate in the budget currency. Excluded from cost, never priced at zero." />}
      </div>
      {money && d.totals.byCurrency.length > 0 && (
        <Card title="Totals per currency" subtitle="Currencies are never added together. Cost covers every project in the currency; revenue and margin only projects with revenue and a measurable cost." className="mb-4" padded={false}>
          <ul className="divide-y divide-line sm:hidden" aria-label="Totals per currency">{d.totals.byCurrency.map((t: any) => (
            <li key={t.currency} className="p-4 text-[13px]">
              <p className="mb-2 font-semibold">{t.currency} <span className="font-normal text-ink-3">· {t.projects} project{t.projects === 1 ? '' : 's'}</span></p>
              <dl className="grid grid-cols-2 gap-2 text-[12px]">
                {([['Budget', fmtMoney(t.budgetAmount, t.currency)], ['Cost to date', fmtMoney(t.costToDate, t.currency)], ['Revenue', fmtMoney(t.revenue, t.currency)],
                  ['Margin', `${fmtMoney(t.margin, t.currency)} (${pct(t.marginPct)})`], ['Unpriced', fmtHours(t.unpricedHours)]] as const).map(([k, v]) => (
                  <div key={k}><dt className="text-ink-3">{k}</dt><dd className={cx('font-medium tabular-nums', k === 'Margin' && t.margin < 0 && 'text-critical-ink')}>{v}</dd></div>))}
              </dl>
            </li>))}</ul>
          <div className="hidden overflow-x-auto sm:block">
            <table className="w-full min-w-[560px] text-[13px]">
              <thead className="text-left text-[12px] text-ink-3"><tr className="border-b border-line">
                {['Currency', 'Projects', 'Budget', 'Cost to date', 'Revenue', 'Margin', 'Unpriced'].map((h) => <th key={h} scope="col" className="px-4 py-2 font-medium">{h}</th>)}</tr></thead>
              <tbody>{d.totals.byCurrency.map((t: any) => (
                <tr key={t.currency} className="border-b border-line last:border-0 tabular-nums">
                  <th scope="row" className="px-4 py-2 text-left font-semibold">{t.currency}</th><td className="px-4 py-2">{t.projects}</td>
                  <td className="px-4 py-2">{fmtMoney(t.budgetAmount, t.currency)}</td><td className="px-4 py-2">{fmtMoney(t.costToDate, t.currency)}</td>
                  <td className="px-4 py-2">{fmtMoney(t.revenue, t.currency)}</td>
                  <td className={cx('px-4 py-2', t.margin < 0 && 'text-critical-ink')}>{fmtMoney(t.margin, t.currency)} <span className="text-ink-3">({pct(t.marginPct)})</span></td>
                  <td className="px-4 py-2">{fmtHours(t.unpricedHours)}</td>
                </tr>))}</tbody>
            </table>
          </div>
        </Card>)}
      <Card padded={false}>
        <div className="flex flex-wrap items-end gap-2 border-b border-line p-3">
          <Input aria-label="Search projects" placeholder="Search projects" className="h-8 w-full sm:w-56" value={search} onChange={(e) => setSearch(e.target.value)} />
          <Select aria-label="Filter by budget status" className="h-8 w-[calc(50%-4px)] sm:w-40" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>{Object.entries(BUDGET_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}{counts[k] ? ` (${counts[k]})` : ''}</option>)}</Select>
          <Select aria-label="Filter by billing type" className="h-8 w-[calc(50%-4px)] sm:w-40" value={billing} onChange={(e) => setBilling(e.target.value)}>
            <option value="">All billing</option>{Object.entries(BILLING_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
          <Select aria-label="Sort projects" className="h-8 w-full sm:hidden" value={`${sort.key}:${sort.dir}`} onChange={(e) => { const [key, dir] = e.target.value.split(':'); setSort({ key: key as SortKey, dir: dir as 'asc' | 'desc' }); }}>
            <option value="consumption:desc">Most consumed first</option><option value="consumption:asc">Least consumed first</option>
            {money && <option value="margin:asc">Lowest margin first</option>}{money && <option value="margin:desc">Highest margin first</option>}
            <option value="hours:desc">Most hours first</option><option value="name:asc">Name A–Z</option></Select>
          <div className="w-full sm:ml-auto sm:w-auto"><BarLegend /></div>
        </div>
        {rows.length === 0 ? <Empty icon={<Wallet className="size-5" />} title={d.rows.length ? 'No projects match these filters' : 'No projects yet'}>
          {d.rows.length ? <Button size="sm" onClick={() => { setSearch(''); setStatus(''); setBilling(''); }}>Clear filters</Button> : 'Create a project, then set its budget from the project page.'}</Empty> : (
          <>
          <ul className="divide-y divide-line sm:hidden" aria-label="Project budgets">{rows.map((r: any) => <MobileRow key={r.project.id} r={r} />)}</ul>
          <div className="hidden overflow-x-auto sm:block">
            <table className="w-full min-w-[720px] text-[13px]">
              <caption className="sr-only">Project budgets{money ? ', money and hours' : ', hours only'}. Sorted by {sort.key} {sort.dir === 'asc' ? 'ascending' : 'descending'}.</caption>
              <thead className="text-left text-[12px] text-ink-3"><tr className="border-b border-line">
                <th scope="col" aria-sort={ariaSort('name')} className="px-4 py-2">{sortBtn('name', 'Project')}</th>
                <th scope="col" aria-sort={ariaSort('consumption')} className="px-3 py-2">{sortBtn('consumption', 'Status')}</th>
                <th scope="col" aria-sort={ariaSort('hours')} className="px-3 py-2">{sortBtn('hours', 'Hours used')}</th>
                {money && <th scope="col" className="px-3 py-2 font-medium">Budget used</th>}
                {money && <th scope="col" className="px-3 py-2 text-right font-medium">Cost</th>}
                {money && <th scope="col" aria-sort={ariaSort('margin')} className="px-3 py-2 text-right">{sortBtn('margin', 'Margin')}</th>}
                <th scope="col" className="px-4 py-2 text-right font-medium">Forecast</th>
              </tr></thead>
              <tbody>{rows.map((r: any) => {
                const m = r.money, h = r.hours, cur = m?.currency;
                return (
                  <tr key={r.project.id} className="border-b border-line align-top last:border-0">
                    <th scope="row" className="px-4 py-2.5 text-left font-normal">
                      <Link to={`/projects/${r.project.id}`} className="rounded font-medium text-ink hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                        <Badge tone="info" className="mr-1.5">{r.project.key}</Badge>{r.project.name}</Link>
                      <div className="mt-0.5 text-[12px] text-ink-3">{r.budget ? BILLING_LABEL[r.budget.billingType] : 'No budget'}{r.project.ownerName && ` · ${r.project.ownerName}`}{r.project.customerName && ` · ${r.project.customerName}`}</div>
                    </th>
                    <td className="px-3 py-2.5"><BudgetStatus label={r.status.label} />{r.status.forecastOver && <div className="mt-1 text-[12px] text-serious-ink">Forecast over</div>}</td>
                    <td className="px-3 py-2.5">
                      <div className="mb-1 text-[12px] tabular-nums text-ink-2">{fmtHours(h.toDate)}{h.budget !== null && ` / ${fmtHours(h.budget)}`}</div>
                      {h.budget !== null ? <BurnBar label={`${r.project.key} hours`} value={h.consumption} forecast={h.forecastConsumption} thresholds={r.budget?.alertThresholds} detail={`${fmtHours(h.toDate)} of ${fmtHours(h.budget)}.`} />
                        : <span className="text-[12px] text-ink-3">{fmtHours(h.burnPerWeek)}/wk burn</span>}
                    </td>
                    {money && <td className="px-3 py-2.5">
                      {m.budgetAmount !== null ? <>
                        <div className="mb-1 text-[12px] tabular-nums text-ink-2">{pct(m.consumption)} of {fmtMoney(m.budgetAmount, cur, true)}{m.consumptionBasis === 'billable_value' && ' cap'}</div>
                        <BurnBar label={`${r.project.key} budget amount`} value={m.consumption} forecast={m.forecastConsumption} thresholds={r.budget?.alertThresholds}
                          detail={`${fmtMoney(m.consumptionBasis === 'billable_value' ? m.revenue : m.costToDate, cur)} of ${fmtMoney(m.budgetAmount, cur)}.`} /></>
                        : <span className="text-[12px] text-ink-3">No amount</span>}
                    </td>}
                    {money && <td className="px-3 py-2.5 text-right tabular-nums">{fmtMoney(m.costToDate, cur)}
                      {m.unpricedHours > 0 && <div className="text-[12px] text-warning-ink">+{fmtHours(m.unpricedHours)} unpriced</div>}</td>}
                    {money && <td className={cx('px-3 py-2.5 text-right tabular-nums', m.margin !== null && m.margin < 0 && 'text-critical-ink')}>
                      {m.margin === null ? <span className="text-ink-3">{r.budget?.billingType === 'internal' ? 'Internal' : '—'}</span> : <>{fmtMoney(m.margin, cur)}<div className="text-[12px] text-ink-3">{pct(m.marginPct)} of {fmtMoney(m.revenue, cur, true)}</div></>}
                    </td>}
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {money ? fmtMoney(m.consumptionBasis === 'billable_value' ? m.forecastRevenue : m.forecastCost, cur) : fmtHours(h.forecastAtCompletion)}
                      <div className="text-[12px] text-ink-3">{money ? `${fmtHours(h.forecastAtCompletion)} · ` : ''}{coverageText(r.estimates.coverage)}</div>
                    </td>
                  </tr>);
              })}</tbody>
            </table>
          </div></>)}
      </Card>
      <p className="mt-3 text-[12px] text-ink-3">Hours are recorded work evidence on project tasks, not a productivity measure. Open each project for the facts and assumptions behind its figures.</p>
    </div>
  );
}

const coverageText = (c: number | null) => (c === null ? 'no open tasks' : `${pct(c)} estimated`);

function MobileRow({ r }: { r: any }) {
  const m = r.money, h = r.hours, cur = m?.currency;
  return (
    <li className="space-y-2 p-4 text-[13px]">
      <div className="flex items-start justify-between gap-2">
        <Link to={`/projects/${r.project.id}`} className="min-w-0 rounded font-medium text-ink hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-accent">
          <Badge tone="info" className="mr-1.5">{r.project.key}</Badge>{r.project.name}</Link>
        <BudgetStatus label={r.status.label} className="shrink-0" />
      </div>
      <div className="text-[12px] text-ink-3">{r.budget ? BILLING_LABEL[r.budget.billingType] : 'No budget'}{r.project.ownerName && ` · ${r.project.ownerName}`}{r.status.forecastOver && <span className="text-serious-ink"> · Forecast over</span>}</div>
      {h.budget === null && <div className="flex justify-between text-[12px] text-ink-2"><span>Hours</span><span className="tabular-nums">{fmtHours(h.toDate)} · {fmtHours(h.burnPerWeek)}/wk burn</span></div>}
      {h.budget !== null && <div><div className="mb-1 flex justify-between text-[12px] text-ink-2"><span>Hours</span><span className="tabular-nums">{fmtHours(h.toDate)} / {fmtHours(h.budget)}</span></div>
        <BurnBar label={`${r.project.key} hours`} value={h.consumption} forecast={h.forecastConsumption} thresholds={r.budget?.alertThresholds} detail={`${fmtHours(h.toDate)} of ${fmtHours(h.budget)}.`} /></div>}
      {m?.budgetAmount != null && <div><div className="mb-1 flex justify-between text-[12px] text-ink-2"><span>{m.consumptionBasis === 'billable_value' ? 'Billable vs cap' : 'Cost vs budget'}</span><span className="tabular-nums">{pct(m.consumption)} of {fmtMoney(m.budgetAmount, cur, true)}</span></div>
        <BurnBar label={`${r.project.key} budget amount`} value={m.consumption} forecast={m.forecastConsumption} thresholds={r.budget?.alertThresholds} detail={`${fmtMoney(m.consumptionBasis === 'billable_value' ? m.revenue : m.costToDate, cur)} of ${fmtMoney(m.budgetAmount, cur)}.`} /></div>}
      <dl className="grid grid-cols-3 gap-2 text-[12px]">
        {m ? <><div><dt className="text-ink-3">Cost</dt><dd className="font-medium tabular-nums">{fmtMoney(m.costToDate, cur, true)}</dd></div>
          <div><dt className="text-ink-3">Margin</dt><dd className={cx('font-medium tabular-nums', m.margin !== null && m.margin < 0 && 'text-critical-ink')}>{m.margin === null ? (r.budget?.billingType === 'internal' ? 'Internal' : '—') : `${fmtMoney(m.margin, cur, true)} (${pct(m.marginPct)})`}</dd></div>
          <div><dt className="text-ink-3">Forecast</dt><dd className="font-medium tabular-nums">{fmtMoney(m.consumptionBasis === 'billable_value' ? m.forecastRevenue : m.forecastCost, cur, true)}</dd></div></>
          : <><div><dt className="text-ink-3">Hours</dt><dd className="font-medium tabular-nums">{fmtHours(h.toDate)}</dd></div>
          <div><dt className="text-ink-3">Burn</dt><dd className="font-medium tabular-nums">{fmtHours(h.burnPerWeek)}/wk</dd></div>
          <div><dt className="text-ink-3">Forecast</dt><dd className="font-medium tabular-nums">{fmtHours(h.forecastAtCompletion)}</dd></div></>}
      </dl>
      {m?.unpricedHours > 0 && <p className="text-[12px] text-warning-ink">+{fmtHours(m.unpricedHours)} unpriced (excluded from cost)</p>}
    </li>
  );
}
