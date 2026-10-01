import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Link2, Pencil, Plus, Target, Trash2, Unlink } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { fmtDate, fmtDateTime, hm, pct } from '../../lib/format';
import { useMe, useRoles } from '../../lib/session';
import { Avatar, Badge, Button, Callout, Card, Checkbox, Empty, ErrorState, Field, IconButton, Input, Modal, PageHeader, Select, Skeleton, StatusBadge, Textarea, cx, useToast } from '../../components/ui';
import { useProjects, useUsers } from '../../components/TaskStatus';
import { TaskDrawer } from '../TaskDetail';
import { BASIS, ConfidenceTrend, FORECAST, ForecastBadge, KR_KIND, LIFECYCLE, ProgressMeter, periodText, weekLabel } from '../../components/ext/ObjectivesUI';

const CONFIDENCE = ['Very low', 'Low', 'Medium', 'High', 'Very high'];
const newKey = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);

function useRefresh(id: string) {
  const qc = useQueryClient();
  return () => { qc.invalidateQueries({ queryKey: ['objective', id] }); qc.invalidateQueries({ queryKey: ['objectives-overview'] }); qc.invalidateQueries({ queryKey: ['leadership'] }); };
}

export default function ObjectiveDetail() {
  const { id = '' } = useParams(); const r = useRoles();
  const q = useQuery({ queryKey: ['objective', id], queryFn: () => api.get(`/api/objectives/${id}`), enabled: !r.customer && !!id });
  const [drawer, setDrawer] = useState<string | null>(null); const [edit, setEdit] = useState(false);
  const back = <Link to="/objectives" className="mb-3 inline-flex items-center gap-1 rounded text-[13px] text-ink-3 hover:text-ink"><ArrowLeft className="size-4" aria-hidden />All objectives</Link>;
  if (r.customer) return <Card><Empty icon={<Target className="size-6" />} title="Objectives are for staff" /></Card>;
  if (q.isLoading) return <div>{back}<Skeleton className="mb-4 h-12 w-2/3" /><div className="grid gap-4 lg:grid-cols-3"><Skeleton className="h-72 lg:col-span-2" /><Skeleton className="h-72" /></div></div>;
  if (q.error) return <div>{back}<ErrorState error={q.error} onRetry={(q.error as any)?.status === 404 ? undefined : () => q.refetch()} /></div>;
  const d = q.data; const o = d.objective;
  return (
    <div>
      {back}
      <PageHeader eyebrow="Objective" title={o.title}
        subtitle={<span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">{o.owner_name ? <span className="inline-flex items-center gap-1.5"><Avatar name={o.owner_name} size={18} />Owner: {o.owner_name}</span> : 'No owner'}<span>{periodText(o.period_start, o.period_end)}</span>
          {o.status !== 'active' && <Badge tone={LIFECYCLE[o.status]?.tone}>{LIFECYCLE[o.status]?.label}</Badge>}</span>}
        actions={d.permissions.canEdit && <Button icon={<Pencil className="size-4" />} onClick={() => setEdit(true)}>Edit objective</Button>} />
      {o.description && <p className="-mt-2 mb-4 max-w-3xl whitespace-pre-line text-sm text-ink-2">{o.description}</p>}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="min-w-0 space-y-4 lg:col-span-2">
          <StatusCard d={d} />
          <KeyResultsCard d={d} />
          <MilestonesCard d={d} />
          <TasksCard d={d} onOpen={setDrawer} />
        </div>
        <div className="min-w-0 space-y-4">
          <CheckinsCard d={d} />
          <HistoryCard d={d} />
        </div>
      </div>
      <TaskDrawer id={drawer} onClose={() => setDrawer(null)} />
      {edit && <EditObjectiveModal o={o} onClose={() => setEdit(false)} />}
    </div>
  );
}

function StatusCard({ d }: { d: any }) {
  const f = d.forecast; const o = d.objective;
  return (
    <Card title="Status and forecast" subtitle="Computed from linked work and key results. Every input is listed; nothing is estimated where data is missing.">
      <div className="flex flex-wrap items-center gap-3">
        <span data-testid="objective-status"><ForecastBadge status={f?.status} lifecycle={o.status} size="lg" /></span>
        <span className="text-[28px] font-semibold leading-none tabular">{d.progress.value === null ? 'N/A' : pct(d.progress.value)}</span>
        <span className="text-[13px] text-ink-3">overall progress</span>
      </div>
      <div className="mt-3"><ProgressMeter value={d.progress.value} expected={f?.expected} status={f?.status} label="Objective progress" showLegend /></div>
      <p className="mt-2 text-[12px] text-ink-3">{d.progress.explanation}</p>
      {f ? (
        <>
          <h3 className="mt-4 text-[13px] font-semibold text-ink">Why {FORECAST[f.status as keyof typeof FORECAST].label.toLowerCase()}</h3>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-[13px] text-ink-2">{f.reasons.map((x: string) => <li key={x}>{x}</li>)}</ul>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {f.signals.map((s: any) => (
              <div key={s.key} className="rounded-lg bg-surface-2 p-3 ring-1 ring-inset ring-line">
                <div className="flex items-center justify-between gap-2"><span className="text-[13px] font-medium">{s.key === 'elapsed' ? 'Progress vs. elapsed time' : 'Velocity forecast'}</span>
                  {s.used ? <ForecastBadge status={s.status} /> : <Badge>Not used</Badge>}</div>
                <p className="mt-1 text-[12px] text-ink-2">{s.summary.charAt(0).toUpperCase() + s.summary.slice(1)}</p>
              </div>))}
          </div>
          <details className="mt-4">
            <summary className="cursor-pointer rounded text-[13px] font-medium text-accent-ink">Facts and assumptions</summary>
            <h4 className="mt-3 text-[12px] font-semibold uppercase tracking-wide text-ink-3">Facts</h4>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-[13px] text-ink-2">{f.facts.map((x: string) => <li key={x}>{x}</li>)}</ul>
            <h4 className="mt-3 text-[12px] font-semibold uppercase tracking-wide text-ink-3">Assumptions</h4>
            {f.assumptions.length ? <ul className="mt-1 list-disc space-y-1 pl-5 text-[13px] text-ink-2">{f.assumptions.map((x: string) => <li key={x}>{x}</li>)}</ul> : <p className="mt-1 text-[13px] text-ink-3">None.</p>}
            <p className="mt-3 text-[12px] text-ink-3">Rules: estimates are used when at least {pct(f.rules.estimateCoverage)} of tasks have one. At risk when progress is more than {Math.round(f.rules.gapAtRisk * 100)} points behind elapsed time
              or the recent pace needs more weeks than remain; off track beyond {Math.round(f.rules.gapOffTrack * 100)} points or {pct(f.rules.paceOffTrack)} of the time left. Velocity uses the last {f.rules.velocityWeeks} weeks and needs {f.rules.minHistoryWeeks} weeks of history.
              Check-in confidence is shown alongside and never changes the computed status.</p>
          </details>
        </>
      ) : <div className="mt-4"><Callout tone="neutral">This objective is {LIFECYCLE[o.status]?.label.toLowerCase()}. Forecasts are computed only for active objectives.</Callout></div>}
    </Card>
  );
}

function KeyResultsCard({ d }: { d: any }) {
  const [modal, setModal] = useState<any | null>(null); const [del, setDel] = useState<any | null>(null);
  const toast = useToast(); const refresh = useRefresh(d.objective.id);
  const rm = useMutation({ mutationFn: (k: any) => api.del(`/api/objectives/${d.objective.id}/key-results/${k.id}`),
    onSuccess: () => { setDel(null); refresh(); toast({ tone: 'good', text: 'Key result removed' }); }, onError: (e: any) => toast({ tone: 'critical', text: e.message }) });
  const can = d.permissions.canMaintain;
  return (
    <Card title="Key results" subtitle="Measurable results. Linked kinds are computed from work; reported values come from the owner."
      actions={can && <Button size="sm" aria-label="Add key result" icon={<Plus className="size-4" />} onClick={() => setModal({})}><span className="sm:hidden">Add</span><span className="hidden sm:inline">Add key result</span></Button>}>
      {d.keyResults.length === 0 ? <Empty title="No key results yet">{can ? 'Add one to say how success is measured.' : 'The owner has not added key results.'}</Empty> : (
        <ul className="divide-y divide-line">{d.keyResults.map((k: any) => (
          <li key={k.id} className="py-3 first:pt-0 last:pb-0">
            <div className="flex flex-wrap items-start gap-2">
              <div className="min-w-0 flex-1 basis-40"><div className="text-[14px] font-medium">{k.title}</div>
                <div className="mt-0.5 text-[12px] text-ink-3">{KR_KIND[k.kind]}{k.basis !== 'none' && k.kind === 'task_completion' ? ` · ${BASIS[k.basis]}` : ''}</div></div>
              <span className="text-[13px] font-medium tabular">{k.progress === null ? 'N/A' : pct(k.progress)}</span>
              {can && <div className="flex gap-0.5">
                <IconButton label={`Edit key result ${k.title}`} onClick={() => setModal(k)}><Pencil className="size-4" /></IconButton>
                <IconButton label={`Delete key result ${k.title}`} onClick={() => setDel(k)}><Trash2 className="size-4" /></IconButton></div>}
            </div>
            <div className="mt-2"><ProgressMeter value={k.progress} label={`Progress of key result ${k.title}`} /></div>
            <p className="mt-1.5 text-[12px] text-ink-2">{k.explanation}</p>
            {k.links.length > 0 && <div className="mt-1.5 flex flex-wrap gap-1">{k.links.map((l: any) => <Badge key={l.id}>{l.label}</Badge>)}</div>}
            {can && k.kind === 'manual' && d.objective.status === 'active' && <ReportValue key={`${k.id}:${k.version}`} objectiveId={d.objective.id} kr={k} />}
          </li>))}</ul>)}
      {modal && <KrModal d={d} kr={modal.id ? modal : null} onClose={() => setModal(null)} />}
      <Modal open={!!del} onClose={() => setDel(null)} title="Delete key result"
        footer={<><Button variant="ghost" onClick={() => setDel(null)}>Cancel</Button><Button variant="danger" loading={rm.isPending} onClick={() => rm.mutate(del)}>Delete</Button></>}>
        <p className="text-sm">Delete “{del?.title}”? The change is recorded in the audit log.</p>
      </Modal>
    </Card>
  );
}

function ReportValue({ objectiveId, kr }: { objectiveId: string; kr: any }) {
  const [v, setV] = useState(kr.current_value ?? ''); const toast = useToast(); const refresh = useRefresh(objectiveId);
  const m = useMutation({ mutationFn: () => api.patch(`/api/objectives/${objectiveId}/key-results/${kr.id}`, { currentValue: v === '' ? null : Number(v), version: kr.version }),
    onSuccess: () => { refresh(); toast({ tone: 'good', text: 'Value recorded' }); }, onError: (e: any) => { toast({ tone: 'critical', text: e.message }); if (e instanceof ApiError && e.status === 409) refresh(); } });
  return (
    <form className="mt-2 flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
      <Input aria-label={`Current value for ${kr.title}`} type="number" step="any" className="h-8 w-28" value={v} onChange={(e) => setV(e.target.value)} />
      <span className="text-[12px] text-ink-3">of {kr.target_value}{kr.unit ? ` ${kr.unit}` : ''}</span>
      <Button size="sm" type="submit" loading={m.isPending} disabled={String(v) === String(kr.current_value ?? '')}>Record value</Button>
    </form>
  );
}

function KrModal({ d, kr, onClose }: { d: any; kr: any | null; onClose: () => void }) {
  const toast = useToast(); const refresh = useRefresh(d.objective.id); const projects = useProjects();
  const open = useQuery({ queryKey: ['milestones-open'], queryFn: () => api.get('/api/milestones') });
  const [f, setF] = useState({ title: kr?.title ?? '', kind: kr?.kind ?? 'manual', targetValue: kr?.target_value ?? '', currentValue: kr?.current_value ?? '', unit: kr?.unit ?? '',
    milestoneIds: (kr?.milestone_ids ?? []) as string[], projectIds: (kr?.project_ids ?? []) as string[] });
  const msOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const x of d.milestones) if (!x.restricted) m.set(x.id, `${x.project_key} · ${x.name}`);
    for (const x of open.data ?? []) if (!m.has(x.id)) m.set(x.id, `${x.project_key} · ${x.name}`);
    for (const l of kr?.links ?? []) if (l.type === 'milestone' && !m.has(l.id)) m.set(l.id, l.label);
    return [...m.entries()];
  }, [d.milestones, open.data, kr]);
  const toggle = (k: 'milestoneIds' | 'projectIds', id: string, on: boolean) => setF({ ...f, [k]: on ? [...f[k], id] : f[k].filter((x) => x !== id) });
  const valid = f.title.trim() && (f.kind === 'manual' ? Number(f.targetValue) > 0 : f.kind === 'milestone_completion' ? f.milestoneIds.length > 0 : f.milestoneIds.length + f.projectIds.length > 0);
  const m = useMutation({
    mutationFn: () => {
      const body: any = { title: f.title, kind: f.kind };
      if (f.kind === 'manual') Object.assign(body, { targetValue: Number(f.targetValue), currentValue: f.currentValue === '' ? null : Number(f.currentValue), unit: f.unit });
      else Object.assign(body, { milestoneIds: f.milestoneIds, projectIds: f.kind === 'task_completion' ? f.projectIds : [] });
      return kr ? api.patch(`/api/objectives/${d.objective.id}/key-results/${kr.id}`, { ...body, version: kr.version }) : api.post(`/api/objectives/${d.objective.id}/key-results`, body);
    },
    onSuccess: () => { refresh(); toast({ tone: 'good', text: kr ? 'Key result updated' : 'Key result added' }); onClose(); },
    onError: (e: any) => { toast({ tone: 'critical', text: e.message }); if (e instanceof ApiError && e.status === 409) { refresh(); onClose(); } },
  });
  return (
    <Modal open onClose={onClose} title={kr ? 'Edit key result' : 'Add key result'}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} disabled={!valid} onClick={() => m.mutate()}>{kr ? 'Save' : 'Add'}</Button></>}>
      <div className="grid gap-3">
        <Field label="Key result">{(id) => <Input id={id} value={f.title} maxLength={300} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="e.g. 3 enterprise pilots live" />}</Field>
        <Field label="How it is measured">{(id) => <Select id={id} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
          {Object.entries(KR_KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}</Field>
        {f.kind === 'manual' ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Target">{(id) => <Input id={id} type="number" step="any" min={0} value={f.targetValue} onChange={(e) => setF({ ...f, targetValue: e.target.value })} />}</Field>
            <Field label="Current (optional)">{(id) => <Input id={id} type="number" step="any" value={f.currentValue} onChange={(e) => setF({ ...f, currentValue: e.target.value })} />}</Field>
            <Field label="Unit">{(id) => <Input id={id} value={f.unit} maxLength={40} onChange={(e) => setF({ ...f, unit: e.target.value })} placeholder="customers" />}</Field>
          </div>
        ) : (
          <>
            <fieldset>
              <legend className="mb-1.5 text-[13px] font-medium text-ink-2">Milestones</legend>
              {open.isLoading ? <Skeleton className="h-16" /> : msOptions.length === 0 ? <p className="text-[13px] text-ink-3">No open milestones.</p> :
                <div className="max-h-44 space-y-1.5 overflow-y-auto rounded-lg p-2 ring-1 ring-inset ring-line">{msOptions.map(([id, label]) =>
                  <div key={id}><Checkbox checked={f.milestoneIds.includes(id)} onChange={(v) => toggle('milestoneIds', id, v)} label={label} /></div>)}</div>}
            </fieldset>
            {f.kind === 'task_completion' && (
              <fieldset>
                <legend className="mb-1.5 text-[13px] font-medium text-ink-2">Projects (all their tasks count)</legend>
                <div className="max-h-36 space-y-1.5 overflow-y-auto rounded-lg p-2 ring-1 ring-inset ring-line">{(projects.data ?? []).filter((p: any) => p.status !== 'archived').map((p: any) =>
                  <div key={p.id}><Checkbox checked={f.projectIds.includes(p.id)} onChange={(v) => toggle('projectIds', p.id, v)} label={`${p.key} · ${p.name}`} /></div>)}</div>
              </fieldset>)}
            <p className="text-[12px] text-ink-3">{f.kind === 'milestone_completion' ? 'Progress = done milestones ÷ linked milestones (cancelled ones are left out).' : 'Progress = accepted tasks, weighted by estimates when at least 80% have one, otherwise by count.'}</p>
          </>
        )}
      </div>
    </Modal>
  );
}

function MilestonesCard({ d }: { d: any }) {
  const toast = useToast(); const refresh = useRefresh(d.objective.id); const can = d.permissions.canEdit;
  const opts = useQuery({ queryKey: ['objective-ms-options', d.objective.id], queryFn: () => api.get(`/api/objectives/${d.objective.id}/milestone-options`), enabled: can });
  const [pick, setPick] = useState(''); const [move, setMove] = useState<{ id: string; message: string } | null>(null); const [drop, setDrop] = useState<any | null>(null);
  const qc = useQueryClient();
  const after = () => { refresh(); qc.invalidateQueries({ queryKey: ['objective-ms-options', d.objective.id] }); };
  const linkM = useMutation({ mutationFn: (b: { milestoneId: string; move?: boolean }) => api.post(`/api/objectives/${d.objective.id}/milestones`, b),
    onSuccess: () => { setPick(''); setMove(null); after(); toast({ tone: 'good', text: 'Milestone linked' }); },
    onError: (e: any, b) => { if (e instanceof ApiError && e.status === 409 && !b.move) setMove({ id: b.milestoneId, message: e.message }); else toast({ tone: 'critical', text: e.message }); } });
  const unlink = useMutation({ mutationFn: (mid: string) => api.del(`/api/objectives/${d.objective.id}/milestones/${mid}`),
    onSuccess: () => { setDrop(null); after(); toast({ tone: 'good', text: 'Milestone unlinked' }); }, onError: (e: any) => toast({ tone: 'critical', text: e.message }) });
  return (
    <Card title="Linked milestones" subtitle={d.milestones.length === 0 ? undefined : d.work.value === null ? d.work.explanation : `Linked work ${pct(d.work.value)}: ${d.work.explanation}`} padded={false}>
      {d.milestones.length === 0 ? <Empty title="No milestones linked">{can ? 'Link project milestones that move this objective.' : 'Leadership links milestones to objectives.'}</Empty> : (
        <ul className="divide-y divide-line">{d.milestones.map((m: any) => (
          <li key={m.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
            <div className="min-w-0 flex-1 basis-48">
              <div className="text-[13px] font-medium">{m.restricted ? <span className="text-ink-3">{m.name}</span> : <>{m.project_id ? <Link className="hover:underline" to={`/projects/${m.project_id}`} aria-label={`Project ${m.project_key}`}>{m.project_key}</Link> : null} · {m.name}</>}</div>
              <div className="text-[12px] text-ink-3">{m.due_date ? `Due ${fmtDate(m.due_date)}` : 'No due date'} · {m.stats.done}/{m.stats.tasks} tasks accepted{m.stats.tasks > 0 && m.stats.estimated < m.stats.tasks ? ` · ${m.stats.tasks - m.stats.estimated} unestimated` : ''}</div>
            </div>
            <Badge tone={m.status === 'done' ? 'good' : m.status === 'cancelled' ? 'neutral' : 'info'}>{m.status === 'done' ? 'Done' : m.status === 'cancelled' ? 'Cancelled' : 'Open'}</Badge>
            {can && <IconButton label={`Unlink milestone ${m.name}`} onClick={() => setDrop(m)}><Unlink className="size-4" /></IconButton>}
          </li>))}</ul>)}
      {can && (
        <form className="flex flex-wrap gap-2 border-t border-line px-4 py-3" onSubmit={(e) => { e.preventDefault(); if (pick) linkM.mutate({ milestoneId: pick }); }}>
          <Select aria-label="Milestone to link" className="h-8 min-w-0 flex-1 basis-56" value={pick} onChange={(e) => setPick(e.target.value)} disabled={opts.isLoading}>
            <option value="">{opts.isLoading ? 'Loading milestones…' : opts.error ? 'Could not load milestones' : (opts.data ?? []).length ? 'Choose a milestone to link' : 'No other open milestones'}</option>
            {(opts.data ?? []).map((m: any) => <option key={m.id} value={m.id}>{m.project_key} · {m.name}{m.objective_title ? ` (linked to: ${m.objective_title})` : ''}</option>)}
          </Select>
          <Button size="sm" type="submit" icon={<Link2 className="size-4" />} disabled={!pick} loading={linkM.isPending}>Link</Button>
        </form>)}
      <Modal open={!!move} onClose={() => setMove(null)} title="Move milestone?"
        footer={<><Button variant="ghost" onClick={() => setMove(null)}>Cancel</Button><Button variant="primary" loading={linkM.isPending} onClick={() => move && linkM.mutate({ milestoneId: move.id, move: true })}>Move here</Button></>}>
        <p className="text-sm">{move?.message}</p><p className="mt-2 text-[13px] text-ink-3">A milestone counts toward one objective at a time.</p>
      </Modal>
      <Modal open={!!drop} onClose={() => setDrop(null)} title="Unlink milestone?"
        footer={<><Button variant="ghost" onClick={() => setDrop(null)}>Cancel</Button><Button variant="danger" loading={unlink.isPending} onClick={() => drop && unlink.mutate(drop.id)}>Unlink</Button></>}>
        <p className="text-sm">Unlink “{drop?.project_key ? `${drop.project_key} · ` : ''}{drop?.name}” from this objective?</p>
        <p className="mt-2 text-[13px] text-ink-3">Its {drop?.stats.tasks ?? 0} task{drop?.stats.tasks === 1 ? '' : 's'} will stop counting toward progress and the forecast. The milestone and its tasks are not changed, and you can link it again later.</p>
      </Modal>
    </Card>
  );
}

function TasksCard({ d, onOpen }: { d: any; onOpen: (id: string) => void }) {
  const [all, setAll] = useState(false);
  const rows = all ? d.tasks : d.tasks.slice(0, 12);
  return (
    <Card title="Linked tasks" subtitle={`Tasks in the linked milestones (cancelled tasks are left out).${d.work.stats.tasks ? ` ${d.work.stats.estimated} of ${d.work.stats.tasks} have an estimate.` : ''}`} padded={false}>
      {d.tasks.length === 0 ? <Empty title={d.hiddenTasks ? 'No tasks you can see' : 'No linked tasks yet'}>{d.hiddenTasks ? `${d.hiddenTasks} task${d.hiddenTasks === 1 ? ' is' : 's are'} in projects you do not have access to. They still count toward progress.` : 'Tasks appear when milestones with tasks are linked.'}</Empty> : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <caption className="sr-only">Tasks linked to this objective</caption>
              <thead className="border-b border-line text-left text-[12px] text-ink-3"><tr><th className="px-4 py-2 font-medium">Task</th><th className="px-3 py-2 font-medium">Status</th><th className="hidden px-3 py-2 font-medium sm:table-cell">Owner</th><th className="hidden px-3 py-2 text-right font-medium sm:table-cell">Estimate</th><th className="hidden px-3 py-2 font-medium sm:table-cell">Due / accepted</th></tr></thead>
              <tbody className="divide-y divide-line">{rows.map((t: any) => (
                <tr key={t.id} className="align-top">
                  <td className="px-4 py-2"><button type="button" className="rounded text-left font-medium break-words hover:underline" onClick={() => onOpen(t.id)}><span className="text-ink-3">#{t.number}</span> {t.title}</button>
                    <div className="mt-0.5 text-[12px] text-ink-3 sm:hidden">{[t.owner_name, t.estimate_minutes ? hm(t.estimate_minutes) : 'No estimate', dueText(t)].filter(Boolean).join(' · ')}</div></td>
                  <td className="px-3 py-2"><StatusBadge status={t.status} /></td>
                  <td className="hidden px-3 py-2 whitespace-nowrap sm:table-cell">{t.owner_name}</td>
                  <td className="hidden px-3 py-2 text-right tabular sm:table-cell">{t.estimate_minutes ? hm(t.estimate_minutes) : <span className="text-ink-3">None</span>}</td>
                  <td className="hidden px-3 py-2 whitespace-nowrap sm:table-cell">{dueText(t) || '—'}</td>
                </tr>))}</tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-2 text-[12px] text-ink-3">
            <span>{d.hiddenTasks ? `${d.hiddenTasks} more task${d.hiddenTasks === 1 ? ' is' : 's are'} in projects you cannot open; they still count toward progress.` : `${d.tasks.length} task${d.tasks.length === 1 ? '' : 's'}`}</span>
            {d.tasks.length > 12 && <Button size="sm" variant="ghost" onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${d.tasks.length}`}</Button>}
          </div>
        </>)}
    </Card>
  );
}

const dueText = (t: any) => (t.status === 'done' && t.accepted_at ? `Accepted ${fmtDate(t.accepted_at)}` : t.due_date ? `Due ${fmtDate(t.due_date)}` : '');

function CheckinsCard({ d }: { d: any }) {
  const toast = useToast(); const refresh = useRefresh(d.objective.id);
  const [c, setC] = useState(0); const [note, setNote] = useState(''); const [key, setKey] = useState(newKey);
  const m = useMutation({ mutationFn: () => api.post(`/api/objectives/${d.objective.id}/checkins`, { confidence: c, note, idempotencyKey: key }),
    onSuccess: () => { setC(0); setNote(''); setKey(newKey()); refresh(); toast({ tone: 'good', text: 'Check-in posted' }); }, onError: (e: any) => toast({ tone: 'critical', text: e.message }) });
  return (
    <Card title="Check-ins" subtitle="Confidence and notes from the owner and leadership. Shown next to the computed status, never folded into it.">
      {d.permissions.canCheckIn && (
        <form className="mb-4 space-y-3 border-b border-line pb-4" onSubmit={(e) => { e.preventDefault(); if (c) m.mutate(); }}>
          <fieldset>
            <legend className="mb-1.5 text-[13px] font-medium text-ink-2">How confident are you this objective will be met?</legend>
            <div className="grid grid-cols-5 gap-1">{CONFIDENCE.map((label, i) => (
              <label key={label} className={cx('flex cursor-pointer flex-col items-center rounded-lg px-1 py-1.5 text-center ring-1 ring-inset focus-within:ring-2 focus-within:ring-accent',
                c === i + 1 ? 'bg-accent-soft text-accent-ink ring-accent' : 'ring-line hover:bg-surface-2')}>
                <input type="radio" name="confidence" className="sr-only" value={i + 1} checked={c === i + 1} onChange={() => setC(i + 1)} aria-label={`${i + 1} – ${label}`} />
                <span className="text-[15px] font-semibold tabular">{i + 1}</span><span className="text-[11px] leading-tight">{label}</span>
              </label>))}</div>
          </fieldset>
          <Field label="Note (optional)">{(id) => <Textarea id={id} rows={2} maxLength={4000} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What changed, what is blocking, what help is needed" />}</Field>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Button type="submit" variant="primary" size="sm" disabled={!c} loading={m.isPending}>Post check-in</Button>
            {!c && <span className="text-[12px] text-ink-3">Choose a confidence level first.</span>}
          </div>
        </form>)}
      <ConfidenceTrend checkins={d.checkins} />
      {d.checkins.length > 0 && (
        <ol className="mt-4 space-y-3" aria-label="Check-in timeline">{d.checkins.map((x: any) => (
          <li key={x.id} className="flex gap-2.5">
            <Avatar name={x.author_name ?? '?'} size={24} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 text-[12px] text-ink-3"><span className="font-medium text-ink">{x.author_name ?? 'Former user'}</span><time dateTime={x.created_at}>{fmtDateTime(x.created_at)}</time>
                <Badge tone={x.confidence <= 2 ? 'warning' : x.confidence >= 4 ? 'good' : 'neutral'}>Confidence {x.confidence}/5</Badge></div>
              {x.note && <p className="mt-0.5 whitespace-pre-line break-words text-[13px] text-ink-2">{x.note}</p>}
            </div>
          </li>))}</ol>)}
    </Card>
  );
}

function HistoryCard({ d }: { d: any }) {
  return (
    <Card title="Weekly status" subtitle="Snapshots from the weekly check. The owner is notified when the status turns at risk or off track.">
      {d.statusHistory.length === 0 ? <p className="text-[13px] text-ink-3">No weekly snapshot yet. The check runs once a week.</p> : (
        <ul className="space-y-2">{d.statusHistory.map((h: any) => (
          <li key={h.period_key} className="flex flex-wrap items-center gap-2 text-[13px]">
            <span className="shrink-0 tabular text-ink-3" title={h.period_key}>{weekLabel(h.period_key)}</span><ForecastBadge status={h.status} />
            <span className="tabular text-ink-2">{h.progress === null ? 'N/A' : pct(h.progress)}</span>
            {h.notified && <span className="text-[12px] text-ink-3">owner notified</span>}
          </li>))}</ul>)}
    </Card>
  );
}

function EditObjectiveModal({ o, onClose }: { o: any; onClose: () => void }) {
  const toast = useToast(); const refresh = useRefresh(o.id); const users = useUsers(); const me = useMe();
  const [f, setF] = useState({ title: o.title, description: o.description ?? '', ownerId: o.owner_id ?? '', periodStart: o.period_start ?? '', periodEnd: o.period_end ?? '', status: o.status, reason: '' });
  const bad = f.periodStart && f.periodEnd && f.periodEnd < f.periodStart;
  const m = useMutation({
    mutationFn: () => api.put(`/api/objectives/${o.id}`, { version: o.version, title: f.title, description: f.description, ownerId: f.ownerId || null,
      periodStart: f.periodStart || null, periodEnd: f.periodEnd || null, status: f.status, reason: f.reason || undefined }),
    onSuccess: () => { refresh(); toast({ tone: 'good', text: 'Objective saved' }); onClose(); },
    onError: (e: any) => { toast({ tone: 'critical', text: e.message }); if (e instanceof ApiError && e.status === 409) { refresh(); onClose(); } },
  });
  return (
    <Modal open onClose={onClose} title="Edit objective"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} disabled={!f.title.trim() || !!bad} onClick={() => m.mutate()}>Save</Button></>}>
      <div className="grid gap-3">
        <Field label="Objective">{(id) => <Input id={id} value={f.title} maxLength={300} onChange={(e) => setF({ ...f, title: e.target.value })} />}</Field>
        <Field label="Description">{(id) => <Textarea id={id} rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />}</Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Owner">{(id) => <Select id={id} value={f.ownerId} onChange={(e) => setF({ ...f, ownerId: e.target.value })}><option value="">No owner</option>
            {o.owner_id && !(users.data ?? []).some((u: any) => u.id === o.owner_id) && <option value={o.owner_id}>{o.owner_name ?? 'Current owner'}</option>}
            {(users.data ?? []).map((u: any) => <option key={u.id} value={u.id}>{u.name}{u.id === me.user.id ? ' (me)' : ''}</option>)}</Select>}</Field>
          <Field label="Lifecycle">{(id) => <Select id={id} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>{Object.entries(LIFECYCLE).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</Select>}</Field>
          <Field label="Period start">{(id) => <Input id={id} type="date" value={f.periodStart} onChange={(e) => setF({ ...f, periodStart: e.target.value })} />}</Field>
          <Field label="Period end" error={bad ? 'End must be on or after the start' : null}>{(id) => <Input id={id} type="date" value={f.periodEnd} onChange={(e) => setF({ ...f, periodEnd: e.target.value })} />}</Field>
        </div>
        <Field label="Reason for the change (optional, kept in the audit log)">{(id) => <Input id={id} value={f.reason} maxLength={500} onChange={(e) => setF({ ...f, reason: e.target.value })} />}</Field>
      </div>
    </Modal>
  );
}
