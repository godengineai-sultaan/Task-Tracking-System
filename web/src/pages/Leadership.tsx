import { Link } from 'react-router';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FileSpreadsheet } from 'lucide-react';
import { api } from '../lib/api';
import { fmtDate, hm } from '../lib/format';
import { useRoles } from '../lib/session';
import { Badge, Button, Callout, Card, ErrorState, Input, PageHeader, Skeleton, Stat, useToast } from '../components/ui';
import { downloadExport } from './util';
import { ForecastBadge, ProgressMeter, useObjectivesOverview } from '../components/ext/ObjectivesUI';

export default function Leadership() {
  const q = useQuery({ queryKey: ['leadership'], queryFn: () => api.get('/api/leadership/delivery') });
  const toast = useToast(); const r = useRoles();
  const exp = (format: 'pdf' | 'csv') => downloadExport(api, { format, report: 'delivery', params: {} }, toast).catch((e) => toast({ tone: 'critical', text: e.message }));
  if (q.isLoading) return <Skeleton className="h-96" />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data;
  const tot = d.projects.reduce((a: any, p: any) => ({ open: a.open + p.open, overdue: a.overdue + p.overdue, blocked: a.blocked + p.blocked, review: a.review + p.in_review }), { open: 0, overdue: 0, blocked: 0, review: 0 });
  const byProject = Object.values(d.allocation.reduce((m: any, x: any) => { m[x.project] ??= { project: x.project, minutes: 0, meeting: 0 }; m[x.project].minutes += x.minutes; if (x.category === 'meeting') m[x.project].meeting += x.minutes; return m; }, {})) as any[];
  const maxAlloc = Math.max(1, ...byProject.map((p) => p.minutes));
  const byDept = Object.values(d.allocation.reduce((m: any, x: any) => { m[x.department] ??= { department: x.department, minutes: 0 }; m[x.department].minutes += x.minutes; return m; }, {})) as any[];
  return (
    <div>
      <PageHeader title="Leadership delivery" subtitle="Which projects move outcomes, what is late, and where to rebalance. Aggregates only — no individual rankings."
        actions={<><Button icon={<Download className="size-4" />} onClick={() => exp('pdf')}>PDF</Button><Button icon={<FileSpreadsheet className="size-4" />} onClick={() => exp('csv')}>CSV</Button></>} />
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Open commitments" value={tot.open} /><Stat label="Overdue" value={tot.overdue} tone={tot.overdue ? 'critical' : undefined} />
        <Stat label="Blocked" value={tot.blocked} tone={tot.blocked ? 'warning' : undefined} /><Stat label="Waiting for review" value={tot.review} />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2" title="Projects" padded={false}>
          <div className="overflow-x-auto"><table className="w-full min-w-[720px] text-[13px]">
            <thead className="border-b border-line text-left text-[12px] text-ink-3"><tr><th className="px-4 py-2 font-medium">Project</th><th className="px-3 py-2 font-medium">Business outcome</th><th className="px-3 py-2 text-right font-medium">Open</th><th className="px-3 py-2 text-right font-medium">Done</th><th className="px-3 py-2 text-right font-medium">Blocked</th><th className="px-3 py-2 text-right font-medium">Overdue</th><th className="px-3 py-2 text-right font-medium">Remaining est.</th><th className="px-3 py-2 font-medium">Target</th></tr></thead>
            <tbody className="divide-y divide-line">{d.projects.map((p: any) => (
              <tr key={p.id}><td className="px-4 py-2"><Link to={`/projects/${p.id}`} className="font-medium hover:underline">{p.key} · {p.name}</Link><div className="text-[12px] text-ink-3">{p.owner}{p.customer && ` · ${p.customer}`}{p.visibility === 'private' && ' · private'}</div></td>
                <td className="max-w-[220px] px-3 py-2 text-[12px] text-ink-2">{p.business_outcome || '—'}</td>
                <td className="px-3 py-2 text-right tabular">{p.open}</td><td className="px-3 py-2 text-right tabular">{p.done}</td>
                <td className="px-3 py-2 text-right tabular">{p.blocked ? <Badge tone="critical">{p.blocked}</Badge> : 0}</td><td className="px-3 py-2 text-right tabular">{p.overdue ? <Badge tone="critical">{p.overdue}</Badge> : 0}</td>
                <td className="px-3 py-2 text-right tabular">{hm(p.remaining_estimate)}</td><td className="px-3 py-2 whitespace-nowrap">{p.target_date ? fmtDate(p.target_date) : '—'}</td></tr>))}</tbody></table></div>
        </Card>
        <ObjectivesCard />
        <Card title="Open milestones" padded={false}>
          <ul className="divide-y divide-line">{d.milestones.map((m: any) => (
            <li key={m.id} className="px-4 py-2 text-[13px]"><div className="flex items-center gap-2"><span className="flex-1 font-medium">{m.name}</span>{m.due_date && <span className={m.due_date < new Date().toISOString().slice(0, 10) ? 'text-critical-ink' : 'text-ink-3'}>{fmtDate(m.due_date)}</span>}</div>
              <div className="text-[12px] text-ink-3">{m.project} · {m.done}/{m.tasks} tasks done</div></li>))}</ul>
        </Card>
        <Card title="Declared allocation by project" subtitle={`Confirmed time since ${fmtDate(d.allocationSince)}. Unknown time is not shown as unproductive.`}>
          <ul className="space-y-2">{byProject.sort((a, b) => b.minutes - a.minutes).map((p) => (
            <li key={p.project} className="text-[13px]"><div className="flex justify-between"><span>{p.project}</span><span className="tabular text-ink-2">{hm(p.minutes)}</span></div>
              <div className="mt-1 h-2 rounded-full bg-surface-2"><div className="h-full rounded-full bg-[var(--c-task)]" style={{ width: `${(p.minutes / maxAlloc) * 100}%` }} /></div>
              {p.meeting > 0 && <div className="text-[11px] text-ink-3">{hm(p.meeting)} in meetings</div>}</li>))}</ul>
          <p className="mb-1.5 mt-4 text-[12px] font-medium text-ink-3">By department</p>
          <ul className="space-y-1 text-[13px]">{byDept.sort((a, b) => b.minutes - a.minutes).map((x) => <li key={x.department} className="flex justify-between"><span>{x.department}</span><span className="tabular text-ink-2">{hm(x.minutes)}</span></li>)}</ul>
        </Card>
        <Card title="Blocker patterns">
          {d.blockerPatterns.length === 0 ? <p className="text-[13px] text-ink-3">No open blockers.</p> : <ul className="space-y-1.5 text-[13px]">{d.blockerPatterns.map((b: any) =>
            <li key={b.cause} className="flex justify-between"><span className="capitalize">{b.cause}</span><span className="tabular">{b.open} open · avg {hm(b.avg_age_hours * 60)}</span></li>)}</ul>}
          <p className="mt-4 mb-1.5 text-[12px] font-medium text-ink-3">Workload concentration (open work, not performance)</p>
          <ul className="space-y-1 text-[13px]">{d.workloadConcentration.map((w: any) => <li key={w.name} className="flex justify-between"><span>{w.name}</span><span className="tabular text-ink-2">{w.open_tasks} open · {hm(w.estimate)}</span></li>)}</ul>
        </Card>
        {r.costViewer && d.cost && <Card className="lg:col-span-3" title="Project cost (confidential)" subtitle="Authorized cost rates × confirmed time, last 30 days. Salaries are not shown.">
          <table className="w-full text-[13px]"><thead className="text-left text-[12px] text-ink-3"><tr><th className="py-1 font-medium">Project</th><th className="font-medium text-right">Hours</th><th className="font-medium text-right">Cost</th></tr></thead>
            <tbody className="divide-y divide-line">{d.cost.map((c: any) => <tr key={c.project + c.currency}><td className="py-1.5">{c.project}</td><td className="text-right tabular">{c.hours}</td>
              <td className="text-right tabular">{new Intl.NumberFormat(undefined, { style: 'currency', currency: c.currency, maximumFractionDigits: 0 }).format(c.cost)}</td></tr>)}</tbody></table>
        </Card>}
      </div>
      <div className="mt-4"><Callout tone="neutral">{d.note}</Callout></div>
    </div>
  );
}

function ObjectivesCard() {
  const q = useObjectivesOverview();
  const active = (q.data?.items ?? []).filter((o: any) => o.status === 'active');
  return (
    <Card title="Objectives" actions={<Link to="/objectives" className="rounded text-[13px] font-medium text-accent-ink hover:underline">All objectives</Link>}>
      {q.isLoading ? <div className="space-y-3"><Skeleton className="h-10" /><Skeleton className="h-10" /></div> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : (
        <ul className="space-y-3">{active.map((o: any) => (
          <li key={o.id}>
            <div className="flex items-start justify-between gap-2"><Link to={`/objectives/${o.id}`} className="min-w-0 text-[13px] font-medium hover:underline">{o.title}</Link><ForecastBadge status={o.forecast?.status} /></div>
            <div className="text-[12px] text-ink-3">{o.owner_name ?? 'No owner'} · {o.period_end ? `ends ${fmtDate(o.period_end)}` : 'no end date'} · {o.milestonesDone}/{o.milestones} milestones · {o.progress === null ? 'progress N/A' : `${Math.round(o.progress * 100)}%`}</div>
            <div className="mt-1"><ProgressMeter value={o.progress} expected={o.forecast?.expected} status={o.forecast?.status} label={`Progress of ${o.title}`} /></div></li>))}
          {active.length === 0 && <li className="text-[13px] text-ink-3">No active objectives.</li>}</ul>)}
      {q.data?.permissions.canCreate && <NewObjective />}
    </Card>
  );
}

function NewObjective() {
  const qc = useQueryClient(); const toast = useToast(); const [f, setF] = useState({ title: '', periodEnd: '' });
  const m = useMutation({ mutationFn: () => api.post('/api/objectives/create', { title: f.title, periodEnd: f.periodEnd || null }),
    onSuccess: () => { setF({ title: '', periodEnd: '' }); qc.invalidateQueries({ queryKey: ['leadership'] }); qc.invalidateQueries({ queryKey: ['objectives-overview'] }); },
    onError: (e: any) => toast({ tone: 'critical', text: e.message }) });
  return (
    <form className="mt-4 flex flex-wrap gap-2 border-t border-line pt-3" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
      <Input aria-label="Objective" className="h-8 min-w-0 flex-1" placeholder="New objective" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
      <Input aria-label="Objective end date" type="date" className="h-8 w-36" value={f.periodEnd} onChange={(e) => setF({ ...f, periodEnd: e.target.value })} />
      <Button size="sm" type="submit" disabled={!f.title} loading={m.isPending}>Add</Button>
    </form>
  );
}
