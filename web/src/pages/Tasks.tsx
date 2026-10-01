import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DndContext, KeyboardSensor, PointerSensor, closestCorners, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { Bookmark, Columns3, List, Plus, Trash2 } from 'lucide-react';
import { api, qs } from '../lib/api';
import { CATEGORY_LABEL, PRIORITY_LABEL, STATUS_LABEL, fmtDate, hm, relDue } from '../lib/format';
import { useMe } from '../lib/session';
import { Avatar, Badge, Button, Card, Empty, ErrorState, Input, PageHeader, Segmented, Select, Skeleton, StatusDot, cx, useToast } from '../components/ui';
import { BlockDialog, ReasonDialog, StatusControl, useProjects, useUsers } from '../components/TaskStatus';
import { TaskDrawer } from './TaskDetail';
import { QuickCapture } from '../components/QuickCapture';

const BOARD = ['backlog', 'planned', 'in_progress', 'blocked', 'in_review', 'done'];

export default function Tasks() {
  const me = useMe(); const qc = useQueryClient(); const toast = useToast();
  const [sp, setSp] = useSearchParams();
  const view = (sp.get('view') as 'list' | 'board') || 'list';
  const filters = { q: sp.get('q') ?? '', projectId: sp.get('projectId') ?? '', ownerId: sp.get('ownerId') ?? '', mine: sp.get('mine') ?? '', due: sp.get('due') ?? '', priority: sp.get('priority') ?? '', status: sp.get('status') ?? '', category: sp.get('category') ?? '' };
  const set = (k: string, v: string) => { const n = new URLSearchParams(sp); v ? n.set(k, v) : n.delete(k); setSp(n, { replace: true }); };
  const q = useQuery({ queryKey: ['tasks', filters], queryFn: () => api.get(`/api/tasks${qs({ ...filters, includeDone: view === 'board' ? '0' : undefined })}`) });
  const users = useUsers(); const projects = useProjects();
  const saved = useQuery({ queryKey: ['saved-filters'], queryFn: () => api.get('/api/saved-filters') });
  const [drawer, setDrawer] = useState<string | null>(null);
  const [capture, setCapture] = useState(false);
  const saveFilter = useMutation({ mutationFn: (name: string) => api.post('/api/saved-filters', { name, view, query: Object.fromEntries([...sp.entries()]) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['saved-filters'] }); toast({ tone: 'good', text: 'View saved' }); } });
  const delFilter = useMutation({ mutationFn: (id: string) => api.del(`/api/saved-filters/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['saved-filters'] }) });
  const active = Object.values(filters).some(Boolean);
  return (
    <div>
      <PageHeader title="Tasks" subtitle="Everything you can see, scoped by your role and project access."
        actions={<>
          <Segmented label="View" value={view} onChange={(v) => set('view', v)} options={[{ value: 'list', label: <span className="flex items-center gap-1"><List className="size-3.5" />List</span> }, { value: 'board', label: <span className="flex items-center gap-1"><Columns3 className="size-3.5" />Board</span> }]} />
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCapture(true)}>New task</Button>
        </>} />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input aria-label="Search tasks" className="h-8 w-56" placeholder="Search…" value={filters.q} onChange={(e) => set('q', e.target.value)} />
        <Select aria-label="Owner" className="h-8 w-40" value={filters.mine ? 'me' : filters.ownerId} onChange={(e) => { const v = e.target.value; const n = new URLSearchParams(sp); n.delete('mine'); n.delete('ownerId'); if (v === 'me') n.set('mine', '1'); else if (v) n.set('ownerId', v); setSp(n, { replace: true }); }}>
          <option value="">Anyone</option><option value="me">Me (owner or collaborator)</option>{(users.data ?? []).map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select>
        <Select aria-label="Project" className="h-8 w-44" value={filters.projectId} onChange={(e) => set('projectId', e.target.value)}>
          <option value="">All projects</option>{(projects.data ?? []).map((p: any) => <option key={p.id} value={p.id}>{p.key} · {p.name}</option>)}</Select>
        <Select aria-label="Due" className="h-8 w-36" value={filters.due} onChange={(e) => set('due', e.target.value)}>
          <option value="">Any due date</option><option value="overdue">Overdue</option><option value="today">Due today</option><option value="week">Next 7 days</option><option value="none">No due date</option></Select>
        <Select aria-label="Priority" className="h-8 w-32" value={filters.priority} onChange={(e) => set('priority', e.target.value)}>
          <option value="">Any priority</option>{Object.entries(PRIORITY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
        {view === 'list' && <Select aria-label="Status" className="h-8 w-36" value={filters.status} onChange={(e) => set('status', e.target.value)}>
          <option value="">Open + recent</option>{Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}
        <Select aria-label="Category" className="h-8 w-36" value={filters.category} onChange={(e) => set('category', e.target.value)}>
          <option value="">Any category</option>{Object.entries(CATEGORY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
        {active && <Button size="sm" variant="ghost" onClick={() => setSp(new URLSearchParams(view === 'board' ? { view } : {}), { replace: true })}>Clear</Button>}
        {active && <Button size="sm" variant="ghost" icon={<Bookmark className="size-3.5" />} onClick={() => { const n = prompt('Name this view'); if (n) saveFilter.mutate(n); }}>Save view</Button>}
      </div>
      {(saved.data ?? []).length > 0 && <div className="mb-3 flex flex-wrap gap-1.5">{saved.data.map((f: any) => (
        <span key={f.id} className="inline-flex items-center rounded-lg bg-surface ring-1 ring-line">
          <button className="px-2.5 py-1 text-[12px] font-medium hover:text-accent-ink" onClick={() => setSp(new URLSearchParams({ ...f.query, view: f.view }), { replace: true })}><Bookmark className="mr-1 inline size-3" />{f.name}</button>
          <button aria-label={`Delete view ${f.name}`} className="px-1.5 text-ink-3 hover:text-critical-ink" onClick={() => delFilter.mutate(f.id)}><Trash2 className="size-3" /></button></span>))}</div>}
      {q.isLoading ? <Skeleton className="h-96" /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} />
        : view === 'board' ? <Board tasks={q.data} onOpen={setDrawer} today={me.today} />
        : <TaskTable tasks={q.data} onOpen={setDrawer} today={me.today} />}
      <TaskDrawer id={drawer} onClose={() => setDrawer(null)} />
      <QuickCapture open={capture} onClose={() => setCapture(false)} defaults={{ projectId: filters.projectId || undefined }} />
    </div>
  );
}

export function TaskTable({ tasks, onOpen, today }: { tasks: any[]; onOpen: (id: string) => void; today: string }) {
  if (!tasks.length) return <Card><Empty title="No tasks match">Adjust the filters or capture a new task with <b>Q</b>.</Empty></Card>;
  return (
    <div className="overflow-x-auto rounded-xl bg-surface ring-1 ring-line">
      <table className="w-full min-w-[760px] text-[13px]">
        <thead className="border-b border-line text-left text-[12px] text-ink-3"><tr>
          <th className="w-28 px-3 py-2 font-medium">Status</th><th className="px-3 py-2 font-medium">Task</th><th className="px-3 py-2 font-medium">Owner</th>
          <th className="px-3 py-2 font-medium">Due</th><th className="px-3 py-2 font-medium">Priority</th><th className="px-3 py-2 text-right font-medium">Estimate</th></tr></thead>
        <tbody className="divide-y divide-line">{tasks.map((t) => {
          const due = relDue(t.due_date, today);
          return (
            <tr key={t.id} className="hover:bg-surface-2/60">
              <td className="px-3 py-1.5"><StatusControl task={t} /></td>
              <td className="max-w-[420px] px-3 py-1.5"><button className="block w-full text-left" onClick={() => onOpen(t.id)}>
                <span className={cx('block truncate font-medium', t.status === 'done' && 'text-ink-3 line-through')}>{t.title}</span>
                <span className="block truncate text-[12px] text-ink-3">{[t.project_key, t.checklist_total ? `☑ ${t.checklist_done}/${t.checklist_total}` : null, t.open_dependencies ? `waits on ${t.open_dependencies}` : null,
                  t.status === 'blocked' && t.blocker_reason ? `Blocked: ${t.blocker_reason}` : null, t.reopen_count ? `reworked ${t.reopen_count}×` : null].filter(Boolean).join(' · ')}</span></button></td>
              <td className="px-3 py-1.5"><span className="flex items-center gap-1.5 whitespace-nowrap">{t.owner_name && <Avatar name={t.owner_name} size={20} />}{t.owner_name}</span></td>
              <td className={cx('whitespace-nowrap px-3 py-1.5', due?.tone === 'critical' && t.status !== 'done' && 'font-medium text-critical-ink')}>{t.due_date ? (t.status === 'done' ? fmtDate(t.due_date) : due?.text) : '—'}</td>
              <td className="px-3 py-1.5">{t.priority === 'urgent' ? <Badge tone="critical">Urgent</Badge> : t.priority === 'high' ? <Badge tone="warning">High</Badge> : <span className="text-ink-2">{PRIORITY_LABEL[t.priority]}</span>}</td>
              <td className="px-3 py-1.5 text-right tabular text-ink-2">{t.estimate_minutes ? hm(t.estimate_minutes) : '—'}</td>
            </tr>
          );
        })}</tbody>
      </table>
    </div>
  );
}

function Board({ tasks, onOpen, today }: { tasks: any[]; onOpen: (id: string) => void; today: string }) {
  const qc = useQueryClient(); const toast = useToast(); const me = useMe();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor));
  const [pending, setPending] = useState<null | { task: any; to: string }>(null);
  const cols = useMemo(() => Object.fromEntries(BOARD.map((s) => [s, tasks.filter((t) => t.status === s)])), [tasks]);
  const move = useMutation({
    mutationFn: ({ task, to, extra }: any) => api.post(`/api/tasks/${task.id}/status`, { to, version: task.version, ...extra }),
    onMutate: async ({ task, to }) => {
      const key = qc.getQueryCache().findAll({ queryKey: ['tasks'] });
      key.forEach((k) => qc.setQueryData(k.queryKey, (old: any) => Array.isArray(old) ? old.map((t: any) => (t.id === task.id ? { ...t, status: to } : t)) : old));
    },
    onSuccess: () => { setPending(null); }, onSettled: () => qc.invalidateQueries({ queryKey: ['tasks'] }),
    onError: (e: any) => toast({ tone: 'critical', text: e.message }),
  });
  const onDragEnd = (e: DragEndEvent) => {
    const task = tasks.find((t) => t.id === e.active.id); const to = e.over?.id as string | undefined;
    if (!task || !to || to === task.status) return;
    if (to === 'blocked') return setPending({ task, to });
    if (to === 'done' && task.requires_review) return toast({ tone: 'critical', text: 'This task needs review — drop it in In Review instead' });
    if (task.status === 'blocked') return setPending({ task, to });
    if (task.status === 'done') return setPending({ task, to: 'reopen' });
    move.mutate({ task, to });
  };
  return (
    <DndContext sensors={sensors} collisionDetection={closestCorners} onDragEnd={onDragEnd}
      accessibility={{ screenReaderInstructions: { draggable: 'Press space to pick up a task, use arrow keys to move between columns, space to drop.' } }}>
      <div className="-mx-4 flex gap-3 overflow-x-auto px-4 pb-4 sm:mx-0 sm:px-0">
        {BOARD.map((s) => <Column key={s} status={s} tasks={cols[s]} onOpen={onOpen} today={today} />)}
      </div>
      <BlockDialog open={pending?.to === 'blocked'} onClose={() => setPending(null)} loading={move.isPending} meId={me.user.id}
        onSubmit={(blocker) => move.mutate({ task: pending!.task, to: 'blocked', extra: { blocker } })} />
      <ReasonDialog open={!!pending && pending.to !== 'blocked' && pending.to !== 'reopen'} title="Resolve blocker" label="How was it resolved?" optional loading={move.isPending}
        onClose={() => setPending(null)} onSubmit={(r) => move.mutate({ task: pending!.task, to: pending!.to, extra: { resolution: r || 'Unblocked' } })} />
      <ReasonDialog open={pending?.to === 'reopen'} title="Reopen task" label="What needs rework?" onClose={() => setPending(null)}
        onSubmit={(reason) => api.post(`/api/tasks/${pending!.task.id}/reopen`, { reason }).then(() => { setPending(null); qc.invalidateQueries(); }).catch((e) => toast({ tone: 'critical', text: e.message }))} />
    </DndContext>
  );
}
function Column({ status, tasks, onOpen, today }: { status: string; tasks: any[]; onOpen: (id: string) => void; today: string }) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const est = tasks.reduce((s, t) => s + (t.estimate_minutes ?? 0), 0);
  return (
    <section ref={setNodeRef} aria-label={`${STATUS_LABEL[status]} column`} className={cx('flex w-72 shrink-0 flex-col rounded-xl bg-surface-2/70 ring-1 ring-line', isOver && 'ring-2 ring-accent')}>
      <header className="flex items-center gap-2 px-3 py-2.5"><StatusDot status={status} /><h2 className="text-[13px] font-semibold">{STATUS_LABEL[status]}</h2>
        <span className="text-[12px] text-ink-3 tabular">{tasks.length}{est ? ` · ${hm(est)}` : ''}</span></header>
      <ul className="flex min-h-24 flex-1 flex-col gap-2 px-2 pb-2">{tasks.map((t) => <Cardlet key={t.id} t={t} onOpen={onOpen} today={today} />)}</ul>
    </section>
  );
}
function Cardlet({ t, onOpen, today }: { t: any; onOpen: (id: string) => void; today: string }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: t.id });
  const due = relDue(t.due_date, today);
  return (
    <li ref={setNodeRef} style={transform ? { transform: `translate(${transform.x}px, ${transform.y}px)` } : undefined} {...attributes} {...listeners}
      className={cx('cursor-grab rounded-lg bg-surface p-2.5 shadow-sm ring-1 ring-line active:cursor-grabbing', isDragging && 'z-10 opacity-80 shadow-xl')}>
      <button className="block w-full text-left text-[13px] font-medium leading-snug hover:underline" onClick={() => onOpen(t.id)} onPointerDown={(e) => e.stopPropagation()}>{t.title}</button>
      {t.status === 'blocked' && t.blocker_reason && <p className="mt-1 line-clamp-2 text-[12px] text-critical-ink">{t.blocker_reason}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-3">
        {t.owner_name && <Avatar name={t.owner_name} size={18} />}
        {t.project_key && <span>{t.project_key}</span>}
        {due && <span className={cx(due.tone === 'critical' && 'font-medium text-critical-ink', due.tone === 'warning' && 'text-warning-ink')}>{due.text}</span>}
        {t.priority === 'urgent' && <Badge tone="critical">Urgent</Badge>}{t.priority === 'high' && <Badge tone="warning">High</Badge>}
        {t.estimate_minutes && <span>{hm(t.estimate_minutes)}</span>}
        {t.checklist_total > 0 && <span>☑ {t.checklist_done}/{t.checklist_total}</span>}
      </div>
    </li>
  );
}
