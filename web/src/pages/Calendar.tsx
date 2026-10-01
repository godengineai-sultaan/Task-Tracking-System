import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Navigate } from 'react-router';
import { Trash2 } from 'lucide-react';
import { api, qs } from '../lib/api';
import { fmtDate } from '../lib/format';
import { useMe, useRoles } from '../lib/session';
import { Badge, Button, Card, Checkbox, ErrorState, Field, IconButton, Input, PageHeader, Select, Skeleton, useToast } from '../components/ui';
import { HolidayImport, RecentHolidayImports } from '../components/ext/CalendarHolidayImport';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const toHm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const toMin = (s: string) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };

export default function CalendarPage() {
  const me = useMe(); const r = useRoles();
  const [target, setTarget] = useState<string>(me.user.id);
  const people = useQuery({ queryKey: ['people'], queryFn: () => api.get('/api/people'), enabled: r.canReview || r.sysAdmin });
  if (r.customer) return <Navigate to="/portal" replace />;
  return (
    <div>
      <PageHeader title="Calendar & leave" subtitle="Working schedules, holidays and leave define available capacity. Leave days show as Not Applicable in reports — never as zero productivity." />
      <div className="grid gap-4 lg:grid-cols-2">
        <Schedule userId={target === 'tenant' ? null : target} canEditTenant={r.sysAdmin}
          header={(r.canReview || r.sysAdmin) && <Select aria-label="Whose schedule" className="h-8 w-48" value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value={me.user.id}>My schedule</option>{r.sysAdmin && <option value="tenant">Organization default</option>}
            {(people.data ?? []).filter((p: any) => p.id !== me.user.id).map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>} />
        <Leave people={people.data ?? []} />
        <Holidays canEdit={r.sysAdmin} />
      </div>
    </div>
  );
}

function Schedule({ userId, header, canEditTenant }: { userId: string | null; header: React.ReactNode; canEditTenant: boolean }) {
  const qc = useQueryClient(); const toast = useToast(); const me = useMe();
  const q = useQuery({ queryKey: ['schedule', userId], queryFn: () => api.get(`/api/calendar/schedule${qs({ userId: userId ?? undefined })}`) });
  const [rows, setRows] = useState<any[]>([]); const [useDefault, setUseDefault] = useState(false);
  useEffect(() => {
    if (!q.data) return;
    setUseDefault(!!userId && q.data.usesDefault);
    setRows(DAYS.map((_, i) => { const s = q.data.schedule.find((x: any) => x.weekday === i + 1); return { weekday: i + 1, on: !!s, start: toHm(s?.start_minute ?? 570), end: toHm(s?.end_minute ?? 1080), brk: s?.break_minutes ?? 60 }; }));
  }, [q.data, userId]);
  const save = useMutation({ mutationFn: () => api.put('/api/calendar/schedule', { userId, useDefault, days: rows.filter((r) => r.on).map((r) => ({ weekday: r.weekday, startMinute: toMin(r.start), endMinute: toMin(r.end), breakMinutes: Number(r.brk) })) }),
    onSuccess: () => { qc.invalidateQueries(); toast({ tone: 'good', text: 'Schedule saved — reports recompute from it' }); }, onError: (e: any) => toast({ tone: 'critical', text: e.message }) });
  const editable = userId === null ? canEditTenant : userId === me.user.id || canEditTenant;
  return (
    <Card title="Working schedule" actions={header}>
      {q.isLoading ? <Skeleton className="h-48" /> : q.error ? <ErrorState error={q.error} /> : <>
        {userId && <div className="mb-3"><Checkbox checked={useDefault} onChange={setUseDefault} disabled={!editable} label="Use the organization default schedule" /></div>}
        <table className="w-full text-[13px]"><thead className="text-left text-[12px] text-ink-3"><tr><th className="pb-1 font-medium">Day</th><th className="font-medium">Start</th><th className="font-medium">End</th><th className="font-medium">Break (min)</th></tr></thead>
          <tbody>{rows.map((r, i) => (
            <tr key={r.weekday} className={useDefault ? 'opacity-50' : ''}>
              <td className="py-1"><Checkbox checked={r.on} disabled={useDefault || !editable} onChange={(v) => setRows(rows.map((x, j) => (j === i ? { ...x, on: v } : x)))} label={DAYS[i]} /></td>
              <td><Input aria-label={`${DAYS[i]} start`} type="time" className="h-8 w-28" disabled={!r.on || useDefault || !editable} value={r.start} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)))} /></td>
              <td><Input aria-label={`${DAYS[i]} end`} type="time" className="h-8 w-28" disabled={!r.on || useDefault || !editable} value={r.end} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)))} /></td>
              <td><Input aria-label={`${DAYS[i]} break`} type="number" min={0} className="h-8 w-20" disabled={!r.on || useDefault || !editable} value={r.brk} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, brk: e.target.value } : x)))} /></td>
            </tr>))}</tbody></table>
        {editable ? <Button className="mt-3" variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save schedule</Button> : <p className="mt-3 text-[12px] text-ink-3">Only an administrator can change this schedule.</p>}
      </>}
    </Card>
  );
}

function Leave({ people }: { people: any[] }) {
  const qc = useQueryClient(); const toast = useToast(); const me = useMe(); const r = useRoles();
  const q = useQuery({ queryKey: ['leave'], queryFn: () => api.get('/api/calendar/leave') });
  const [f, setF] = useState({ userId: me.user.id, startDate: me.today, endDate: me.today, portion: 'full', kind: 'leave', note: '' });
  const add = useMutation({ mutationFn: () => api.post('/api/calendar/leave', f), onSuccess: () => { qc.invalidateQueries(); toast({ tone: 'good', text: 'Leave recorded' }); }, onError: (e: any) => toast({ tone: 'critical', text: e.message }) });
  const del = useMutation({ mutationFn: (id: string) => api.del(`/api/calendar/leave/${id}`), onSuccess: () => qc.invalidateQueries(), onError: (e: any) => toast({ tone: 'critical', text: e.message }) });
  const others = people.filter((p) => p.id !== me.user.id && (r.sysAdmin || me.user.managedUserIds.includes(p.id)));
  return (
    <Card title="Leave">
      <div className="grid gap-3 sm:grid-cols-2">
        {others.length > 0 && <Field label="Person">{(id) => <Select id={id} value={f.userId} onChange={(e) => setF({ ...f, userId: e.target.value })}><option value={me.user.id}>Me</option>{others.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>}</Field>}
        <Field label="Type">{(id) => <Select id={id} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="leave">Leave</option><option value="sick">Sick</option><option value="training">Training</option><option value="other">Other</option></Select>}</Field>
        <Field label="From">{(id) => <Input id={id} type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value, endDate: e.target.value > f.endDate ? e.target.value : f.endDate })} />}</Field>
        <Field label="To">{(id) => <Input id={id} type="date" min={f.startDate} value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} />}</Field>
        <Field label="Portion">{(id) => <Select id={id} value={f.portion} onChange={(e) => setF({ ...f, portion: e.target.value })}><option value="full">Full day(s)</option><option value="half_am">Half day — morning</option><option value="half_pm">Half day — afternoon</option></Select>}</Field>
        <Field label="Note (optional)">{(id) => <Input id={id} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />}</Field>
      </div>
      <Button className="mt-3" variant="primary" loading={add.isPending} onClick={() => add.mutate()}>Record leave</Button>
      <ul className="mt-4 divide-y divide-line border-t border-line">{(q.data ?? []).map((l: any) => (
        <li key={l.id} className="flex items-center gap-2 py-2 text-[13px]"><span className="flex-1"><b>{l.user_name}</b> · {fmtDate(l.start_date)}{l.end_date !== l.start_date && ` – ${fmtDate(l.end_date)}`} <Badge>{l.kind}</Badge>{l.portion !== 'full' && <Badge tone="info">{l.portion === 'half_am' ? 'AM' : 'PM'}</Badge>}</span>
          <IconButton label="Delete leave" onClick={() => confirm(`Delete ${l.user_name}'s ${l.kind} from ${fmtDate(l.start_date)}? Capacity and reports recompute.`) && del.mutate(l.id)}><Trash2 className="size-3.5" /></IconButton></li>))}</ul>
    </Card>
  );
}

function Holidays({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['holidays'], queryFn: () => api.get('/api/calendar/holidays') });
  const [f, setF] = useState({ date: '', name: '' });
  const add = useMutation({ mutationFn: () => api.post('/api/calendar/holidays', f), onSuccess: () => { setF({ date: '', name: '' }); qc.invalidateQueries(); }, onError: (e: any) => toast({ tone: 'critical', text: e.message }) });
  const del = useMutation({ mutationFn: (id: string) => api.del(`/api/calendar/holidays/${id}`), onSuccess: () => qc.invalidateQueries(), onError: (e: any) => toast({ tone: 'critical', text: e.message }) });
  return (
    <Card title="Holidays" subtitle="Organization-wide non-working days." actions={canEdit && <HolidayImport />}>
      {q.isLoading ? <Skeleton className="h-24" /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} />
        : (q.data ?? []).length === 0 && <p className="py-2 text-[13px] text-ink-3">No holidays yet.{canEdit && ' Add one below or import a calendar file.'}</p>}
      <ul className="divide-y divide-line">{(q.data ?? []).map((h: any) => <li key={h.id} className="flex items-center py-2 text-[13px]"><span className="w-32 tabular text-ink-2">{fmtDate(h.date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</span><span className="flex-1">{h.name}</span>
        {canEdit && <IconButton label={`Delete holiday ${h.name}`} onClick={() => confirm(`Delete the holiday ${h.name}? It becomes a working day for everyone.`) && del.mutate(h.id)}><Trash2 className="size-3.5" /></IconButton>}</li>)}</ul>
      {canEdit && <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}><Input aria-label="Holiday date" type="date" className="h-8 w-40" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
        <Input aria-label="Holiday name" className="h-8" placeholder="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /><Button size="sm" type="submit" disabled={!f.date || !f.name}>Add</Button></form>}
      {canEdit && <RecentHolidayImports />}
    </Card>
  );
}
