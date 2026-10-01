import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Columns3, Lock, Plus } from 'lucide-react';
import { api } from '../lib/api';
import { fmtDate } from '../lib/format';
import { useMe, useRoles } from '../lib/session';
import { Avatar, Badge, Button, Card, ErrorState, Input, PageHeader, Select, Skeleton, useToast } from '../components/ui';
import { useUsers } from '../components/TaskStatus';
import { TaskTable } from './Tasks';
import { TaskDrawer } from './TaskDetail';

export default function ProjectDetail() {
  const { id } = useParams(); const me = useMe(); const roles = useRoles(); const qc = useQueryClient(); const toast = useToast(); const users = useUsers();
  const q = useQuery({ queryKey: ['project', id], queryFn: () => api.get(`/api/projects/${id}`) });
  const tasks = useQuery({ queryKey: ['tasks', { projectId: id }], queryFn: () => api.get(`/api/tasks?projectId=${id}`) });
  const [ms, setMs] = useState({ name: '', dueDate: '', objectiveId: '' }); const [al, setAl] = useState({ userId: '', percent: '50', startDate: me.today, assumption: '' });
  const objectives = useQuery({ queryKey: ['objectives'], queryFn: () => api.get('/api/objectives') }); const [member, setMember] = useState(''); const [drawer, setDrawer] = useState<string | null>(null);
  const err = (e: any) => toast({ tone: 'critical', text: e.message });
  const addMs = useMutation({ mutationFn: () => api.post(`/api/projects/${id}/milestones`, { name: ms.name, dueDate: ms.dueDate || null, objectiveId: ms.objectiveId || null }), onSuccess: () => { setMs({ name: '', dueDate: '', objectiveId: '' }); qc.invalidateQueries({ queryKey: ['project', id] }); }, onError: err });
  const msStatus = useMutation({ mutationFn: ({ mid, status }: any) => api.patch(`/api/milestones/${mid}`, { status }), onSuccess: () => qc.invalidateQueries({ queryKey: ['project', id] }), onError: err });
  const addAlloc = useMutation({ mutationFn: () => api.post('/api/admin/allocations', { userId: al.userId, projectId: id, percent: Number(al.percent), startDate: al.startDate, assumption: al.assumption }),
    onSuccess: (r: any) => { setAl({ ...al, userId: '', assumption: '' }); qc.invalidateQueries({ queryKey: ['project', id] }); if (r.warning) toast({ tone: 'info', text: r.warning }); }, onError: err });
  const addMember = useMutation({ mutationFn: () => api.post(`/api/projects/${id}/members`, { userId: member }), onSuccess: () => { setMember(''); qc.invalidateQueries({ queryKey: ['project', id] }); }, onError: err });
  if (q.isLoading) return <Skeleton className="h-96" />;
  if (q.error) return <ErrorState error={q.error} />;
  const { project: p, members, milestones, allocations } = q.data;
  return (
    <div>
      <PageHeader eyebrow={<span className="flex items-center gap-2">{p.key}{p.visibility === 'private' && <Lock className="size-3" />}{p.customer_name && ` · ${p.customer_name}`}</span>} title={p.name}
        subtitle={p.business_outcome} actions={<Link to={`/tasks?view=board&projectId=${p.id}`}><Button icon={<Columns3 className="size-4" />}>Board</Button></Link>} />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">{tasks.isLoading ? <Skeleton className="h-64" /> : <TaskTable tasks={tasks.data ?? []} onOpen={setDrawer} today={me.today} />}</div>
        <div className="space-y-4">
          <Card title="Milestones">
            <ul className="space-y-2">{milestones.map((m: any) => (
              <li key={m.id} className="text-[13px]"><div className="flex items-center gap-2"><span className="flex-1 font-medium">{m.name}</span>
                <Select aria-label={`Status of ${m.name}`} className="h-7 w-28 text-[12px]" value={m.status} onChange={(e) => msStatus.mutate({ mid: m.id, status: e.target.value })}><option value="open">Open</option><option value="done">Done</option><option value="cancelled">Cancelled</option></Select></div>
                <div className="text-[12px] text-ink-3">{m.due_date ? `Due ${fmtDate(m.due_date)}` : 'No date'} · {m.done}/{m.tasks} tasks{m.objective_title && ` · ${m.objective_title}`}</div></li>))}</ul>
            <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); addMs.mutate(); }}><Input aria-label="Milestone name" className="h-8" placeholder="New milestone" value={ms.name} onChange={(e) => setMs({ ...ms, name: e.target.value })} />
              <Input aria-label="Milestone due" type="date" className="h-8 w-36" value={ms.dueDate} onChange={(e) => setMs({ ...ms, dueDate: e.target.value })} /><Button size="sm" type="submit" aria-label="Add milestone" disabled={!ms.name} icon={<Plus className="size-3.5" />} /></form>
            {(objectives.data ?? []).length > 0 && <Select aria-label="Link milestone to objective" className="mt-2 h-8" value={ms.objectiveId} onChange={(e) => setMs({ ...ms, objectiveId: e.target.value })}>
              <option value="">No linked objective</option>{objectives.data.map((o: any) => <option key={o.id} value={o.id}>{o.title}</option>)}</Select>}
          </Card>
          <Card title="Members">
            <ul className="space-y-1.5">{members.map((u: any) => <li key={u.id} className="flex items-center gap-2 text-[13px]"><Avatar name={u.name} size={22} />{u.name}<span className="text-[12px] text-ink-3">{u.title}</span></li>)}</ul>
            <div className="mt-3 flex gap-2"><Select aria-label="Add member" className="h-8" value={member} onChange={(e) => setMember(e.target.value)}><option value="">Add member…</option>
              {(users.data ?? []).filter((u: any) => !members.some((m: any) => m.id === u.id)).map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select><Button size="sm" disabled={!member} onClick={() => addMember.mutate()}>Add</Button></div>
          </Card>
          <Card title="Capacity allocation" subtitle="Explicit assumptions used by team capacity planning.">
            <ul className="space-y-1 text-[13px]">{allocations.map((a: any) => <li key={a.id}><b>{a.user_name}</b> {a.percent}% <span className="text-ink-3">from {fmtDate(a.start_date)}{a.assumption && ` · ${a.assumption}`}</span></li>)}
              {allocations.length === 0 && <li className="text-ink-3">No allocations recorded.</li>}</ul>
            {(roles.leadership || roles.sysAdmin) && <form className="mt-3 grid grid-cols-2 gap-2" onSubmit={(e) => { e.preventDefault(); addAlloc.mutate(); }}>
              <Select aria-label="Person" className="h-8" value={al.userId} onChange={(e) => setAl({ ...al, userId: e.target.value })}><option value="">Person…</option>{(users.data ?? []).map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select>
              <Input aria-label="Percent" type="number" min={1} max={100} className="h-8" value={al.percent} onChange={(e) => setAl({ ...al, percent: e.target.value })} />
              <Input aria-label="From" type="date" className="h-8" value={al.startDate} onChange={(e) => setAl({ ...al, startDate: e.target.value })} />
              <Input aria-label="Assumption" className="h-8" placeholder="Assumption" value={al.assumption} onChange={(e) => setAl({ ...al, assumption: e.target.value })} />
              <Button size="sm" type="submit" disabled={!al.userId} className="col-span-2">Add allocation</Button></form>}
          </Card>
          {p.customer_name && <Card title="Client view"><p className="text-[13px] text-ink-2">{p.customer_name} sees milestones and only tasks marked “Show to client”. No time, analytics or staff details are shared.</p><Badge className="mt-2" tone="info">{(tasks.data ?? []).filter((t: any) => t.customer_visible).length} client-visible tasks</Badge></Card>}
        </div>
      </div>
      <TaskDrawer id={drawer} onClose={() => setDrawer(null)} />
    </div>
  );
}
