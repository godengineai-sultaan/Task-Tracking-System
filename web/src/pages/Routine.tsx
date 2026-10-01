import { Link, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Download, FileSpreadsheet, ShieldCheck } from 'lucide-react';
import { api, qs } from '../lib/api';
import { STATUS_LABEL, addDays, fmtDate, hm, pct } from '../lib/format';
import { useMe, useRoles } from '../lib/session';
import { AssessmentBadge, Avatar, Badge, Button, Callout, Card, Empty, ErrorState, IconButton, Input, PageHeader, Select, Skeleton, Stat, StatusDot, useToast } from '../components/ui';
import { useProjects } from '../components/TaskStatus';
import { downloadExport } from './util';

const RECAP: Record<string, { label: string; tone: any }> = {
  missing: { label: 'Missing', tone: 'critical' }, pending: { label: 'Pending today', tone: 'neutral' }, draft: { label: 'Draft', tone: 'warning' },
  confirmed: { label: 'Confirmed', tone: 'info' }, manager_reviewed: { label: 'Reviewed', tone: 'good' }, not_required: { label: 'Not required', tone: 'neutral' },
};

export default function Routine() {
  const me = useMe(); const r = useRoles(); const toast = useToast();
  const [sp, setSp] = useSearchParams();
  const f = { date: sp.get('date') ?? me.today, departmentId: sp.get('departmentId') ?? '', projectId: sp.get('projectId') ?? '', userId: sp.get('userId') ?? '', status: sp.get('status') ?? '' };
  const set = (k: string, v: string) => { const n = new URLSearchParams(sp); v ? n.set(k, v) : n.delete(k); setSp(n, { replace: true }); };
  const q = useQuery({ queryKey: ['routine', f], queryFn: () => api.get(`/api/admin/routine${qs(f)}`) });
  const depts = useQuery({ queryKey: ['departments'], queryFn: () => api.get('/api/admin/departments') });
  const people = useQuery({ queryKey: ['people'], queryFn: () => api.get('/api/people') });
  const projects = useProjects();
  const exp = (format: 'pdf' | 'csv') => downloadExport(api, { format, report: 'team_daily', params: { date: f.date, departmentId: f.departmentId || undefined, projectId: f.projectId || undefined } }, toast).catch((e) => toast({ tone: 'critical', text: e.message }));
  const d = q.data;
  return (
    <div>
      <PageHeader eyebrow={r.routineAdmin ? 'Main administrator · company-wide' : 'Team manager · your teams'} title="Daily routine"
        subtitle="Each person's recorded day: plan, work-state changes, confirmed time, recap and review status."
        actions={<><Button icon={<Download className="size-4" />} onClick={() => exp('pdf')}>PDF</Button><Button icon={<FileSpreadsheet className="size-4" />} onClick={() => exp('csv')}>CSV</Button></>} />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <IconButton label="Previous day" onClick={() => set('date', addDays(f.date, -1))}><ChevronLeft className="size-4" /></IconButton>
          <Input aria-label="Date" type="date" className="h-8 w-40" max={me.today} value={f.date} onChange={(e) => set('date', e.target.value)} />
          <IconButton label="Next day" disabled={f.date >= me.today} onClick={() => set('date', addDays(f.date, 1))}><ChevronRight className="size-4" /></IconButton>
        </div>
        <Select aria-label="Department" className="h-8 w-40" value={f.departmentId} onChange={(e) => set('departmentId', e.target.value)}><option value="">All departments</option>{(depts.data ?? []).map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>
        <Select aria-label="Project" className="h-8 w-44" value={f.projectId} onChange={(e) => set('projectId', e.target.value)}><option value="">All projects</option>{(projects.data ?? []).map((x: any) => <option key={x.id} value={x.id}>{x.key} · {x.name}</option>)}</Select>
        <Select aria-label="Employee" className="h-8 w-44" value={f.userId} onChange={(e) => set('userId', e.target.value)}><option value="">Everyone in scope</option>{(people.data ?? []).map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>
        <Select aria-label="Status" className="h-8 w-44" value={f.status} onChange={(e) => set('status', e.target.value)}>
          <option value="">Any status</option><optgroup label="Recap"><option value="missing">Recap missing</option><option value="pending">Pending today</option><option value="confirmed">Confirmed (not reviewed)</option><option value="manager_reviewed">Reviewed</option></optgroup>
          <optgroup label="Assessment"><option value="needs_attention">Needs attention</option><option value="insufficient_data">Insufficient data</option><option value="on_track">On track</option></optgroup></Select>
      </div>
      {q.isLoading ? <Skeleton className="h-96" /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : <>
        <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-5">
          <Stat label="People in scope" value={d.rollup.people} sub={d.scope === 'company' ? 'company-wide' : 'your teams'} />
          <Stat label="Recap completion" value={pct(d.rollup.recapCompletion)} sub={f.date === me.today ? 'today still pending' : 'of people with capacity'} />
          <Stat label="Missing recaps" value={d.rollup.missing} tone={d.rollup.missing ? 'warning' : undefined} />
          <Stat label="Blocked tasks" value={d.rollup.blocked} tone={d.rollup.blocked ? 'warning' : undefined} />
          <Stat label="Overdue commitments" value={d.rollup.overdue} tone={d.rollup.overdue ? 'critical' : undefined} />
        </div>
        <div className="overflow-x-auto rounded-xl bg-surface ring-1 ring-line">
          {d.rows.length === 0 ? <Empty title="Nobody matches these filters" /> : (
            <table className="w-full min-w-[980px] text-[13px]">
              <thead className="border-b border-line text-left text-[12px] text-ink-3"><tr>
                <th className="px-3 py-2 font-medium">Employee</th><th className="px-3 py-2 font-medium">Capacity</th><th className="px-3 py-2 font-medium">Daily plan</th>
                <th className="px-3 py-2 font-medium">Work state</th><th className="px-3 py-2 font-medium">Confirmed · unknown</th><th className="px-3 py-2 font-medium">Recap</th><th className="px-3 py-2 font-medium">Assessment</th><th /></tr></thead>
              <tbody className="divide-y divide-line">{d.rows.map((row: any) => (
                <tr key={row.user.id} className="align-top hover:bg-surface-2/60">
                  <td className="px-3 py-2.5"><Link to={`/admin/routine/${row.user.id}?date=${f.date}`} className="flex items-center gap-2 font-medium hover:underline"><Avatar name={row.user.name} size={26} />
                    <span>{row.user.name}{row.user.isFounder && <Badge className="ml-1.5" tone="info">Founder</Badge>}<span className="block text-[12px] font-normal text-ink-3">{row.user.department ?? '—'}</span></span></Link></td>
                  <td className="whitespace-nowrap px-3 py-2.5">{row.availableMinutes ? hm(row.availableMinutes) : <Badge>{row.capacityStatus.replace('_', ' ')}</Badge>}{row.capacityStatus === 'partial_leave' && <div className="text-[11px] text-ink-3">half-day leave</div>}</td>
                  <td className="max-w-[260px] px-3 py-2.5">{row.plan.length === 0 ? <span className="text-ink-3">No plan</span> : <ul className="space-y-0.5">{row.plan.map((p: any, i: number) =>
                    <li key={i} className="flex items-center gap-1.5"><StatusDot status={p.status} /><span className="truncate" title={`${p.title} — ${STATUS_LABEL[p.status]}`}>{p.title}</span></li>)}</ul>}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-[12px]"><div>{row.acceptedPlanned}/{row.plan.length} accepted</div><div className="text-ink-3">{row.inProgress} in progress · <span className={row.blocked ? 'text-critical-ink' : ''}>{row.blocked} blocked</span>{row.overdue ? <> · <span className="text-critical-ink">{row.overdue} overdue</span></> : null}</div></td>
                  <td className="whitespace-nowrap px-3 py-2.5 tabular">{row.availableMinutes ? <>{hm(row.explainedMinutes)} <span className="text-ink-3">· {hm(row.unknownMinutes)}</span><div className="text-[11px] text-ink-3">{pct(row.coverage)} coverage</div></> : 'N/A'}</td>
                  <td className="px-3 py-2.5"><Badge tone={RECAP[row.recapStatus]?.tone}>{RECAP[row.recapStatus]?.label ?? row.recapStatus}</Badge>
                    {row.openClarifications > 0 && <div className="mt-1 text-[11px] text-warning-ink">{row.openClarifications} question open</div>}</td>
                  <td className="px-3 py-2.5"><AssessmentBadge label={row.assessment} /></td>
                  <td className="px-3 py-2.5 text-right"><Link to={`/admin/routine/${row.user.id}?date=${f.date}`}><Button size="sm">Open</Button></Link></td>
                </tr>))}</tbody>
            </table>)}
        </div>
        <div className="mt-4"><Callout tone="neutral" icon={<ShieldCheck className="mt-0.5 size-4 shrink-0" />}>This view shows recorded work only — not continuous monitoring. People are not ranked; dissimilar roles are not compared by hours or task counts. Private HR files, calendar descriptions and vault contents stay behind their own permissions.</Callout></div>
      </>}
    </div>
  );
}
