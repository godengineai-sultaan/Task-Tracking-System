import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, ChevronLeft, ChevronRight, Download, FileSpreadsheet, Lightbulb, Table2, BarChart3 } from 'lucide-react';
import { api, qs } from '../lib/api';
import { ASSESSMENT, STATUS_LABEL, TIME_CATS, addDays, fmtDate, fmtDateTime, hm, pct } from '../lib/format';
import { useMe, useRoles } from '../lib/session';
import { AssessmentBadge, Badge, Button, Callout, Card, ErrorState, Input, PageHeader, Segmented, Select, Skeleton, Stat, cx, useToast } from '../components/ui';
import { AllocationBar } from '../components/time';
import { downloadExport } from './util';
import { TrendsView, useTrends } from '../components/ext/TrendsView';

type Kind = 'day' | 'week' | 'month' | 'custom';

export default function Analytics() {
  const me = useMe(); const roles = useRoles(); const toast = useToast(); const nav = useNavigate();
  const { userId } = useParams(); const [sp, setSp] = useSearchParams();
  const kind = (sp.get('kind') as Kind) || 'week';
  const date = sp.get('date') ?? me.today;
  const start = sp.get('start') ?? addDays(me.today, -13); const end = sp.get('end') ?? me.today;
  const uid = userId ?? me.user.id;
  const view = sp.get('view') === 'trends' ? 'trends' : 'report';
  const weeks = [8, 12, 26].includes(Number(sp.get('weeks'))) ? Number(sp.get('weeks')) : 12;
  const tq = useTrends(uid, weeks, view === 'trends');
  const people = useQuery({ queryKey: ['people'], queryFn: () => api.get('/api/people'), enabled: roles.canReview });
  const q = useQuery({ queryKey: ['report', uid, kind, date, start, end], queryFn: () => api.get(`/api/reports/individual${qs({ userId: uid, kind, date: kind === 'custom' ? undefined : date, start: kind === 'custom' ? start : undefined, end: kind === 'custom' ? end : undefined })}`), enabled: view === 'report' });
  const set = (o: Record<string, string>) => { const n = new URLSearchParams(sp); for (const [k, v] of Object.entries(o)) n.set(k, v); setSp(n, { replace: true }); };
  const shift = (dir: number) => set({ date: addDays(date, dir * (kind === 'day' ? 1 : kind === 'week' ? 7 : 30)) });
  const exp = (format: 'pdf' | 'csv') => downloadExport(api, { format, report: 'individual', params: { userId: uid, kind, start: q.data.period.start, end: q.data.period.end } }, toast).catch((e) => toast({ tone: 'critical', text: e.message }));
  const r = q.data;
  const subject = view === 'trends' ? tq.data?.subject : r?.subject;
  const expTrends = () => downloadExport(api, { format: 'csv', report: 'personal_trends', params: { userId: uid, weeks } }, toast).catch((e) => toast({ tone: 'critical', text: e.message }));
  return (
    <div>
      <PageHeader eyebrow={uid === me.user.id ? 'My Analytics' : 'Individual report'} title={subject ? subject.name : view === 'trends' ? 'Trends' : 'Report'}
        subtitle={view === 'trends' ? (subject ? `${subject.title ? `${subject.title} · ` : ''}personal ${weeks}-week trends` : undefined) : r ? `${r.subject.title || ''}${r.subject.department ? ` · ${r.subject.department}` : ''} · role profile “${r.roleProfile.name}”` : undefined}
        actions={<>
          {roles.canReview && <Select aria-label="Person" className="h-9 w-48" value={uid} onChange={(e) => nav(`/analytics/${e.target.value === me.user.id ? '' : e.target.value}?${sp.toString()}`)}>
            {(people.data ?? []).map((p: any) => <option key={p.id} value={p.id}>{p.id === me.user.id ? `${p.name} (me)` : p.name}</option>)}</Select>}
          {view === 'trends' ? <Button icon={<FileSpreadsheet className="size-4" />} disabled={!tq.data} onClick={expTrends}>CSV</Button> : <>
            <Button icon={<Download className="size-4" />} disabled={!r} onClick={() => exp('pdf')}>PDF</Button>
            <Button icon={<FileSpreadsheet className="size-4" />} disabled={!r} onClick={() => exp('csv')}>CSV</Button></>}
        </>} />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Segmented label="View" value={view} onChange={(v) => set({ view: v })} options={[{ value: 'report', label: 'Report' }, { value: 'trends', label: 'Trends' }]} />
        {view === 'trends' ? null : <>
        <Segmented label="Period" value={kind} onChange={(v) => set({ kind: v })} options={[{ value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }, { value: 'custom', label: 'Custom' }]} />
        {kind !== 'custom' ? <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" aria-label="Previous period" onClick={() => shift(-1)}><ChevronLeft className="size-4" /></Button>
          <Input aria-label="Anchor date" type="date" className="h-8 w-40" value={date} onChange={(e) => e.target.value && set({ date: e.target.value })} />
          <Button size="sm" variant="ghost" aria-label="Next period" onClick={() => shift(1)}><ChevronRight className="size-4" /></Button>
          {date !== me.today && <Button size="sm" variant="ghost" onClick={() => set({ date: me.today })}>Today</Button>}
        </div> : <div className="flex items-center gap-1">
          <Input aria-label="Start date" type="date" className="h-8 w-40" value={start} onChange={(e) => set({ start: e.target.value })} /><span className="text-ink-3">–</span>
          <Input aria-label="End date" type="date" className="h-8 w-40" value={end} onChange={(e) => set({ end: e.target.value })} /></div>}
        {r && <span className="text-[13px] text-ink-2">{fmtDate(r.period.start, { day: 'numeric', month: 'short', year: 'numeric' })}{r.period.end !== r.period.start && ` – ${fmtDate(r.period.end, { day: 'numeric', month: 'short', year: 'numeric' })}`}</span>}
        {r && <Badge tone={r.reportState === 'provisional' ? 'warning' : 'good'}>{r.reportState === 'provisional' ? 'Provisional' : r.reportState === 'manager_reviewed' ? 'Manager reviewed' : 'Confirmed'}</Badge>}
        </>}
      </div>
      {view === 'trends' ? <TrendsView uid={uid} weeks={weeks} onWeeks={(n) => set({ weeks: String(n) })} /> : q.isLoading ? <div className="grid gap-4"><Skeleton className="h-40" /><Skeleton className="h-64" /></div> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : <Report r={r} kind={kind} own={uid === me.user.id} />}
    </div>
  );
}

function Report({ r, kind, own }: { r: any; kind: Kind; own: boolean }) {
  const s = r.summary; const tr = r.trend;
  const delta = (v: number | null | undefined, isPct = true, higherIsGood: boolean | null = true) => {
    if (v === null || v === undefined || !tr) return undefined;
    if (Math.abs(v) < (isPct ? 0.005 : 1)) return { text: 'no change vs prev.', good: null };
    const txt = isPct ? `${v > 0 ? '+' : ''}${Math.round(v * 100)} pts vs prev.` : `${v > 0 ? '+' : ''}${isPct ? v : hm(Math.abs(v)).replace(/^/, v < 0 ? '−' : '')} vs prev.`;
    return { text: txt, good: higherIsGood === null ? null : (v > 0) === higherIsGood };
  };
  const day = kind === 'day' ? r.days[0] : null;
  return (
    <div className="space-y-4">
      <Card padded={false}>
        <div className="grid gap-0 lg:grid-cols-3">
          <div className="border-b border-line p-4 lg:border-b-0 lg:border-r">
            <p className="text-[12px] font-medium text-ink-3">{kind === 'day' ? 'Was this day on track?' : 'How is this period going?'}</p>
            <div className="mt-2"><AssessmentBadge label={r.assessment.label} size="lg" /></div>
            <ul className="mt-3 space-y-1.5 text-[13px]">{r.assessment.reasons.map((x: string) => <li key={x}>{x}</li>)}</ul>
          </div>
          <div className="p-4 lg:col-span-2">
            <p className="text-[12px] font-medium text-ink-3">Supporting facts</p>
            <ul className="mt-2 space-y-1 text-[13px] text-ink-2">{r.assessment.facts.map((x: string) => <li key={x}>• {x}</li>)}</ul>
            <p className="mt-3 text-[12px] text-ink-3">Assumptions: {r.assessment.assumptions.join(' · ')}. This label explains recorded facts against your role's configured commitments — it is not a productivity score or ranking.</p>
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
        <Stat label="Intended outcomes accepted" value={s.intendedOutcomes ? `${s.acceptedPlannedOutcomes}/${s.intendedOutcomes}` : '—'} sub={pct(s.plannedCommitmentCompletion)} delta={delta(tr?.plannedCommitmentCompletion.delta)} hint={r.definitions.planned_commitment_completion} />
        <Stat label="Accepted outcomes" value={s.acceptedOutcomes} sub={`${s.carryovers} carried over`} delta={tr ? { text: `${tr.acceptedOutcomes.delta >= 0 ? '+' : ''}${tr.acceptedOutcomes.delta} vs prev.`, good: null } : undefined} hint={r.definitions.accepted_outcome} />
        <Stat label="Logging coverage" value={s.availableMinutes ? pct(s.loggingCoverage) : 'N/A'} sub={`${hm(s.explainedMinutes)} of ${hm(s.availableMinutes)}`} delta={delta(tr?.loggingCoverage.delta, true, null)} hint={r.definitions.logging_coverage} />
        <Stat label="Unknown time" value={s.availableMinutes ? hm(s.unknownMinutes) : 'N/A'} sub="not recorded — not idle" hint={r.definitions.unknown_time} />
        <Stat label="Blocked time" value={s.blockedMinutes ? hm(s.blockedMinutes) : '0m'} sub={s.blockerShare !== null ? `${pct(s.blockerShare)} of available` : 'no blockers recorded'} tone={s.blockerShare > 0.25 ? 'warning' : undefined} hint={r.definitions.blocker_share} />
        <Stat label="Deadlines" value={`${s.deadlines.met} met`} sub={<>{s.deadlines.late} late · <span className={s.deadlines.overdue ? 'font-medium text-critical-ink' : ''}>{s.deadlines.overdue} overdue</span></>} />
        <Stat label="Evidence coverage" value={pct(s.evidenceCoverage)} sub={s.evidenceRequired ? `${s.evidenceRequired} required` : 'none required'} hint={r.definitions.evidence_coverage} />
        <Stat label="Rework" value={s.reworkCount} sub="reopened / changes requested" hint={r.definitions.rework} />
        <Stat label="Capacity pressure" value={s.capacityPressure.ratio !== null ? pct(s.capacityPressure.ratio) : 'N/A'} sub={`next ${s.capacityPressure.horizonWorkingDays} working days · ${pct(s.capacityPressure.estimateCoverage)} estimated`} tone={s.capacityPressure.ratio > 1.1 ? 'warning' : undefined} hint={r.definitions.capacity_pressure} />
        <Stat label="Recaps" value={`${s.confirmedRecaps}/${s.workingDays}`} sub={`${s.missingRecaps} missing · ${s.nonWorkingDays} non-working`} hint="Confirmed recaps out of scheduled working days so far" />
        <Stat label="Meetings" value={hm(s.byCategory.meeting)} sub={s.availableMinutes ? `${pct(s.byCategory.meeting / s.availableMinutes)} of available` : ''} delta={tr ? { text: `${tr.meetingMinutes.delta >= 0 ? '+' : '−'}${hm(Math.abs(tr.meetingMinutes.delta))} vs prev.`, good: null } : undefined} />
        <Stat label="Overlaps counted once" value={hm(s.conflictMinutes)} sub={s.outsideScheduleMinutes ? `${hm(s.outsideScheduleMinutes)} outside schedule` : 'inside schedule'} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2" title="Time allocation" subtitle="Confirmed, non-overlapping time by category. Hatched = unknown (unrecorded) time.">
          {day ? <div className="space-y-3"><AllocationBar byCategory={day.time.byCategory} unknown={day.time.unknownMinutes} available={day.capacity.availableMinutes} height={16} />
            <p className="text-[12px] text-ink-3">Sources: {Object.entries(day.time.bySource).map(([k, v]) => `${k} ${hm(v as number)}`).join(' · ') || 'none'} · planned estimate {hm(day.time.plannedEstimateMinutes)} · unconfirmed suggestions {hm(day.time.inferredUnconfirmedMinutes)}</p></div>
            : <DailyChart days={r.days} />}
        </Card>
        <Card title={<span className="flex items-center gap-2"><Lightbulb className="size-4 text-accent" aria-hidden />Recommended next steps</span>}>
          {r.recommendations.length === 0 ? <p className="text-[13px] text-ink-3">Nothing needs action right now.</p> : <ul className="space-y-2.5">
            {r.recommendations.map((x: any, i: number) => <li key={i} className="flex gap-2 text-[13px]"><ArrowRight className="mt-0.5 size-3.5 shrink-0 text-accent" aria-hidden />
              <span>{x.text}{x.ref && <> <Link className="text-accent-ink underline" to={`/tasks/${x.ref}`}>Open</Link></>}</span></li>)}</ul>}
          {own && <p className="mt-4 text-[12px] text-ink-3">Recommendations are rule-based and use only your recorded work.</p>}
        </Card>
      </div>

      {tr && <Card title="Trend vs previous period" subtitle={`${fmtDate(tr.previousPeriod.start)} – ${fmtDate(tr.previousPeriod.end)} · ${tr.comparableWorkingDays} comparable working days`}>
        <div className="grid gap-3 text-[13px] sm:grid-cols-2 lg:grid-cols-4">
          <TrendRow label="Intended outcomes accepted" a={pct(tr.plannedCommitmentCompletion.previous)} b={pct(tr.plannedCommitmentCompletion.current)} />
          <TrendRow label="Logging coverage" a={pct(tr.loggingCoverage.previous)} b={pct(tr.loggingCoverage.current)} />
          <TrendRow label="Blocked time" a={hm(tr.blockedMinutes.previous)} b={hm(tr.blockedMinutes.current)} />
          <TrendRow label="Accepted outcomes" a={String(tr.acceptedOutcomes.previous)} b={String(tr.acceptedOutcomes.current)} />
        </div>
        <p className="mt-3 text-[12px] text-ink-3">{tr.note}</p>
      </Card>}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Delivery" subtitle="Accepted outcomes and deadlines in this period" padded={false}>
          <ul className="divide-y divide-line">{r.acceptedOutcomes.length === 0 && <li className="px-4 py-3 text-[13px] text-ink-3">No accepted outcomes in this period.</li>}
            {r.acceptedOutcomes.slice(0, 15).map((o: any) => (
              <li key={o.taskId} className="flex items-center gap-2 px-4 py-2 text-[13px]">
                <Link to={`/tasks/${o.taskId}`} className="min-w-0 flex-1 truncate hover:underline">{o.title}</Link>
                {o.project && <span className="text-[12px] text-ink-3">{o.project}</span>}
                <Badge tone={o.reviewed ? 'good' : 'neutral'}>{o.reviewed ? 'Reviewer accepted' : 'Self-accepted'}</Badge>
                {o.requiresEvidence && <Badge tone={o.evidenceCount ? 'good' : 'warning'}>{o.evidenceCount ? 'Evidence' : 'No evidence'}</Badge>}
              </li>))}</ul>
          {r.deadlines.length > 0 && <div className="border-t border-line px-4 py-3"><p className="mb-1.5 text-[12px] font-medium text-ink-3">Deadlines</p>
            <ul className="space-y-1">{r.deadlines.map((d: any) => <li key={d.taskId} className="flex items-center gap-2 text-[13px]"><span className="flex-1 truncate">{d.title}</span>
              <span className="text-[12px] text-ink-3">{fmtDate(d.dueDate)}</span><Badge tone={d.state === 'met' ? 'good' : d.state === 'overdue' ? 'critical' : d.state === 'late' ? 'warning' : 'neutral'}>{d.state}</Badge></li>)}</ul></div>}
        </Card>
        <Card title="Bottlenecks" subtitle="Recorded blockers, causes and who work waits on" padded={false}>
          {Object.keys(r.blockersByCause).length > 0 && <div className="flex flex-wrap gap-1.5 border-b border-line px-4 py-2.5">{Object.entries(r.blockersByCause).map(([c, v]: any) =>
            <Badge key={c} tone="neutral">{c}: {v.count} · {hm(v.minutes)}</Badge>)}</div>}
          <ul className="divide-y divide-line">{r.blockers.length === 0 && <li className="px-4 py-3 text-[13px] text-ink-3">No blockers recorded in this period.</li>}
            {r.blockers.slice(0, 12).map((b: any) => (
              <li key={b.id} className="px-4 py-2 text-[13px]">
                <div className="flex items-center gap-2"><Link to={`/tasks/${b.taskId}`} className="flex-1 truncate font-medium hover:underline">{b.task}</Link>
                  <Badge tone={b.resolvedAt ? 'good' : 'critical'}>{b.resolvedAt ? 'Resolved' : 'Open'}</Badge></div>
                <div className="text-[12px] text-ink-2">{b.reason} · waiting on {b.waitingOn || '—'} · since {fmtDateTime(b.raisedAt)}</div>
              </li>))}</ul>
          {r.rework.length > 0 && <div className="border-t border-line px-4 py-3"><p className="mb-1.5 text-[12px] font-medium text-ink-3">Rework</p>
            <ul className="space-y-1">{r.rework.map((x: any, i: number) => <li key={i} className="text-[13px]"><b>{x.title}</b> — {x.kind === 'reopened' ? 'reopened' : 'changes requested'}: <span className="text-ink-2">{x.reason}</span></li>)}</ul></div>}
        </Card>
      </div>

      {r.managerReviews.length > 0 && <Card title="Manager review history">
        <ul className="space-y-1.5 text-[13px]">{r.managerReviews.map((m: any) => <li key={m.id}><b>{m.reviewer}</b> · {m.action.replace(/_/g, ' ')} · {fmtDate(m.date)}{m.note && <> — <span className="text-ink-2">{m.note}</span></>}</li>)}</ul></Card>}

      {r.versions?.length > 0 && <Card title="Report versions" subtitle="Snapshots taken when the recap was confirmed, corrected or reviewed. The figures above are recomputed live from current records.">
        <ul className="space-y-1 text-[13px]">{r.versions.map((v: any) => <li key={v.id}><b>v{v.version}</b> · {v.status.replace('_', ' ')} · {v.reason} <span className="text-ink-3">· {fmtDateTime(v.generated_at)} · {v.definitions_version}</span></li>)}</ul></Card>}

      <details className="rounded-xl bg-surface p-4 ring-1 ring-line">
        <summary className="cursor-pointer text-[13px] font-semibold">Metric definitions ({r.definitions.version})</summary>
        <dl className="mt-3 grid gap-2 text-[13px] sm:grid-cols-2">{Object.entries(r.definitions).filter(([k]) => k !== 'version').map(([k, v]) => (
          <div key={k}><dt className="font-medium capitalize">{k.replace(/_/g, ' ')}</dt><dd className="text-ink-2">{v as string}</dd></div>))}</dl>
      </details>
      <span className="hidden">{STATUS_LABEL.done}{String(ASSESSMENT)}</span>
    </div>
  );
}

function TrendRow({ label, a, b }: { label: string; a: string; b: string }) {
  return <div className="rounded-lg bg-surface-2 p-3"><div className="text-[12px] text-ink-3">{label}</div><div className="mt-1 tabular"><span className="text-ink-3">{a}</span> → <b>{b}</b></div></div>;
}

/** Daily stacked bars with available-capacity tick, hover tooltip and a table view (relief for low-contrast hues). */
function DailyChart({ days }: { days: any[] }) {
  const [table, setTable] = useState(false); const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(60, ...days.map((d) => Math.max(d.capacity.availableMinutes, d.time.explainedMinutes + d.time.unknownMinutes)));
  const H = 180;
  return (
    <div>
      <div className="mb-2 flex justify-end"><Segmented label="Chart or table" value={table ? 't' : 'c'} onChange={(v) => setTable(v === 't')}
        options={[{ value: 'c', label: <span className="flex items-center gap-1"><BarChart3 className="size-3.5" />Chart</span> }, { value: 't', label: <span className="flex items-center gap-1"><Table2 className="size-3.5" />Table</span> }]} /></div>
      {table ? (
        <div className="overflow-x-auto"><table className="w-full min-w-[640px] text-[12.5px] tabular">
          <thead className="text-left text-ink-3"><tr><th className="py-1.5 pr-2 font-medium">Date</th><th className="font-medium">Capacity</th>{TIME_CATS.map((c) => <th key={c.key} className="font-medium">{c.label}</th>)}<th className="font-medium">Unknown</th><th className="font-medium">Outcomes</th><th className="font-medium">Recap</th><th className="font-medium">Assessment</th></tr></thead>
          <tbody className="divide-y divide-line">{days.map((d) => (
            <tr key={d.date}><td className="py-1.5 pr-2">{fmtDate(d.date, { weekday: 'short', day: 'numeric', month: 'short' })}</td>
              <td>{d.capacity.availableMinutes ? hm(d.capacity.availableMinutes) : capLabel(d.capacity)}</td>
              {TIME_CATS.map((c) => <td key={c.key}>{d.time.byCategory[c.key] ? hm(d.time.byCategory[c.key]) : '—'}</td>)}
              <td>{d.capacity.availableMinutes ? hm(d.time.unknownMinutes) : 'N/A'}</td><td>{d.intendedOutcomes.length ? `${d.acceptedPlanned}/${d.intendedOutcomes.length}` : '—'}</td>
              <td>{d.recap ? `${d.recap.status.replace('_', ' ')} v${d.recap.version}` : d.capacity.availableMinutes && !d.isFuture ? 'missing' : '—'}</td><td>{ASSESSMENT[d.assessment.label]?.label}</td></tr>))}</tbody>
        </table></div>
      ) : (
        <div className="relative">
          <div className="flex items-end gap-1.5 overflow-x-auto pb-1" style={{ height: H + 28 }}>
            {days.map((d, i) => {
              const segs = [...TIME_CATS.map((c) => ({ key: c.key, color: c.color, v: d.time.byCategory[c.key] ?? 0 })), { key: 'unknown', color: '', v: d.capacity.availableMinutes ? d.time.unknownMinutes : 0 }].filter((s) => s.v > 0);
              const na = d.capacity.availableMinutes === 0;
              return (
                <div key={d.date} className="relative flex min-w-[22px] flex-1 flex-col items-center" onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} tabIndex={0}
                  aria-label={`${fmtDate(d.date, { weekday: 'long', day: 'numeric', month: 'short' })}: ${na ? capLabel(d.capacity) : `${hm(d.time.explainedMinutes)} confirmed, ${hm(d.time.unknownMinutes)} unknown of ${hm(d.capacity.availableMinutes)}`}`}>
                  <div className="relative flex w-full max-w-[28px] flex-col-reverse gap-[2px]" style={{ height: H }}>
                    {na ? <div className="mt-auto text-center text-[10px] text-ink-3">N/A</div> : segs.map((s, j) => (
                      <div key={s.key} className={cx(s.key === 'unknown' && 'hatch', j === segs.length - 1 && 'rounded-t-[4px]')} style={{ height: Math.max(2, (s.v / max) * H - 2), background: s.key === 'unknown' ? undefined : s.color }} />))}
                    {!na && <div aria-hidden className="absolute left-[-3px] right-[-3px] h-[2px] rounded bg-ink-2" style={{ bottom: (d.capacity.availableMinutes / max) * H }} />}
                  </div>
                  <div className={cx('mt-1.5 text-[10.5px] tabular', d.isToday ? 'font-semibold text-ink' : 'text-ink-3')}>{fmtDate(d.date, { day: 'numeric' })}</div>
                  {hover === i && <div role="tooltip" className="absolute bottom-full z-10 mb-1 w-52 rounded-lg bg-surface p-2.5 text-[12px] shadow-xl ring-1 ring-line">
                    <div className="font-semibold">{fmtDate(d.date, { weekday: 'short', day: 'numeric', month: 'short' })}</div>
                    {na ? <div className="text-ink-3">{capLabel(d.capacity)} — Not Applicable</div> : <>
                      {TIME_CATS.filter((c) => d.time.byCategory[c.key]).map((c) => <div key={c.key} className="flex justify-between"><span>{c.label}</span><span className="tabular">{hm(d.time.byCategory[c.key])}</span></div>)}
                      <div className="flex justify-between text-ink-3"><span>Unknown</span><span className="tabular">{hm(d.time.unknownMinutes)}</span></div>
                      <div className="mt-1 flex justify-between border-t border-line pt-1"><span>Available</span><span className="tabular">{hm(d.capacity.availableMinutes)}</span></div>
                      <div className="text-ink-3">Outcomes {d.acceptedPlanned}/{d.intendedOutcomes.length} · recap {d.recap ? d.recap.status.replace('_', ' ') : 'missing'}</div></>}
                  </div>}
                </div>
              );
            })}
          </div>
          <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-ink-2">
            {TIME_CATS.map((c) => <li key={c.key} className="flex items-center gap-1.5"><span aria-hidden className="size-2.5 rounded-sm" style={{ background: c.color }} />{c.label}</li>)}
            <li className="flex items-center gap-1.5"><span aria-hidden className="hatch size-2.5 rounded-sm ring-1 ring-line-strong" />Unknown</li>
            <li className="flex items-center gap-1.5"><span aria-hidden className="h-[2px] w-3 rounded bg-ink-2" />Available capacity</li>
          </ul>
        </div>
      )}
      <div className="mt-3" /><Callout tone="neutral"><span className="text-[12px]">Coverage measures how much scheduled time was explained by records you confirmed. It is not productivity: a research day or an incident can be valuable with little logged time.</span></Callout>
    </div>
  );
}
const capLabel = (c: any) => (c.status === 'holiday' ? `Holiday${c.holiday ? `: ${c.holiday}` : ''}` : c.status === 'leave' ? `Leave` : 'Non-working');
