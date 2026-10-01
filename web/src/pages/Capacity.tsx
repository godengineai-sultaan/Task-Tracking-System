import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, qs } from '../lib/api';
import { fmtDate, hm, pct } from '../lib/format';
import { useMe } from '../lib/session';
import { Avatar, Badge, Callout, Card, ErrorState, Input, PageHeader, Segmented, Skeleton, cx } from '../components/ui';

export default function Capacity() {
  const me = useMe();
  const [start, setStart] = useState(me.today); const [days, setDays] = useState('10');
  const q = useQuery({ queryKey: ['capacity', start, days], queryFn: () => api.get(`/api/team/capacity${qs({ start, days })}`) });
  return (
    <div>
      <PageHeader title="Team capacity" subtitle="Available working time (schedule − holidays − leave) against estimated open commitments."
        actions={<><Input aria-label="Start date" type="date" className="h-9 w-40" value={start} onChange={(e) => setStart(e.target.value)} />
          <Segmented label="Horizon" value={days} onChange={setDays} options={[{ value: '5', label: '1 wk' }, { value: '10', label: '2 wks' }, { value: '20', label: '4 wks' }]} /></>} />
      {q.isLoading ? <Skeleton className="h-96" /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : (
        <Card padded={false}>
          <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-[13px]">
            <thead className="border-b border-line text-left text-[12px] text-ink-3"><tr><th className="px-4 py-2 font-medium">Person</th><th className="px-3 py-2 font-medium">Working days</th>
              <th className="px-3 py-2 font-medium">Available</th><th className="px-3 py-2 font-medium">Estimated open work</th><th className="w-[26%] px-3 py-2 font-medium">Load</th><th className="px-3 py-2 font-medium">Calendar</th><th className="px-3 py-2 font-medium">Allocation assumptions</th></tr></thead>
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
                  <td className="px-3 py-2.5"><div className="flex gap-[2px]" aria-label="Daily availability">{p.daily.map((d: any) => (
                    <span key={d.date} title={`${fmtDate(d.date, { weekday: 'short', day: 'numeric', month: 'short' })}: ${d.minutes ? hm(d.minutes) : d.status}`}
                      className={cx('h-5 w-2 rounded-sm', d.minutes === 0 ? (d.status === 'leave' || d.status === 'holiday' ? 'hatch' : 'bg-surface-2') : d.status === 'partial_leave' ? 'bg-[var(--c-task)] opacity-50' : 'bg-[var(--c-task)]')} />))}</div></td>
                  <td className="px-3 py-2.5 text-[12px]">{p.allocations.length === 0 ? <span className="text-ink-3">—</span> : p.allocations.map((a: any, i: number) => <div key={i}><Badge>{a.project} {a.percent}%</Badge>{a.assumption && <span className="ml-1 text-ink-3">{a.assumption}</span>}</div>)}</td>
                </tr>);
            })}</tbody></table></div>
          <div className="border-t border-line p-4"><Callout tone="neutral">{q.data.note} Leave and holidays are removed from availability, so they never inflate load. Calendar strip: solid = working day, faded = half-day leave, hatched = leave/holiday.</Callout></div>
        </Card>)}
    </div>
  );
}
