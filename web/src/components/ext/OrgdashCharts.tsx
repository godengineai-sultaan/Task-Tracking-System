import { useId, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { CircleHelp } from 'lucide-react';
import { cx } from '../ui';

export interface Series { key: string; label: string; color: string }
export interface Point { label: string; partial?: boolean; na?: boolean; values: (number | null)[]; lines?: string[] }

export function Legend({ series, className }: { series: Series[]; className?: string }) {
  return (
    <ul className={cx('flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-ink-2', className)}>
      {series.map((s) => <li key={s.key} className="flex items-center gap-1.5"><span aria-hidden className="inline-block size-2.5 rounded-sm" style={{ background: s.color }} />{s.label}</li>)}
    </ul>
  );
}

const W = 320, H = 112, PT = 8, PB = 2;

/**
 * Small-multiple trend chart (one per metric, one y-axis). Line for ratios, bars / stacked bars for counts.
 * Hover or focus + arrow keys moves a crosshair and tooltip; the active week is announced to screen readers.
 * Not Applicable weeks (zero capacity) render as a gap with an N/A mark, never as zero.
 */
export function TrendChart({ title, headline, sub, hint, series, points, kind, format, max }: {
  title: string; headline: ReactNode; sub?: ReactNode; hint?: string; series: Series[]; points: Point[];
  kind: 'line' | 'bar' | 'stack'; format: (v: number | null) => string; max?: number;
}) {
  const [active, setActive] = useState<number | null>(null);
  const id = useId();
  const n = points.length;
  const totals = points.map((p) => (kind === 'stack' ? p.values.reduce<number>((s, v) => s + (v ?? 0), 0) : Math.max(0, ...p.values.map((v) => v ?? 0))));
  const top = Math.max(max ?? 0, ...totals) || 1;
  const band = W / Math.max(n, 1);
  const x = (i: number) => (i + 0.5) * band;
  const y = (v: number) => PT + (1 - v / top) * (H - PT - PB);
  const barW = Math.min(band * 0.56, 26);
  const move = (e: MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setActive(Math.max(0, Math.min(n - 1, Math.floor(((e.clientX - r.left) / r.width) * n))));
  };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const cur = active ?? n - 1;
    const next = e.key === 'ArrowLeft' ? cur - 1 : e.key === 'ArrowRight' ? cur + 1 : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : null;
    if (next === null) return;
    e.preventDefault(); setActive(Math.max(0, Math.min(n - 1, next)));
  };
  const describe = (p: Point) => `${p.label}${p.partial ? ' (partial week)' : ''}: ${p.na ? 'Not applicable, no scheduled working time' : series.map((s, j) => `${series.length > 1 ? `${s.label} ` : ''}${format(p.values[j])}`).join(', ')}`;
  const ap = active !== null ? points[active] : null;
  const leftPct = active !== null ? ((active + 0.5) / n) * 100 : 0;
  return (
    <div className="flex min-w-0 flex-col rounded-xl bg-surface p-3.5 ring-1 ring-line">
      <div className="flex items-start justify-between gap-2">
        <h3 className="flex items-center gap-1 text-[13px] font-medium text-ink-2">{title}
          {hint && <span title={hint} className="text-ink-3"><CircleHelp className="size-3" aria-label={hint} /></span>}</h3>
        <div className="text-right text-[15px] font-semibold leading-tight tabular">{headline}</div>
      </div>
      {sub && <div className="mt-0.5 text-[12px] text-ink-3">{sub}</div>}
      {series.length > 1 && <Legend series={series} className="mt-2" />}
      <div className="relative mt-2" onMouseMove={move} onMouseLeave={() => setActive(null)}
        tabIndex={0} role="group" aria-label={`${title} by week. Use the left and right arrow keys to read each week.`} aria-describedby={`${id}-live`}
        onKeyDown={key} onFocus={() => setActive((a) => a ?? n - 1)} onBlur={() => setActive(null)}>
        <span className="pointer-events-none absolute left-0 top-0 text-[10.5px] text-ink-3 tabular" aria-hidden>{format(top)}</span>
        <svg viewBox={`0 0 ${W} ${H}`} className="block w-full" aria-hidden focusable="false">
          <line x1={0} x2={W} y1={y(top)} y2={y(top)} stroke="var(--line)" strokeDasharray="2 3" />
          <line x1={0} x2={W} y1={H - PB} y2={H - PB} stroke="var(--line-strong)" />
          {active !== null && <line x1={x(active)} x2={x(active)} y1={PT - 4} y2={H - PB} stroke="var(--line-strong)" />}
          {points.map((p, i) => p.na && <text key={`na${i}`} x={x(i)} y={H - PB - 4} textAnchor="middle" fontSize="9" fill="var(--ink-3)">N/A</text>)}
          {kind === 'line' && series.map((s, j) => {
            const segs: string[] = []; let cur = '';
            points.forEach((p, i) => { const v = p.na ? null : p.values[j]; if (v === null || v === undefined) { if (cur) segs.push(cur); cur = ''; } else cur += `${cur ? 'L' : 'M'}${x(i)},${y(v)}`; });
            if (cur) segs.push(cur);
            return (
              <g key={s.key}>
                {segs.map((d, k) => <path key={k} d={d} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />)}
                {points.map((p, i) => { const v = p.na ? null : p.values[j]; return v === null || v === undefined ? null
                  : <circle key={i} cx={x(i)} cy={y(v)} r={active === i ? 5 : 4} fill={p.partial ? 'var(--surface)' : s.color} stroke={p.partial ? s.color : 'var(--surface)'} strokeWidth={2} />; })}
              </g>
            );
          })}
          {kind !== 'line' && points.map((p, i) => {
            if (p.na) return null;
            let base = H - PB;
            const parts = kind === 'stack' ? series.map((s, j) => ({ s, v: p.values[j] ?? 0 })) : [{ s: series[0], v: p.values[0] ?? 0 }];
            return (
              <g key={i} opacity={p.partial ? 0.55 : 1}>
                {parts.filter((x0) => x0.v > 0).map(({ s, v }) => {
                  const h = Math.max(1.5, (v / top) * (H - PT - PB));
                  base -= h;
                  return <rect key={s.key} x={x(i) - barW / 2} y={base} width={barW} height={Math.max(0.5, h - 1)} rx={2} fill={s.color} stroke="var(--surface)" strokeWidth={1} />;
                })}
              </g>
            );
          })}
        </svg>
        {ap && (
          <div aria-hidden className="pointer-events-none absolute bottom-full z-10 mb-1 w-48 rounded-lg bg-surface p-2.5 text-[12px] shadow-xl ring-1 ring-line"
            style={{ left: `clamp(0px, calc(${leftPct}% - 96px), calc(100% - 192px))` }}>
            <div className="font-semibold">{ap.label}{ap.partial && <span className="font-normal text-ink-3"> · partial</span>}</div>
            {ap.na ? <div className="text-ink-3">Not applicable: no scheduled working time</div> : series.map((s, j) => (
              <div key={s.key} className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5">{series.length > 1 && <span className="inline-block size-2 rounded-sm" style={{ background: s.color }} />}{series.length > 1 ? s.label : title}</span>
                <span className="tabular font-medium">{format(ap.values[j])}</span>
              </div>))}
            {!ap.na && ap.lines?.map((l) => <div key={l} className="text-ink-3">{l}</div>)}
          </div>
        )}
        <div id={`${id}-live`} className="sr-only" aria-live="polite">{ap ? describe(ap) : ''}</div>
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-ink-3 tabular" aria-hidden>
        <span>{points[0]?.label}</span>{n > 1 && <span>{points[n - 1]?.label}</span>}
      </div>
    </div>
  );
}

/** Labelled horizontal bars (single series: values are printed, so no legend is needed). */
export function BarList({ items, color = 'var(--c-task)', label }: { items: { key: string; label: string; value: number; detail?: string }[]; color?: string; label: string }) {
  const top = Math.max(1, ...items.map((i) => i.value));
  return (
    <ul className="space-y-2.5" aria-label={label}>
      {items.map((i) => (
        <li key={i.key} className="text-[13px]">
          <div className="flex items-baseline justify-between gap-2"><span className="font-medium">{i.label}</span><span className="tabular text-ink-2">{i.value}</span></div>
          <div className="mt-1 h-2 rounded-full bg-surface-2"><div className="h-full rounded-full" style={{ width: `${(i.value / top) * 100}%`, background: color, minWidth: i.value ? 4 : 0 }} /></div>
          {i.detail && <div className="mt-0.5 text-[12px] text-ink-3">{i.detail}</div>}
        </li>
      ))}
    </ul>
  );
}

/** Vertical histogram with counts printed above each bar. */
export function Histogram({ items, label }: { items: { key: string; label: string; count: number }[]; label: string }) {
  const top = Math.max(1, ...items.map((i) => i.count));
  return (
    <div role="img" aria-label={`${label}: ${items.map((i) => `${i.label} ${i.count}`).join(', ')}`}>
      <div className="flex h-32 items-end gap-2" aria-hidden>
        {items.map((i) => (
          <div key={i.key} className="flex min-w-0 flex-1 flex-col items-center justify-end gap-1">
            <span className="text-[12px] font-medium tabular text-ink">{i.count}</span>
            <div className="w-full max-w-[44px] rounded-t-[4px]" style={{ height: `${(i.count / top) * 96}px`, minHeight: i.count ? 3 : 0, background: 'var(--c-task)' }} />
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex gap-2 border-t border-line pt-1.5" aria-hidden>
        {items.map((i) => <span key={i.key} className="min-w-0 flex-1 text-center text-[11px] leading-tight text-ink-3">{i.label}</span>)}
      </div>
    </div>
  );
}
