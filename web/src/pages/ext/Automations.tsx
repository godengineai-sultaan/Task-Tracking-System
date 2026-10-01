import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlarmClock, Archive, BellRing, CheckCircle2, CircleDashed, FlaskConical, ListChecks, Pencil, Plus, ShieldCheck, Sparkles, UserCheck, Workflow, XCircle } from 'lucide-react';
import { api, qs } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { Badge, Button, Callout, Card, Empty, ErrorState, IconButton, Modal, PageHeader, Segmented, Select, Skeleton, cx, useToast } from '../../components/ui';
import { type Draft, RuleBuilder, TRIGGER_SHORT, TestPanel, describeRule, draftFrom, emptyDraft, useLookups } from '../../components/ext/AutomationBuilder';
import { TaskDrawer } from '../TaskDetail';

const RUN_TONE: Record<string, 'good' | 'neutral' | 'critical'> = { success: 'good', skipped: 'neutral', failed: 'critical' };
const RUN_LABEL: Record<string, string> = { success: 'Ran', skipped: 'Skipped', failed: 'Failed' };
const PRESET_ICON: Record<string, typeof Workflow> = {
  escalate_blocked_finance: BellRing, follow_up_changes_requested: ListChecks, notify_reviewer_submitted: UserCheck,
  due_tomorrow: AlarmClock, overdue_manager: AlarmClock, urgent_needs_review: ShieldCheck,
};

function RunBadge({ status }: { status: string }) {
  const Icon = status === 'success' ? CheckCircle2 : status === 'failed' ? XCircle : CircleDashed;
  return <Badge tone={RUN_TONE[status]} icon={<Icon className="size-3.5" aria-hidden />}>{RUN_LABEL[status] ?? status}</Badge>;
}
function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} title={disabled ? 'View only' : undefined} disabled={disabled} onClick={() => onChange(!checked)}
      className={cx('relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-60',
        checked ? 'bg-accent' : 'bg-surface-3 ring-1 ring-inset ring-line-strong')}>
      <span aria-hidden className={cx('inline-block size-4 rounded-full bg-surface shadow-sm transition-transform', checked ? 'translate-x-[18px]' : 'translate-x-0.5')} />
    </button>
  );
}

export default function Automations() {
  const qc = useQueryClient(); const toast = useToast(); const lookups = useLookups();
  const q = useQuery({ queryKey: ['automations'], queryFn: () => api.get('/api/automations') });
  const [tab, setTab] = useState<'rules' | 'runs'>('rules');
  const [builder, setBuilder] = useState<{ draft: Draft; key: number } | null>(null);
  const [testing, setTesting] = useState<any>(null);
  const [archiving, setArchiving] = useState<any>(null);
  const perms = q.data?.permissions ?? { company: false, team: false };
  const canCreate = perms.company || perms.team;
  const defaultScope: 'company' | 'team' = perms.company ? 'company' : 'team';
  const open = (draft: Draft) => setBuilder({ draft, key: Date.now() });
  const toggle = useMutation({
    mutationFn: (r: any) => api.patch(`/api/automations/${r.id}/enabled`, { enabled: !r.enabled, version: r.version }),
    onSuccess: (r: any) => { qc.invalidateQueries({ queryKey: ['automations'] }); toast({ tone: 'good', text: r.enabled ? `"${r.name}" is on` : `"${r.name}" is paused` }); },
    onError: (e: any) => { qc.invalidateQueries({ queryKey: ['automations'] }); toast({ tone: 'critical', text: e.message }); },
  });
  const archive = useMutation({
    mutationFn: (r: any) => api.del(`/api/automations/${r.id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['automations'] }); setArchiving(null); toast({ tone: 'good', text: 'Rule archived. Its run history is kept.' }); },
    onError: (e: any) => toast({ tone: 'critical', text: e.message }),
  });

  return (
    <div>
      <PageHeader title="Automations" subtitle="Rules that take care of routine follow-through on tasks: reminders, escalations, follow-ups and review steps."
        actions={canCreate && <Button variant="primary" icon={<Plus className="size-4" aria-hidden />} onClick={() => open(emptyDraft(defaultScope))}>New rule</Button>} />
      <div className="mb-4">
        <Callout tone="info">
          Rules only act on task records and every automated change is in the run log and audit trail. A rule never blocks a person's change: if it fails, the change still goes through and the failure is logged.
          {q.data && (perms.company ? ' You can create company-wide rules.' : perms.team ? ' You can create rules for the people on your team.' : ' You can view rules; system admins and team managers can change them.')}
        </Callout>
      </div>
      <div className="mb-4"><Segmented label="View" value={tab} onChange={setTab} options={[{ value: 'rules', label: 'Rules' }, { value: 'runs', label: 'Run log' }]} /></div>

      {tab === 'rules' ? (
        q.isLoading ? <div className="grid gap-3"><Skeleton className="h-28" /><Skeleton className="h-40" /></div>
        : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} />
        : <div className="grid gap-5">
          <Card title="Rules" subtitle={`${q.data.rules.length} rule${q.data.rules.length === 1 ? '' : 's'} · ${q.data.rules.filter((r: any) => r.enabled).length} on`} padded={false}>
            {q.data.rules.length === 0 ? (
              <Empty icon={<Workflow className="size-6" />} title="No automation rules yet">
                {canCreate ? 'Start from a recipe below, or build your own with New rule.' : 'When your admins or managers add rules, they appear here.'}
              </Empty>
            ) : (
              <ul className="divide-y divide-line">
                {q.data.rules.map((r: any) => (
                  <li key={r.id} className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-start">
                    <div className="flex items-start gap-3 sm:contents">
                      <div className="pt-0.5"><Switch checked={r.enabled} disabled={!r.can_edit || toggle.isPending} label={`${r.name}: ${r.enabled ? 'on' : 'off'}`} onChange={() => toggle.mutate(r)} /></div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-[14px] font-medium">{r.name}</h3>
                          <Badge tone={r.scope === 'company' ? 'info' : 'neutral'}>{r.scope === 'company' ? 'Company-wide' : `${r.owner_name}'s team`}</Badge>
                          {!r.enabled && <Badge>Paused</Badge>}
                        </div>
                        <p className="mt-1 text-[13px] leading-relaxed text-ink-2">{describeRule(r, { ...lookups, ownerName: r.owner_name })}</p>
                        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-3">
                          {r.last_status ? <span className="inline-flex items-center gap-1.5">Last run <RunBadge status={r.last_status} /> {fmtDateTime(r.last_run_at)}</span> : <span>Has not run yet</span>}
                          <span>Last 7 days: {r.success_7d} ran · {r.skipped_7d} skipped · {r.failed_7d} failed</span>
                        </div>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1 self-end sm:self-start">
                      <IconButton label={`Test ${r.name} against a task`} onClick={() => setTesting(r)}><FlaskConical className="size-4" aria-hidden /></IconButton>
                      {r.can_edit && <>
                        <IconButton label={`Edit ${r.name}`} onClick={() => open(draftFrom(r))}><Pencil className="size-4" aria-hidden /></IconButton>
                        <IconButton label={`Archive ${r.name}`} onClick={() => setArchiving(r)}><Archive className="size-4" aria-hidden /></IconButton>
                      </>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          {canCreate && (
            <section aria-labelledby="recipes">
              <h2 id="recipes" className="mb-2 flex items-center gap-1.5 text-[14px] font-semibold"><Sparkles className="size-4 text-ink-3" aria-hidden />Start from a recipe</h2>
              <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {q.data.presets.map((p: any) => {
                  const Icon = PRESET_ICON[p.key] ?? Workflow;
                  return (
                    <li key={p.key} className="flex flex-col rounded-xl bg-surface p-3.5 ring-1 ring-line shadow-card">
                      <div className="flex items-start gap-2.5">
                        <span className="rounded-lg bg-accent-soft p-1.5 text-accent-ink"><Icon className="size-4" aria-hidden /></span>
                        <div className="min-w-0"><h3 className="text-[14px] font-medium">{p.name}</h3><p className="mt-0.5 text-[12.5px] text-ink-3">{p.description}</p></div>
                      </div>
                      <div className="mt-3 flex justify-end">
                        <Button size="sm" aria-label={`Use recipe: ${p.name}`} onClick={() => open({ ...draftFrom({ ...p, scope: defaultScope, enabled: true }), id: undefined, version: undefined, preset: p.key })}>Use recipe</Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </div>
      ) : <RunLog rules={q.data?.rules ?? []} />}

      {builder && <RuleBuilder key={builder.key} open onClose={() => setBuilder(null)} initial={builder.draft} permissions={perms} />}
      <Modal open={!!testing} onClose={() => setTesting(null)} title={testing ? `Test "${testing.name}"` : 'Test rule'} width="max-w-2xl">
        {testing && <><p className="mb-3 text-[13px] text-ink-2">{describeRule(testing, { ...lookups, ownerName: testing.owner_name })}</p><TestPanel ruleId={testing.id} /></>}
      </Modal>
      <Modal open={!!archiving} onClose={() => setArchiving(null)} title="Archive this rule?"
        footer={<><Button variant="ghost" onClick={() => setArchiving(null)}>Keep it</Button><Button variant="danger" loading={archive.isPending} onClick={() => archive.mutate(archiving)}>Archive rule</Button></>}>
        <p className="text-sm text-ink-2">"{archiving?.name}" stops running immediately. Its run history and audit trail are kept.</p>
      </Modal>
    </div>
  );
}

function RunLog({ rules }: { rules: any[] }) {
  const [status, setStatus] = useState<'all' | 'success' | 'skipped' | 'failed'>('all');
  const [ruleId, setRuleId] = useState('');
  const [taskId, setTaskId] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['automations', 'runs', status, ruleId], queryFn: () => api.get(`/api/automations/runs${qs({ status: status === 'all' ? undefined : status, ruleId: ruleId || undefined, limit: 100 })}`) });
  return (
    <Card title="Run log" subtitle="Every time a rule matched a task: what it did, what it skipped and why." padded={false}
      actions={<Button size="sm" variant="ghost" onClick={() => q.refetch()}>Refresh</Button>}>
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        <Segmented label="Outcome" value={status} onChange={setStatus} options={[{ value: 'all', label: 'All' }, { value: 'success', label: 'Ran' }, { value: 'skipped', label: 'Skipped' }, { value: 'failed', label: 'Failed' }]} />
        <label className="flex min-w-0 items-center gap-2 text-[13px] text-ink-2">Rule
          <Select className="w-auto max-w-[14rem]" value={ruleId} onChange={(e) => setRuleId(e.target.value)}><option value="">All rules</option>{rules.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select>
        </label>
      </div>
      {q.isLoading ? <div className="grid gap-2 p-4"><Skeleton className="h-12" /><Skeleton className="h-12" /></div>
        : q.error ? <div className="p-4"><ErrorState error={q.error} onRetry={() => q.refetch()} /></div>
        : q.data.length === 0 ? <Empty icon={<Workflow className="size-6" />} title="No runs yet">Runs appear here as soon as a rule matches a task.</Empty>
        : <ul className="divide-y divide-line">
          {q.data.map((r: any) => (
            <li key={r.id} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:gap-4">
              <time dateTime={r.created_at} className="shrink-0 text-[12px] text-ink-3 sm:w-32 sm:pt-0.5">{fmtDateTime(r.created_at)}</time>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13.5px]">
                  <RunBadge status={r.status} />
                  <span className="font-medium">{r.rule_name}</span>
                  <span className="text-ink-3">on</span>
                  {r.task_visible
                    ? <button type="button" className="min-w-0 max-w-full truncate text-left text-accent-ink underline-offset-2 hover:underline" onClick={() => setTaskId(r.task_id)}>#{r.task_number} {r.task_title}</button>
                    : <span className="text-ink-3">{r.task_id ? 'a task you can\'t view' : 'a deleted task'}</span>}
                </div>
                {r.message && <p className="mt-0.5 break-words text-[13px] text-ink-2">{r.message}</p>}
                <div className="mt-0.5 text-[12px] text-ink-3">{TRIGGER_SHORT[r.trigger] ?? r.trigger}{r.depth > 0 && ` · triggered by another automation (chain step ${r.depth})`}</div>
              </div>
            </li>
          ))}
        </ul>}
      <TaskDrawer id={taskId} onClose={() => setTaskId(null)} />
    </Card>
  );
}
