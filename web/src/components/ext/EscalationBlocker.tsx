import { useRef, useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, ChevronDown, Hand } from 'lucide-react';
import { api } from '../../lib/api';
import { fmtDate, fmtDateTime } from '../../lib/format';
import { useRoles } from '../../lib/session';
import { Badge, Button, Field, Modal, Skeleton, Textarea, cx, useToast } from '../ui';

export type Level = 'waiting_on' | 'manager' | 'admin';
export const LEVEL_META: Record<Level, { label: string; short: string; tone: 'warning' | 'serious' | 'critical' }> = {
  waiting_on: { label: 'Person waited on notified', short: 'Waited-on notified', tone: 'warning' },
  manager: { label: 'Team manager notified', short: 'Manager notified', tone: 'serious' },
  admin: { label: 'Main admins notified', short: 'Admins notified', tone: 'critical' },
};
export const STEP_WHO: Record<Level, string> = { waiting_on: 'the person waited on', manager: "the owner's team manager", admin: 'main admins' };
export const CAUSE_LABEL: Record<string, string> = {
  dependency: 'Dependency', client: 'Client', requirement: 'Unclear requirement', access: 'Access', technical: 'Technical', capacity: 'Capacity', other: 'Other',
};
export const wd = (n: number) => `${n} working day${n === 1 ? '' : 's'}`;

export function LevelBadge({ level }: { level: Level | null }) {
  if (!level) return <Badge tone="neutral">Not escalated</Badge>;
  return <Badge tone={LEVEL_META[level].tone}>{LEVEL_META[level].short}</Badge>;
}

interface Hist { id: string; type: 'escalation' | 'nudge'; level?: 'owner' | Level; outcome?: string; note: string; workingDays?: number; followUpDate?: string | null; recipients: string[]; actor?: string; at: string }
interface EscalationState {
  resolved: boolean; ageWorkingDays: number | null; raisedOn: string | null; currentLevel: Level | null; waitingOn: string | null;
  next: { level: Level; afterDays: number; date: string | null } | null;
  policy: { enabled: boolean; steps: { level: Level; afterDays: number }[] };
  nudge: { allowed: boolean; nudgedToday: boolean; reason: string | null; hint: string | null };
  history: Hist[];
}

function describe(h: Hist) {
  const to = h.recipients.length ? h.recipients.join(', ') : null;
  if (h.type === 'nudge') return { title: `${h.actor} nudged ${to ?? 'the person waited on'}`, sub: h.note ? `“${h.note}”` : null };
  if (h.level === 'owner') return { title: h.outcome === 'skipped' ? 'Owner reminder skipped' : `Owner reminded to follow up${to ? ` (${to})` : ''}`,
    sub: h.followUpDate ? `Follow-up date ${fmtDate(h.followUpDate)}` : h.note || null };
  const meta = LEVEL_META[h.level as Level];
  if (h.outcome === 'skipped') return { title: `${meta.label.replace(' notified', '')} step skipped`, sub: h.note || null };
  return { title: `${meta.label}${to ? `: ${to}` : ''}`, sub: `After ${wd(h.workingDays ?? 0)}` };
}

/** Escalation state, nudge action and history for an open blocker (rendered inside the TaskDetail BlockerCard). */
export function BlockerEscalation({ blockerId }: { blockerId: string }) {
  const qc = useQueryClient(); const toast = useToast(); const r = useRoles();
  const histBtn = useRef<HTMLButtonElement>(null);
  const q = useQuery({ queryKey: ['blocker-escalation', blockerId], queryFn: () => api.get<EscalationState>(`/api/blockers/${blockerId}/escalation`) });
  const [open, setOpen] = useState(false);
  const [nudging, setNudging] = useState(false);
  const [note, setNote] = useState('');
  const nudge = useMutation({
    mutationFn: () => api.post(`/api/blockers/${blockerId}/nudge`, { note }),
    // The Nudge button gives way to "Nudged today", so focus moves to the (now open) history rather than being lost.
    onSuccess: () => { setNudging(false); setNote(''); setOpen(true); toast({ tone: 'good', text: `Nudge sent to ${q.data?.waitingOn}` });
      qc.invalidateQueries({ queryKey: ['blocker-escalation', blockerId] }).then(() => histBtn.current?.focus()); },
    onError: (e: any) => { toast({ tone: 'critical', text: e.message }); qc.invalidateQueries({ queryKey: ['blocker-escalation', blockerId] }); },
  });
  if (q.isLoading) return <Skeleton className="mt-2.5 h-7 w-64" />;
  if (q.error) return <p className="mt-2 text-[12px] text-ink-2">Escalation details unavailable. <button className="underline" onClick={() => q.refetch()}>Retry</button></p>;
  const d = q.data!;
  const historyId = `esc-hist-${blockerId}`;
  return (
    <div className="mt-2.5 border-t border-critical/20 pt-2.5" data-testid="blocker-escalation">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[12px] text-ink-2">
        {d.ageWorkingDays !== null && <span className="font-medium text-ink">Blocked {wd(d.ageWorkingDays)}</span>}
        <LevelBadge level={d.currentLevel} />
        {d.policy.enabled
          ? d.next && <span>Next: {STEP_WHO[d.next.level]} {d.next.date ? `on ${fmtDate(d.next.date, { weekday: 'short', day: 'numeric', month: 'short' })}` : `after ${wd(d.next.afterDays)}`}</span>
          : <span>Automatic escalation is off</span>}
        <span className="ml-auto flex flex-wrap items-center gap-1.5">
          {d.nudge.allowed && <Button size="sm" icon={<Hand className="size-3.5" aria-hidden />} onClick={() => setNudging(true)}>Nudge {d.waitingOn}</Button>}
          {!d.nudge.allowed && d.nudge.nudgedToday && <Badge tone="neutral" icon={<BellRing className="size-3" aria-hidden />}>Nudged today</Badge>}
          <button ref={histBtn} type="button" aria-expanded={open} aria-controls={historyId} onClick={() => setOpen((v) => !v)}
            className="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-[12px] font-medium text-ink-2 hover:bg-surface/60 hover:text-ink">
            History ({d.history.length})<ChevronDown className={cx('size-3.5 transition-transform', open && 'rotate-180')} aria-hidden />
          </button>
        </span>
      </div>
      {d.nudge.hint && <p className="mt-1.5 text-[12px] font-medium text-ink">{d.nudge.hint}</p>}
      {open && (
        <div id={historyId} className="mt-2 rounded-lg bg-surface p-2.5 ring-1 ring-line">
          {d.history.length === 0
            ? <p className="text-[12px] text-ink-3">No reminders, escalations or nudges yet.</p>
            : <ol className="space-y-2" aria-label="Escalation history">
              {d.history.map((h) => { const x = describe(h); return (
                <li key={h.id} className="flex gap-2.5 text-[12.5px]">
                  <span aria-hidden className={cx('mt-1.5 size-2 shrink-0 rounded-full', h.type === 'nudge' ? 'bg-accent' : h.outcome === 'skipped' ? 'bg-ink-3' : h.level === 'owner' ? 'bg-warning' : 'bg-critical')} />
                  <div className="min-w-0 flex-1">
                    <p className="text-ink">{x.title}</p>
                    <p className="text-[11.5px] text-ink-3">{fmtDateTime(h.at)}{x.sub ? ` · ${x.sub}` : ''}</p>
                  </div>
                </li>); })}
            </ol>}
          {(r.manager || r.routineAdmin || r.sysAdmin) && (
            <Link to="/admin?tab=escalation" className="mt-2.5 inline-block text-[12px] font-medium text-accent-ink hover:underline">See every open blocker in your scope</Link>)}
        </div>
      )}
      <Modal open={nudging} onClose={() => setNudging(false)} title={`Nudge ${d.waitingOn}`}
        footer={<><Button variant="ghost" onClick={() => setNudging(false)}>Cancel</Button><Button variant="primary" loading={nudge.isPending} onClick={() => nudge.mutate()}>Send nudge</Button></>}>
        <p className="mb-3 text-[13px] text-ink-2">{d.waitingOn} gets an in-app notification linking to this task. You can nudge about this blocker once a day.</p>
        <Field label="Note (optional)" hint={`${note.length}/500`}>{(id) => <Textarea id={id} rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What do you need from them?" />}</Field>
      </Modal>
    </div>
  );
}
