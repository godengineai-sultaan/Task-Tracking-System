import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Search, Target } from 'lucide-react';
import { api } from '../../lib/api';
import { pct } from '../../lib/format';
import { useMe, useRoles } from '../../lib/session';
import { Avatar, Button, Card, Empty, ErrorState, Field, Input, Modal, PageHeader, Segmented, Select, Skeleton, Stat, Textarea, useToast } from '../../components/ui';
import { useUsers } from '../../components/TaskStatus';
import { BASIS, FORECAST, ForecastBadge, ProgressMeter, periodText, useObjectivesOverview, type ForecastStatus } from '../../components/ext/ObjectivesUI';

export default function Objectives() {
  const r = useRoles(); const me = useMe();
  const q = useObjectivesOverview(!r.customer);
  const [scope, setScope] = useState<'active' | 'closed' | 'all'>('active');
  const [health, setHealth] = useState(''); const [owner, setOwner] = useState(''); const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const items: any[] = q.data?.items ?? [];
  const owners = useMemo(() => [...new Map(items.filter((o) => o.owner_id).map((o) => [o.owner_id, o.owner_name])).entries()].sort((a, b) => String(a[1]).localeCompare(String(b[1]))), [items]);
  const shown = items.filter((o) => (scope === 'all' || (scope === 'active' ? o.status === 'active' : o.status !== 'active'))
    && (!health || o.forecast?.status === health) && (!owner || o.owner_id === (owner === 'me' ? me.user.id : owner))
    && (!text || `${o.title} ${o.description}`.toLowerCase().includes(text.toLowerCase())));
  const counts = items.filter((o) => o.status === 'active').reduce((m: Record<string, number>, o) => { m[o.forecast?.status] = (m[o.forecast?.status] ?? 0) + 1; return m; }, {});

  if (r.customer) return <div><PageHeader title="Objectives" /><Card><Empty icon={<Target className="size-6" />} title="Objectives are for staff">Your project updates are in the client portal.</Empty></Card></div>;
  return (
    <div>
      <PageHeader title="Objectives" subtitle="Company goals, the work linked to them, and an explained early warning. Status comes from recorded work and reported key results, never from monitoring people."
        actions={q.data?.permissions.canCreate && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>New objective</Button>} />
      {q.isLoading ? <div className="space-y-3"><Skeleton className="h-20" /><Skeleton className="h-28" /><Skeleton className="h-28" /></div>
        : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
            {(['on_track', 'at_risk', 'off_track', 'insufficient_data'] as ForecastStatus[]).map((s) => (
              <Stat key={s} label={FORECAST[s].label} value={counts[s] ?? 0} sub="active objectives" tone={s === 'off_track' && counts[s] ? 'critical' : s === 'at_risk' && counts[s] ? 'warning' : undefined} />))}
          </div>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Segmented label="Objective lifecycle" value={scope} onChange={setScope} options={[{ value: 'active', label: 'Active' }, { value: 'closed', label: 'Closed' }, { value: 'all', label: 'All' }]} />
            <Select aria-label="Filter by forecast status" className="h-8 w-auto" value={health} onChange={(e) => setHealth(e.target.value)}>
              <option value="">Any status</option>{Object.entries(FORECAST).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</Select>
            <Select aria-label="Filter by owner" className="h-8 w-auto max-w-[12rem]" value={owner} onChange={(e) => setOwner(e.target.value)}>
              <option value="">Any owner</option><option value="me">Owned by me</option>{owners.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</Select>
            <div className="relative min-w-0 flex-1 basis-40">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-3" aria-hidden />
              <Input aria-label="Search objectives" placeholder="Search objectives" className="h-8 w-full pl-8" value={text} onChange={(e) => setText(e.target.value)} />
            </div>
          </div>
          {shown.length === 0 ? (
            <Card><Empty icon={<Target className="size-6" />} title={items.length ? 'No objectives match these filters' : 'No objectives yet'}
              action={items.length ? <Button size="sm" onClick={() => { setScope('all'); setHealth(''); setOwner(''); setText(''); }}>Clear filters</Button>
                : q.data.permissions.canCreate ? <Button variant="primary" size="sm" onClick={() => setOpen(true)}>Create the first objective</Button> : undefined}>
              {items.length ? 'Try another status, owner or search.' : 'Leadership sets objectives; milestones and key results show how work moves them.'}</Empty></Card>
          ) : (
            <ul className="space-y-3" aria-label="Objectives">{shown.map((o) => <ObjectiveRow key={o.id} o={o} />)}</ul>
          )}
        </>)}
      <NewObjectiveModal open={open} onClose={() => setOpen(false)} />
    </div>
  );
}

function ObjectiveRow({ o }: { o: any }) {
  const f = o.forecast;
  return (
    <li className="rounded-xl bg-surface p-4 ring-1 ring-line transition focus-within:ring-accent hover:ring-line-strong">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 basis-64">
          <Link to={`/objectives/${o.id}`} className="text-[15px] font-semibold text-ink hover:underline">{o.title}</Link>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-3">
            {o.owner_name ? <span className="inline-flex items-center gap-1.5"><Avatar name={o.owner_name} size={18} />{o.owner_name}</span> : <span>No owner</span>}
            <span>{periodText(o.period_start, o.period_end)}</span>
          </div>
        </div>
        <ForecastBadge status={f?.status} lifecycle={o.status} />
      </div>
      <div className="mt-3 flex items-center gap-3">
        <div className="min-w-0 flex-1"><ProgressMeter value={o.progress} expected={f?.expected} status={f?.status} label={`Progress of ${o.title}`} /></div>
        <span className="w-12 shrink-0 text-right text-[13px] font-medium tabular">{o.progress === null ? 'N/A' : pct(o.progress)}</span>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-ink-3">
        <span>{o.milestones ? `${o.milestonesDone}/${o.milestones} milestones` : 'No linked milestones'}</span>
        {o.tasks > 0 && <span>{o.tasksDone}/{o.tasks} tasks accepted · {BASIS[o.workBasis]}</span>}
        <span>{o.keyResults} key result{o.keyResults === 1 ? '' : 's'}</span>
        {f?.expected != null && <span>Expected now {pct(f.expected)}</span>}
        {o.latestCheckin && <span>Owner confidence {o.latestCheckin.confidence}/5</span>}
      </div>
      {f && f.status !== 'on_track' && f.reasons[0] && <p className="mt-2 text-[13px] text-ink-2">{f.reasons[0]}</p>}
    </li>
  );
}

export function NewObjectiveModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient(); const toast = useToast(); const users = useUsers(); const nav = useNavigate();
  const blank = { title: '', description: '', ownerId: '', periodStart: '', periodEnd: '' };
  const [f, setF] = useState(blank);
  const bad = f.periodStart && f.periodEnd && f.periodEnd < f.periodStart;
  const m = useMutation({
    mutationFn: () => api.post('/api/objectives/create', { title: f.title, description: f.description, ownerId: f.ownerId || null, periodStart: f.periodStart || null, periodEnd: f.periodEnd || null }),
    onSuccess: (o: any) => { qc.invalidateQueries({ queryKey: ['objectives-overview'] }); qc.invalidateQueries({ queryKey: ['leadership'] }); toast({ tone: 'good', text: 'Objective created' }); setF(blank); onClose(); nav(`/objectives/${o.id}`); },
    onError: (e: any) => toast({ tone: 'critical', text: e.message }),
  });
  return (
    <Modal open={open} onClose={onClose} title="New objective"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} disabled={!f.title.trim() || !!bad} onClick={() => m.mutate()}>Create objective</Button></>}>
      <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); if (f.title.trim() && !bad) m.mutate(); }}>
        <Field label="Objective">{(id) => <Input id={id} value={f.title} maxLength={300} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="What outcome should be true by the end of the period?" />}</Field>
        <Field label="Description (optional)">{(id) => <Textarea id={id} rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />}</Field>
        <Field label="Owner">{(id) => <Select id={id} value={f.ownerId} onChange={(e) => setF({ ...f, ownerId: e.target.value })}><option value="">Me</option>{(users.data ?? []).map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select>}</Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Period start">{(id) => <Input id={id} type="date" value={f.periodStart} onChange={(e) => setF({ ...f, periodStart: e.target.value })} />}</Field>
          <Field label="Period end" error={bad ? 'End must be on or after the start' : null} hint="Needed for the early warning">{(id) => <Input id={id} type="date" value={f.periodEnd} onChange={(e) => setF({ ...f, periodEnd: e.target.value })} />}</Field>
        </div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
