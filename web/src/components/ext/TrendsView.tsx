import { useState, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, BarChart3, CheckCircle2, Info, Lightbulb, Table2, TrendingUp } from 'lucide-react';
import { api, qs } from '../../lib/api';
import { fmtDate, hm, pct } from '../../lib/format';
import { Badge, Callout, Card, Empty, ErrorState, Segmented, Skeleton, Stat, cx } from '../ui';

/** Personal weekly trends (same access rules as the individual report). */
export function useTrends(uid: string, weeks: number, enabled = true) {
  return useQuery({ queryKey: ['trends', uid, weeks], queryFn: () => api.get(`/api/trends/personal${qs({ userId: uid, weeks })}`), enabled });
}

type Week = any;
const ratioX = (v: number) => `${v.toFixed(1)}x`;
const wk = (d: string) => fmtDate(d, { day: 'numeric', month: 'short' });
const weekLabel = (w: Week) => `Week of ${wk(w.weekStart)}${w.partial ? ' (so far)' : ''}`;

interface Metric {
  key: string; title: string; kind: 'line' | 'bar'; color: string; hatch?: boolean; hint: string;
  value: (w: Week) => number | null; fmt: (v: number) => string; max?: number; minutes?: boolean; minMax?: number; ref?: { value: number; label: string };
  detail?: (w: Week) => string;
}

function metrics(defs: any): Metric[] {
  return [
    { key: 'plannedCompletion', title: 'Intended outcomes accepted', kind: 'line', color: 'var(--accent)', max: 1, fmt: (v) => pct(v), value: (w) => w.plannedCompletion,
      detail: (w) => (w.intendedOutcomes ? `${w.acceptedPlanned} of ${w.intendedOutcomes} intended outcomes` : 'Nothing planned in My Day'), hint: defs.planned_commitment_completion },
    { key: 'acceptedOutcomes', title: 'Accepted outcomes', kind: 'bar', color: 'var(--accent)', minMax: 4, fmt: (v) => String(Math.round(v)), value: (w) => w.acceptedOutcomes, hint: defs.accepted_outcomes },
    { key: 'focus', title: 'Focus time', kind: 'bar', color: 'var(--c-task)', minMax: 120, minutes: true, fmt: hm, value: (w) => w.focusMinutes,
      detail: (w) => `${w.focusBlocks} block(s) of 60+ min · ${pct(w.focusShare)} of available`, hint: defs.focus_time },
    { key: 'meetingShare', title: 'Meeting share', kind: 'line', color: 'var(--c-meeting)', max: 1, fmt: (v) => pct(v), value: (w) => w.meetingShare,
      detail: (w) => `${hm(w.meetingMinutes)} of ${hm(w.availableMinutes)} available`, hint: defs.meeting_share },
    { key: 'switches', title: 'Switches per logged day', kind: 'line', color: 'var(--accent)', minMax: 4, fmt: (v) => v.toFixed(1), value: (w) => w.switchesPerDay,
      detail: (w) => `${w.taskSwitches} switch(es) over ${w.loggedDays} logged day(s)`, hint: defs.fragmentation },
    { key: 'carryover', title: 'Carryover rate', kind: 'line', color: 'var(--accent)', max: 1, fmt: (v) => pct(v), value: (w) => w.carryoverRate,
      detail: (w) => `${w.carryovers} of ${w.intendedOutcomes} carried over`, hint: defs.carryover_rate },
    { key: 'coverage', title: 'Logging coverage', kind: 'line', color: 'var(--accent)', max: 1, fmt: (v) => pct(v), value: (w) => w.loggingCoverage,
      detail: (w) => `${hm(w.explainedMinutes)} confirmed of ${hm(w.availableMinutes)} · record completeness, not productivity`, hint: defs.logging_coverage },
    { key: 'unknown', title: 'Unknown time', kind: 'bar', color: '', hatch: true, minMax: 60, minutes: true, fmt: hm, value: (w) => w.unknownMinutes,
      detail: () => 'Not recorded — not assumed idle', hint: defs.unknown_time },
    { key: 'blocked', title: 'Blocked time', kind: 'bar', color: 'var(--c-other)', minMax: 60, minutes: true, fmt: hm, value: (w) => w.blockedMinutes,
      detail: (w) => `${pct(w.blockedShare)} of available time`, hint: defs.blocked_time },
    { key: 'estimate', title: 'Estimate ratio (accepted tasks)', kind: 'line', color: 'var(--accent)', minMax: 2, fmt: ratioX, value: (w) => w.estimate.ratio, ref: { value: 1, label: 'as estimated' },
      detail: (w) => `${w.estimate.measured} of ${w.estimate.accepted} accepted task(s) measured`, hint: defs.estimate_accuracy },
    { key: 'recaps', title: 'Recap completion', kind: 'line', color: 'var(--accent)', max: 1, fmt: (v) => pct(v), value: (w) => w.recaps.rate,
      detail: (w) => `${w.recaps.confirmed} of ${w.recaps.expected} working day(s) confirmed`, hint: defs.recap_completion },
  ];
}

function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v)); const m = v / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
}

export function TrendsView({ uid, weeks, onWeeks }: { uid: string; weeks: number; onWeeks: (n: number) => void }) {
  const q = useTrends(uid, weeks);
  const [table, setTable] = useState(false);
  const d = q.data;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented label="Weeks shown" value={String(weeks)} onChange={(v) => onWeeks(Number(v))} options={[{ value: '8', label: '8 wk' }, { value: '12', label: '12 wk' }, { value: '26', label: '26 wk' }]} />
        <Segmented label="Chart or table" value={table ? 't' : 'c'} onChange={(v) => setTable(v === 't')}
          options={[{ value: 'c', label: <span className="flex items-center gap-1"><BarChart3 className="size-3.5" aria-hidden />Charts</span> }, { value: 't', label: <span className="flex items-center gap-1"><Table2 className="size-3.5" aria-hidden />Table</span> }]} />
        {d && <span className="text-[13px] text-ink-2">{fmtDate(d.range.start, { day: 'numeric', month: 'short', year: 'numeric' })} – {fmtDate(d.range.end, { day: 'numeric', month: 'short', year: 'numeric' })}
          {' · '}{d.summary.applicableWeeks} comparable week(s){d.summary.notApplicableWeeks ? ` · ${d.summary.notApplicableWeeks} Not Applicable` : ''}</span>}
      </div>
      {q.isLoading ? <div className="grid gap-4"><Skeleton className="h-24" /><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-40" />)}</div></div>
        : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} />
        : d ? <TrendsBody d={d} table={table} /> : null}
    </div>
  );
}

function TrendsBody({ d, table }: { d: any; table: boolean }) {
  const s = d.summary;
  const anyRecords = d.weeks.some((w: Week) => w.explainedMinutes > 0 || w.intendedOutcomes > 0 || w.acceptedOutcomes > 0);
  if (!s.applicableWeeks || !anyRecords) {
    return <Card><Empty icon={<TrendingUp className="size-6" aria-hidden />} title={s.applicableWeeks ? 'No recorded work in these weeks yet' : 'No comparable working days in these weeks'}>
      {s.applicableWeeks ? 'Trends appear once plans, time entries, recaps or accepted tasks are recorded. Nothing is inferred from activity monitoring.' : 'Every week was a holiday, leave or non-working week, so there is nothing to compare.'}
    </Empty></Card>;
  }
  const ms = metrics(d.definitions);
  return (
    <>
      <Callout tone="neutral"><span className="text-[12.5px]">These trends describe only what {d.subject.name.split(' ')[0]} recorded: plans, confirmed time, recaps, blockers and accepted tasks. They are not a productivity score, they are never compared with other people, and unknown time is not treated as idle. Weeks without comparable working days are shown as Not Applicable, not zero.</span></Callout>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Intended outcomes accepted" value={pct(s.plannedCompletion)} sub={`over ${s.comparableWorkingDays} working days`} hint={d.definitions.planned_commitment_completion} />
        <Stat label="Accepted outcomes" value={s.acceptedOutcomes} sub={`in ${d.range.weeks} weeks`} hint={d.definitions.accepted_outcomes} />
        <Stat label="Focus time" value={hm(s.focusMinutes)} sub={`${pct(s.focusShare)} of available`} hint={d.definitions.focus_time} />
        <Stat label="Meeting share" value={pct(s.meetingShare)} sub="of available time" hint={d.definitions.meeting_share} />
        <Stat label="Logging coverage" value={pct(s.loggingCoverage)} sub={`${hm(s.unknownMinutes)} unknown — not idle`} hint={d.definitions.logging_coverage} />
        <Stat label="Estimate ratio" value={s.estimateRatio === null ? 'N/A' : ratioX(s.estimateRatio)} sub={`${d.estimateAccuracy.overall.measured} of ${d.estimateAccuracy.overall.accepted} tasks measured`} hint={d.definitions.estimate_accuracy} />
      </div>

      <Card title="Weekly trends" subtitle="One small chart per measure. Arrow keys move between weeks; Not Applicable weeks are gaps, not zeros." padded={!table}>
        <WorkingDaysStrip weeks={d.weeks} />
        {table ? <WeeklyTable weeks={d.weeks} /> : <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{ms.map((m) => <MiniChart key={m.key} m={m} weeks={d.weeks} />)}</div>}
      </Card>

      <Card title={<span className="flex items-center gap-2"><Lightbulb className="size-4 text-accent" aria-hidden />Pattern review</span>}
        subtitle="Rule-based observations from these weeks, each with the facts behind it and a gentle suggestion.">
        <Patterns patterns={d.patterns} />
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Focus vs meetings by weekday" subtitle={`Share of available time on scheduled working days. Focus = ${d.thresholds.focusMinMinutes}+ minutes on one task.`}>
          <WeekdayReview days={d.weekdays} coverage={d.thresholds.coverage} />
        </Card>
        <Card title="Estimate accuracy" subtitle="Accepted tasks: logged time vs estimate. 1.0x = as estimated." padded={false}>
          <EstimateTable ea={d.estimateAccuracy} />
        </Card>
      </div>

      <details className="rounded-xl bg-surface p-4 ring-1 ring-line">
        <summary className="cursor-pointer text-[13px] font-semibold">How these trends are calculated ({d.definitions.version})</summary>
        <dl className="mt-3 grid gap-2 text-[13px] sm:grid-cols-2">{Object.entries(d.definitions).filter(([k]) => k !== 'version').map(([k, v]) => (
          <div key={k}><dt className="font-medium capitalize">{k.replace(/_/g, ' ')}</dt><dd className="text-ink-2">{v as string}</dd></div>))}</dl>
      </details>
    </>
  );
}

function WorkingDaysStrip({ weeks }: { weeks: Week[] }) {
  return (
    <div className="px-4 pt-3 sm:px-0 sm:pt-0">
      <p className="mb-1 text-[12px] font-medium text-ink-3">Comparable working days per week</p>
      <ol className="grid gap-[2px]" style={{ gridTemplateColumns: `repeat(${weeks.length}, minmax(0, 1fr))` }}>
        {weeks.map((w) => (
          <li key={w.weekStart} title={`${weekLabel(w)}: ${w.status === 'applicable' ? `${w.workingDays} working day(s)` : w.naReason}`}
            className={cx('rounded-[4px] py-0.5 text-center text-[11px] tabular', w.status === 'applicable' ? 'bg-surface-2 text-ink-2' : 'hatch text-ink-3')}>
            <span className="sr-only">{weekLabel(w)}: </span>{w.status === 'applicable' ? w.workingDays : <><span aria-hidden>–</span><span className="sr-only">Not Applicable. {w.naReason}</span></>}
          </li>))}
      </ol>
    </div>
  );
}

/** Single-series small multiple: plain HTML/SVG, one tab stop, arrow keys or hover reveal each week; table view elsewhere. */
function MiniChart({ m, weeks }: { m: Metric; weeks: Week[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const vals = weeks.map((w) => (w.status === 'applicable' ? m.value(w) : null));
  const nums = vals.filter((v): v is number => v !== null);
  const top = Math.max(m.minMax ?? 0, ...nums, m.ref?.value ?? 0);
  const max = m.max ?? (m.minutes ? niceMax(top / 60) * 60 : niceMax(top)); // minute axes round to whole hours
  const N = weeks.length;
  let lastIdx = -1; vals.forEach((v, i) => { if (v !== null) lastIdx = i; });
  const yPct = (v: number) => Math.min(100, (v / max) * 100);
  const lines: number[][][] = []; let cur: number[][] = [];
  vals.forEach((v, i) => { if (v === null) { if (cur.length) lines.push(cur); cur = []; } else cur.push([((i + 0.5) / N) * 100, 100 - yPct(v)]); });
  if (cur.length) lines.push(cur);
  const describe = (i: number) => {
    const w = weeks[i];
    if (w.status !== 'applicable') return `${weekLabel(w)}: Not Applicable. ${w.naReason}`;
    const v = vals[i];
    return `${weekLabel(w)}: ${m.title} ${v === null ? 'N/A' : m.fmt(v)}${m.detail ? `. ${m.detail(w)}` : ''}. ${w.workingDays} comparable working day(s).`;
  };
  const onKey = (e: KeyboardEvent) => {
    const k = e.key;
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(k)) return;
    e.preventDefault();
    setHover((h) => (k === 'Home' ? 0 : k === 'End' ? N - 1 : Math.max(0, Math.min(N - 1, (h ?? N - 1) + (k === 'ArrowLeft' ? -1 : 1)))));
  };
  const tipAlign = (i: number) => (i < N / 3 ? 'left-0' : i >= (2 * N) / 3 ? 'right-0' : 'left-1/2 -translate-x-1/2');
  return (
    <figure className="min-w-0 rounded-xl bg-surface-2/40 p-3 ring-1 ring-line" data-metric={m.key}>
      <figcaption className="flex items-baseline justify-between gap-2">
        <span className="text-[13px] font-medium text-ink" title={m.hint}>{m.title}</span>
        <span className="text-[14px] font-semibold tabular text-ink">{lastIdx >= 0 ? m.fmt(vals[lastIdx]!) : 'N/A'}</span>
      </figcaption>
      <p className="text-[11.5px] text-ink-3">{lastIdx >= 0 ? `latest: ${weekLabel(weeks[lastIdx]).replace(/^Week/, 'week')}` : 'no applicable week'}</p>
      <div className="relative mt-5 h-24" tabIndex={0} role="group" aria-roledescription="chart" onKeyDown={onKey}
        aria-label={`${m.title} by week. Latest ${lastIdx >= 0 ? m.fmt(vals[lastIdx]!) : 'not applicable'}. Use left and right arrow keys to read each week.`}
        onFocus={() => setHover((h) => h ?? (lastIdx >= 0 ? lastIdx : N - 1))} onBlur={() => setHover(null)} onMouseLeave={() => setHover(null)}>
        <div aria-hidden className="absolute inset-x-0 top-0 border-t border-dashed border-line" />
        <span aria-hidden className="absolute -top-3.5 right-0 text-[10px] leading-none text-ink-3 tabular">{m.fmt(max)}</span>
        <div aria-hidden className="absolute inset-x-0 bottom-0 border-t border-line-strong" />
        {m.ref && <div aria-hidden className="absolute inset-x-0 border-t border-dashed border-ink-3" style={{ bottom: `${yPct(m.ref.value)}%` }}>
          <span className="absolute left-0 top-0.5 rounded bg-surface/80 px-0.5 text-[10px] leading-none text-ink-3">{m.ref.label}</span></div>}
        {m.kind === 'line' && <svg aria-hidden className="absolute inset-0 h-full w-full overflow-visible" viewBox="0 0 100 100" preserveAspectRatio="none">
          {lines.map((pts, i) => <polyline key={i} points={pts.map((p) => p.join(',')).join(' ')} fill="none" stroke={m.color} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />)}
        </svg>}
        <div className="absolute inset-0 grid" style={{ gridTemplateColumns: `repeat(${N}, minmax(0, 1fr))` }}>
          {weeks.map((w, i) => {
            const v = vals[i]; const na = w.status !== 'applicable';
            return (
              <div key={w.weekStart} className={cx('relative h-full', hover === i && 'bg-ink/5 rounded-[3px]')} onMouseEnter={() => setHover(i)}>
                {m.kind === 'bar' && v !== null && v > 0 && <div aria-hidden className={cx('absolute inset-x-[18%] bottom-0 rounded-t-[4px]', m.hatch && 'hatch ring-1 ring-inset ring-line-strong')}
                  style={{ height: `${Math.max(2, yPct(v))}%`, background: m.hatch ? undefined : m.color }} />}
                {m.kind === 'line' && v !== null && <span aria-hidden className="absolute left-1/2 size-2 -translate-x-1/2 translate-y-1/2 rounded-full ring-2 ring-surface"
                  style={{ bottom: `${yPct(v)}%`, background: m.color }} />}
                {na && <span aria-hidden className="absolute bottom-0.5 left-1/2 -translate-x-1/2 text-[9px] leading-none text-ink-3">{N <= 13 ? 'N/A' : '–'}</span>}
                {hover === i && <div role="tooltip" className={cx('pointer-events-none absolute bottom-full z-20 mb-2 w-52 rounded-lg bg-surface p-2.5 text-[12px] shadow-xl ring-1 ring-line', tipAlign(i))}>
                  <div className="font-semibold">{weekLabel(w)}</div>
                  {na ? <div className="text-ink-2">Not Applicable — {w.naReason}</div> : <>
                    <div className="flex justify-between gap-2"><span>{m.title}</span><span className="font-medium tabular">{v === null ? 'N/A' : m.fmt(v)}</span></div>
                    {m.detail && <div className="text-ink-2">{m.detail(w)}</div>}
                    <div className="mt-1 border-t border-line pt-1 text-ink-3">{w.workingDays} comparable working day(s)</div></>}
                </div>}
              </div>
            );
          })}
        </div>
      </div>
      <div aria-hidden className="mt-1 flex justify-between text-[10.5px] text-ink-3 tabular"><span>{wk(weeks[0].weekStart)}</span><span>{wk(weeks[N - 1].weekStart)}</span></div>
      <div className="sr-only" aria-live="polite">{hover !== null ? describe(hover) : ''}</div>
    </figure>
  );
}

function WeeklyTable({ weeks }: { weeks: Week[] }) {
  const cols = ['Working days', 'Intended accepted', 'Accepted outcomes', 'Focus', 'Meetings', 'Switches / day', 'Carryover', 'Logging coverage', 'Unknown', 'Blocked', 'Estimate ratio', 'Recaps'];
  return (
    <div className="mt-3 overflow-x-auto border-t border-line">
      <table className="w-full min-w-[980px] text-[12.5px] tabular">
        <caption className="sr-only">Weekly trend values</caption>
        <thead className="text-left text-ink-3"><tr><th scope="col" className="px-4 py-2 font-medium">Week</th>{cols.map((c) => <th key={c} scope="col" className="py-2 pr-3 font-medium">{c}</th>)}</tr></thead>
        <tbody className="divide-y divide-line">{weeks.map((w) => (
          <tr key={w.weekStart}>
            <th scope="row" className="whitespace-nowrap px-4 py-1.5 text-left font-medium">{wk(w.weekStart)}{w.partial && <span className="font-normal text-ink-3"> (so far)</span>}</th>
            {w.status !== 'applicable' ? <td colSpan={cols.length} className="py-1.5 pr-3 text-ink-3">Not Applicable — {w.naReason}{w.acceptedOutcomes ? ` (${w.acceptedOutcomes} accepted outcome(s) recorded)` : ''}</td> : <>
              <td className="pr-3">{w.workingDays}</td>
              <td className="pr-3">{w.intendedOutcomes ? `${pct(w.plannedCompletion)} (${w.acceptedPlanned}/${w.intendedOutcomes})` : 'N/A'}</td>
              <td className="pr-3">{w.acceptedOutcomes}</td>
              <td className="pr-3">{hm(w.focusMinutes)} · {w.focusBlocks} blk</td>
              <td className="pr-3">{hm(w.meetingMinutes)} ({pct(w.meetingShare)})</td>
              <td className="pr-3">{w.switchesPerDay === null ? 'N/A' : w.switchesPerDay.toFixed(1)}</td>
              <td className="pr-3">{pct(w.carryoverRate)}</td>
              <td className="pr-3">{pct(w.loggingCoverage)}</td>
              <td className="pr-3">{hm(w.unknownMinutes)}</td>
              <td className="pr-3">{hm(w.blockedMinutes)}</td>
              <td className="pr-3">{w.estimate.ratio === null ? 'N/A' : `${ratioX(w.estimate.ratio)} (${w.estimate.measured}/${w.estimate.accepted})`}</td>
              <td className="pr-3">{w.recaps.expected ? `${w.recaps.confirmed}/${w.recaps.expected}` : 'N/A'}</td></>}
          </tr>))}</tbody>
      </table>
    </div>
  );
}

const TONE: Record<string, { badge: 'warning' | 'good' | 'info'; label: string; Icon: typeof Info }> = {
  attention: { badge: 'warning', label: 'Worth a look', Icon: AlertTriangle }, positive: { badge: 'good', label: 'Going well', Icon: CheckCircle2 }, info: { badge: 'info', label: 'Note', Icon: Info },
};

function Patterns({ patterns }: { patterns: any[] }) {
  if (!patterns.length) return <Empty title="No notable patterns in these weeks">Patterns appear when the same thing shows up repeatedly in your records — for example several meeting-heavy Wednesdays or a category that regularly runs over its estimates.</Empty>;
  return (
    <>
      <ul className="divide-y divide-line" aria-label="Patterns">
        {patterns.map((p) => {
          const t = TONE[p.tone] ?? TONE.info;
          return (
            <li key={p.id} className="py-3 first:pt-0 last:pb-0" data-pattern={p.id}>
              <div className="flex flex-wrap items-start gap-2">
                <Badge tone={t.badge} icon={<t.Icon className="size-3.5" aria-hidden />}>{t.label}</Badge>
                <h3 className="min-w-0 flex-1 text-[14px] font-semibold text-ink">{p.title}</h3>
              </div>
              <p className="mt-1.5 text-[12px] font-medium text-ink-3">Facts</p>
              <ul className="mt-0.5 space-y-0.5 text-[13px] text-ink-2">{p.facts.map((f: string, i: number) => <li key={i}>• {f}</li>)}</ul>
              <p className="mt-2 flex gap-1.5 text-[13px] text-ink"><Lightbulb className="mt-0.5 size-3.5 shrink-0 text-accent" aria-hidden /><span><span className="sr-only">Suggestion: </span>{p.suggestion}</span></p>
              <p className="mt-1 text-[12px] text-ink-3">Assumptions: {p.assumptions.join(' ')}</p>
            </li>
          );
        })}
      </ul>
      <p className="mt-4 text-[12px] text-ink-3">Observations, not ratings: they use only this person's recorded work and are never compared with other people. Decide for yourself whether any is worth acting on.</p>
    </>
  );
}

function WeekdayReview({ days, coverage }: { days: any[]; coverage: number }) {
  if (!days.length) return <Empty title="No scheduled working days in range" />;
  const bar = (v: number | null, color: string, label: string) => (
    <div className="flex items-center gap-2">
      <div className="relative h-2.5 flex-1 rounded-full bg-surface-2"><div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${Math.min(100, (v ?? 0) * 100)}%`, background: color }} /></div>
      <span className="w-20 shrink-0 text-right text-[12px] tabular text-ink-2">{pct(v)} <span className="sr-only">{label}</span></span>
    </div>
  );
  return (
    <div>
      <ul className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-2" aria-label="Legend">
        <li className="flex items-center gap-1.5"><span aria-hidden className="size-2.5 rounded-sm" style={{ background: 'var(--c-meeting)' }} />Meetings</li>
        <li className="flex items-center gap-1.5"><span aria-hidden className="size-2.5 rounded-sm" style={{ background: 'var(--c-task)' }} />Focus time</li>
      </ul>
      <ul className="space-y-3">
        {days.map((d) => (
          <li key={d.weekday} data-weekday={d.weekday}>
            <div className="flex items-baseline justify-between gap-2 text-[13px]"><span className="font-medium">{d.label}</span><span className="text-[12px] text-ink-3">{d.days} day(s)</span></div>
            <div className="mt-1 space-y-1">{bar(d.meetingShare, 'var(--c-meeting)', 'meetings')}{bar(d.focusShare, 'var(--c-task)', 'focus time')}</div>
            <p className="mt-0.5 text-[12px] text-ink-3">Meetings over half the day on {d.meetingHeavyDays} of {d.days} · no focus block on {d.wellLoggedWithoutFocus} of {d.wellLoggedDays} well-logged day(s)</p>
          </li>))}
      </ul>
      <p className="mt-3 text-[12px] text-ink-3">"Well-logged" = at least {pct(coverage)} of available time confirmed; days with less are skipped for focus because their time is mostly unknown.</p>
    </div>
  );
}

function EstimateTable({ ea }: { ea: any }) {
  const [by, setBy] = useState<'category' | 'project'>('category');
  const rows = by === 'category' ? ea.byCategory : ea.byProject;
  if (!ea.overall.accepted) return <Empty title="No accepted tasks in these weeks">Estimate accuracy uses tasks that reached Done, with an estimate and logged time.</Empty>;
  const maxR = Math.max(2, ...rows.map((r: any) => r.ratio ?? 0));
  const Row = ({ r, total }: { r: any; total?: boolean }) => (
    <tr className={total ? 'border-t border-line-strong font-medium' : ''}>
      <th scope="row" className="px-4 py-1.5 text-left font-medium">{r.label}</th>
      <td className="pr-3">{r.accepted}</td>
      <td className="pr-3">{r.measured} <span className="text-ink-3">({pct(r.coverage)})</span></td>
      <td className="pr-3">{hm(r.estimateMinutes)}</td>
      <td className="pr-3">{hm(r.actualMinutes)}</td>
      <td className="pr-4">{r.ratio === null ? <span className="text-ink-3">N/A</span> : <div className="flex items-center gap-2">
        <span className="w-9 tabular">{ratioX(r.ratio)}</span>
        <span aria-hidden className="relative hidden h-2 w-20 rounded-full bg-surface-2 sm:block">
          <span className="absolute inset-y-0 left-0 rounded-full bg-accent" style={{ width: `${(r.ratio / maxR) * 100}%` }} />
          <span className="absolute -inset-y-0.5 w-[2px] bg-ink-2" style={{ left: `${(1 / maxR) * 100}%` }} /></span></div>}</td>
    </tr>
  );
  return (
    <div>
      <div className="px-4 pt-3"><Segmented label="Group estimate accuracy by" value={by} onChange={setBy} options={[{ value: 'category', label: 'By category' }, { value: 'project', label: 'By project' }]} /></div>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full min-w-[480px] text-[12.5px] tabular">
          <caption className="sr-only">Estimate accuracy {by === 'category' ? 'by category' : 'by project'}</caption>
          <thead className="text-left text-ink-3"><tr><th scope="col" className="px-4 py-1.5 font-medium">{by === 'category' ? 'Category' : 'Project'}</th><th scope="col" className="pr-3 font-medium">Accepted</th>
            <th scope="col" className="pr-3 font-medium">Measured</th><th scope="col" className="pr-3 font-medium">Estimated</th><th scope="col" className="pr-3 font-medium">Logged</th><th scope="col" className="pr-4 font-medium">Ratio</th></tr></thead>
          <tbody className="divide-y divide-line">{rows.map((r: any) => <Row key={r.key} r={r} />)}</tbody>
          <tfoot><Row r={{ ...ea.overall, label: 'All' }} total /></tfoot>
        </table>
      </div>
      <p className="px-4 py-3 text-[12px] text-ink-3">Measured = accepted tasks with both an estimate and logged time (coverage in brackets). Logged time is the owner's confirmed time only, so unlogged work makes ratios look lower than reality. The marker on each bar is 1.0x.</p>
    </div>
  );
}
