import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { TIME_CATS, fmtTime, hm } from '../lib/format';
import { Badge, Button, Field, Input, Modal, Select, Textarea, cx, useToast } from './ui';

/** Stacked allocation bar: confirmed categories + unknown (hatched, never a category hue). 2px gaps between segments. */
export function AllocationBar({ byCategory, unknown, available, height = 12, showLegend = true }: { byCategory: Record<string, number>; unknown: number; available: number; height?: number; showLegend?: boolean }) {
  if (!available) return <p className="text-[13px] text-ink-3">No scheduled capacity — Not Applicable.</p>;
  const segs = [...TIME_CATS.map((c) => ({ key: c.key, label: c.label, color: c.color, v: byCategory[c.key] ?? 0 })), { key: 'unknown', label: 'Unknown', color: '', v: unknown }].filter((s) => s.v > 0);
  const total = Math.max(available, segs.reduce((s, x) => s + x.v, 0));
  return (
    <div>
      <div className="flex w-full gap-[2px] overflow-hidden rounded" style={{ height }} role="img"
        aria-label={segs.map((s) => `${s.label} ${hm(s.v)}`).join(', ') + ` of ${hm(available)} available`}>
        {segs.map((s, i) => (
          <div key={s.key} title={`${s.label}: ${hm(s.v)}`} className={cx(s.key === 'unknown' && 'hatch', i === 0 && 'rounded-l', i === segs.length - 1 && 'rounded-r')}
            style={{ width: `${(s.v / total) * 100}%`, background: s.key === 'unknown' ? undefined : s.color, minWidth: 3 }} />
        ))}
      </div>
      {showLegend && (
        <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-ink-2">
          {segs.map((s) => (
            <li key={s.key} className="flex items-center gap-1.5">
              <span aria-hidden className={cx('inline-block size-2.5 rounded-sm', s.key === 'unknown' && 'hatch ring-1 ring-line-strong')} style={{ background: s.key === 'unknown' ? undefined : s.color }} />
              {s.label} <span className="tabular font-medium text-ink">{hm(s.v)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export const SOURCE_LABEL: Record<string, string> = { timer: 'Timer', manual: 'Manual', calendar: 'Calendar', integration: 'Integration' };

/** Add or correct a time entry. Corrections require a reason and keep the original in the revision history. */
export function EntryModal({ open, onClose, entry, tasks, date, tz }: { open: boolean; onClose: () => void; entry?: any; tasks: any[]; date: string; tz: string }) {
  const qc = useQueryClient(); const toast = useToast();
  const toLocal = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz });
  const [taskId, setTaskId] = useState(''); const [category, setCategory] = useState('task'); const [start, setStart] = useState('10:00'); const [end, setEnd] = useState('10:30');
  const [note, setNote] = useState(''); const [reason, setReason] = useState('');
  useEffect(() => {
    if (!open) return;
    setTaskId(entry?.task_id ?? ''); setCategory(entry?.category ?? 'task'); setNote(entry?.note ?? ''); setReason('');
    if (entry) { setStart(toLocal(entry.started_at)); setEnd(entry.ended_at ? toLocal(entry.ended_at) : toLocal(new Date().toISOString())); }
    else { const now = new Date(); const s = new Date(now.getTime() - 30 * 60000); setStart(toLocal(s.toISOString())); setEnd(toLocal(now.toISOString())); }
  }, [open, entry]);
  const toIso = (hhmm: string) => {
    // Interpret HH:mm in the user's working time zone for `date`.
    const probe = new Date(`${date}T${hhmm}:00Z`);
    const offset = tzOffsetMinutes(tz, probe);
    return new Date(probe.getTime() - offset * 60000).toISOString();
  };
  const mut = useMutation({
    mutationFn: () => {
      const body = { taskId: category === 'task' ? taskId || null : null, category, startedAt: toIso(start), endedAt: toIso(end), note };
      return entry ? api.patch(`/api/time-entries/${entry.id}`, { ...body, version: entry.version, reason }) : api.post('/api/time-entries', body);
    },
    onSuccess: (r: any) => {
      qc.invalidateQueries(); onClose();
      toast({ tone: 'good', text: r.overlaps?.length ? `Saved. Overlaps ${r.overlaps.length} other entr${r.overlaps.length > 1 ? 'ies' : 'y'} — counted once in reports.` : entry ? 'Correction saved — original kept in history' : 'Time added' });
    },
    onError: (e: any) => toast({ tone: 'critical', text: e.message }),
  });
  const del = useMutation({
    mutationFn: () => api.del(`/api/time-entries/${entry.id}`, { reason }),
    onSuccess: () => { qc.invalidateQueries(); onClose(); toast({ tone: 'good', text: 'Entry removed — kept in history' }); },
    onError: (e: any) => toast({ tone: 'critical', text: e.message }),
  });
  const invalid = end <= start || (category === 'task' && !taskId) || (entry && !reason.trim());
  return (
    <Modal open={open} onClose={onClose} title={entry ? 'Correct time entry' : 'Add time'}
      footer={<>
        {entry && <Button variant="ghost" className="mr-auto text-critical-ink" disabled={!reason.trim()} loading={del.isPending} onClick={() => del.mutate()}>Remove</Button>}
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!!invalid} loading={mut.isPending} onClick={() => mut.mutate()}>{entry ? 'Save correction' : 'Add'}</Button>
      </>}>
      <div className="grid gap-3">
        {entry && <p className="text-[13px] text-ink-2">Source: <Badge>{SOURCE_LABEL[entry.source]}</Badge> — the original values stay in the revision history.</p>}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Category">{(id) => <Select id={id} value={category} onChange={(e) => setCategory(e.target.value)}>{TIME_CATS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</Select>}</Field>
          {category === 'task' && <Field label="Task">{(id) => <Select id={id} value={taskId} onChange={(e) => setTaskId(e.target.value)}><option value="">Choose…</option>
            {tasks.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}</Select>}</Field>}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label={`Start (${tz})`}>{(id) => <Input id={id} type="time" value={start} onChange={(e) => setStart(e.target.value)} />}</Field>
          <Field label="End">{(id) => <Input id={id} type="time" value={end} onChange={(e) => setEnd(e.target.value)} />}</Field>
        </div>
        <Field label="Note (optional)">{(id) => <Input id={id} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
        {entry && <Field label="Reason for correction">{(id) => <Textarea id={id} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Forgot to stop the timer during lunch" />}</Field>}
      </div>
    </Modal>
  );
}

export function tzOffsetMinutes(tz: string, at: Date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(at).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((asUtc - at.getTime()) / 60000);
}

export function EntryRow({ e, tz, onEdit }: { e: any; tz: string; onEdit?: () => void }) {
  const cat = TIME_CATS.find((c) => c.key === e.category);
  return (
    <li className="flex items-center gap-2.5 py-1.5">
      <span aria-hidden className="h-6 w-1 shrink-0 rounded-full" style={{ background: cat?.color }} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium">{e.task_title ?? e.note ?? cat?.label}</div>
        <div className="tabular text-[12px] text-ink-3">{fmtTime(e.started_at, tz)}–{e.ended_at ? fmtTime(e.ended_at, tz) : 'running'} · {SOURCE_LABEL[e.source]}{e.revisions ? ` · corrected` : ''}</div>
      </div>
      {onEdit && e.ended_at && <Button size="sm" variant="ghost" onClick={onEdit}>Correct</Button>}
    </li>
  );
}

export function useTicker(ms = 30000) {
  const [, set] = useState(0);
  useEffect(() => { const t = setInterval(() => set((x) => x + 1), ms); return () => clearInterval(t); }, [ms]);
}
