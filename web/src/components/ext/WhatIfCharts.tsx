import { useState, type ReactNode } from 'react';
import { fmtDate, hm, pct } from '../../lib/format';
import { Avatar, Segmented, cx } from '../ui';

export interface SideLoad {
  availableMinutes: number; workingDays: number; demandMinutes: number; scheduledMinutes: number; spareMinutes: number; overflowMinutes: number;
  load: number | null; openTasks: number; lateTasks: number; overdueTasks: number;
  days: { date: string; status: string; capacity: number; used: number }[];
}
export interface PersonResult { id: string; name: string; title: string; allocationPercent: number; simulatedLeaveDays: number; baseline: SideLoad; scenario: SideLoad }

const SERIES = [
  { key: 'scheduled', label: 'Scheduled open work', swatch: 'bg-[var(--c-task)]' },
  { key: 'spare', label: 'Unclaimed capacity', swatch: 'bg-surface-3 ring-1 ring-inset ring-line-strong' },
  { key: 'overflow', label: 'Work that does not fit', swatch: 'bg-serious' },
] as const;

function Legend({ items }: { items: { label: string; swatch: string }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-2">
      {items.map((s) => <li key={s.label} className="flex items-center gap-1.5"><span aria-hidden className={cx('inline-block size-2.5 rounded-sm', s.swatch)} />{s.label}</li>)}
    </ul>
  );
}

/** Focusable element with a hover/focus tooltip. */
function Tip({ text, children, className }: { text: string; children: ReactNode; className?: string }) {
  return (
    <div className={cx('group relative', className)} tabIndex={0} role="img" aria-label={text}>
      {children}
      <div role="tooltip" className="pointer-events-none absolute bottom-full left-0 z-20 mb-1.5 hidden w-max max-w-[min(18rem,80vw)] rounded-lg bg-ink px-2.5 py-1.5 text-[12px] leading-snug text-bg shadow-lg group-hover:block group-focus:block">
        {text}
      </div>
    </div>
  );
}

function LoadBar({ side, label, scale }: { side: SideLoad; label: string; scale: number }) {
  const w = (m: number) => `${scale ? (m / scale) * 100 : 0}%`;
  const text = `${label}: ${hm(side.scheduledMinutes)} scheduled of ${hm(side.availableMinutes)} available, ${hm(side.spareMinutes)} unclaimed`
    + `${side.overflowMinutes ? `, ${hm(side.overflowMinutes)} does not fit` : ''}; ${side.lateTasks} projected late`;
  return (
    <div className="flex items-center gap-2">
      <span className="w-[4.5rem] shrink-0 text-[12px] text-ink-3">{label}</span>
      <Tip text={text} className="flex-1 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-accent">
        <div className="relative flex h-3.5 w-full items-stretch">
          {side.scheduledMinutes > 0 && <div className="h-full rounded-l bg-[var(--c-task)]" style={{ width: w(side.scheduledMinutes) }} />}
          {side.spareMinutes > 0 && <div className={cx('h-full bg-surface-3 ring-1 ring-inset ring-line-strong', !side.overflowMinutes && 'rounded-r', !side.scheduledMinutes && 'rounded-l')} style={{ width: w(side.spareMinutes) }} />}
          {side.overflowMinutes > 0 && <div className="h-full rounded-r bg-serious" style={{ width: w(side.overflowMinutes), minWidth: 3 }} />}
          {side.availableMinutes === 0 && <span className="ml-2 self-center text-[12px] leading-none text-ink-3">No available time</span>}
        </div>
      </Tip>
      <span className={cx('w-14 shrink-0 text-right text-[12px] tabular', side.lateTasks ? 'font-medium text-critical-ink' : 'text-ink-3')}>{side.lateTasks} late</span>
    </div>
  );
}

function DayStrip({ side, label }: { side: SideLoad; label: string }) {
  const working = side.days.filter((d) => d.capacity > 0).length;
  return (
    <div className="flex items-center gap-2">
      <span className="w-[4.5rem] shrink-0 text-[11px] text-ink-3">{label}</span>
      <div className="flex h-4 min-w-0 flex-1 gap-px" role="img" aria-label={`${label}: ${working} days with available time, ${hm(side.scheduledMinutes)} scheduled`}>
        {side.days.map((d) => {
          const title = `${fmtDate(d.date, { weekday: 'short', day: 'numeric', month: 'short' })}: ${d.capacity ? `${hm(d.used)} of ${hm(d.capacity)} used` : d.status.replace('_', ' ')}`;
          if (!d.capacity) return <span key={d.date} title={title} className={cx('min-w-0 flex-1 rounded-[2px]',
            d.status === 'simulated_leave' ? 'hatch ring-1 ring-inset ring-serious' : d.status === 'leave' || d.status === 'holiday' ? 'hatch' : 'bg-transparent')} />;
          return (
            <span key={d.date} title={title} className="relative min-w-0 flex-1 overflow-hidden rounded-[2px] bg-surface-3">
              <span className="absolute inset-x-0 bottom-0 bg-[var(--c-task)]" style={{ height: `${Math.min(100, (d.used / d.capacity) * 100)}%` }} />
            </span>);
        })}
      </div>
    </div>
  );
}

/** Baseline vs scenario load per person: stacked bars (chart) or a table. */
export function PersonLoadChart({ people }: { people: PersonResult[] }) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const scale = Math.max(1, ...people.flatMap((p) => [p.baseline, p.scenario].map((s) => Math.max(s.availableMinutes, s.demandMinutes))));
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <Legend items={SERIES as any} />
        <Segmented label="Load view" value={view} onChange={setView} options={[{ value: 'chart', label: 'Chart' }, { value: 'table', label: 'Table' }]} />
      </div>
      {view === 'chart' ? (
        <ul className="divide-y divide-line">
          {people.map((p) => (
            <li key={p.id} className="py-3 first:pt-0 last:pb-0">
              <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
                <Avatar name={p.name} size={22} /><span className="text-[13px] font-medium">{p.name}</span>
                {p.allocationPercent !== 100 && <span className="rounded bg-accent-soft px-1.5 text-[11px] font-medium text-accent-ink">{p.allocationPercent}% allocation</span>}
                {p.simulatedLeaveDays > 0 && <span className="rounded bg-serious-soft px-1.5 text-[11px] font-medium text-serious-ink">{p.simulatedLeaveDays} simulated leave day{p.simulatedLeaveDays === 1 ? '' : 's'}</span>}
                <span className="ml-auto text-[12px] text-ink-3 tabular">load {pct(p.baseline.load)} → <span className={cx((p.scenario.load ?? 0) > 1 ? 'font-medium text-serious-ink' : 'text-ink-2')}>{pct(p.scenario.load)}</span></span>
              </div>
              <div className="space-y-1.5">
                <LoadBar side={p.baseline} label="Baseline" scale={scale} />
                <LoadBar side={p.scenario} label="Scenario" scale={scale} />
              </div>
              <div className="mt-2 space-y-1">
                <DayStrip side={p.baseline} label="Days before" />
                <DayStrip side={p.scenario} label="Days after" />
              </div>
            </li>))}
        </ul>
      ) : (
        <div className="relative overflow-x-auto" tabIndex={0} role="region" aria-label="Load table">
          <table className="w-full min-w-[640px] text-[13px]">
            <caption className="sr-only">Baseline and scenario load per person</caption>
            <thead className="border-b border-line text-left text-[12px] text-ink-3"><tr>
              <th scope="col" className="py-2 pr-3 font-medium">Person</th><th scope="col" className="px-2 py-2 font-medium">Available</th>
              <th scope="col" className="px-2 py-2 font-medium">Scheduled</th><th scope="col" className="px-2 py-2 font-medium">Unclaimed</th>
              <th scope="col" className="px-2 py-2 font-medium">Does not fit</th><th scope="col" className="px-2 py-2 font-medium">Projected late</th><th scope="col" className="px-2 py-2 font-medium">Load</th></tr></thead>
            <tbody className="divide-y divide-line">{people.map((p) => (
              <tr key={p.id}>
                <th scope="row" className="py-2 pr-3 text-left font-medium">{p.name}</th>
                {([['availableMinutes', hm], ['scheduledMinutes', hm], ['spareMinutes', hm], ['overflowMinutes', hm], ['lateTasks', String], ['load', pct]] as const).map(([k, f]) => (
                  <td key={k} className="px-2 py-2 tabular">{(f as any)(p.baseline[k])} → <span className="font-medium">{(f as any)(p.scenario[k])}</span></td>))}
              </tr>))}</tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-[12px] text-ink-3">Day strips: bar height = share of that day's available time filled by open work; hatched = leave or holiday; outlined hatch = simulated leave; blank = non-working day.</p>
    </div>
  );
}
