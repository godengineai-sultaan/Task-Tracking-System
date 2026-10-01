import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ArrowUpDown, CheckCircle2, Hourglass, RefreshCw } from 'lucide-react';
import { api } from '../../lib/api';
import { useMe, useRoles } from '../../lib/session';
import { addDays, fmtDate, fmtDateTime } from '../../lib/format';
import { Button, Callout, Card, Checkbox, Empty, ErrorState, IconButton, Input, Select, Skeleton, Stat, cx, useToast } from '../ui';
import { CAUSE_LABEL, LEVEL_META, LevelBadge, STEP_WHO, wd, type Level } from './EscalationBlocker';

interface Policy {
  enabled: boolean; remindOwner: boolean; quietWhenOwnerOnLeave: boolean;
  waitingOnAfterDays: number | null; managerAfterDays: number | null; adminAfterDays: number | null;
  version: number; updatedAt: string | null;
}
const STEP_KEY: Record<Level, 'waitingOnAfterDays' | 'managerAfterDays' | 'adminAfterDays'> = { waiting_on: 'waitingOnAfterDays', manager: 'managerAfterDays', admin: 'adminAfterDays' };
const STEP_LABEL: Record<Level, string> = { waiting_on: 'Notify the person being waited on', manager: "Notify the owner's team manager", admin: 'Notify main admins' };
const STEP_DEFAULT: Record<Level, number> = { waiting_on: 2, manager: 4, admin: 7 };
const ORDER: Level[] = ['waiting_on', 'manager', 'admin'];
type Draft = { enabled: boolean; remindOwner: boolean; quietWhenOwnerOnLeave: boolean; steps: Record<Level, { on: boolean; n: string }> };

const toDraft = (p: Policy): Draft => ({
  enabled: p.enabled, remindOwner: p.remindOwner, quietWhenOwnerOnLeave: p.quietWhenOwnerOnLeave,
  steps: Object.fromEntries(ORDER.map((l) => [l, { on: p[STEP_KEY[l]] !== null, n: String(p[STEP_KEY[l]] ?? STEP_DEFAULT[l]) }])) as Draft['steps'],
});
function validate(d: Draft): Partial<Record<Level, string>> {
  const errs: Partial<Record<Level, string>> = {}; let prev = 0;
  for (const l of ORDER) {
    const s = d.steps[l]; if (!s.on) continue;
    const n = Number(s.n);
    if (!/^\d+$/.test(s.n) || n < 1 || n > 60) { errs[l] = 'Enter 1 to 60 working days'; continue; }
    if (n < prev) errs[l] = 'Must be on or after the previous step';
    prev = n;
  }
  return errs;
}
const toPolicy = (d: Draft) => ({
  enabled: d.enabled, remindOwner: d.remindOwner, quietWhenOwnerOnLeave: d.quietWhenOwnerOnLeave,
  ...Object.fromEntries(ORDER.map((l) => [STEP_KEY[l], d.steps[l].on ? Number(d.steps[l].n) : null])),
});
/** Example dates assume a Monday-Friday schedule with no holidays or leave (stated in the UI). */
function addWeekdays(date: string, n: number) {
  let d = date; let k = 0;
  while (k < n) { d = addDays(d, 1); const wdN = new Date(d + 'T12:00:00Z').getUTCDay(); if (wdN >= 1 && wdN <= 5) k++; }
  return d;
}

/** Admin tab owned by the 'escalation' feature area. */
export default function AdminEscalation() {
  const r = useRoles();
  return (
    <div className="space-y-4">
      <PolicyEditor canEdit={r.sysAdmin} />
      {(r.sysAdmin || r.routineAdmin || r.manager) && <AgingView />}
    </div>
  );
}

function PolicyEditor({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['escalation-policy'], queryFn: () => api.get<Policy>('/api/escalation/policy') });
  const [draft, setDraft] = useState<Draft | null>(null);
  useEffect(() => { if (q.data) setDraft(toDraft(q.data)); }, [q.data]);
  const save = useMutation({
    mutationFn: (d: Draft) => api.put<Policy>('/api/escalation/policy', { policy: toPolicy(d), version: q.data!.version }),
    onSuccess: (p) => { qc.setQueryData(['escalation-policy'], p); qc.invalidateQueries({ queryKey: ['escalation-aging'] }); toast({ tone: 'good', text: 'Escalation policy saved' }); },
    onError: (e: any) => { toast({ tone: 'critical', text: e.message }); if (e.status === 409) q.refetch(); },
  });
  if (q.isLoading || (!draft && !q.error)) return <Card title="Blocker escalation"><Skeleton className="h-64" /></Card>;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = draft!;
  const errs = validate(d);
  const dirty = JSON.stringify(toPolicy(d)) !== JSON.stringify(toPolicy(toDraft(q.data!)));
  const set = (patch: Partial<Draft>) => setDraft({ ...d, ...patch });
  const setStep = (l: Level, patch: Partial<{ on: boolean; n: string }>) => setDraft({ ...d, steps: { ...d.steps, [l]: { ...d.steps[l], ...patch } } });
  const off = !canEdit || save.isPending;
  return (
    <Card title="Blocker escalation" subtitle="Reminds the right people, in order, when a blocker stays open. Ages count the owner's working days only.">
      {!canEdit && <div className="mb-4"><Callout tone="neutral">Only system admins can change this policy. You can see how it works and the blockers in your scope below.</Callout></div>}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
        <form className="space-y-5" onSubmit={(e) => { e.preventDefault(); if (!Object.keys(errs).length) save.mutate(d); }}>
          <div className="rounded-lg bg-surface-2 p-3 ring-1 ring-inset ring-line">
            <Checkbox checked={d.enabled} disabled={off} onChange={(v) => set({ enabled: v })} label={<span className="font-medium">Turn on smart escalation</span>} />
            <p className="mt-1 pl-6 text-[12.5px] text-ink-3">When off, owners still get the standard daily follow-up reminder. When on, the steps below replace it so nobody is reminded twice.</p>
          </div>
          <fieldset className={cx('space-y-3', !d.enabled && 'opacity-70')}>
            <legend className="mb-2 text-[13px] font-semibold text-ink-2">Steps</legend>
            <Checkbox checked={d.remindOwner} disabled={off} onChange={(v) => set({ remindOwner: v })} label="Remind the owner on their follow-up date (after 1 working day if no date is set)" />
            {ORDER.map((l) => (
              <div key={l} className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <div className="min-w-[15rem] flex-1"><Checkbox checked={d.steps[l].on} disabled={off} onChange={(v) => setStep(l, { on: v })} label={STEP_LABEL[l]} /></div>
                <div className="flex items-center gap-2 pl-6 sm:pl-0">
                  <span className="text-[13px] text-ink-3">after</span>
                  <Input type="number" inputMode="numeric" min={1} max={60} className="w-20" aria-label={`Working days before: ${STEP_LABEL[l].toLowerCase()}`}
                    aria-invalid={!!errs[l]} aria-describedby={errs[l] ? `err-${l}` : undefined}
                    disabled={off || !d.steps[l].on} value={d.steps[l].n} onChange={(e) => setStep(l, { n: e.target.value })} />
                  <span className="text-[13px] text-ink-3">working days</span>
                </div>
                {errs[l] && <p id={`err-${l}`} role="alert" className="basis-full pl-6 text-[12px] text-critical-ink">{errs[l]}</p>}
              </div>
            ))}
            <Checkbox checked={d.quietWhenOwnerOnLeave} disabled={off} onChange={(v) => set({ quietWhenOwnerOnLeave: v })} label="Stay quiet while the owner is on full-day leave (the clock pauses)" />
          </fieldset>
          {canEdit && (
            <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
              <Button type="submit" variant="primary" loading={save.isPending} disabled={!dirty || Object.keys(errs).length > 0}>Save policy</Button>
              {dirty && <Button type="button" variant="ghost" onClick={() => setDraft(toDraft(q.data!))}>Discard changes</Button>}
              <span className="text-[12px] text-ink-3">{dirty ? 'Unsaved changes' : q.data!.updatedAt ? `Last changed ${fmtDateTime(q.data!.updatedAt)}` : 'Not configured yet'}</span>
            </div>
          )}
        </form>
        <LadderPreview d={d} />
      </div>
    </Card>
  );
}

function LadderPreview({ d }: { d: Draft }) {
  const me = useMe();
  const steps = ORDER.filter((l) => d.steps[l].on && /^\d+$/.test(d.steps[l].n)).map((l) => ({ level: l, n: Number(d.steps[l].n) }));
  const items: { when: string; text: string }[] = [{ when: 'When blocked', text: 'If the task waits on someone in the app, they are told right away.' }];
  if (d.remindOwner) items.push({ when: 'Follow-up date', text: 'The owner is reminded to follow up. Without a date, this comes after 1 working day.' });
  for (const s of steps) items.push({
    when: `After ${wd(s.n)}`,
    text: s.level === 'waiting_on' ? 'The person being waited on gets a reminder. Skipped when waiting on someone outside the app.'
      : s.level === 'manager' ? "The owner's team manager is told the blocker may need help." : 'Main admins are told about the long-running blocker.',
  });
  return (
    <section aria-labelledby="ladder-preview" className="rounded-xl bg-surface-2 p-4 ring-1 ring-inset ring-line">
      <h3 id="ladder-preview" className="text-[13px] font-semibold text-ink">What happens when a task is blocked</h3>
      {!d.enabled && <p className="mt-1 text-[12.5px] text-warning-ink">Preview only: escalation is off.</p>}
      <ol className="mt-3 space-y-3">
        {items.map((it, i) => (
          <li key={i} className="relative flex gap-3 text-[13px]">
            <span aria-hidden className={cx('mt-1 size-2.5 shrink-0 rounded-full ring-2 ring-surface-2', i === 0 ? 'bg-critical' : 'bg-accent')} />
            <div className="min-w-0"><p className="font-medium text-ink">{it.when}</p><p className="text-ink-2">{it.text}</p></div>
          </li>
        ))}
      </ol>
      {steps.length > 0 && (
        <p className="mt-4 rounded-lg bg-surface p-2.5 text-[12.5px] text-ink-2 ring-1 ring-line">
          <span className="font-medium text-ink">Example.</span> Blocked today ({fmtDate(me.today, { weekday: 'short', day: 'numeric', month: 'short' })}), assuming a Monday to Friday schedule with no holidays or leave:{' '}
          {steps.map((s, i) => <span key={s.level}>{i ? '; ' : ''}{fmtDate(addWeekdays(me.today, s.n), { weekday: 'short', day: 'numeric', month: 'short' })} for {STEP_WHO[s.level]}</span>)}.
        </p>
      )}
      <ul className="mt-3 list-disc space-y-1 pl-4 text-[12px] text-ink-3">
        <li>Working days follow each owner's own schedule. Weekends and company holidays do not count{d.quietWhenOwnerOnLeave ? ', and nothing is sent while the owner is on full-day leave' : ''}.</li>
        <li>Each step happens once per blocker. Resolving the blocker stops it.</li>
        <li>Anyone working on the task can also nudge the person waited on, once a day.</li>
      </ul>
    </section>
  );
}

// ---------- Blocker aging ----------

interface Item {
  blockerId: string; taskId: string; taskNumber: number; taskTitle: string; ownerName: string; cause: string; reason: string;
  waitingOn: string | null; waitingOnInternal: boolean; raisedAt: string; ageWorkingDays: number; level: Level | null;
  nextFollowUp: string | null; nextEscalation: { level: Level; date: string | null; afterDays: number } | null; nudges: number;
}
interface Aging { scope: 'company' | 'team'; policy: { enabled: boolean }; summary: { open: number; medianAgeWorkingDays: number | null; escalated: number; external: number }; items: Item[] }
type SortKey = 'task' | 'owner' | 'cause' | 'waitingOn' | 'age' | 'level' | 'followUp' | 'next';
const COLS: { key: SortKey; label: string }[] = [
  { key: 'task', label: 'Task' }, { key: 'owner', label: 'Owner' }, { key: 'cause', label: 'Cause' }, { key: 'waitingOn', label: 'Waiting on' },
  { key: 'age', label: 'Age (working days)' }, { key: 'level', label: 'Level' }, { key: 'followUp', label: 'Next follow-up' }, { key: 'next', label: 'Next escalation' },
];
const LEVEL_RANK: Record<string, number> = { none: 0, waiting_on: 1, manager: 2, admin: 3 };
const sortVal = (i: Item, k: SortKey): string | number => ({
  task: i.taskTitle.toLowerCase(), owner: i.ownerName.toLowerCase(), cause: CAUSE_LABEL[i.cause] ?? i.cause, waitingOn: (i.waitingOn ?? '~').toLowerCase(),
  age: i.ageWorkingDays, level: LEVEL_RANK[i.level ?? 'none'], followUp: i.nextFollowUp ?? '9999', next: i.nextEscalation?.date ?? '9999',
})[k];

function AgingView() {
  const me = useMe();
  const q = useQuery({ queryKey: ['escalation-aging'], queryFn: () => api.get<Aging>('/api/escalation/blockers') });
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'age', dir: 'desc' });
  const items = useMemo(() => [...(q.data?.items ?? [])].sort((a, b) => {
    const x = sortVal(a, sort.key), y = sortVal(b, sort.key);
    const c = x < y ? -1 : x > y ? 1 : b.ageWorkingDays - a.ageWorkingDays;
    return sort.dir === 'asc' ? c : -c;
  }), [q.data, sort]);
  const toggle = (key: SortKey) => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 'asc' ? 'desc' : 'asc') : key === 'age' || key === 'level' ? 'desc' : 'asc' }));
  const d = q.data;
  return (
    <Card title="Blocker aging" subtitle={d ? (d.scope === 'company' ? 'Every open blocker in the company.' : 'Open blockers on your team.') : undefined}
      actions={<IconButton label="Refresh blocker aging" onClick={() => q.refetch()}><RefreshCw className={cx('size-4', q.isFetching && 'animate-spin')} /></IconButton>}>
      {q.isLoading ? <div className="space-y-3"><Skeleton className="h-20" /><Skeleton className="h-48" /></div>
        : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} />
        : !d!.items.length ? <Empty icon={<CheckCircle2 className="size-8" />} title="No open blockers">Blocked tasks in your scope will appear here with their age in working days.</Empty>
        : <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Open blockers" value={d!.summary.open} />
            <Stat label="Median age" value={d!.summary.medianAgeWorkingDays ?? 'N/A'} sub="working days" />
            <Stat label="Reached manager or admins" value={d!.summary.escalated} sub={d!.policy.enabled ? 'by the escalation ladder' : 'escalation is off'} />
            <Stat label="Waiting outside the app" value={d!.summary.external} sub="clients, vendors, others" />
          </div>
          <p className="mt-3 text-[12.5px] text-ink-3">This lists blockers, not people. A long blocker usually reflects a dependency, not the owner's effort. Ages skip weekends, holidays and days outside the owner's schedule.</p>
          <div className="mt-3 flex items-center gap-2 md:hidden">
            <label htmlFor="aging-sort" className="text-[13px] text-ink-2">Sort by</label>
            <Select id="aging-sort" className="w-auto" value={`${sort.key}:${sort.dir}`} onChange={(e) => { const [key, dir] = e.target.value.split(':'); setSort({ key: key as SortKey, dir: dir as 'asc' | 'desc' }); }}>
              <option value="age:desc">Oldest first</option><option value="age:asc">Newest first</option><option value="level:desc">Highest level</option>
              <option value="next:asc">Next escalation</option><option value="followUp:asc">Next follow-up</option><option value="cause:asc">Cause</option>
            </Select>
          </div>
          <ul className="mt-3 space-y-2 md:hidden" aria-label="Open blockers">
            {items.map((i) => (
              <li key={i.blockerId} className="rounded-lg p-3 ring-1 ring-line">
                <Link to={`/tasks/${i.taskId}`} className="font-medium text-ink hover:underline">#{i.taskNumber} {i.taskTitle}</Link>
                <p className="mt-0.5 line-clamp-2 text-[12.5px] text-ink-3">{i.reason}</p>
                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[12.5px] text-ink-2">
                  <span className="inline-flex items-center gap-1 font-medium text-ink"><Hourglass className="size-3.5" aria-hidden />{wd(i.ageWorkingDays)}</span>
                  <LevelBadge level={i.level} />
                </div>
                <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[12.5px]">
                  <dt className="text-ink-3">Owner</dt><dd>{i.ownerName}</dd>
                  <dt className="text-ink-3">Cause</dt><dd>{CAUSE_LABEL[i.cause] ?? i.cause}</dd>
                  <dt className="text-ink-3">Waiting on</dt><dd>{i.waitingOn ?? '—'}{i.waitingOn && !i.waitingOnInternal ? ' (outside app)' : ''}</dd>
                  <dt className="text-ink-3">Next follow-up</dt><dd><FollowUp date={i.nextFollowUp} today={me.today} /></dd>
                  <dt className="text-ink-3">Next escalation</dt><dd><NextStep i={i} enabled={d!.policy.enabled} /></dd>
                </dl>
              </li>
            ))}
          </ul>
          <div className="mt-3 hidden overflow-x-auto md:block">
            <table className="w-full min-w-[900px] text-[13px]">
              <caption className="sr-only">Open blockers, sortable by column</caption>
              <thead><tr className="border-b border-line text-left text-[12px] text-ink-3">
                {COLS.map((c) => {
                  const active = sort.key === c.key; const Icon = !active ? ArrowUpDown : sort.dir === 'asc' ? ArrowUp : ArrowDown;
                  return (
                    <th key={c.key} scope="col" aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'} className={cx('px-3 py-2 font-medium', c.key === 'age' && 'text-right')}>
                      <button type="button" onClick={() => toggle(c.key)} className={cx('inline-flex items-center gap-1 rounded hover:text-ink', active && 'text-ink')}>
                        {c.label}<Icon className="size-3" aria-hidden />
                      </button>
                    </th>);
                })}
              </tr></thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.blockerId} className="border-b border-line align-top last:border-0">
                    <td className="max-w-[18rem] px-3 py-2"><Link to={`/tasks/${i.taskId}`} className="font-medium text-ink hover:underline">#{i.taskNumber} {i.taskTitle}</Link>
                      <p className="truncate text-[12px] text-ink-3" title={i.reason}>{i.reason}</p></td>
                    <td className="whitespace-nowrap px-3 py-2">{i.ownerName}</td>
                    <td className="whitespace-nowrap px-3 py-2">{CAUSE_LABEL[i.cause] ?? i.cause}</td>
                    <td className="px-3 py-2">{i.waitingOn ?? '—'}{i.waitingOn && !i.waitingOnInternal && <span className="block text-[11.5px] text-ink-3">outside the app</span>}</td>
                    <td className="tabular px-3 py-2 text-right font-medium">{i.ageWorkingDays}</td>
                    <td className="px-3 py-2"><LevelBadge level={i.level} /></td>
                    <td className="whitespace-nowrap px-3 py-2"><FollowUp date={i.nextFollowUp} today={me.today} /></td>
                    <td className="px-3 py-2 text-[12.5px]"><NextStep i={i} enabled={d!.policy.enabled} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>}
    </Card>
  );
}

function FollowUp({ date, today }: { date: string | null; today: string }) {
  if (!date) return <span className="text-ink-3">Not set</span>;
  return <span className={cx(date <= today && 'font-medium text-warning-ink')}>{fmtDate(date)}{date <= today ? ' (due)' : ''}</span>;
}
function NextStep({ i, enabled }: { i: Item; enabled: boolean }) {
  if (!enabled) return <span className="text-ink-3">Escalation off</span>;
  if (!i.nextEscalation) return <span className="text-ink-3">All steps done</span>;
  const { level, date } = i.nextEscalation;
  return <span title={LEVEL_META[level].label}>{STEP_WHO[level][0].toUpperCase() + STEP_WHO[level].slice(1)}{date ? `, ${fmtDate(date, { weekday: 'short', day: 'numeric', month: 'short' })}` : ''}</span>;
}
