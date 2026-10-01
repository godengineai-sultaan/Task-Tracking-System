import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, BarChart3, CheckCheck, ChevronLeft, ChevronRight, CircleDot, Clock, FileText, HelpCircle, ListPlus, MessageSquare, Pencil, Shuffle, Unlock, XCircle } from 'lucide-react';
import { api, qs } from '../lib/api';
import { STATUS_LABEL, addDays, fmtDate, fmtDateTime, fmtTime, hm } from '../lib/format';
import { useMe, useRoles } from '../lib/session';
import { AssessmentBadge, Badge, Button, Callout, Card, Field, IconButton, Input, Modal, NoAccess, PageError, PageHeader, Select, Skeleton, StatusDot, Textarea, useToast } from '../components/ui';
import { AllocationBar } from '../components/time';
import { useUsers } from '../components/TaskStatus';

const ICON: Record<string, any> = { status: CircleDot, time: Clock, evidence: FileText, blocker: XCircle, comment: MessageSquare, correction: Pencil };

export default function PersonDay() {
  const { userId } = useParams(); const me = useMe(); const roles = useRoles(); const [sp, setSp] = useSearchParams();
  const date = sp.get('date') ?? me.today;
  const allowed = roles.canReview || userId === me.user.id; // anyone may open their own day
  const q = useQuery({ queryKey: ['timeline', userId, date], queryFn: () => api.get(`/api/admin/routine/${userId}${qs({ date })}`), enabled: allowed });
  const [action, setAction] = useState<string | null>(null);
  if (!allowed) return <div><PageHeader title="Daily routine" /><NoAccess>Only the main administrator and team managers can open the daily routine view.</NoAccess></div>;
  if (q.isLoading) return <Skeleton className="h-96" />;
  if (q.error) return <PageError title="Daily routine" error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data; const r = d.report; const day = r.days[0]; const tz = d.timezone;
  const recap = day.recap;
  const self = userId === me.user.id;
  return (
    <div>
      <Link to={`/admin/routine?date=${date}`} className="mb-3 inline-flex items-center gap-1 text-[13px] text-ink-3 hover:text-ink"><ArrowLeft className="size-3.5" />Daily routine</Link>
      <PageHeader title={r.subject.name} subtitle={`${r.subject.title || ''}${r.subject.department ? ` · ${r.subject.department}` : ''} · ${fmtDate(date, { weekday: 'long', day: 'numeric', month: 'long' })} · ${tz}`}
        actions={<>
          <div className="flex items-center gap-1"><IconButton label="Previous day" onClick={() => setSp({ date: addDays(date, -1) })}><ChevronLeft className="size-4" /></IconButton>
            <Input aria-label="Date" type="date" max={me.today} className="h-8 w-40" value={date} onChange={(e) => setSp({ date: e.target.value })} />
            <IconButton label="Next day" disabled={date >= me.today} onClick={() => setSp({ date: addDays(date, 1) })}><ChevronRight className="size-4" /></IconButton></div>
          <Link to={`/analytics/${userId}?kind=week&date=${date}`}><Button icon={<BarChart3 className="size-4" />}>Period report</Button></Link>
        </>} />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card title="Day summary" actions={<AssessmentBadge label={day.assessment.label} />}>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <p className="mb-1.5 text-[12px] font-medium text-ink-3">Intended outcomes</p>
                {day.intendedOutcomes.length === 0 ? <p className="text-[13px] text-ink-3">No plan recorded.</p> : <ul className="space-y-1">{day.intendedOutcomes.map((o: any) =>
                  <li key={o.taskId} className="flex items-center gap-2 text-[13px]"><StatusDot status={o.statusAtEndOfDay} /><Link to={`/tasks/${o.taskId}`} className="flex-1 truncate hover:underline">{o.title}</Link><span className="text-[11px] text-ink-3">{STATUS_LABEL[o.statusAtEndOfDay]}</span></li>)}</ul>}
                {day.scopeChanges.length > 0 && <p className="mt-1.5 text-[12px] text-ink-3">Replanned: {day.scopeChanges.map((s: any) => s.title).join('; ')}</p>}
              </div>
              <div>
                <p className="mb-1.5 text-[12px] font-medium text-ink-3">Time ({day.capacity.availableMinutes ? `${hm(day.capacity.availableMinutes)} available` : 'zero capacity — N/A'})</p>
                <AllocationBar byCategory={day.time.byCategory} unknown={day.time.unknownMinutes} available={day.capacity.availableMinutes} />
              </div>
            </div>
            <ul className="mt-3 space-y-1 border-t border-line pt-3 text-[12.5px] text-ink-2">{day.assessment.reasons.concat(day.assessment.facts).map((x: string) => <li key={x}>• {x}</li>)}</ul>
          </Card>
          <Card title="Recorded routine" subtitle={d.note} padded={false}>
            {d.items.length === 0 ? <p className="px-4 py-6 text-center text-[13px] text-ink-3">Nothing was recorded on this day.</p> : (
              <ol className="relative px-4 py-3">{d.items.map((it: any, i: number) => {
                const I = ICON[it.type] ?? CircleDot;
                return (
                  <li key={i} className="relative flex gap-3 pb-3 last:pb-0">
                    <div className="flex w-14 shrink-0 justify-end pt-0.5 text-[12px] tabular text-ink-3">{fmtTime(it.at, tz)}</div>
                    <div className="relative flex flex-col items-center"><span className="flex size-6 items-center justify-center rounded-full bg-surface-2 ring-1 ring-line"><I className="size-3.5 text-ink-2" aria-hidden /></span>
                      {i < d.items.length - 1 && <span className="mt-1 w-px flex-1 bg-line" />}</div>
                    <div className="min-w-0 flex-1 pb-1 text-[13px]">
                      <div className="font-medium">{it.title}{it.end && <span className="font-normal text-ink-3"> · until {fmtTime(it.end, tz)}</span>}</div>
                      <div className="text-[12px] text-ink-2">{it.detail}</div>
                    </div>
                  </li>);
              })}</ol>)}
          </Card>
        </div>
        <div className="space-y-4">
          <Card title="Recap" actions={recap && <Badge tone={recap.status === 'manager_reviewed' ? 'good' : recap.status === 'confirmed' ? 'info' : 'warning'}>{recap.status.replace('_', ' ')} · v{recap.version}</Badge>}>
            {!recap ? <p className="text-[13px] text-ink-3">{day.capacity.availableMinutes ? (date === me.today ? 'Not submitted yet today.' : 'No recap was submitted for this day.') : 'Not required — zero capacity.'}</p> : (
              <dl className="space-y-2 text-[13px]">
                {recap.dayType !== 'work' && <Badge tone="warning">{recap.dayType === 'no_work' ? 'Confirmed: no work' : 'Confirmed: non-working day'}</Badge>}
                <div><dt className="text-[12px] text-ink-3">Done</dt><dd className="whitespace-pre-wrap">{recap.summary || '—'}</dd></div>
                {recap.blockersNote && <div><dt className="text-[12px] text-ink-3">Blockers</dt><dd>{recap.blockersNote}</dd></div>}
                {recap.nextSteps && <div><dt className="text-[12px] text-ink-3">Next</dt><dd>{recap.nextSteps}</dd></div>}
                {recap.contextNote && <div><dt className="text-[12px] text-ink-3">Context</dt><dd>{recap.contextNote}</dd></div>}
              </dl>)}
            {d.recapVersions.length > 1 && <details className="mt-3 text-[12px]"><summary className="cursor-pointer text-ink-2">{d.recapVersions.length} versions — employee corrections are preserved</summary>
              <ol className="mt-2 space-y-2">{d.recapVersions.map((v: any) => <li key={v.version} className="rounded bg-surface-2 p-2"><b>v{v.version}</b> · {v.change_reason} · {fmtDateTime(v.created_at)}<p className="mt-1 text-ink-2">{v.snapshot.summary}</p></li>)}</ol></details>}
          </Card>
          {!self && <Card title="Review actions" subtitle="Visible to the employee and kept in history. Nothing here edits their record.">
            <div className="grid grid-cols-2 gap-2">
              <Button size="sm" icon={<CheckCheck className="size-3.5" />} disabled={!recap || recap.status === 'draft' || recap.status === 'manager_reviewed'} onClick={() => setAction('acknowledge')}>Acknowledge</Button>
              <Button size="sm" icon={<MessageSquare className="size-3.5" />} onClick={() => setAction('note')}>Review note</Button>
              <Button size="sm" icon={<HelpCircle className="size-3.5" />} onClick={() => setAction('clarification_request')}>Ask to clarify</Button>
              <Button size="sm" icon={<ListPlus className="size-3.5" />} onClick={() => setAction('follow_up')}>Assign follow-up</Button>
              <Button size="sm" icon={<Unlock className="size-3.5" />} disabled={!r.blockers.some((b: any) => !b.resolvedAt)} onClick={() => setAction('blocker_help')}>Help blocker</Button>
              <Button size="sm" icon={<Shuffle className="size-3.5" />} onClick={() => setAction('reassign')}>Redistribute</Button>
            </div>
          </Card>}
          <Card title="Review history">
            {d.reviews.length === 0 ? <p className="text-[13px] text-ink-3">No review actions for this day.</p> : <ul className="space-y-2.5">{d.reviews.map((m: any) => (
              <li key={m.id} className="text-[13px]"><div className="text-[12px] text-ink-3"><b className="text-ink">{m.reviewer_name}</b> · {m.action.replace(/_/g, ' ')} · {fmtDateTime(m.created_at)}{m.resolved_at && ' · answered'}</div>{m.note && <p>{m.note}</p>}</li>))}</ul>}
          </Card>
          <Callout tone="neutral">Restricted evidence and private calendar details stay hidden here unless you have access at the source.</Callout>
        </div>
      </div>
      <ActionModal action={action} onClose={() => setAction(null)} userId={userId!} date={date} report={r} />
    </div>
  );
}

function ActionModal({ action, onClose, userId, date, report }: { action: string | null; onClose: () => void; userId: string; date: string; report: any }) {
  const qc = useQueryClient(); const toast = useToast(); const users = useUsers();
  const [note, setNote] = useState(''); const [title, setTitle] = useState(''); const [due, setDue] = useState(''); const [blockerId, setBlockerId] = useState(''); const [taskId, setTaskId] = useState(''); const [owner, setOwner] = useState('');
  const tasks = useQuery({ queryKey: ['tasks', { ownerId: userId }], queryFn: () => api.get(`/api/tasks?ownerId=${userId}`), enabled: action === 'reassign' });
  const m = useMutation({
    mutationFn: () => api.post('/api/manager-reviews', { subjectUserId: userId, date, action, note: note || undefined, blockerId: blockerId || undefined, taskId: taskId || undefined, newOwnerId: owner || undefined,
      followUp: action === 'follow_up' ? { title, dueDate: due || undefined } : undefined }),
    onSuccess: () => { qc.invalidateQueries(); toast({ tone: 'good', text: 'Done — the employee has been notified' }); setNote(''); setTitle(''); onClose(); },
    onError: (e: any) => toast({ tone: 'critical', text: e.message }),
  });
  const titles: Record<string, string> = { acknowledge: 'Acknowledge recap', note: 'Add a review note', clarification_request: 'Ask for clarification', follow_up: 'Assign a follow-up', blocker_help: 'Help resolve a blocker', reassign: 'Redistribute work' };
  const valid = action === 'acknowledge' || (action === 'follow_up' ? !!title.trim() : action === 'blocker_help' ? !!(blockerId && note.trim()) : action === 'reassign' ? !!(taskId && owner) : !!note.trim());
  return (
    <Modal open={!!action} onClose={onClose} title={action ? titles[action] : ''} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!valid} loading={m.isPending} onClick={() => m.mutate()}>Send</Button></>}>
      <div className="grid gap-3">
        {action === 'acknowledge' && <p className="text-[13px] text-ink-2">Marks this recap as manager-reviewed. The employee's text is not changed.</p>}
        {action === 'follow_up' && <><Field label="Follow-up task">{(id) => <Input id={id} value={title} onChange={(e) => setTitle(e.target.value)} />}</Field>
          <Field label="Due date (optional)">{(id) => <Input id={id} type="date" value={due} onChange={(e) => setDue(e.target.value)} />}</Field></>}
        {action === 'blocker_help' && <Field label="Blocker">{(id) => <Select id={id} value={blockerId} onChange={(e) => setBlockerId(e.target.value)}><option value="">Choose…</option>
          {report.blockers.filter((b: any) => !b.resolvedAt).map((b: any) => <option key={b.id} value={b.id}>{b.task}: {b.reason}</option>)}</Select>}</Field>}
        {action === 'reassign' && <><Field label="Task">{(id) => <Select id={id} value={taskId} onChange={(e) => setTaskId(e.target.value)}><option value="">Choose…</option>
          {(tasks.data ?? []).filter((t: any) => !['done', 'cancelled'].includes(t.status)).map((t: any) => <option key={t.id} value={t.id}>{t.title}</option>)}</Select>}</Field>
          <Field label="New owner">{(id) => <Select id={id} value={owner} onChange={(e) => setOwner(e.target.value)}><option value="">Choose…</option>{(users.data ?? []).filter((u: any) => u.id !== userId).map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select>}</Field></>}
        {action !== 'acknowledge' && <Field label={action === 'clarification_request' ? 'Your question' : action === 'reassign' ? 'Reason' : 'Note'}>{(id) => <Textarea id={id} rows={3} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>}
      </div>
    </Modal>
  );
}
