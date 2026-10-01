import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ClipboardCheck, GitBranch, Paperclip } from 'lucide-react';
import { api, qs } from '../../lib/api';
import { fmtDate, hm } from '../../lib/format';
import { useMe } from '../../lib/session';
import { Badge, Button, Callout, ErrorState, Field, Input, Modal, Select, Skeleton, cx } from '../ui';
import { useProjects } from '../TaskStatus';
import { newApplyKey, offsetLabel, plural } from './TemplatesShared';

const longDate = (d: string | null) => (d ? fmtDate(d, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : 'No due date');

/** Apply wizard: where and when, then owners and computed due dates, then the created tasks. */
export function ApplyWizard({ template, items, open, onClose }: { template: any; items: any[]; open: boolean; onClose: () => void }) {
  const me = useMe(); const qc = useQueryClient();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [f, setF] = useState({ startDate: me.today, projectId: '', milestoneId: '', defaultOwnerId: me.user.id });
  const [assign, setAssign] = useState<Record<string, string>>({});
  const [applyKey, setApplyKey] = useState(newApplyKey);
  const [result, setResult] = useState<any>(null);
  useEffect(() => {
    if (!open) return;
    setStep(1); setF({ startDate: me.today, projectId: '', milestoneId: '', defaultOwnerId: me.user.id }); setAssign({}); setApplyKey(newApplyKey()); setResult(null);
  }, [open, template.id]);

  const projects = useProjects();
  const milestones = useQuery({ queryKey: ['milestones'], queryFn: () => api.get('/api/milestones'), enabled: open && !!f.projectId });
  const assignees = useQuery({ queryKey: ['template-assignees', f.projectId], queryFn: () => api.get(`/api/templates/assignees${qs({ projectId: f.projectId })}`), enabled: open });
  const body = useMemo(() => ({
    startDate: f.startDate, projectId: f.projectId || null, milestoneId: f.milestoneId || null, defaultOwnerId: f.defaultOwnerId || null, assignments: assign,
  }), [f, assign]);
  const preview = useQuery({
    queryKey: ['template-preview', template.id, template.version, body], queryFn: () => api.post(`/api/templates/${template.id}/preview`, body),
    enabled: open && step === 2 && /^\d{4}-\d{2}-\d{2}$/.test(f.startDate), placeholderData: keepPreviousData, retry: false,
  });
  const apply = useMutation({
    mutationFn: () => api.post(`/api/templates/${template.id}/apply`, { ...body, applyKey }),
    onSuccess: (r: any) => { setResult(r); setStep(3); qc.invalidateQueries({ queryKey: ['tasks'] }); qc.invalidateQueries({ queryKey: ['template', template.id] }); qc.invalidateQueries({ queryKey: ['templates'] }); },
  });

  const people: any[] = assignees.data ?? [];
  const setProject = (projectId: string) => { setF({ ...f, projectId, milestoneId: '', defaultOwnerId: me.user.id }); setAssign({}); };
  const projectOptions = (projects.data ?? []).filter((p: any) => p.status !== 'archived');
  const projectMilestones = (milestones.data ?? []).filter((m: any) => m.project_id === f.projectId);
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(f.startDate);
  // Company holidays affect every owner the same way: list them once instead of on every step.
  const holidays: { date: string; reason: string }[] = [...new Map<string, any>((preview.data?.rows ?? [])
    .flatMap((r: any) => r.skipped).filter((s: any) => s.reason !== 'Unavailable').map((s: any) => [s.date, s])).values()]
    .sort((x, y) => x.date.localeCompare(y.date));

  const footer = step === 1 ? (
    <><Button variant="ghost" onClick={onClose}>Cancel</Button>
      <Button variant="primary" disabled={!validDate} onClick={() => setStep(2)}>Next: owners and dates</Button></>
  ) : step === 2 ? (
    <><Button variant="ghost" onClick={() => setStep(1)} disabled={apply.isPending}>Back</Button>
      <Button variant="primary" loading={apply.isPending} disabled={!preview.data || preview.isFetching || !!preview.error} onClick={() => apply.mutate()}>
        Create {plural(items.length, 'task')}</Button></>
  ) : <Button variant="primary" onClick={onClose}>Done</Button>;

  return (
    <Modal open={open} onClose={onClose} title={`Apply "${template.name}"`} width="max-w-3xl" footer={footer}>
      <ol className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]" aria-label="Progress">
        {['Where and when', 'Owners and dates', 'Created'].map((s, i) => (
          <li key={s} className={cx('flex items-center gap-1.5', step === i + 1 ? 'font-semibold text-ink' : 'text-ink-3')} aria-current={step === i + 1 ? 'step' : undefined}>
            <span className={cx('inline-flex size-5 items-center justify-center rounded-full text-[11px]', step > i ? 'bg-accent text-on-accent' : 'bg-surface-2 ring-1 ring-line')}>{i + 1}</span>{s}
          </li>))}
      </ol>

      {step === 1 && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Start date" hint="Step due dates are counted in working days from here." error={validDate ? null : 'Pick a start date'}>{(id) =>
            <Input id={id} type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} />}</Field>
          <Field label="Default owner" hint="You can change the owner of each step next.">{(id) =>
            <Select id={id} value={f.defaultOwnerId} onChange={(e) => setF({ ...f, defaultOwnerId: e.target.value })} disabled={assignees.isLoading}>
              {people.length === 0 && <option value={me.user.id}>{me.user.name}</option>}
              {people.map((u) => <option key={u.id} value={u.id}>{u.id === me.user.id ? `${u.name} (me)` : u.name}</option>)}
            </Select>}</Field>
          <Field label="Project (optional)">{(id) =>
            <Select id={id} value={f.projectId} onChange={(e) => setProject(e.target.value)}>
              <option value="">No project</option>
              {projectOptions.map((p: any) => <option key={p.id} value={p.id}>{p.key} · {p.name}</option>)}
            </Select>}</Field>
          <Field label="Milestone (optional)" hint={f.projectId ? undefined : 'Choose a project first.'}>{(id) =>
            <Select id={id} value={f.milestoneId} onChange={(e) => setF({ ...f, milestoneId: e.target.value })} disabled={!f.projectId}>
              <option value="">No milestone</option>
              {projectMilestones.map((m: any) => <option key={m.id} value={m.id}>{m.name}{m.due_date ? ` (due ${fmtDate(m.due_date)})` : ''}</option>)}
            </Select>}</Field>
          <div className="sm:col-span-2"><Callout tone="neutral">
            You can assign steps to yourself and to people you manage{f.projectId ? ', and to project members if you own the project' : ''}. Main and system admins can assign anyone.
          </Callout></div>
        </div>
      )}

      {step === 2 && (
        preview.isLoading ? <div className="space-y-2"><Skeleton className="h-14" /><Skeleton className="h-14" /><Skeleton className="h-14" /></div>
          : preview.error && !preview.data ? <ErrorState error={preview.error} onRetry={() => preview.refetch()} />
            : preview.data && (
              <div className="space-y-3">
                {preview.error && <Callout tone="critical">{(preview.error as any).message}</Callout>}
                {preview.data.warnings.map((w: string) => <Callout key={w} tone="warning">{w}</Callout>)}
                {holidays.length > 0 && <Callout tone="neutral">Company holidays skipped: {holidays.map((h) => `${fmtDate(h.date, { weekday: 'short', day: 'numeric', month: 'short' })} (${h.reason})`).join(', ')}.</Callout>}
                <ol className="divide-y divide-line rounded-xl ring-1 ring-line" aria-busy={preview.isFetching}>
                  {preview.data.rows.map((r: any) => (
                    <li key={r.position} className="grid gap-2 p-3 sm:grid-cols-[minmax(0,1fr)_11rem_10rem] sm:items-center">
                      <div className="min-w-0">
                        <div className="flex items-start gap-2">
                          <span aria-hidden className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-surface-2 text-[11px] font-semibold text-ink-2">{r.position}</span>
                          <span className="text-sm font-medium break-words">{r.title}</span>
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5 pl-7 text-[12px] text-ink-3">
                          {r.ownerHint && <span>Suggested: {r.ownerHint}</span>}
                          {r.estimateMinutes && <span>{hm(r.estimateMinutes)}</span>}
                          {r.dependsOn.length > 0 && <Badge icon={<GitBranch className="size-3" aria-hidden />}>After {r.dependsOn.join(', ')}</Badge>}
                          {r.requiresReview && <Badge tone="warning" icon={<ClipboardCheck className="size-3" aria-hidden />}>Review</Badge>}
                          {r.requiresEvidence && <Badge tone="info" icon={<Paperclip className="size-3" aria-hidden />}>Evidence</Badge>}
                        </div>
                      </div>
                      <Select aria-label={`Owner for step ${r.position}: ${r.title}`} className="h-8 text-[13px]" value={assign[r.position] ?? f.defaultOwnerId}
                        onChange={(e) => setAssign({ ...assign, [r.position]: e.target.value })}>
                        {people.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                      </Select>
                      <div className="text-[13px] sm:text-right">
                        <div className="font-medium">{longDate(r.dueDate)}</div>
                        <div className="text-[12px] text-ink-3">{offsetLabel(r.dueOffsetDays)}</div>
                        {r.skipped.some((s: any) => s.reason === 'Unavailable') && <div className="text-[12px] text-ink-3">
                          Skips {r.skipped.filter((s: any) => s.reason === 'Unavailable').map((s: any) => fmtDate(s.date)).join(', ')} (owner unavailable)</div>}
                      </div>
                    </li>))}
                </ol>
                <details className="text-[12px] text-ink-3">
                  <summary className="cursor-pointer font-medium text-ink-2">How due dates are calculated</summary>
                  <ul className="mt-1 list-disc space-y-0.5 pl-5">{preview.data.assumptions.map((s: string) => <li key={s}>{s}</li>)}</ul>
                </details>
                {apply.error && <Callout tone="critical">{(apply.error as any).message} Retrying is safe: the same request never creates tasks twice.</Callout>}
              </div>
            )
      )}

      {step === 3 && result && (
        <div className="space-y-3">
          <Callout tone="good" icon={<CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden />}>
            {result.created ? `Created ${plural(result.tasks.length, 'task')} from "${template.name}".` : 'These tasks were already created by an earlier attempt. Nothing was duplicated.'}
            {preview.data?.project && <> Added to <Link className="font-semibold underline" to={`/projects/${preview.data.project.id}`}>{preview.data.project.key} · {preview.data.project.name}</Link>.</>}
          </Callout>
          {result.warnings?.map((w: string) => <Callout key={w} tone="warning">{w}</Callout>)}
          <ul className="divide-y divide-line rounded-xl ring-1 ring-line" aria-label="Created tasks">
            {result.tasks.map((t: any) => (
              <li key={t.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-[13px]">
                <Link to={`/tasks/${t.id}`} className="min-w-0 flex-1 font-medium text-accent-ink hover:underline"><span className="text-ink-3">#{t.number}</span> {t.title}</Link>
                <span className="text-ink-2">{t.owner_name}</span>
                <span className="w-28 text-right text-ink-3">{t.due_date ? fmtDate(t.due_date, { weekday: 'short', day: 'numeric', month: 'short' }) : 'No due date'}</span>
              </li>))}
          </ul>
        </div>
      )}
    </Modal>
  );
}
