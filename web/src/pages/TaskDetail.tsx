import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, CheckCircle2, Download, ExternalLink, FileText, Link2, Lock, MessageSquare, Paperclip, Trash2, UserPlus, XCircle } from 'lucide-react';
import { api } from '../lib/api';
import { CATEGORY_LABEL, PRIORITY_LABEL, STATUS_LABEL, fmtDate, fmtDateTime, hm } from '../lib/format';
import { useMe } from '../lib/session';
import { Avatar, Badge, Button, Callout, Card, Checkbox, Drawer, ErrorState, Field, IconButton, Input, Modal, Select, Spinner, StatusBadge, StatusDot, Textarea, cx, useToast } from '../components/ui';
import { StatusControl, useProjects, useUsers } from '../components/TaskStatus';
import { BlockerEscalation, CAUSE_LABEL } from '../components/ext/EscalationBlocker';

export default function TaskPage() {
  const { id } = useParams(); const nav = useNavigate();
  return <div className="mx-auto max-w-4xl rounded-xl bg-surface ring-1 ring-line"><TaskDetailView id={id!} onClose={() => nav(-1)} /></div>;
}
export function TaskDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  return <Drawer open={!!id} onClose={onClose} title={id ? <Link to={`/tasks/${id}`} className="inline-flex items-center gap-1 hover:text-ink">Open full page <ArrowUpRight className="size-3.5" /></Link> : ''}>
    {id && <TaskDetailView id={id} onClose={onClose} />}</Drawer>;
}

export function TaskDetailView({ id, onClose }: { id: string; onClose: () => void }) {
  const me = useMe(); const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['task', id], queryFn: () => api.get(`/api/tasks/${id}`) });
  const users = useUsers(); const projects = useProjects();
  const ms = useQuery({ queryKey: ['milestones'], queryFn: () => api.get('/api/milestones'), staleTime: 120_000 });
  const patch = useMutation({
    mutationFn: (p: any) => api.patch(`/api/tasks/${id}`, { ...p, version: q.data.task.version }),
    onSuccess: () => qc.invalidateQueries(),
    onError: (e: any) => { toast({ tone: 'critical', text: e.message }); qc.invalidateQueries({ queryKey: ['task', id] }); },
  });
  const [reassign, setReassign] = useState(false);
  if (q.isLoading) return <Spinner />;
  if (q.error) return <div className="p-5"><ErrorState error={q.error} onRetry={() => q.refetch()} /></div>;
  const d = q.data;
  if (d.customerView) return <div className="p-6"><h1 className="text-lg font-semibold">{d.task.title}</h1><div className="mt-2"><StatusBadge status={d.task.status} /></div></div>;
  const t = d.task; const can = d.canEdit;
  const isReviewer = t.status === 'in_review' && (t.reviewer_id ? t.reviewer_id === me.user.id : me.user.managedUserIds.includes(t.owner_id)) && t.owner_id !== me.user.id;
  const openBlocker = d.blockers.find((b: any) => !b.resolved_at);
  return (
    <div className="px-5 py-4 sm:px-6">
      <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-3">
        <span className="tabular">#{t.number}</span>
        {d.project && <Link to={`/projects/${d.project.id}`} className="hover:text-ink">{d.project.key} · {d.project.name}</Link>}
        {d.milestone && <span>· {d.milestone.name}</span>}
        {t.source_type !== 'manual' && <Badge tone="info">{sourceLabel(t.source_type)}</Badge>}
        {t.reopen_count > 0 && <Badge tone="warning">Reworked {t.reopen_count}×</Badge>}
      </div>
      <EditableTitle value={t.title} disabled={!can} onSave={(title) => patch.mutate({ title })} />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <StatusControl task={t} />
        {t.requires_review && <Badge tone="neutral">Review required{d.reviewer ? ` · ${d.reviewer.name}` : ''}</Badge>}
        {t.requires_evidence && <Badge tone={d.evidence.length ? 'good' : 'warning'}>Evidence {d.evidence.length ? 'attached' : 'required'}</Badge>}
        {t.customer_visible && <Badge tone="info">Visible to client</Badge>}
      </div>

      {openBlocker && <div className="mt-4"><BlockerCard b={openBlocker} canEdit={can} /></div>}
      {isReviewer && <div className="mt-4"><ReviewPanel taskId={t.id} /></div>}

      <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 text-[13px] sm:grid-cols-3">
        <Prop label="Owner"><div className="flex items-center gap-1.5"><Avatar name={d.owner.name} size={20} />{d.owner.name}
          <button className="ml-1 text-[12px] text-accent-ink underline" onClick={() => setReassign(true)}>Reassign</button></div></Prop>
        <Prop label="Priority"><Select aria-label="Priority" disabled={!can} className="h-8" value={t.priority} onChange={(e) => patch.mutate({ priority: e.target.value })}>
          {Object.entries(PRIORITY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Prop>
        <Prop label="Due date"><Input aria-label="Due date" type="date" disabled={!can} className="h-8" value={t.due_date ?? ''} onChange={(e) => patch.mutate({ dueDate: e.target.value || null })} /></Prop>
        <Prop label="Estimate (minutes)"><Input aria-label="Estimate in minutes" type="number" min={1} disabled={!can} className="h-8" defaultValue={t.estimate_minutes ?? ''} key={t.version}
          onBlur={(e) => { const v = e.target.value ? Number(e.target.value) : null; if (v !== t.estimate_minutes) patch.mutate({ estimateMinutes: v }); }} /></Prop>
        <Prop label="Category"><Select aria-label="Category" disabled={!can} className="h-8" value={t.category} onChange={(e) => patch.mutate({ category: e.target.value })}>
          {Object.entries(CATEGORY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Prop>
        <Prop label="Reviewer"><Select aria-label="Reviewer" disabled={!can} className="h-8" value={t.reviewer_id ?? ''} onChange={(e) => patch.mutate({ reviewerId: e.target.value || null, requiresReview: !!e.target.value })}>
          <option value="">None</option>{(users.data ?? []).filter((u: any) => u.id !== t.owner_id).map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select></Prop>
        <Prop label="Project"><Select aria-label="Project" disabled={!can} className="h-8" value={t.project_id ?? ''} onChange={(e) => patch.mutate({ projectId: e.target.value || null, milestoneId: null })}>
          <option value="">No project (personal)</option>{(projects.data ?? []).filter((p: any) => p.status !== 'archived').map((p: any) => <option key={p.id} value={p.id}>{p.key} · {p.name}</option>)}</Select></Prop>
        <Prop label="Milestone"><Select aria-label="Milestone" disabled={!can || !t.project_id} className="h-8" value={t.milestone_id ?? ''} onChange={(e) => patch.mutate({ milestoneId: e.target.value || null })}>
          <option value="">None</option>{(ms.data ?? []).filter((m: any) => m.project_id === t.project_id).map((m: any) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select></Prop>
        <Prop label="Options"><div className="space-y-1">
          <Checkbox disabled={!can} checked={t.requires_evidence} onChange={(v) => patch.mutate({ requiresEvidence: v })} label="Evidence required" />
          <Checkbox disabled={!can || !d.project?.customer_id} checked={t.customer_visible} onChange={(v) => patch.mutate({ customerVisible: v })} label="Show to client" />
        </div></Prop>
      </dl>

      <Section title="Description & acceptance">
        <EditableText label="Description" value={t.description} disabled={!can} onSave={(description) => patch.mutate({ description })} placeholder="Context, links, notes…" />
        <EditableText label="Acceptance criteria" value={t.acceptance_criteria} disabled={!can} onSave={(acceptanceCriteria) => patch.mutate({ acceptanceCriteria })} placeholder="What does done mean? Reviewers check against this." />
      </Section>
      <Checklist taskId={t.id} items={d.checklist} can={can} />
      <Evidence task={t} items={d.evidence} can={can} />
      <Relations task={t} d={d} can={can} />
      <Comments taskId={t.id} comments={d.comments} />
      <Section title="History">
        <ol className="space-y-2 border-l border-line pl-4">
          {d.history.map((h: any) => (
            <li key={h.id} className="relative text-[13px]">
              <span className="absolute -left-[21px] top-1"><StatusDot status={h.to_status} /></span>
              <span className="font-medium">{h.from_status ? `${STATUS_LABEL[h.from_status]} → ${STATUS_LABEL[h.to_status]}` : `Created as ${STATUS_LABEL[h.to_status]}`}</span>
              <span className="text-ink-3"> · {h.actor_name ?? 'System'} · {fmtDateTime(h.at)}</span>
              {h.reason && <div className="text-[12px] text-ink-2">{h.reason}</div>}
            </li>
          ))}
        </ol>
        {d.timeTotalMinutes > 0 && <p className="mt-3 text-[12px] text-ink-3">Time recorded: {hm(d.timeTotalMinutes)}{d.time.length > 0 ? ` across ${d.time.length} entr${d.time.length > 1 ? 'ies' : 'y'} you can see` : ''}{d.timeHiddenEntries > 0 ? ' — teammates\' individual entries stay in their own records' : ''} (sources shown in My Day / reports).</p>}
      </Section>
      <ReassignModal open={reassign} onClose={() => setReassign(false)} task={t} users={users.data ?? []} />
      <div className="h-6" />
      <span className="hidden">{String(onClose)}</span>
    </div>
  );
}

const sourceLabel = (s: string) => ({ quick_capture: 'Quick capture', recurring: 'Recurring', integration: 'From integration', follow_up: 'Review follow-up', ai_draft: 'AI draft (reviewed)' } as any)[s] ?? s;
function Prop({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="min-w-0"><dt className="mb-1 text-[12px] text-ink-3">{label}</dt><dd>{children}</dd></div>;
}
function Section({ title, children, actions }: { title: string; children: React.ReactNode; actions?: React.ReactNode }) {
  return <section className="mt-6"><div className="mb-2 flex items-center justify-between"><h3 className="text-[13px] font-semibold uppercase tracking-wide text-ink-3">{title}</h3>{actions}</div>{children}</section>;
}
function EditableTitle({ value, onSave, disabled }: { value: string; onSave: (v: string) => void; disabled?: boolean }) {
  const [v, setV] = useState(value); useEffect(() => setV(value), [value]);
  return <input aria-label="Title" disabled={disabled} value={v} onChange={(e) => setV(e.target.value)} onBlur={() => v.trim() && v !== value && onSave(v.trim())}
    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
    className="mt-1 w-full rounded-md bg-transparent px-1 py-0.5 -mx-1 text-[20px] font-semibold leading-snug hover:bg-surface-2 focus:bg-surface-2 focus:outline-none disabled:hover:bg-transparent" />;
}
function EditableText({ label, value, onSave, disabled, placeholder }: { label: string; value: string; onSave: (v: string) => void; disabled?: boolean; placeholder?: string }) {
  const [v, setV] = useState(value); useEffect(() => setV(value), [value]);
  return <div className="mb-3"><Field label={label}>{(id) => <Textarea id={id} rows={v.split('\n').length > 2 ? 5 : 2} disabled={disabled} value={v} placeholder={placeholder}
    onChange={(e) => setV(e.target.value)} onBlur={() => v !== value && onSave(v)} />}</Field></div>;
}

function BlockerCard({ b, canEdit }: { b: any; canEdit: boolean }) {
  const qc = useQueryClient(); const toast = useToast();
  const [date, setDate] = useState(b.next_follow_up ?? '');
  const m = useMutation({ mutationFn: () => api.post(`/api/blockers/${b.id}/follow-up`, { nextFollowUp: date }), onSuccess: () => { qc.invalidateQueries(); toast({ tone: 'good', text: 'Follow-up date saved' }); },
    onError: (e: any) => toast({ tone: 'critical', text: e.message }) });
  const overdue = !b.next_follow_up || b.next_follow_up < new Date().toISOString().slice(0, 10);
  return (
    <div className="rounded-xl bg-critical-soft p-3.5 text-[13px] text-critical-ink">
      <div className="flex items-start gap-2"><XCircle className="mt-0.5 size-4 shrink-0" aria-hidden /><div className="flex-1">
        <p className="font-semibold">Blocked · {CAUSE_LABEL[b.cause] ?? b.cause}</p><p className="mt-0.5 text-ink">{b.reason}</p>
        <p className="mt-1 text-[12px]">Waiting on {b.waiting_on_name || b.waiting_on_text || '—'} · raised {fmtDateTime(b.raised_at)} by {b.raised_by_name}</p>
        {canEdit && <div className="mt-2 flex flex-wrap items-center gap-2">
          <label className="text-[12px]" htmlFor={`fu-${b.id}`}>Next follow-up{overdue ? ' (due)' : ''}</label>
          <Input id={`fu-${b.id}`} type="date" className="h-7 w-40" value={date} onChange={(e) => setDate(e.target.value)} />
          <Button size="sm" onClick={() => m.mutate()} disabled={!date} loading={m.isPending}>Save</Button>
        </div>}
        <BlockerEscalation blockerId={b.id} />
      </div></div>
    </div>
  );
}

function ReviewPanel({ taskId }: { taskId: string }) {
  const qc = useQueryClient(); const toast = useToast(); const [note, setNote] = useState('');
  const m = useMutation({ mutationFn: (decision: string) => api.post(`/api/tasks/${taskId}/review`, { decision, note }),
    onSuccess: (_r, decision) => { qc.invalidateQueries(); toast({ tone: 'good', text: decision === 'accepted' ? 'Accepted — counted as an accepted outcome' : 'Changes requested — owner notified' }); },
    onError: (e: any) => toast({ tone: 'critical', text: e.message }) });
  return (
    <div className="rounded-xl bg-warning-soft p-3.5">
      <p className="text-[13px] font-semibold text-warning-ink">Your review is requested</p>
      <p className="mt-0.5 text-[12px] text-ink-2">Check the acceptance criteria and evidence below, then decide.</p>
      <Textarea aria-label="Review note" className="mt-2" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (required when requesting changes)" />
      <div className="mt-2 flex gap-2">
        <Button variant="primary" size="sm" icon={<CheckCircle2 className="size-3.5" />} loading={m.isPending && m.variables === 'accepted'} onClick={() => m.mutate('accepted')}>Accept</Button>
        <Button size="sm" disabled={!note.trim()} loading={m.isPending && m.variables === 'changes_requested'} onClick={() => m.mutate('changes_requested')}>Request changes</Button>
      </div>
    </div>
  );
}

function Checklist({ taskId, items, can }: { taskId: string; items: any[]; can: boolean }) {
  const qc = useQueryClient(); const toast = useToast(); const [text, setText] = useState('');
  const inv = () => qc.invalidateQueries({ queryKey: ['task', taskId] });
  const add = useMutation({ mutationFn: () => api.post(`/api/tasks/${taskId}/checklist`, { text }), onSuccess: () => { setText(''); inv(); }, onError: (e: any) => toast({ tone: 'critical', text: e.message }) });
  const toggle = useMutation({ mutationFn: (i: any) => api.patch(`/api/checklist/${i.id}`, { done: !i.done }), onSuccess: inv });
  const del = useMutation({ mutationFn: (i: any) => api.del(`/api/checklist/${i.id}`), onSuccess: inv });
  const done = items.filter((i) => i.done).length;
  return (
    <Section title={`Checklist${items.length ? ` · ${done}/${items.length}` : ''}`}>
      <ul className="space-y-1">{items.map((i) => (
        <li key={i.id} className="group flex items-center gap-2">
          <Checkbox disabled={!can} checked={i.done} onChange={() => toggle.mutate(i)} label={<span className={cx(i.done && 'text-ink-3 line-through')}>{i.text}</span>} />
          {can && <IconButton label="Remove item" className="ml-auto size-6 opacity-0 group-hover:opacity-100" onClick={() => del.mutate(i)}><Trash2 className="size-3.5" /></IconButton>}
        </li>))}</ul>
      {can && <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (text.trim()) add.mutate(); }}>
        <Input aria-label="New checklist item" className="h-8" value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a step…" /><Button size="sm" type="submit" disabled={!text.trim()}>Add</Button></form>}
    </Section>
  );
}

function Evidence({ task, items, can }: { task: any; items: any[]; can: boolean }) {
  const qc = useQueryClient(); const toast = useToast(); const me = useMe();
  const [mode, setMode] = useState<null | 'link' | 'file' | 'ref'>(null);
  const [label, setLabel] = useState(''); const [url, setUrl] = useState(''); const [file, setFile] = useState<File | null>(null); const [ref, setRef] = useState(''); const [mod, setMod] = useState('');
  const add = useMutation({
    mutationFn: () => {
      if (mode === 'file') { const fd = new FormData(); fd.append('label', label || file!.name); fd.append('file', file!); return api.post(`/api/tasks/${task.id}/evidence`, fd); }
      if (mode === 'ref') return api.post(`/api/tasks/${task.id}/evidence`, { label, sourceModule: mod || undefined, sourceReference: ref, restricted: true });
      return api.post(`/api/tasks/${task.id}/evidence`, { label, url });
    },
    onSuccess: () => { qc.invalidateQueries(); setMode(null); setLabel(''); setUrl(''); setFile(null); setRef(''); toast({ tone: 'good', text: 'Evidence added' }); },
    onError: (e: any) => toast({ tone: 'critical', text: e.message }),
  });
  const del = useMutation({ mutationFn: (id: string) => api.del(`/api/evidence/${id}`), onSuccess: () => qc.invalidateQueries(), onError: (e: any) => toast({ tone: 'critical', text: e.message }) });
  return (
    <Section title="Evidence" actions={can && <div className="flex gap-1">
      <Button size="sm" variant="ghost" icon={<Link2 className="size-3.5" />} onClick={() => setMode('link')}>Link</Button>
      <Button size="sm" variant="ghost" icon={<Paperclip className="size-3.5" />} onClick={() => setMode('file')}>File</Button>
      <Button size="sm" variant="ghost" icon={<Lock className="size-3.5" />} onClick={() => setMode('ref')}>Confidential ref</Button></div>}>
      {items.length === 0 ? <p className="text-[13px] text-ink-3">{task.requires_evidence ? 'Evidence is required before this can be completed.' : 'No evidence yet.'}</p> : (
        <ul className="divide-y divide-line rounded-lg ring-1 ring-line">{items.map((e) => (
          <li key={e.id} className="flex items-center gap-2.5 px-3 py-2 text-[13px]">
            {e.hidden || e.restricted ? <Lock className="size-4 text-ink-3" aria-hidden /> : e.kind === 'file' ? <FileText className="size-4 text-ink-3" aria-hidden /> : <ExternalLink className="size-4 text-ink-3" aria-hidden />}
            <div className="min-w-0 flex-1">
              {e.hidden ? <span className="text-ink-2">Confidential reference <span className="text-ink-3">(visible only to the owner and the person who added it)</span></span>
                : e.kind === 'link' ? <a href={e.url} target="_blank" rel="noopener noreferrer" className="truncate text-accent-ink underline">{e.label}</a>
                : e.kind === 'file' ? <a href={`/api/evidence/${e.id}/file`} className="inline-flex items-center gap-1 text-accent-ink underline">{e.label}<Download className="size-3" /></a>
                : <span>{e.label} <span className="text-ink-3">· {e.source_module ? `${e.source_module} · ` : ''}ref {e.source_reference}</span></span>}
              {!e.hidden && <div className="text-[11px] text-ink-3">{e.added_by_name ?? 'System'} · {fmtDateTime(e.created_at)}</div>}
            </div>
            {e.added_by === me.user.id && task.status !== 'done' && <IconButton label="Withdraw evidence" className="size-7" onClick={() => del.mutate(e.id)}><Trash2 className="size-3.5" /></IconButton>}
          </li>))}</ul>
      )}
      <Modal open={!!mode} onClose={() => setMode(null)} title={mode === 'file' ? 'Upload evidence file' : mode === 'ref' ? 'Add confidential reference' : 'Add evidence link'}
        footer={<><Button variant="ghost" onClick={() => setMode(null)}>Cancel</Button><Button variant="primary" loading={add.isPending}
          disabled={mode === 'file' ? !file : mode === 'ref' ? !(label && ref) : !(label && url)} onClick={() => add.mutate()}>Add</Button></>}>
        <div className="grid gap-3">
          {mode === 'ref' && <Callout tone="neutral">A confidential reference stores only a label and an ID pointing to a document kept elsewhere (e.g. an HR file or contract). The content stays in that system under its own permissions — only you and the task owner see the reference here.</Callout>}
          <Field label="Label">{(id) => <Input id={id} value={label} onChange={(e) => setLabel(e.target.value)} placeholder={mode === 'ref' ? 'Signed contract (confidential)' : 'e.g. Pull request #42'} />}</Field>
          {mode === 'link' && <Field label="URL">{(id) => <Input id={id} type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" />}</Field>}
          {mode === 'file' && <Field label="File (max 15 MB, stored privately)">{(id) => <input id={id} type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-[13px]" />}</Field>}
          {mode === 'ref' && <div className="grid grid-cols-2 gap-3">
            <Field label="System (optional)">{(id) => <Input id={id} value={mod} onChange={(e) => setMod(e.target.value)} placeholder="e.g. HR drive" />}</Field>
            <Field label="Reference ID">{(id) => <Input id={id} value={ref} onChange={(e) => setRef(e.target.value)} placeholder="e.g. FILE-123" />}</Field></div>}
        </div>
      </Modal>
    </Section>
  );
}

function Relations({ task, d, can }: { task: any; d: any; can: boolean }) {
  const qc = useQueryClient(); const toast = useToast(); const users = useUsers();
  const [depQ, setDepQ] = useState(''); const [collab, setCollab] = useState('');
  const search = useQuery({ queryKey: ['search', depQ], queryFn: () => api.get(`/api/search?q=${encodeURIComponent(depQ)}`), enabled: depQ.length > 1 });
  const inv = () => qc.invalidateQueries({ queryKey: ['task', task.id] });
  const err = (e: any) => toast({ tone: 'critical', text: e.message });
  const addDep = useMutation({ mutationFn: (dep: string) => api.post(`/api/tasks/${task.id}/dependencies`, { dependsOnTaskId: dep }), onSuccess: () => { setDepQ(''); inv(); }, onError: err });
  const delDep = useMutation({ mutationFn: (dep: string) => api.del(`/api/tasks/${task.id}/dependencies/${dep}`), onSuccess: inv });
  const addCol = useMutation({ mutationFn: (uid: string) => api.post(`/api/tasks/${task.id}/collaborators`, { userId: uid }), onSuccess: () => { setCollab(''); inv(); }, onError: err });
  const delCol = useMutation({ mutationFn: (uid: string) => api.del(`/api/tasks/${task.id}/collaborators/${uid}`), onSuccess: inv });
  return (
    <Section title="Dependencies & collaborators">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <p className="mb-1 text-[12px] text-ink-3">Waits on</p>
          <ul className="space-y-1">{d.dependencies.map((x: any) => (
            <li key={x.id} className="flex items-center gap-2 text-[13px]"><StatusDot status={x.status} /><Link className="truncate hover:underline" to={`/tasks/${x.id}`}>{x.title}</Link>
              {can && <button className="ml-auto text-[12px] text-ink-3 hover:text-critical-ink" onClick={() => delDep.mutate(x.id)}>Remove</button>}</li>))}
            {d.dependencies.length === 0 && <li className="text-[13px] text-ink-3">None</li>}</ul>
          {d.dependents.length > 0 && <p className="mt-2 text-[12px] text-ink-3">Blocks: {d.dependents.map((x: any) => x.title).join(', ')}</p>}
          {can && <div className="relative mt-2"><Input aria-label="Add dependency" className="h-8" value={depQ} onChange={(e) => setDepQ(e.target.value)} placeholder="Search a task this waits on…" />
            {(search.data?.tasks ?? []).filter((x: any) => x.id !== task.id).length > 0 && depQ && <ul className="absolute z-10 mt-1 w-full rounded-lg bg-surface p-1 shadow-xl ring-1 ring-line">
              {search.data.tasks.filter((x: any) => x.id !== task.id).slice(0, 6).map((x: any) => <li key={x.id}><button className="w-full truncate rounded px-2 py-1 text-left text-[13px] hover:bg-surface-2" onClick={() => addDep.mutate(x.id)}>{x.title}</button></li>)}</ul>}</div>}
        </div>
        <div>
          <p className="mb-1 text-[12px] text-ink-3">Collaborators (the owner stays accountable)</p>
          <ul className="space-y-1">{d.collaborators.map((u: any) => (
            <li key={u.id} className="flex items-center gap-2 text-[13px]"><Avatar name={u.name} size={20} />{u.name}{can && <button className="ml-auto text-[12px] text-ink-3 hover:text-critical-ink" onClick={() => delCol.mutate(u.id)}>Remove</button>}</li>))}
            {d.collaborators.length === 0 && <li className="text-[13px] text-ink-3">None</li>}</ul>
          {can && <div className="mt-2 flex gap-2"><Select aria-label="Add collaborator" className="h-8" value={collab} onChange={(e) => setCollab(e.target.value)}>
            <option value="">Add a collaborator…</option>{(users.data ?? []).filter((u: any) => u.id !== task.owner_id && !d.collaborators.some((c: any) => c.id === u.id)).map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select>
            <Button size="sm" disabled={!collab} onClick={() => addCol.mutate(collab)} icon={<UserPlus className="size-3.5" />}>Add</Button></div>}
        </div>
      </div>
    </Section>
  );
}

function Comments({ taskId, comments }: { taskId: string; comments: any[] }) {
  const qc = useQueryClient(); const toast = useToast(); const [body, setBody] = useState('');
  const m = useMutation({ mutationFn: () => api.post(`/api/tasks/${taskId}/comments`, { body }), onSuccess: () => { setBody(''); qc.invalidateQueries({ queryKey: ['task', taskId] }); }, onError: (e: any) => toast({ tone: 'critical', text: e.message }) });
  return (
    <Section title="Discussion">
      <ul className="space-y-3">{comments.map((c) => (
        <li key={c.id} className="flex gap-2.5">
          {c.author_name ? <Avatar name={c.author_name} size={26} /> : <MessageSquare className="size-5 text-ink-3" />}
          <div className="min-w-0 flex-1"><div className="text-[12px] text-ink-3"><b className="text-ink">{c.author_name ?? 'System'}</b> · {fmtDateTime(c.created_at)}
            {c.kind !== 'comment' && <Badge className="ml-1" tone={c.kind === 'review' ? 'warning' : 'neutral'}>{c.kind.replace('_', ' ')}</Badge>}</div>
            <p className="whitespace-pre-wrap text-[13px]">{c.body}</p></div>
        </li>))}</ul>
      <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (body.trim()) m.mutate(); }}>
        <Textarea aria-label="Comment" rows={1} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write a comment…" />
        <Button type="submit" disabled={!body.trim()} loading={m.isPending}>Post</Button></form>
    </Section>
  );
}

function ReassignModal({ open, onClose, task, users }: { open: boolean; onClose: () => void; task: any; users: any[] }) {
  const qc = useQueryClient(); const toast = useToast(); const [owner, setOwner] = useState(''); const [reason, setReason] = useState('');
  const m = useMutation({ mutationFn: () => api.post(`/api/tasks/${task.id}/reassign`, { ownerId: owner, reason }), onSuccess: () => { qc.invalidateQueries(); onClose(); toast({ tone: 'good', text: 'Reassigned — both people notified' }); },
    onError: (e: any) => toast({ tone: 'critical', text: e.message }) });
  return (
    <Modal open={open} onClose={onClose} title="Reassign task" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!owner || !reason.trim()} loading={m.isPending} onClick={() => m.mutate()}>Reassign</Button></>}>
      <div className="grid gap-3">
        <Field label="New owner">{(id) => <Select id={id} value={owner} onChange={(e) => setOwner(e.target.value)}><option value="">Choose…</option>{users.filter((u) => u.id !== task.owner_id).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select>}</Field>
        <Field label="Reason (kept in history)">{(id) => <Textarea id={id} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
      </div>
    </Modal>
  );
}
void Card; void fmtDate;
