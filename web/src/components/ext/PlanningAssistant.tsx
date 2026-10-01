import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, CalendarRange, ChevronLeft, ChevronRight, Copy, RotateCcw, Undo2 } from 'lucide-react';
import { api, qs } from '../../lib/api';
import { addDays, fmtDate, hm, pct, relDue, STATUS_LABEL } from '../../lib/format';
import { AssessmentBadge, Badge, Button, Callout, Card, Checkbox, Drawer, Empty, ErrorState, IconButton, Modal, Skeleton, Stat, cx, useToast } from '../ui';

/** Plan-my-day assistant (deterministic ranking with reasons), weekly self-summary and reminder settings for My Day. */

const CHECK_TONE: Record<string, 'good' | 'warning' | 'neutral' | 'info'> = { fits: 'good', over: 'warning', partial: 'info', empty: 'neutral' };

function TaskLine({ t, today }: { t: any; today: string }) {
  const due = relDue(t.dueDate, today);
  return (
    <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12px] text-ink-3">
      {t.projectKey && <span>{t.projectKey}</span>}
      <span>{STATUS_LABEL[t.status] ?? t.status}</span>
      {due && <span className={due.tone === 'critical' ? 'font-medium text-critical-ink' : due.tone === 'warning' ? 'text-warning-ink' : ''}>{due.text}</span>}
      <span>{t.estimateMinutes ? `Est. ${hm(t.estimateMinutes)}` : 'No estimate'}</span>
    </span>
  );
}

export function SuggestDayDialog({ open, onClose, date, today, onApply }: { open: boolean; onClose: () => void; date: string; today: string; onApply: (taskIds: string[]) => Promise<unknown> }) {
  const toast = useToast();
  const q = useQuery({ queryKey: ['planning-suggest', date], queryFn: () => api.get(`/api/planning/suggest${qs({ date })}`), enabled: open, staleTime: 0, gcTime: 0 });
  const [picked, setPicked] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!open) setPicked(null); }, [open]);
  const s = q.data;
  const proposalAdd: string[] = s?.proposal?.add ?? [];
  const selected = picked ?? proposalAdd;
  const slots: number = s?.slots ?? 0;
  const candidates: any[] = s?.candidates ?? [];
  const chosen = candidates.filter((c) => selected.includes(c.id)); // rank order
  const toggle = (id: string, on: boolean) => setPicked((on ? [...selected, id] : selected.filter((x) => x !== id)).slice(0, slots));
  const isProposal = selected.length === proposalAdd.length && selected.every((x) => proposalAdd.includes(x));
  // Capacity check for a changed selection, with the same rules the server uses for the proposal.
  const custom = (() => {
    if (!s?.applicable || isProposal) return null;
    const mins = [...s.current.filter((c: any) => !['done', 'cancelled'].includes(c.status)).map((c: any) => c.estimateMinutes), ...chosen.map((c) => c.estimateMinutes)];
    const est = mins.filter((m) => m != null).reduce((a: number, m: number) => a + m, 0);
    const un = mins.filter((m) => m == null).length, left = s.capacity.remainingMinutes;
    const state = !mins.length ? 'empty' : est > left ? 'over' : un ? 'partial' : 'fits';
    const text = state === 'empty' ? 'Nothing selected yet.' : `Your selection is estimated at ${hm(est)} of the ${hm(left)} available${un ? `; ${un} without an estimate, so the real total is unknown` : ''}${state === 'over' ? '. That is more than the time available.' : '.'}`;
    return { state, text };
  })();
  const check = custom ?? s?.capacityCheck;

  const apply = async () => {
    setBusy(true);
    try {
      await onApply([...s.proposal.keep, ...chosen.map((c) => c.id)]);
      toast({ tone: 'good', text: `Planned ${s.proposal.keep.length + chosen.length} intended outcome${s.proposal.keep.length + chosen.length === 1 ? '' : 's'}` });
      onClose();
    } catch { /* the plan mutation already shows the error */ } finally { setBusy(false); }
  };

  const canApply = !!s?.applicable && chosen.length > 0 && !s.current.some((c: any) => ['done', 'cancelled'].includes(c.status));
  // Only offer "Use these" when there is something to choose; otherwise the dialog is informational.
  const choosable = !!s?.applicable && slots > 0 && candidates.length > 0;
  return (
    <Modal open={open} onClose={onClose} title="Suggest my day" width="max-w-2xl"
      footer={choosable ? <>
        <span className="mr-auto self-center text-[12px] text-ink-3 tabular">{chosen.length} of {slots} open slot{slots === 1 ? '' : 's'} selected</span>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={apply} loading={busy} disabled={!canApply}>Use these</Button>
      </> : <Button onClick={onClose}>Close</Button>}>
      {q.isLoading ? (
        <div className="space-y-3" aria-busy="true"><Skeleton className="h-12" /><Skeleton className="h-20" /><Skeleton className="h-20" /><Skeleton className="h-20" /></div>
      ) : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} />
      : !s ? null : !s.applicable ? (
        <div className="space-y-3">
          <AssessmentBadge label="not_applicable" />
          <p className="text-[14px] leading-relaxed text-ink-2">{s.rationale}</p>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-[13.5px] leading-relaxed text-ink-2" data-testid="suggest-rationale">{s.rationale}</p>
          {check && <Callout tone={CHECK_TONE[check.state]}><b className="font-semibold">Capacity check. </b>{check.text}</Callout>}
          {s.proposal.applyNote && <Callout tone="warning">{s.proposal.applyNote}</Callout>}

          {s.current.length > 0 && (
            <section aria-labelledby="sugg-kept">
              <h3 id="sugg-kept" className="mb-1.5 text-[12px] font-semibold uppercase tracking-wide text-ink-3">Already chosen (kept)</h3>
              <ul className="divide-y divide-line rounded-lg ring-1 ring-line">
                {s.current.map((t: any) => (
                  <li key={t.id} className="flex items-start gap-3 px-3 py-2.5">
                    <Badge tone="neutral">Kept</Badge>
                    <div className="min-w-0 flex-1"><div className="truncate text-[13.5px] font-medium">{t.title}</div><TaskLine t={t} today={today} /></div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section aria-labelledby="sugg-ranked">
            <h3 id="sugg-ranked" className="mb-1.5 text-[12px] font-semibold uppercase tracking-wide text-ink-3">
              {slots === 0 ? 'Ranked open work' : `Ranked candidates · choose up to ${slots}`}
            </h3>
            {slots === 0 && <div className="mb-2"><Callout tone="neutral">All three outcomes for the day are chosen. Remove one from My Day first if you want to swap.</Callout></div>}
            {candidates.length === 0 ? (slots > 0 && (
              <Empty title="Nothing ready to plan">
                {s.excluded.some((e: any) => !['done', 'cancelled'].includes(e.reason))
                  ? 'Your open work is blocked, in review or waiting on other work. The reasons are listed under Set aside below.'
                  : 'You have no open work to plan. Capture a task with Quick capture first.'}
              </Empty>
            )) : (
              <ol className="divide-y divide-line rounded-lg ring-1 ring-line" aria-label="Ranked candidates">
                {candidates.map((c) => {
                  const on = selected.includes(c.id);
                  const full = !on && selected.length >= slots;
                  return (
                    <li key={c.id} className={cx('px-3 py-2.5', on && 'bg-accent-soft/40')}>
                      <label className={cx('flex items-start gap-3', full ? 'cursor-not-allowed' : 'cursor-pointer')}>
                        <input type="checkbox" className="mt-1 size-4 shrink-0 accent-[var(--accent)]" checked={on} disabled={full || slots === 0}
                          onChange={(e) => toggle(c.id, e.target.checked)} aria-describedby={`why-${c.id}`} />
                        <span className="w-5 shrink-0 pt-0.5 text-center text-[12px] font-semibold text-ink-3 tabular"><span className="sr-only">Rank </span>{c.rank}</span>
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="text-[13.5px] font-medium text-ink">{c.title}</span>
                            {c.proposed && <Badge tone="info">Suggested</Badge>}
                          </span>
                          <TaskLine t={c} today={today} />
                        </span>
                      </label>
                      <div id={`why-${c.id}`} className="ml-[3.25rem] mt-1">
                        <ul className="list-disc space-y-0.5 pl-4 text-[12px] text-ink-2">
                          {c.reasons.map((r: string) => <li key={r}>{r}</li>)}
                        </ul>
                        <details className="mt-1 text-[12px] text-ink-3">
                          <summary className="cursor-pointer select-none rounded hover:text-ink">{c.score} ranking points</summary>
                          <table className="mt-1 w-full max-w-sm text-left">
                            <caption className="sr-only">Ranking points for {c.title}</caption>
                            <thead><tr><th scope="col" className="font-medium">Rule</th><th scope="col" className="text-right font-medium">Points</th></tr></thead>
                            <tbody>{c.parts.map((p: any) => <tr key={p.key}><td className="pr-3">{p.label}</td><td className="text-right tabular">{p.points > 0 ? `+${p.points}` : p.points}</td></tr>)}</tbody>
                          </table>
                        </details>
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </section>

          {s.excluded.length > 0 && (
            <details className="rounded-lg ring-1 ring-line">
              <summary className="cursor-pointer select-none px-3 py-2 text-[13px] font-medium text-ink-2">Set aside ({s.excluded.length})</summary>
              <ul className="divide-y divide-line border-t border-line">
                {s.excluded.map((e: any) => (
                  <li key={e.id} className="px-3 py-2">
                    <div className="truncate text-[13px] text-ink">{e.title}</div>
                    <div className="text-[12px] text-ink-3">{e.label}</div>
                  </li>
                ))}
              </ul>
            </details>
          )}
          <details className="rounded-lg ring-1 ring-line">
            <summary className="cursor-pointer select-none px-3 py-2 text-[13px] font-medium text-ink-2">How the ranking works</summary>
            <div className="space-y-2 border-t border-line px-3 py-2 text-[12px] text-ink-2">
              <ul className="list-disc space-y-0.5 pl-4">{s.rules.map((r: string) => <li key={r}>{r}</li>)}</ul>
              <ul className="list-disc space-y-0.5 pl-4 text-ink-3">{s.assumptions.map((r: string) => <li key={r}>{r}</li>)}</ul>
            </div>
          </details>
        </div>
      )}
    </Modal>
  );
}

export function WeeklySummaryDrawer({ open, onClose, today }: { open: boolean; onClose: () => void; today: string }) {
  const toast = useToast();
  const [ref, setRef] = useState(today);
  const q = useQuery({ queryKey: ['planning-weekly', ref], queryFn: () => api.get(`/api/planning/weekly-summary${qs({ date: ref })}`), enabled: open });
  // Edits are kept per week, so a background refetch (for example on window focus) never overwrites them; Reset discards them.
  const [edits, setEdits] = useState<Record<string, string>>({});
  const area = useRef<HTMLTextAreaElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const prevBtn = useRef<HTMLButtonElement>(null); // keeps keyboard focus inside the drawer when "This week" or "Next week" disappears or disables
  useEffect(() => { if (open) setRef(today); }, [open, today]);
  // The shared Drawer has no name prop: name the dialog after its heading so screen readers announce "Weekly summary".
  useEffect(() => { if (open) heading.current?.closest('[role="dialog"]')?.setAttribute('aria-labelledby', 'weekly-summary-title'); }, [open]);
  const s = q.data;
  const text: string = s ? edits[s.period.start] ?? s.text : '';
  const setWeekText = (week: string, v: string | null) => setEdits((e) => {
    const n = { ...e };
    if (v === null) delete n[week]; else n[week] = v;
    return n;
  });
  // Reset discards edits, so it turns into "Undo reset" in place (reachable by keyboard inside the drawer) until the text changes again.
  const [undo, setUndo] = useState<{ week: string; text: string } | null>(null);
  const reset = () => {
    setUndo({ week: s.period.start, text });
    setWeekText(s.period.start, null);
    toast({ tone: 'info', text: 'Summary text reset to the generated version' });
  };
  const canUndo = !!s && undo?.week === s.period.start && text === s.text;
  const nextStart = s ? addDays(s.period.start, 7) : null;
  const isCurrentWeek = !nextStart || nextStart > today;
  const copy = async () => {
    let ok = true;
    try { await navigator.clipboard.writeText(text); }
    catch { area.current?.select(); ok = document.execCommand('copy'); }
    toast(ok ? { tone: 'good', text: 'Summary copied to the clipboard' } : { tone: 'critical', text: 'Could not copy automatically. The text is selected: press Ctrl+C (Cmd+C on a Mac).' });
  };
  return (
    <Drawer open={open} onClose={onClose} title="My Day" width="max-w-xl">
      <div className="space-y-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 id="weekly-summary-title" ref={heading} className="flex items-center gap-2 text-[17px] font-semibold"><CalendarRange className="size-4 text-accent" aria-hidden />Weekly summary</h2>
            <p className="text-[13px] text-ink-3">{s ? `${fmtDate(s.period.start, { weekday: 'short', day: 'numeric', month: 'short' })} – ${fmtDate(s.period.end, { weekday: 'short', day: 'numeric', month: 'short' })}` : 'Loading week'}</p>
          </div>
          <div className="flex items-center gap-1">
            {!isCurrentWeek && <Button size="sm" variant="ghost" onClick={() => { setRef(today); prevBtn.current?.focus(); }}>This week</Button>}
            <IconButton ref={prevBtn} label="Previous week" onClick={() => setRef(addDays(s?.period.start ?? ref, -7))}><ChevronLeft className="size-4" /></IconButton>
            <IconButton label="Next week" disabled={isCurrentWeek} onClick={() => { if (!nextStart) return; setRef(nextStart); if (addDays(nextStart, 7) > today) prevBtn.current?.focus(); }} className="disabled:opacity-40"><ChevronRight className="size-4" /></IconButton>
          </div>
        </div>
        {q.isLoading ? (
          <div className="space-y-3" aria-busy="true"><div className="grid grid-cols-2 gap-3">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-20" />)}</div><Skeleton className="h-72" /></div>
        ) : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : s && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Stat label="Accepted outcomes" value={s.facts.acceptedOutcomes} sub={`${s.facts.acceptedPlannedOutcomes} of ${s.facts.intendedOutcomes} planned outcomes accepted the same day`} />
              <Stat label="Carried over" value={s.facts.carryovers} />
              <Stat label="Open blockers" value={s.facts.openBlockers} sub={`${s.facts.resolvedBlockers} resolved`} />
              <Stat label="Recorded time" value={s.facts.availableMinutes ? hm(s.facts.explainedMinutes) : 'N/A'}
                sub={s.facts.availableMinutes ? `${pct(s.facts.loggingCoverage)} of ${hm(s.facts.availableMinutes)} scheduled` : 'No scheduled time'}
                hint="Logging coverage: how much scheduled time has a time entry. It is not a productivity measure, and unrecorded time is unknown, not idle." />
            </div>
            {s.reportState !== 'confirmed' && <Callout tone="neutral">Some days have no confirmed recap yet, so parts of this summary are provisional.</Callout>}
            <div className="space-y-1.5">
              <div className="flex flex-wrap items-end justify-between gap-2">
                <label htmlFor="weekly-summary-text" className="text-[13px] font-medium text-ink-2">Summary text</label>
                <div className="flex gap-2">
                  {canUndo
                    ? <Button size="sm" variant="ghost" icon={<Undo2 className="size-3.5" />} onClick={() => { setWeekText(undo!.week, undo!.text); setUndo(null); }}>Undo reset</Button>
                    : <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" />} disabled={text === s.text} onClick={reset}>Reset</Button>}
                  <Button size="sm" variant="primary" icon={<Copy className="size-3.5" />} onClick={copy}>Copy</Button>
                </div>
              </div>
              <textarea id="weekly-summary-text" ref={area} value={text} onChange={(e) => setWeekText(s.period.start, e.target.value)} rows={18} spellCheck
                className="w-full rounded-lg bg-surface px-3 py-2 text-[13px] leading-relaxed text-ink ring-1 ring-inset ring-line-strong focus:outline-none focus:ring-2 focus:ring-accent" />
              <p className="text-[12px] text-ink-3">Edit freely. Nothing is saved or shared; it only leaves this screen when you copy it.</p>
            </div>
            <ul className="list-disc space-y-0.5 pl-4 text-[12px] text-ink-3">{s.assumptions.map((a: string) => <li key={a}>{a}</li>)}</ul>
          </>
        )}
      </div>
    </Drawer>
  );
}

export function NudgeSettings() {
  const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['planning-prefs'], queryFn: () => api.get('/api/planning/preferences') });
  const m = useMutation({
    mutationFn: (b: { planNudge?: boolean; recapNudge?: boolean }) => api.put('/api/planning/preferences', b),
    onSuccess: (d) => { qc.setQueryData(['planning-prefs'], d); toast({ tone: 'good', text: 'Reminder preference saved' }); },
    onError: (e: any) => toast({ tone: 'critical', text: e.message }),
  });
  return (
    <Card title={<span className="flex items-center gap-2"><Bell className="size-4 text-accent" aria-hidden />Reminders</span>} subtitle="In-app only, at most once a day, on your working days.">
      {q.isLoading ? <div className="space-y-2"><Skeleton className="h-5 w-56" /><Skeleton className="h-5 w-60" /></div>
        : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : (
          <div className="space-y-2.5">
            <div className="flex flex-col gap-2">
              <Checkbox checked={q.data.planNudge} disabled={m.isPending} onChange={(v) => m.mutate({ planNudge: v })} label="Remind me to plan my day" />
              <Checkbox checked={q.data.recapNudge} disabled={m.isPending} onChange={(v) => m.mutate({ recapNudge: v })} label="Remind me to confirm my recap" />
            </div>
            <details className="text-[12px] text-ink-3">
              <summary className="cursor-pointer select-none hover:text-ink">When reminders are sent</summary>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">{q.data.rules.map((r: string) => <li key={r}>{r}</li>)}</ul>
            </details>
          </div>
        )}
    </Card>
  );
}

