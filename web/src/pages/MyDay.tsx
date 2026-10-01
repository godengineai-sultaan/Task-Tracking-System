import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, CalendarRange, CheckCircle2, ClipboardList, Clock, MessageSquareWarning, Pause, Play, Plus, Sparkles, Target, X } from 'lucide-react';
import { api, qs } from '../lib/api';
import { fmtDate, fmtTime, hm, minutesSince, relDue } from '../lib/format';
import { useMe } from '../lib/session';
import { Badge, Button, Callout, Card, Empty, ErrorState, IconButton, PageHeader, Select, Skeleton, cx, useToast } from '../components/ui';
import { StatusControl, ReasonDialog } from '../components/TaskStatus';
import { AllocationBar, EntryModal, EntryRow, useTicker } from '../components/time';
import { TaskDrawer } from './TaskDetail';
import { NudgeSettings, SuggestDayDialog, WeeklySummaryDrawer } from '../components/ext/PlanningAssistant';

export default function MyDay() {
  const me = useMe(); const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['my-day'], queryFn: () => api.get(`/api/my-day`) });
  const openedAt = useRef(Date.now());
  const [drawer, setDrawer] = useState<string | null>(null);
  const [removing, setRemoving] = useState<any>(null);
  const [entryModal, setEntryModal] = useState<{ entry?: any } | null>(null);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [weeklyOpen, setWeeklyOpen] = useState(false);
  useTicker(30000);
  const plan = useMutation({
    mutationFn: (body: { taskIds: string[]; reason?: string }) => api.put('/api/my-day/plan', { ...body, elapsedMs: q.data?.intendedOutcomes?.length ? undefined : Date.now() - openedAt.current }),
    onSuccess: (d) => { qc.setQueryData(['my-day'], d); qc.invalidateQueries({ queryKey: ['tasks'] }); setRemoving(null); },
    onError: (e: any) => toast({ tone: 'critical', text: e.message }),
  });
  const timer = useMutation({
    mutationFn: (b: { stop?: boolean; taskId?: string | null; category?: string }) => b.stop ? api.post('/api/timer/stop') : api.post('/api/timer/start', b),
    onSuccess: () => qc.invalidateQueries(), onError: (e: any) => toast({ tone: 'critical', text: e.message }),
  });
  const decide = useMutation({
    mutationFn: ({ id, decision, taskId }: any) => api.post(`/api/suggestions/${id}/decide`, { decision, taskId }),
    onSuccess: (_r, v: any) => { qc.invalidateQueries(); toast({ tone: 'good', text: v.decision === 'accept' ? 'Confirmed' : 'Dismissed' }); },
    onError: (e: any) => toast({ tone: 'critical', text: e.message }),
  });
  if (q.isLoading) return <div className="space-y-4"><Skeleton className="h-10 w-72" /><div className="grid gap-4 lg:grid-cols-3"><Skeleton className="h-72 lg:col-span-2" /><Skeleton className="h-72" /></div></div>;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data;
  const tz = me.user.effectiveTimezone;
  const ids: string[] = d.intendedOutcomes.map((t: any) => t.id);
  const cap = d.capacity;
  const running = d.runningTimer;
  const capLabel = cap.status === 'working' ? `${hm(cap.availableMinutes)} available · ${cap.schedule.start}–${cap.schedule.end}`
    : cap.status === 'partial_leave' ? `Half-day ${cap.leave.kind} · ${hm(cap.availableMinutes)} available` : cap.status === 'holiday' ? `Holiday — ${cap.holiday}` : cap.status === 'leave' ? `On ${cap.leave.kind}` : 'Not a scheduled working day';
  const recapState = d.recap?.status;
  const groups = [
    { key: 'in_progress', label: 'In progress', items: d.openTasks.filter((t: any) => t.status === 'in_progress' && !ids.includes(t.id)) },
    { key: 'blocked', label: 'Blocked', items: d.openTasks.filter((t: any) => t.status === 'blocked') },
    { key: 'review', label: 'In review', items: d.openTasks.filter((t: any) => t.status === 'in_review') },
    { key: 'due', label: 'Due soon / overdue', items: d.openTasks.filter((t: any) => ['planned', 'backlog'].includes(t.status) && t.due_date && t.due_date <= addDaysIso(d.today, 3) && !ids.includes(t.id)) },
    { key: 'other', label: 'Other open work', items: d.openTasks.filter((t: any) => ['planned', 'backlog'].includes(t.status) && !(t.due_date && t.due_date <= addDaysIso(d.today, 3)) && !ids.includes(t.id)) },
  ].filter((g) => g.items.length);
  return (
    <div>
      <PageHeader eyebrow={d.isToday ? 'Today' : 'Day'} title={fmtDate(d.date, { weekday: 'long', day: 'numeric', month: 'long' })}
        subtitle={<span className="inline-flex items-center gap-1.5"><CalendarDays className="size-4" aria-hidden />{capLabel}</span>}
        actions={<><Button icon={<CalendarRange className="size-4" />} onClick={() => setWeeklyOpen(true)}>Weekly summary</Button><Link to="/recap"><Button variant={recapState && recapState !== 'draft' ? 'secondary' : 'primary'} icon={recapState && recapState !== 'draft' ? <CheckCircle2 className="size-4" /> : <ClipboardList className="size-4" />}>
          {recapState === 'confirmed' || recapState === 'manager_reviewed' ? 'Recap confirmed' : 'End-of-day recap'}</Button></Link></>} />

      {d.pendingClarifications.length > 0 && (
        <div className="mb-4"><Callout tone="warning" icon={<MessageSquareWarning className="mt-0.5 size-4 shrink-0" />}>
          {d.pendingClarifications.map((c: any) => <div key={c.id}><b>{c.reviewer_name}</b> {c.action === 'clarification_request' ? 'asked' : c.action === 'follow_up' ? 'assigned a follow-up' : 'responded to a blocker'} for {fmtDate(c.date)}: “{c.note}” <Link className="font-medium underline" to={`/recap?date=${c.date}`}>Respond</Link></div>)}
        </Callout></div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card title={<span className="flex items-center gap-2"><Target className="size-4 text-accent" aria-hidden />Intended outcomes</span>}
            subtitle="Up to three outcomes that would make today a success." padded={false}
            actions={<><Button size="sm" variant="subtle" icon={<Sparkles className="size-3.5 text-accent" />} onClick={() => setSuggestOpen(true)}>Suggest my day</Button><span className="text-[12px] text-ink-3 tabular">{ids.length}/3</span></>}>
            <ol className="divide-y divide-line">
              {d.intendedOutcomes.map((t: any, i: number) => (
                <li key={t.id} className="group flex items-center gap-3 px-4 py-3">
                  <span className="w-4 text-center text-[13px] font-semibold text-ink-3 tabular">{i + 1}</span>
                  <StatusControl task={t} />
                  <button className="min-w-0 flex-1 text-left" onClick={() => setDrawer(t.id)}>
                    <div className={cx('truncate text-[14px] font-medium', t.status === 'done' && 'text-ink-3 line-through')}>{t.title}</div>
                    <TaskMeta t={t} today={d.today} />
                  </button>
                  <TimerButton running={running} taskId={t.id} onToggle={(stop) => timer.mutate(stop ? { stop: true } : { taskId: t.id })} disabled={t.status === 'done'} />
                  <IconButton label="Remove from today" onClick={() => setRemoving(t)} className="opacity-60 group-hover:opacity-100"><X className="size-4" /></IconButton>
                </li>
              ))}
              {ids.length < 3 && (
                <li className="px-4 py-3">
                  {d.suggestedOutcomes.length ? (
                    <div>
                      <p className="mb-2 text-[12px] font-medium text-ink-3">{ids.length === 0 ? 'Pick your outcomes — suggestions from your due and in-progress work:' : 'Add another outcome:'}</p>
                      <div className="flex flex-wrap gap-2">
                        {d.suggestedOutcomes.slice(0, 5).map((t: any) => (
                          <button key={t.id} aria-label={`Add "${t.title}" to today`} onClick={() => plan.mutate({ taskIds: [...ids, t.id] })} disabled={plan.isPending}
                            className="inline-flex max-w-full items-center gap-1.5 rounded-lg bg-surface-2 px-2.5 py-1.5 text-left text-[13px] ring-1 ring-inset ring-line hover:ring-accent">
                            <Plus className="size-3.5 shrink-0 text-accent" aria-hidden /><span className="truncate">{t.title}</span>
                            {relDue(t.due_date, d.today) && <span className="shrink-0 text-[11px] text-ink-3">· {relDue(t.due_date, d.today)!.text}</span>}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : <p className="text-[13px] text-ink-3">No open tasks to plan. Press <b>Q</b> to capture one.</p>}
                </li>
              )}
            </ol>
            <FocusNote date={d.date} value={d.plan?.focusNote ?? ''} ids={ids} />
            {d.scopeChanges.length > 0 && (
              <div className="border-t border-line px-4 py-2.5 text-[12px] text-ink-3">
                Replanned today: {d.scopeChanges.map((s: any) => `${s.title} (${s.removed_reason})`).join('; ')}
              </div>
            )}
          </Card>

          <Card title="Open work" subtitle="One click to change status. Blocked asks who you're waiting on." padded={false}>
            {groups.length === 0 ? <Empty icon={<CheckCircle2 className="size-6" />} title="Nothing else open">Capture new work with <b>Q</b>.</Empty> : groups.map((g) => (
              <div key={g.key}>
                <div className="bg-surface-2/60 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-3">{g.label} · {g.items.length}</div>
                <ul className="divide-y divide-line">
                  {g.items.slice(0, 12).map((t: any) => (
                    <li key={t.id} className="flex items-center gap-3 px-4 py-2">
                      <StatusControl task={t} compact />
                      <button className="min-w-0 flex-1 text-left" onClick={() => setDrawer(t.id)}>
                        <div className="truncate text-[13.5px]">{t.title}</div>
                        {t.status === 'blocked' && t.blocker_reason ? <div className="truncate text-[12px] text-critical-ink">Blocked: {t.blocker_reason}</div> : <TaskMeta t={t} today={d.today} />}
                      </button>
                      {ids.length < 3 && !['blocked', 'in_review'].includes(t.status) && <Button size="sm" variant="ghost" onClick={() => plan.mutate({ taskIds: [...ids, t.id] })}>Add to today</Button>}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </Card>
        </div>

        <div className="space-y-4">
          <Card title={<span className="flex items-center gap-2"><Clock className="size-4 text-accent" aria-hidden />Timer</span>} subtitle="Optional. You can also add or correct time manually.">
            {running ? (
              <div className="flex items-center gap-3">
                <span className="relative flex size-2.5"><span className="absolute inline-flex size-full animate-ping rounded-full bg-good opacity-60" /><span className="relative inline-flex size-2.5 rounded-full bg-good" /></span>
                <div className="min-w-0 flex-1"><div className="truncate text-[13px] font-medium">{running.task_title ?? running.category}</div>
                  <div className="text-[12px] text-ink-3 tabular">since {fmtTime(running.started_at, tz)} · {hm(minutesSince(running.started_at))}</div></div>
                <Button size="sm" variant="primary" onClick={() => timer.mutate({ stop: true })} loading={timer.isPending} icon={<Pause className="size-3.5" />}>Stop</Button>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {[['meeting', 'Meeting'], ['admin', 'Admin'], ['learning', 'Learning'], ['other', 'Other']].map(([k, l]) => (
                  <Button key={k} size="sm" variant="subtle" icon={<Play className="size-3" />} onClick={() => timer.mutate({ category: k })}>{l}</Button>
                ))}
              </div>
            )}
          </Card>

          <Card title="Time today" actions={<Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => setEntryModal({})}>Add</Button>}>
            <div className="mb-1 flex items-baseline justify-between text-[13px]">
              <span><b className="tabular text-[18px]">{hm(d.allocation.explainedMinutes)}</b> <span className="text-ink-3">confirmed</span></span>
              <span className="text-ink-3 tabular">{cap.availableMinutes ? `${hm(d.allocation.unknownMinutes)} unknown` : 'Not applicable'}</span>
            </div>
            <AllocationBar byCategory={d.allocation.byCategory} unknown={d.allocation.unknownMinutes} available={cap.availableMinutes} />
            {d.allocation.conflicts.length > 0 && <p className="mt-2 text-[12px] text-warning-ink">⚠ {d.allocation.conflicts.length} overlapping entr{d.allocation.conflicts.length > 1 ? 'ies are' : 'y is'} counted once. Correct the duplicate if needed.</p>}
            <p className="mt-2 text-[12px] text-ink-3">Unknown time is simply unrecorded — it is not treated as idle.</p>
            {d.timeEntries.length > 0 && <ul className="mt-3 divide-y divide-line border-t border-line">
              {d.timeEntries.map((e: any) => <EntryRow key={e.id} e={e} tz={tz} onEdit={() => setEntryModal({ entry: e })} />)}
            </ul>}
          </Card>

          {d.suggestions.length > 0 && (
            <Card title={<span className="flex items-center gap-2"><Sparkles className="size-4 text-accent" aria-hidden />Suggestions</span>} subtitle="From your connected calendar and tools. Nothing is recorded until you confirm.">
              <ul className="space-y-3">
                {d.suggestions.map((s: any) => (
                  <li key={s.id} className="rounded-lg bg-surface-2 p-3">
                    <div className="flex items-center gap-2"><Badge tone="info">{s.kind === 'time_entry' ? 'Meeting time' : s.kind === 'task' ? 'New task' : 'Link activity'}</Badge>
                      {s.data?.event_count > 1 && <span className="text-[11px] text-ink-3">{s.data.event_count} related events</span>}</div>
                    <div className="mt-1.5 text-[13px] font-medium">{s.title}</div>
                    {s.kind === 'time_entry' && <div className="text-[12px] text-ink-3 tabular">{fmtTime(s.data.started_at, tz)}–{fmtTime(s.data.ended_at, tz)}</div>}
                    <SuggestionActions s={s} tasks={d.openTasks} onDecide={(decision, taskId) => decide.mutate({ id: s.id, decision, taskId })} />
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <NudgeSettings />
        </div>
      </div>
      <SuggestDayDialog open={suggestOpen} onClose={() => setSuggestOpen(false)} date={d.date} today={d.today} onApply={(taskIds) => plan.mutateAsync({ taskIds })} />
      <WeeklySummaryDrawer open={weeklyOpen} onClose={() => setWeeklyOpen(false)} today={d.today} />
      <TaskDrawer id={drawer} onClose={() => setDrawer(null)} />
      <ReasonDialog open={!!removing} title={`Remove "${removing?.title ?? ''}" from today`} label="Why are you replanning? (visible as a scope change)" loading={plan.isPending}
        onClose={() => setRemoving(null)} onSubmit={(reason) => plan.mutate({ taskIds: ids.filter((x) => x !== removing.id), reason })} />
      <EntryModal open={!!entryModal} onClose={() => setEntryModal(null)} entry={entryModal?.entry} tasks={d.openTasks} date={d.date} tz={tz} />
    </div>
  );
}

function SuggestionActions({ s, tasks, onDecide }: { s: any; tasks: any[]; onDecide: (d: 'accept' | 'dismiss', taskId?: string) => void }) {
  const [taskId, setTaskId] = useState(s.matched_task_id ?? '');
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      {s.kind !== 'task' && <Select aria-label="Link to task" className="h-7 max-w-[180px] text-[12px]" value={taskId} onChange={(e) => setTaskId(e.target.value)}>
        <option value="">{s.kind === 'time_entry' ? 'No task (meeting)' : 'Choose task…'}</option>{tasks.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}</Select>}
      <Button size="sm" variant="primary" disabled={s.kind === 'link_to_task' && !taskId} onClick={() => onDecide('accept', taskId || undefined)}>Confirm</Button>
      <Button size="sm" variant="ghost" onClick={() => onDecide('dismiss')}>Dismiss</Button>
    </div>
  );
}

function TimerButton({ running, taskId, onToggle, disabled }: { running: any; taskId: string; onToggle: (stop: boolean) => void; disabled?: boolean }) {
  const on = running?.task_id === taskId;
  return <IconButton label={on ? 'Stop timer' : 'Start timer'} disabled={disabled} onClick={() => onToggle(on)} className={on ? 'bg-good-soft text-good-ink' : ''}>
    {on ? <Pause className="size-4" /> : <Play className="size-4" />}</IconButton>;
}

export function TaskMeta({ t, today }: { t: any; today: string }) {
  const due = relDue(t.due_date, today);
  return (
    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12px] text-ink-3">
      {t.project_key && <span>{t.project_key}</span>}
      {due && <span className={due.tone === 'critical' ? 'font-medium text-critical-ink' : due.tone === 'warning' ? 'text-warning-ink' : ''}>{due.text}</span>}
      {t.estimate_minutes && <span>{hm(t.estimate_minutes)}</span>}
      {t.checklist_total > 0 && <span className="tabular">☑ {t.checklist_done}/{t.checklist_total}</span>}
      {t.requires_review && <span>Needs review</span>}
    </div>
  );
}
const addDaysIso = (d: string, n: number) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
void qs; void useEffect;

function FocusNote({ date, value, ids }: { date: string; value: string; ids: string[] }) {
  const qc = useQueryClient(); const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const save = useMutation({ mutationFn: () => api.put('/api/my-day/plan', { date, taskIds: ids, focusNote: v }), onSuccess: (d) => qc.setQueryData(['my-day'], d) });
  return (
    <div className="flex items-center gap-2 border-t border-line px-4 py-2.5">
      <label htmlFor="focus-note" className="shrink-0 text-[12px] font-medium text-ink-3">Focus block</label>
      <input id="focus-note" value={v} onChange={(e) => setV(e.target.value)} onBlur={() => v !== value && save.mutate()} placeholder="e.g. 14:00–16:00 protected for the tracking page"
        className="min-w-0 flex-1 rounded-md bg-transparent px-1.5 py-1 text-[13px] hover:bg-surface-2 focus:bg-surface-2 focus:outline-none" />
    </div>
  );
}
