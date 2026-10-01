import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { FlaskConical } from 'lucide-react';
import { api, qs } from '../lib/api';
import { fmtDate, hm, pct } from '../lib/format';
import { useMe } from '../lib/session';
import { Avatar, Badge, Callout, Card, ErrorState, Input, PageHeader, Segmented, Skeleton, cx } from '../components/ui';

export default function Capacity() {
  const me = useMe();
  const [start, setStart] = useState(me.today); const [days, setDays] = useState('10');
  const q = useQuery({ queryKey: ['capacity', start, days], queryFn: () => api.get(`/api/team/capacity${qs({ start, days })}`) });
  // Baseline projection from the what-if planner (read-only): open tasks projected to finish after their due date.
  const horizon = ({ '5': 7, '10': 14, '20': 28 } as Record<string, number>)[days] ?? 14;
  const ids: string[] = q.data?.people.map((p: any) => p.user.id) ?? [];
  const proj = useQuery({ queryKey: ['whatif-sim', 'capacity', start, horizon, ids], enabled: ids.length > 0, retry: false,
    queryFn: () => api.post('/api/whatif/simulate', { start, horizonDays: horizon, people: ids, changes: [] }) });
  const projected = new Map<string, any>((proj.data?.people ?? []).map((p: any) => [p.id, p.baseline]));
  return (
    <div>
      <PageHeader title="Team capacity" subtitle="Available working time (schedule − holidays − leave) against estimated open commitments."
        actions={<><Input aria-label="Start date" type="date" className="h-9 w-40" value={start} onChange={(e) => setStart(e.target.value)} />
          <Segmented label="Horizon" value={days} onChange={setDays} options={[{ value: '5', label: '1 wk' }, { value: '10', label: '2 wks' }, { value: '20', label: '4 wks' }]} />
          <Link to={`/capacity/what-if${qs({ start, horizon })}`} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-surface px-3.5 text-sm font-medium text-ink ring-1 ring-inset ring-line-strong hover:bg-surface-2">
            <FlaskConical className="size-4" aria-hidden />What-if</Link></>} />
      {q.isLoading ? <Skeleton className="h-96" /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : (
        <Card padded={false}>
          <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-[13px]">
            <thead className="border-b border-line text-left text-[12px] text-ink-3"><tr><th className="px-4 py-2 font-medium">Person</th><th className="px-3 py-2 font-medium">Working days</th>
              <th className="px-3 py-2 font-medium">Available</th><th className="px-3 py-2 font-medium">Estimated open work</th><th className="w-[26%] px-3 py-2 font-medium">Load</th><th className="px-3 py-2 font-medium" title={`Open tasks projected to finish after their due date within ${horizon} days, filling available time in due-date order (what-if baseline).`}>Projected late</th><th className="px-3 py-2 font-medium">Calendar</th><th className="px-3 py-2 font-medium">Allocation assumptions</th></tr></thead>
            <tbody className="divide-y divide-line">{q.data.people.map((p: any) => {
              const load = p.load; const over = load !== null && load > 1;
              return (
                <tr key={p.user.id} className="align-top">
                  <td className="px-4 py-2.5"><div className="flex items-center gap-2"><Avatar name={p.user.name} size={24} /><div><div className="font-medium">{p.user.name}</div><div className="text-[12px] text-ink-3">{p.user.department ?? ''}</div></div></div></td>
                  <td className="px-3 py-2.5 tabular">{p.horizon.workingDays}{p.leaveOrHolidayDays > 0 && <div className="text-[11px] text-ink-3">{p.leaveOrHolidayDays} leave/holiday</div>}</td>
                  <td className="px-3 py-2.5 tabular">{hm(p.availableMinutes)}</td>
                  <td className="px-3 py-2.5 tabular">{hm(p.estimatedMinutes)}<div className="text-[11px] text-ink-3">{p.openTasks} open · {pct(p.estimateCoverage)} estimated</div>{p.blocked > 0 && <div className="text-[11px] text-critical-ink">{p.blocked} blocked</div>}</td>
                  <td className="px-3 py-2.5">
                    {load === null ? <span className="text-ink-3">N/A — no capacity</span> : <>
                      <div className="relative h-2.5 w-full rounded-full bg-surface-2" role="img" aria-label={`Load ${pct(load)}`}>
                        <div className={cx('h-full rounded-full', over ? 'bg-serious' : 'bg-[var(--c-task)]')} style={{ width: `${Math.min(100, load * 100)}%` }} />
                        <div aria-hidden className="absolute top-[-3px] h-4 w-[2px] bg-ink-2" style={{ left: '100%' }} />
                      </div>
                      <div className={cx('mt-1 text-[12px] tabular', over ? 'font-medium text-serious-ink' : 'text-ink-2')}>{pct(load)}{over && ' · over capacity'}</div></>}
                  </td>
                  <td className="px-3 py-2.5 tabular" data-testid="projected-late">{proj.isLoading ? <Skeleton className="h-4 w-8" /> : proj.error || !projected.has(p.user.id) ? <span className="text-ink-3" title={proj.error ? String((proj.error as any).message) : undefined}>—</span> : (() => {
                    const b = projected.get(p.user.id);
                    return <><span className={cx(b.lateTasks ? 'font-medium text-critical-ink' : 'text-ink-2')}>{b.lateTasks}</span>
                      {b.overdueTasks > 0 && <div className="text-[11px] text-ink-3">{b.overdueTasks} already overdue</div>}
                      {b.overflowMinutes > 0 && <div className="text-[11px] text-ink-3">{hm(b.overflowMinutes)} does not fit</div>}</>;
                  })()}</td>
                  <td className="px-3 py-2.5"><div className="flex gap-[2px]" aria-label="Daily availability">{p.daily.map((d: any) => (
                    <span key={d.date} title={`${fmtDate(d.date, { weekday: 'short', day: 'numeric', month: 'short' })}: ${d.minutes ? hm(d.minutes) : d.status}`}
                      className={cx('h-5 w-2 rounded-sm', d.minutes === 0 ? (d.status === 'leave' || d.status === 'holiday' ? 'hatch' : 'bg-surface-2') : d.status === 'partial_leave' ? 'bg-[var(--c-task)] opacity-50' : 'bg-[var(--c-task)]')} />))}</div></td>
                  <td className="px-3 py-2.5 text-[12px]">{p.allocations.length === 0 ? <span className="text-ink-3">—</span> : p.allocations.map((a: any, i: number) => <div key={i}><Badge>{a.project} {a.percent}%</Badge>{a.assumption && <span className="ml-1 text-ink-3">{a.assumption}</span>}</div>)}</td>
                </tr>);
            })}</tbody></table></div>
          <div className="border-t border-line p-4"><Callout tone="neutral">{q.data.note} Leave and holidays are removed from availability, so they never inflate load. Calendar strip: solid = working day, faded = half-day leave, hatched = leave/holiday. Projected late = open tasks that would finish after their due date if each person works through them in due-date order (what-if baseline; tasks without an estimate assumed to take 1h).</Callout></div>
        </Card>)}
    </div>
  );
}
