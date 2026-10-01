import { useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, BarChart3, CalendarRange, CheckCircle2, FileSpreadsheet, Info, Lightbulb, Loader2, ShieldCheck, Table2, Users } from 'lucide-react';
import { api, qs } from '../../lib/api';
import { CATEGORY_LABEL, addDays, fmtDate, hm } from '../../lib/format';
import { useMe } from '../../lib/session';
import { Badge, Button, Callout, Card, Empty, ErrorState, Input, PageHeader, Segmented, Select, Skeleton, Stat, cx, useToast } from '../../components/ui';
import { AllocationBar } from '../../components/time';
import { BarList, Histogram, TrendChart, type Point, type Series } from '../../components/ext/OrgdashCharts';
import { downloadExport } from '../util';

type R = { value: number | null; status: 'ok' | 'not_applicable' | 'no_data'; num: number; den: number };
const fr = (r: R | undefined) => (!r ? '—' : r.status === 'not_applicable' ? 'N/A' : r.value === null ? '—' : `${Math.round(r.value * 100)}%`);
const fp = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`);
const dur = (h: number | null) => (h === null ? '—' : h < 24 ? `${Math.round(h * 10) / 10}h` : `${Math.round((h / 24) * 10) / 10}d`);
const fx = (v: number | null) => (v === null ? '—' : `${v.toFixed(2)}x`);
const cnt = (v: number | null) => (v === null ? '—' : String(Math.round(v)));
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
const ONE: Series[] = [{ key: 'v', label: 'Value', color: 'var(--c-task)' }]; // single series: the chart title names it
const SEV = {
  attention: { label: 'Needs attention', tone: 'warning' as const, Icon: AlertTriangle },
  info: { label: 'Note', tone: 'info' as const, Icon: Info },
  positive: { label: 'Improving', tone: 'good' as const, Icon: CheckCircle2 },
};

export default function Insights() {
  const me = useMe(); const toast = useToast();
  const [sp, setSp] = useSearchParams();
  const f = { period: sp.get('period') ?? '4', start: sp.get('start') ?? '', end: sp.get('end') ?? '', scope: sp.get('scope') ?? '',
    departmentId: sp.get('departmentId') ?? '', teamId: sp.get('teamId') ?? '', projectId: sp.get('projectId') ?? '' };
  const set = (o: Record<string, string>) => { const n = new URLSearchParams(sp); for (const [k, v] of Object.entries(o)) v ? n.set(k, v) : n.delete(k); setSp(n, { replace: true }); };
  const custom = f.period === 'custom';
  // Validate a custom range here so a typo shows inline guidance instead of a failed request with a pointless Retry.
  const badRange = custom && (!f.start || !f.end || f.start > f.end || f.end > me.today);
  const hasFilters = !!(f.departmentId || f.teamId || f.projectId);
  const clearFilters = () => set({ departmentId: '', teamId: '', projectId: '' });
  const params ={ weeks: custom ? undefined : Number(f.period), start: custom ? f.start || undefined : undefined, end: custom ? f.end || undefined : undefined,
    scope: f.scope || undefined, departmentId: f.departmentId || undefined, teamId: f.teamId || undefined, projectId: f.projectId || undefined };
  const opts = useQuery({ queryKey: ['insights-options'], queryFn: () => api.get('/api/insights/options'), retry: false });
  const q = useQuery({ queryKey: ['insights', params], queryFn: () => api.get(`/api/insights${qs(params)}`), retry: false, enabled: !badRange, placeholderData: (prev) => prev });
  const o = opts.data; const d = q.data;
  const scope = f.scope || o?.defaultScope;
  const teams = (o?.teams ?? []).filter((t: any) => scope !== 'team' || t.managed_by_me);
  const exportCsv = () => downloadExport(api, { format: 'csv', report: 'insights', params: Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined)) }, toast)
    .catch((e) => toast({ tone: 'critical', text: e.message }));
  const eyebrow = !d ? 'Insights' : d.scope.mode === 'team' ? 'Team manager · your teams' : d.scope.perPerson ? 'Main administrator · company-wide' : 'Leadership · company aggregates';

  if (opts.error) return <div><PageHeader title="Insights" /><ErrorState error={opts.error} onRetry={() => opts.refetch()} /></div>;
  return (
    <div>
      <PageHeader eyebrow={eyebrow} title="Insights"
        subtitle="Team and organization patterns from recorded work evidence."
        actions={<Button icon={<FileSpreadsheet className="size-4" />} disabled={!d || badRange || !!d.suppressed || !d.totals} onClick={exportCsv}>Export CSV</Button>} />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Segmented label="Period" value={f.period as any} onChange={(v) => set(v === 'custom' ? { period: v, start: f.start || addDays(me.today, -27), end: f.end || me.today } : { period: v, start: '', end: '' })}
          options={[{ value: '4', label: '4 weeks' }, { value: '8', label: '8 weeks' }, { value: '12', label: '12 weeks' }, { value: 'custom', label: 'Custom' }]} />
        {custom && <div className="flex items-center gap-1">
          <Input aria-label="Start date" type="date" className="h-8 w-[150px]" max={me.today} value={f.start} aria-invalid={badRange || undefined} aria-describedby={badRange ? 'insights-range-error' : undefined} onChange={(e) => set({ start: e.target.value })} />
          <span className="text-ink-3" aria-hidden>–</span>
          <Input aria-label="End date" type="date" className="h-8 w-[150px]" max={me.today} value={f.end} aria-invalid={badRange || undefined} aria-describedby={badRange ? 'insights-range-error' : undefined} onChange={(e) => set({ end: e.target.value })} />
        </div>}
        {o && o.scopes.length > 1 && <Segmented label="Scope" value={scope} onChange={(v) => set({ scope: v, teamId: '' })}
          options={o.scopes.map((s: string) => ({ value: s, label: s === 'company' ? 'Company' : 'My teams' }))} />}
        <Select aria-label="Department" className="h-8 w-full sm:w-44" value={f.departmentId} onChange={(e) => set({ departmentId: e.target.value })}>
          <option value="">All departments</option>{(o?.departments ?? []).map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>
        <Select aria-label="Team" className="h-8 w-full sm:w-44" value={f.teamId} onChange={(e) => set({ teamId: e.target.value })}>
          <option value="">{scope === 'team' ? 'All my teams' : 'All teams'}</option>{teams.map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>
        <Select aria-label="Project" className="h-8 w-full sm:w-48" value={f.projectId} onChange={(e) => set({ projectId: e.target.value })}>
          <option value="">All projects</option>{(o?.projects ?? []).map((x: any) => <option key={x.id} value={x.id}>{x.key} · {x.name}</option>)}</Select>
        {hasFilters && <Button size="sm" variant="ghost" onClick={clearFilters}>Clear filters</Button>}
        {q.isFetching && !q.isLoading && <span className="flex items-center gap-1.5 text-[12px] text-ink-3" role="status"><Loader2 className="size-3.5 animate-spin" aria-hidden />Updating</span>}
      </div>
      {badRange ? <Card><Empty icon={<CalendarRange className="size-6" />} title="Choose a valid date range">
          <span id="insights-range-error" role="alert">Pick both dates, with the start on or before the end, and the end no later than today ({fmtDate(me.today)}).</span></Empty></Card>
        : q.isLoading ? <div className="space-y-4" role="status"><span className="sr-only">Loading insights…</span><div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-24" />)}</div><Skeleton className="h-72" /></div>
        : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} />
        : d.suppressed ? <Card><Empty icon={<ShieldCheck className="size-6" />} title="Withheld to protect individuals"
            action={hasFilters ? <Button size="sm" onClick={clearFilters}>Clear filters</Button> : undefined}>{d.suppressed}</Empty></Card>
        : !d.totals ? <Card><Empty icon={<Users className="size-6" />} title="No one in this selection"
            action={hasFilters ? <Button size="sm" onClick={clearFilters}>Clear filters</Button> : undefined}>Change the department, team or project filter to include people you can view.</Empty></Card>
        : <Dashboard d={d} />}
    </div>
  );
}

function Dashboard({ d }: { d: any }) {
  const c = d.totals.current, p = d.totals.previous, def = d.definitions;
  const ptsDelta = (k: string, a: R, b: R) => {
    if (a.value === null || b.value === null) return undefined;
    const v = a.value - b.value, dir = def[k].direction;
    if (Math.abs(v) < 0.005) return { text: 'no change vs prev.', good: null };
    return { text: `${v > 0 ? '+' : '−'}${Math.round(Math.abs(v) * 100)} pts vs prev.`, good: dir === 'neutral' ? null : (v > 0) === (dir === 'up') };
  };
  const numDelta = (a: number | null, b: number | null, fmt: (v: number) => string = String) =>
    a === null || b === null ? undefined : { text: a === b ? 'no change vs prev.' : `${a > b ? '+' : '−'}${fmt(Math.abs(a - b))} vs prev.`, good: null };
  const naSub = (r: R, sub: ReactNode) => (r.status === 'not_applicable' ? 'No scheduled working time' : r.status === 'no_data' ? 'No qualifying records' : sub);
  const period = `${fmtDate(d.period.start, { day: 'numeric', month: 'short', year: 'numeric' })} – ${fmtDate(d.period.end, { day: 'numeric', month: 'short', year: 'numeric' })}`;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-ink-2">
        <span>{period}</span><span aria-hidden>·</span><span>{d.scope.people} {d.scope.people === 1 ? 'person' : 'people'} in scope</span><span aria-hidden>·</span>
        <span>compared with {fmtDate(d.period.previous.start)} – {fmtDate(d.period.previous.end)}</span>
      </div>
      <Callout tone="neutral">{d.scope.notes.join(' ')} Today is excluded from day-based ratios until its recap is due; unknown time is never treated as idle.</Callout>

      <section aria-label="Key indicators" className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Recap adoption" value={fr(c.recapAdoption)} sub={naSub(c.recapAdoption, `${c.recapAdoption.num}/${c.recapAdoption.den} person-days`)} delta={ptsDelta('recapAdoption', c.recapAdoption, p.recapAdoption)} hint={def.recapAdoption.definition} />
        <Stat label="Logging coverage" value={fr(c.loggingCoverage)} sub={naSub(c.loggingCoverage, `${hm(c.loggingCoverage.unknownMinutes)} unknown, not idle`)} delta={ptsDelta('loggingCoverage', c.loggingCoverage, p.loggingCoverage)} hint={def.loggingCoverage.definition} />
        <Stat label="Planned completion" value={fr(c.plannedCompletion)} sub={naSub(c.plannedCompletion, `${c.plannedCompletion.num}/${c.plannedCompletion.den} intended outcomes`)} delta={ptsDelta('plannedCompletion', c.plannedCompletion, p.plannedCompletion)} hint={def.plannedCompletion.definition} />
        <Stat label="Accepted outcomes" value={c.acceptedOutcomes} sub="tasks reaching Done" delta={numDelta(c.acceptedOutcomes, p.acceptedOutcomes)} hint={def.acceptedOutcomes.definition} />
        <Stat label="Deadline reliability" value={fr(c.deadlineReliability)} sub={`${c.deadlineReliability.met} met · ${c.deadlineReliability.late} late · ${c.deadlineReliability.overdue} overdue`} delta={ptsDelta('deadlineReliability', c.deadlineReliability, p.deadlineReliability)} hint={def.deadlineReliability.definition} />
        <Stat label="Active blockers" value={c.blockers.active} sub={`median age ${dur(c.blockers.medianAgeHours)} · ${c.blockers.openAtEnd} open`} delta={numDelta(c.blockers.active, p.blockers.active)} hint={def.blockers.definition} />
        <Stat label="Cycle time (median)" value={dur(c.cycleTime.medianHours)} sub={`p75 ${dur(c.cycleTime.p75Hours)} · ${c.cycleTime.n}/${c.cycleTime.accepted} with a start`} delta={numDelta(c.cycleTime.medianHours, p.cycleTime.medianHours, (v) => dur(v))} hint={def.cycleTime.definition} />
        <Stat label="Rework rate" value={fr(c.reworkRate)} sub={naSub(c.reworkRate, `${c.reworkRate.num}/${c.reworkRate.den} accepted outcomes`)} delta={ptsDelta('reworkRate', c.reworkRate, p.reworkRate)} hint={def.reworkRate.definition} />
        <Stat label="Work in progress" value={cnt(c.wip.value)} sub={`${c.wip.blocked} blocked · ${c.wip.inReview} in review`} delta={numDelta(c.wip.value, p.wip.value)} hint={def.wip.definition} />
        <Stat label="Meeting load" value={fr(c.meetingShare)} sub={naSub(c.meetingShare, `${hm(c.meetingShare.num)} of available time`)} delta={ptsDelta('meetingShare', c.meetingShare, p.meetingShare)} hint={def.meetingShare.definition} />
        <Stat label="Uninterrupted task time" value={fr(c.focusShare)} sub={naSub(c.focusShare, `${hm(c.focusShare.num)} in unbroken 60m+ stretches`)} delta={ptsDelta('focusShare', c.focusShare, p.focusShare)} hint={def.focusShare.definition} />
        <Stat label="Estimate accuracy" value={fx(c.estimateAccuracy.value)} sub={`${c.estimateAccuracy.n}/${c.estimateAccuracy.accepted} accepted qualify`} delta={numDelta(c.estimateAccuracy.value, p.estimateAccuracy.value, (v) => fx(v))} hint={def.estimateAccuracy.definition} />
      </section>

      <div className="grid items-start gap-4 lg:grid-cols-3">
        <Observations items={d.observations} />
        <Card title="Where scheduled time went" subtitle="Confirmed, non-overlapping time inside schedules. Hatched = unknown (not recorded), not idle.">
          <AllocationBar byCategory={d.timeComposition.byCategory} unknown={d.timeComposition.unknownMinutes} available={d.timeComposition.availableMinutes} height={14} />
          {d.timeComposition.availableMinutes > 0 && <p className="mt-3 text-[13px] text-ink-2">{hm(d.timeComposition.focusMinutes)} of task time came in unbroken stretches of 60 minutes or more ({fr(c.focusShare)} of available time).</p>}
        </Card>
      </div>

      <Trends d={d} />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Blockers by cause" subtitle="Blockers active during the period. Raising blockers early is healthy; age shows how long work waited.">
          {d.blockersByCause.length === 0 ? <p className="text-[13px] text-ink-3">No blockers recorded in this period.</p>
            : <BarList label="Active blockers by cause" items={d.blockersByCause.map((b: any) => ({ key: b.cause, label: cap(b.cause), value: b.active,
              detail: `${b.raised} raised in period · ${b.openAtEnd} still open · median age ${dur(b.medianAgeHours)}` }))} />}
        </Card>
        <Card title="Cycle time" subtitle={`Start to acceptance for ${d.cycleTime.withStart} of ${d.cycleTime.accepted} accepted outcomes${d.cycleTime.withStart < d.cycleTime.accepted ? ' (the rest were never marked In Progress)' : ''}.`}>
          {d.cycleTime.withStart === 0 ? <p className="text-[13px] text-ink-3">No accepted outcomes with a recorded start in this period.</p> : <>
            <Histogram label="Accepted outcomes by cycle time" items={d.cycleTime.distribution} />
            <ScrollX label="Cycle time by category" className="mt-4"><table className="w-full min-w-[300px] text-[13px] tabular">
              <caption className="sr-only">Cycle time by category</caption>
              <thead className="text-left text-[12px] text-ink-3"><tr><th className="py-1 font-medium">Category</th><th className="py-1 text-right font-medium">Accepted</th><th className="py-1 text-right font-medium">With start</th><th className="py-1 text-right font-medium">Median</th><th className="py-1 text-right font-medium"><abbr title="75th percentile" className="no-underline">p75</abbr></th></tr></thead>
              <tbody className="divide-y divide-line">{d.cycleTime.byCategory.map((x: any) => <tr key={x.category}><td className="py-1.5">{CATEGORY_LABEL[x.category] ?? x.category}</td>
                <td className="text-right">{x.accepted}</td><td className="text-right">{x.n}</td><td className="text-right">{dur(x.medianHours)}</td><td className="text-right">{dur(x.p75Hours)}</td></tr>)}</tbody>
            </table></ScrollX></>}
        </Card>
      </div>

      <Groups d={d} />
      <Workload d={d} />

      <details className="rounded-xl bg-surface p-4 ring-1 ring-line">
        <summary className="cursor-pointer text-[13px] font-semibold">Metric definitions ({d.version})</summary>
        <dl className="mt-3 grid gap-3 text-[13px] sm:grid-cols-2">{Object.entries(def).map(([k, v]: any) => (
          <div key={k}><dt className="font-medium">{v.label}</dt><dd className="text-ink-2">{v.definition}</dd></div>))}</dl>
        <p className="mt-3 text-[12px] text-ink-3">Days are bucketed in the organization time zone ({d.timezone}). N/A means there was no scheduled working time, so a ratio would be meaningless; a dash means no qualifying records.</p>
      </details>
    </div>
  );
}

function Observations({ items }: { items: any[] }) {
  return (
    <Card className="lg:col-span-2" title={<span className="flex items-center gap-2"><Lightbulb className="size-4 text-accent" aria-hidden />Observations</span>}
      subtitle="Rule-based, with the facts behind each one. Use them to start a conversation, not to judge individuals.">
      {items.length === 0 ? <p className="text-[13px] text-ink-3">No notable changes. Observations appear when a metric moves 15 points or more between complete weeks, or crosses a documented threshold.</p>
        : <ul className="divide-y divide-line">{items.map((o) => { const s = SEV[o.severity as keyof typeof SEV]; return (
          <li key={o.id} className="py-3 first:pt-0 last:pb-0">
            <div className="flex flex-wrap items-start gap-2"><Badge tone={s.tone} icon={<s.Icon className="size-3.5" aria-hidden />}>{s.label}</Badge><p className="min-w-0 flex-1 text-[14px] font-medium">{o.title}</p></div>
            <ul className="mt-1.5 space-y-0.5 text-[13px] text-ink-2">{o.facts.map((x: string) => <li key={x}>• {x}</li>)}</ul>
            {o.assumptions.length > 0 && <p className="mt-1 text-[12px] text-ink-3">Assumptions: {o.assumptions.join(' ')}</p>}
          </li>); })}</ul>}
    </Card>
  );
}

function Trends({ d }: { d: any }) {
  const [table, setTable] = useState(false);
  const def = d.definitions;
  const label = (w: any) => fmtDate(w.weekOf, { day: 'numeric', month: 'short' });
  const mk = (val: (m: any) => (number | null)[], na: (m: any) => boolean = () => false, lines?: (m: any) => string[]): Point[] =>
    d.weeks.map((w: any) => ({ label: label(w), partial: w.partial, na: na(w.metrics), values: val(w.metrics), lines: lines?.(w.metrics) }));
  const ratioPts = (k: string, lines?: (m: any) => string[]) => mk((m) => [m[k].value], (m) => m[k].status === 'not_applicable', lines);
  const c = d.totals.current;
  const pctF = (v: number | null) => fp(v);
  const charts = [
    <TrendChart key="recap" title="Recap adoption" hint={def.recapAdoption.definition} headline={fr(c.recapAdoption)} series={ONE} kind="line" max={1} format={pctF}
      points={ratioPts('recapAdoption', (m) => [`${m.recapAdoption.num} of ${m.recapAdoption.den} person-days`])} />,
    <TrendChart key="cov" title="Logging coverage" hint={def.loggingCoverage.definition} headline={fr(c.loggingCoverage)} sub="Record completeness, not productivity" series={ONE} kind="line" max={1} format={pctF}
      points={ratioPts('loggingCoverage', (m) => [`${hm(m.loggingCoverage.unknownMinutes)} unknown`])} />,
    <TrendChart key="plan" title="Planned completion" hint={def.plannedCompletion.definition} headline={fr(c.plannedCompletion)} series={ONE} kind="line" max={1} format={pctF}
      points={ratioPts('plannedCompletion', (m) => [`${m.plannedCompletion.num} of ${m.plannedCompletion.den} intended outcomes`])} />,
    <TrendChart key="acc" title="Accepted outcomes" hint={def.acceptedOutcomes.definition} headline={c.acceptedOutcomes} series={ONE} kind="bar" format={cnt}
      points={mk((m) => [m.acceptedOutcomes])} />,
    <TrendChart key="dl" title="Deadlines by due week" hint={def.deadlineReliability.definition} headline={fr(c.deadlineReliability)} sub="Reliability for the period" kind="stack" format={cnt}
      series={[{ key: 'met', label: 'Met', color: 'var(--good)' }, { key: 'late', label: 'Late', color: 'var(--warning)' }, { key: 'over', label: 'Overdue', color: 'var(--critical)' }]}
      points={mk((m) => [m.deadlineReliability.met, m.deadlineReliability.late, m.deadlineReliability.overdue], () => false, (m) => [`Reliability ${fr(m.deadlineReliability)}`])} />,
    <TrendChart key="bl" title="Blockers raised" hint={def.blockers.definition} headline={c.blockers.raised} series={ONE} kind="bar" format={cnt}
      points={mk((m) => [m.blockers.raised], () => false, (m) => [`${m.blockers.active} active · median age ${dur(m.blockers.medianAgeHours)}`])} />,
    <TrendChart key="cyc" title="Cycle time (median)" hint={def.cycleTime.definition} headline={dur(c.cycleTime.medianHours)} series={ONE} kind="line" format={dur}
      points={mk((m) => [m.cycleTime.medianHours], () => false, (m) => [`p75 ${dur(m.cycleTime.p75Hours)} · ${m.cycleTime.n} outcomes`])} />,
    <TrendChart key="rw" title="Rework rate" hint={def.reworkRate.definition} headline={fr(c.reworkRate)} series={ONE} kind="line" max={1} format={pctF}
      points={ratioPts('reworkRate', (m) => [`${m.reworkRate.num} of ${m.reworkRate.den} accepted`])} />,
    <TrendChart key="wip" title="Work in progress (end of week)" hint={def.wip.definition} headline={cnt(c.wip.value)} kind="stack" format={cnt}
      series={[{ key: 'act', label: 'In progress', color: 'var(--c-task)' }, { key: 'rev', label: 'In review', color: 'var(--c-learning)' }, { key: 'blk', label: 'Blocked', color: 'var(--critical)' }]}
      points={mk((m) => [m.wip.value === null ? null : m.wip.value - m.wip.blocked - m.wip.inReview, m.wip.inReview, m.wip.blocked])} />,
    <TrendChart key="meet" title="Meeting load" hint={def.meetingShare.definition} headline={fr(c.meetingShare)} series={ONE} kind="line" max={1} format={pctF}
      points={ratioPts('meetingShare', (m) => [`${hm(m.meetingShare.num)} in meetings`])} />,
    <TrendChart key="focus" title="Uninterrupted task time" hint={def.focusShare.definition} headline={fr(c.focusShare)} series={ONE} kind="line" max={1} format={pctF}
      points={ratioPts('focusShare', (m) => [`${hm(m.focusShare.num)} in unbroken 60m+ stretches`])} />,
    <TrendChart key="est" title="Estimate accuracy" hint={def.estimateAccuracy.definition} headline={fx(c.estimateAccuracy.value)} sub="Confirmed time ÷ estimate (1.00x = as estimated)" series={ONE} kind="line" max={1.5} format={fx}
      points={mk((m) => [m.estimateAccuracy.value], () => false, (m) => [`${m.estimateAccuracy.n} of ${m.estimateAccuracy.accepted} accepted qualify`])} />,
  ];
  return (
    <Card title="Weekly trends" subtitle="One chart per metric, each on its own scale."
      actions={<Segmented label="Chart or table" value={table ? 't' : 'c'} onChange={(v) => setTable(v === 't')}
        options={[{ value: 'c', label: <span className="flex items-center gap-1"><BarChart3 className="size-3.5" aria-hidden />Chart</span> }, { value: 't', label: <span className="flex items-center gap-1"><Table2 className="size-3.5" aria-hidden />Table</span> }]} />}>
      {table ? <TrendTable d={d} /> : <>
        <p className="mb-3 text-[12px] text-ink-3">Hollow points and faded bars mark a partial week. Hover a chart, or focus it and use the arrow keys, to read each week.</p>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{charts}</div></>}
    </Card>
  );
}

function TrendTable({ d }: { d: any }) {
  const th = 'px-2 py-1.5 text-right font-medium whitespace-nowrap';
  return (
    <ScrollX label="Weekly metrics table">
      <table className="w-full min-w-[1100px] text-[12.5px] tabular">
        <caption className="sr-only">Weekly metrics. N/A means no scheduled working time; a dash means no qualifying records.</caption>
        <thead className="text-ink-3"><tr>
          <th className="py-1.5 pr-2 text-left font-medium">Week of</th><th className={th}>Working person-days</th><th className={th}>Recap adoption</th><th className={th}>Logging coverage</th><th className={th}>Unknown</th>
          <th className={th}>Planned completion</th><th className={th}>Accepted</th><th className={th}>Met / late / overdue</th><th className={th}>Reliability</th><th className={th}>Blockers raised</th>
          <th className={th}>Blocker age</th><th className={th}>Cycle median</th><th className={th}>Rework</th><th className={th}>WIP</th><th className={th}>Meetings</th><th className={th}>Uninterrupted</th><th className={th}>Estimate</th>
        </tr></thead>
        <tbody className="divide-y divide-line">{d.weeks.map((w: any) => { const m = w.metrics; return (
          <tr key={w.weekOf}>
            <th scope="row" className="py-1.5 pr-2 text-left font-normal whitespace-nowrap">{fmtDate(w.start)} – {fmtDate(w.end)}{w.partial && <span className="text-ink-3"> (partial)</span>}</th>
            <td className="px-2 text-right">{m.workingPersonDays}</td><td className="px-2 text-right">{fr(m.recapAdoption)}</td><td className="px-2 text-right">{fr(m.loggingCoverage)}</td>
            <td className="px-2 text-right">{m.loggingCoverage.status === 'not_applicable' ? 'N/A' : hm(m.loggingCoverage.unknownMinutes)}</td><td className="px-2 text-right">{fr(m.plannedCompletion)}</td>
            <td className="px-2 text-right">{m.acceptedOutcomes}</td><td className="px-2 text-right">{m.deadlineReliability.met} / {m.deadlineReliability.late} / {m.deadlineReliability.overdue}</td>
            <td className="px-2 text-right">{fr(m.deadlineReliability)}</td><td className="px-2 text-right">{m.blockers.raised}</td><td className="px-2 text-right">{dur(m.blockers.medianAgeHours)}</td>
            <td className="px-2 text-right">{dur(m.cycleTime.medianHours)}</td><td className="px-2 text-right">{fr(m.reworkRate)}</td><td className="px-2 text-right">{cnt(m.wip.value)}</td>
            <td className="px-2 text-right">{fr(m.meetingShare)}</td><td className="px-2 text-right">{fr(m.focusShare)}</td><td className="px-2 text-right">{fx(m.estimateAccuracy.value)}</td>
          </tr>); })}</tbody>
      </table>
    </ScrollX>
  );
}

function Groups({ d }: { d: any }) {
  if (d.groups.length < 2) return null;
  const th = 'px-3 py-2 text-right font-medium';
  return (
    <Card title="By department" subtitle={`Alphabetical. ${d.scope.perPerson ? '' : `Departments with fewer than ${d.scope.minGroup} people, and any that would let them be worked out from the total, are withheld.`}`} padded={false}>
      <ScrollX label="Departments table"><table className="w-full min-w-[760px] text-[13px] tabular">
        <thead className="border-b border-line text-[12px] text-ink-3"><tr><th className="px-4 py-2 text-left font-medium">Department</th><th className={th}>People</th><th className={th}>Recap adoption</th>
          <th className={th}>Logging coverage</th><th className={th}>Planned completion</th><th className={th}>Accepted</th><th className={th}>Deadline reliability</th><th className={th}>Meeting load</th><th className={th}>Uninterrupted task time</th></tr></thead>
        <tbody className="divide-y divide-line">{d.groups.map((g: any) => (
          <tr key={g.id ?? 'none'}><th scope="row" className="px-4 py-2 text-left font-medium">{g.name}</th><td className="px-3 text-right">{g.people}</td>
            {g.suppressed ? <td colSpan={7} className="px-3 text-ink-3">{g.people < d.scope.minGroup ? `Withheld: fewer than ${d.scope.minGroup} people` : 'Withheld so smaller departments cannot be worked out from the total'}</td> : <>
              <td className="px-3 text-right">{fr(g.metrics.recapAdoption)}</td><td className="px-3 text-right">{fr(g.metrics.loggingCoverage)}</td><td className="px-3 text-right">{fr(g.metrics.plannedCompletion)}</td>
              <td className="px-3 text-right">{g.metrics.acceptedOutcomes}</td><td className="px-3 text-right">{fr(g.metrics.deadlineReliability)}</td><td className="px-3 text-right">{fr(g.metrics.meetingShare)}</td>
              <td className="px-3 text-right">{fr(g.metrics.focusShare)}</td></>}
          </tr>))}</tbody>
      </table></ScrollX>
    </Card>
  );
}

/** Horizontally scrollable table wrapper; focusable so keyboard users can scroll it. */
function ScrollX({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return <div className={cx('overflow-x-auto', className)} tabIndex={0} role="region" aria-label={label}>{children}</div>;
}

function LoadCell({ r }: { r: R }) {
  if (r.status === 'not_applicable') return <span className="text-ink-3">N/A · no capacity</span>;
  if (r.value === null) return <span className="text-ink-3">—</span>;
  const over = r.value > 1.25;
  return (
    <div className="flex items-center justify-end gap-2">
      <div className="hidden h-1.5 w-20 rounded-full bg-surface-2 sm:block" aria-hidden><div className="h-full rounded-full" style={{ width: `${Math.min(1, r.value / 1.5) * 100}%`, background: 'var(--c-task)' }} /></div>
      <span className="tabular">{Math.round(r.value * 100)}%</span>
      {over && <Badge tone="warning" icon={<AlertTriangle className="size-3" aria-hidden />}>Above capacity</Badge>}
    </div>
  );
}

function Workload({ d }: { d: any }) {
  const w = d.workload; const t = w.totals;
  const th = 'px-3 py-2 text-right font-medium whitespace-nowrap';
  const people = !!w.rows;
  const rows = people ? w.rows : w.byGroup;
  return (
    <Card title="Workload" padded={false}
      subtitle={`${w.note} Next ${w.horizonWorkingDays} working days: ${hm(t.estimatedMinutes)} estimated against ${hm(t.availableMinutes)} available (${fr(t.load)}); ${t.estimatedTasks} of ${t.openTasks} open tasks have estimates.`}>
      <ScrollX label="Workload table"><table className="w-full min-w-[820px] text-[13px] tabular">
        <caption className="sr-only">{people ? 'Workload per person, alphabetical. Load, not performance.' : 'Workload per department. Individual rows are not shown for this access level.'}</caption>
        <thead className="border-b border-line text-[12px] text-ink-3"><tr><th className="px-4 py-2 text-left font-medium">{people ? 'Person' : 'Department'}</th>
          {people ? <th className="px-3 py-2 text-left font-medium">Department</th> : <th className={th}>People</th>}
          <th className={th}>Open tasks</th><th className={th}>With estimate</th><th className={th}>Open estimate</th><th className={th}>Available</th><th className={th}>Load</th>
          <th className={th}>Blocked</th><th className={th}>Overdue</th></tr></thead>
        <tbody className="divide-y divide-line">{rows.map((r: any) => (
          <tr key={r.userId ?? r.id ?? 'none'}>
            <th scope="row" className="px-4 py-2 text-left font-medium">{r.name}</th>
            {people ? <td className="px-3 text-ink-2">{r.department ?? '—'}</td> : <td className="px-3 text-right">{r.people}</td>}
            {r.suppressed ? <td colSpan={7} className="px-3 text-ink-3">{r.people < d.scope.minGroup ? `Withheld: fewer than ${d.scope.minGroup} people` : 'Withheld so smaller departments cannot be worked out from the total'}</td> : <>
              <td className="px-3 text-right">{r.openTasks}</td><td className="px-3 text-right">{r.estimatedTasks} of {r.openTasks}</td>
              <td className="px-3 text-right">{hm(r.estimatedMinutes)}</td><td className="px-3 text-right">{hm(r.availableMinutes)}</td>
              <td className="px-3"><LoadCell r={r.load} /></td>
              <td className={cx('px-3 text-right', r.blocked > 0 && 'font-medium')}>{r.blocked}</td><td className={cx('px-3 text-right', r.overdue > 0 && 'font-medium')}>{r.overdue}</td></>}
          </tr>))}</tbody>
      </table></ScrollX>
    </Card>
  );
}
