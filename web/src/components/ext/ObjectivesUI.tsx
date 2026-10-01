import { useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, CircleHelp, Flag, XCircle } from 'lucide-react';
import { api } from '../../lib/api';
import { fmtDate, pct } from '../../lib/format';
import { Badge, cx } from '../ui';

/** Shared bits for the objectives pages (status vocabulary, progress meter, confidence trend). */
export type ForecastStatus = 'on_track' | 'at_risk' | 'off_track' | 'insufficient_data';
export const FORECAST: Record<ForecastStatus, { label: string; tone: 'good' | 'warning' | 'critical' | 'neutral'; bar: string }> = {
  on_track: { label: 'On track', tone: 'good', bar: 'bg-good' },
  at_risk: { label: 'At risk', tone: 'warning', bar: 'bg-warning' },
  off_track: { label: 'Off track', tone: 'critical', bar: 'bg-critical' },
  insufficient_data: { label: 'Insufficient data', tone: 'neutral', bar: 'bg-ink-3' },
};
export const LIFECYCLE: Record<string, { label: string; tone: 'good' | 'serious' | 'neutral' | 'info' }> = {
  active: { label: 'Active', tone: 'info' }, achieved: { label: 'Achieved', tone: 'good' }, missed: { label: 'Missed', tone: 'serious' }, dropped: { label: 'Dropped', tone: 'neutral' },
};
export const KR_KIND: Record<string, string> = { milestone_completion: 'Milestone completion', task_completion: 'Task completion', manual: 'Reported value' };
export const BASIS: Record<string, string> = { estimate: 'weighted by estimates', count: 'weighted by task count', milestones: 'by milestones', manual: 'reported', none: 'no data' };

export function useObjectivesOverview(enabled = true) {
  return useQuery({ queryKey: ['objectives-overview'], queryFn: () => api.get('/api/objectives/overview'), enabled });
}

export function ForecastBadge({ status, lifecycle, size = 'sm' }: { status?: ForecastStatus | null; lifecycle?: string; size?: 'sm' | 'lg' }) {
  if (!status) {
    const l = LIFECYCLE[lifecycle ?? 'active'] ?? LIFECYCLE.active;
    return <Badge tone={l.tone} icon={<Flag className="size-3.5" aria-hidden />} className={size === 'lg' ? 'px-2.5 py-1 text-[13px]' : ''}>{l.label}</Badge>;
  }
  const f = FORECAST[status];
  const Icon = status === 'on_track' ? CheckCircle2 : status === 'at_risk' ? AlertTriangle : status === 'off_track' ? XCircle : CircleHelp;
  return <Badge tone={f.tone} className={size === 'lg' ? 'px-2.5 py-1 text-[13px]' : ''} icon={<Icon className={size === 'lg' ? 'size-4' : 'size-3.5'} aria-hidden />}>{f.label}</Badge>;
}

/** Progress meter with an optional "expected by elapsed time" marker. Unknown progress is hatched, never shown as zero. */
export function ProgressMeter({ value, expected, status, label, showLegend }: { value: number | null; expected?: number | null; status?: ForecastStatus | null; label: string; showLegend?: boolean }) {
  const fill = status ? FORECAST[status].bar : 'bg-[var(--c-task)]';
  return (
    <div>
      <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value === null ? undefined : Math.round(value * 100)}
        aria-valuetext={value === null ? 'Not measurable yet' : `${pct(value)}${expected != null ? `, expected ${pct(expected)} by elapsed time` : ''}`}
        className={cx('relative h-2 overflow-hidden rounded-full bg-surface-2 ring-1 ring-inset ring-line', value === null && 'hatch')}>
        {value !== null && <div className={cx('h-full rounded-full', fill)} style={{ width: `${Math.max(value > 0 ? 2 : 0, Math.min(100, value * 100))}%` }} />}
        {expected != null && <div aria-hidden className="absolute inset-y-[-2px] w-0.5 bg-ink" style={{ left: `calc(${Math.min(100, expected * 100)}% - 1px)` }} />}
      </div>
      {showLegend && expected != null && (
        <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-3">
          <span className="inline-flex items-center gap-1.5"><span aria-hidden className={cx('inline-block h-2 w-4 rounded-full', fill)} />Progress {pct(value)}</span>
          <span className="inline-flex items-center gap-1.5"><span aria-hidden className="inline-block h-3 w-0.5 bg-ink" />Expected by elapsed time {pct(expected)}</span>
        </div>)}
    </div>
  );
}

/** Key for the compact progress meters in lists (progress bar, expected-by-time tick, hatched when not measurable). */
export function MeterKey({ className }: { className?: string }) {
  return (
    <p className={cx('flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-ink-3', className)}>
      <span className="inline-flex items-center gap-1.5"><span aria-hidden className="inline-block h-2 w-4 rounded-full bg-ink-3" />Progress, coloured by status</span>
      <span className="inline-flex items-center gap-1.5"><span aria-hidden className="inline-block h-3 w-0.5 bg-ink" />Expected by elapsed time</span>
      <span className="inline-flex items-center gap-1.5"><span aria-hidden className="hatch inline-block h-2 w-4 rounded-full ring-1 ring-inset ring-line" />Not measurable yet</span>
    </p>
  );
}

export function periodText(start: string | null, end: string | null) {
  if (!start && !end) return 'No period set';
  const o: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' };
  return `${start ? fmtDate(start, o) : 'No start'} – ${end ? fmtDate(end, o) : 'no end date'}`;
}

/** "2026-W40" -> "Week of 28 Sept 2026" (ISO week keys from the weekly snapshot). */
export function weekLabel(key: string) {
  const m = /^(\d{4})-W(\d{2})$/.exec(key);
  if (!m) return key;
  const jan4 = Date.UTC(+m[1], 0, 4);
  const monday = new Date(jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * 864e5 + (+m[2] - 1) * 7 * 864e5);
  return `Week of ${fmtDate(monday.toISOString().slice(0, 10), { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

/** Confidence (1-5) over time, oldest to newest. Accessible: focusable points with tooltips plus a table view.
 *  Axis labels are HTML so they do not stretch with the SVG (which scales to the card width). */
export function ConfidenceTrend({ checkins }: { checkins: { id: string; confidence: number; created_at: string; author_name?: string | null }[] }) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const [tip, setTip] = useState<number | null>(null);
  const titleId = useId();
  const pts = [...checkins].reverse().slice(-20);
  if (pts.length < 2) return <p className="text-[13px] text-ink-3">{pts.length ? 'One check-in so far. The trend appears after the second.' : 'No check-ins yet.'}</p>;
  const W = 600, H = 150, px = 12, py = 12;
  const x = (i: number) => px + (i * (W - 2 * px)) / (pts.length - 1);
  const y = (c: number) => py + ((5 - c) * (H - 2 * py)) / 4;
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p.confidence)}`).join(' ');
  return (
    <figure aria-labelledby={titleId}>
      <div className="mb-2 flex items-start justify-between gap-2">
        <figcaption id={titleId} className="text-[12px] font-medium text-ink-3">Confidence trend (1 = low, 5 = high), last {pts.length} check-ins</figcaption>
        <button type="button" className="shrink-0 whitespace-nowrap rounded text-[12px] font-medium text-accent-ink hover:underline" onClick={() => setView(view === 'chart' ? 'table' : 'chart')}>
          {view === 'chart' ? 'Show table' : 'Show chart'}</button>
      </div>
      {view === 'chart' ? (
        <div className="relative pl-5">
          {[1, 2, 3, 4, 5].map((c) => <span key={c} aria-hidden className="absolute left-0 -translate-y-1/2 text-[11px] leading-none text-ink-3 tabular" style={{ top: `${y(c)}px` }}>{c}</span>)}
          <div className="relative">
            <svg viewBox={`0 0 ${W} ${H}`} className="block h-[150px] w-full" preserveAspectRatio="none" role="img" aria-label={`Confidence from ${pts[0].confidence} to ${pts[pts.length - 1].confidence} over ${pts.length} check-ins`}>
              {[1, 2, 3, 4, 5].map((c) => <line key={c} x1={0} x2={W} y1={y(c)} y2={y(c)} stroke="var(--line)" strokeWidth={1} vectorEffect="non-scaling-stroke" />)}
              <path d={path} fill="none" stroke="var(--c-task)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
            </svg>
            {pts.map((p, i) => (
              <button key={p.id} type="button" aria-label={`${fmtDate(p.created_at)}: confidence ${p.confidence} of 5${p.author_name ? ` by ${p.author_name}` : ''}`}
                onMouseEnter={() => setTip(i)} onMouseLeave={() => setTip(null)} onFocus={() => setTip(i)} onBlur={() => setTip(null)}
                className="absolute size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-surface bg-[var(--c-task)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                style={{ left: `${(x(i) / W) * 100}%`, top: `${y(p.confidence)}px` }} />))}
            {tip !== null && (
              <div role="tooltip" className="pointer-events-none absolute z-10 -translate-x-1/2 whitespace-nowrap rounded-md bg-ink px-2 py-1 text-[12px] text-surface shadow"
                style={{ left: `${Math.min(80, Math.max(20, (x(tip) / W) * 100))}%`, top: `${y(pts[tip].confidence) + 12}px` }}>
                {fmtDate(pts[tip].created_at)} · {pts[tip].confidence}/5{pts[tip].author_name ? ` · ${pts[tip].author_name}` : ''}
              </div>)}
          </div>
          <div aria-hidden className="mt-1 flex justify-between text-[11px] text-ink-3"><span>{fmtDate(pts[0].created_at)}</span><span>{fmtDate(pts[pts.length - 1].created_at)}</span></div>
        </div>
      ) : (
        <table className="w-full text-[13px]">
          <caption className="sr-only">Check-in confidence, newest first</caption>
          <thead className="text-left text-[12px] text-ink-3"><tr><th className="py-1 font-medium">Date</th><th className="py-1 font-medium">Confidence</th><th className="py-1 font-medium">By</th></tr></thead>
          <tbody className="divide-y divide-line">{[...pts].reverse().map((p) => <tr key={p.id}><td className="py-1.5">{fmtDate(p.created_at)}</td><td className="tabular">{p.confidence}/5</td><td>{p.author_name ?? '—'}</td></tr>)}</tbody>
        </table>
      )}
    </figure>
  );
}
