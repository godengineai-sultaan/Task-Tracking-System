import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import { api } from '../lib/api';
import { STATUS_LABEL } from '../lib/format';
import { useMe } from '../lib/session';
import { Button, Field, Input, Modal, Select, StatusDot, Textarea, cx, useToast } from './ui';

const NEXT: Record<string, string[]> = {
  backlog: ['planned', 'in_progress', 'cancelled'], planned: ['in_progress', 'blocked', 'done', 'in_review', 'backlog', 'cancelled'],
  in_progress: ['done', 'in_review', 'blocked', 'planned', 'cancelled'], blocked: ['in_progress', 'planned', 'cancelled'], in_review: [], done: [], cancelled: [],
};

/** Inline one-click status change. Opens a short dialog only when the transition needs a reason (blocked / cancel / reopen). */
export function StatusControl({ task, compact, onChanged }: { task: any; compact?: boolean; onChanged?: () => void }) {
  const qc = useQueryClient(); const toast = useToast(); const me = useMe();
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<null | 'blocked' | 'cancelled' | 'reopen' | 'unblock'>(null);
  const started = useState(() => Date.now())[0];
  const mut = useMutation({
    mutationFn: (body: any) => body.reopen ? api.post(`/api/tasks/${task.id}/reopen`, { reason: body.reason }) : api.post(`/api/tasks/${task.id}/status`, body),
    onSuccess: (_r, body: any) => {
      qc.invalidateQueries(); setDialog(null); setOpen(false); onChanged?.();
      toast({ tone: 'good', text: body.reopen ? 'Reopened — kept in rework history' : `Moved to ${STATUS_LABEL[body.to]}` });
    },
    onError: (e: any) => toast({ tone: 'critical', text: e.message }),
  });
  const options = (() => {
    const base = NEXT[task.status] ?? [];
    return base.filter((s) => !(s === 'done' && task.requires_review) && !(s === 'in_review' && !task.requires_review && !task.reviewer_id));
  })();
  const choose = (to: string) => {
    setOpen(false);
    if (to === 'blocked') return setDialog('blocked');
    if (to === 'cancelled') return setDialog('cancelled');
    if (task.status === 'blocked') return setDialog('unblock'), setPending(to);
    mut.mutate({ to, version: task.version, elapsedMs: Date.now() - started });
  };
  const [pending, setPending] = useState<string | null>(null);
  const closed = task.status === 'done' || task.status === 'cancelled';
  return (
    <div className="relative inline-block">
      <button type="button" aria-haspopup="menu" aria-expanded={open} disabled={mut.isPending}
        onClick={(e) => { e.stopPropagation(); closed ? setDialog('reopen') : setOpen((v) => !v); }}
        className={cx('inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] font-medium text-ink-2 hover:bg-surface-2', compact ? '' : 'ring-1 ring-inset ring-line')}
        aria-label={`Status: ${STATUS_LABEL[task.status]}. ${closed ? 'Reopen' : 'Change status'}`}>
        <StatusDot status={task.status} />{!compact && STATUS_LABEL[task.status]}{!closed && !compact && <ChevronDown className="size-3" aria-hidden />}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={(e) => { e.stopPropagation(); setOpen(false); }} />
          <div role="menu" className="absolute left-0 z-40 mt-1 w-48 rounded-lg bg-surface p-1 shadow-xl ring-1 ring-line" onClick={(e) => e.stopPropagation()}>
            {task.status === 'in_review' && <p className="px-2 py-1.5 text-[12px] text-ink-3">Waiting for the reviewer to accept or request changes.</p>}
            {options.map((s) => (
              <button key={s} role="menuitem" onClick={() => choose(s)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-surface-2">
                <StatusDot status={s} />{s === 'in_review' ? 'Submit for review' : STATUS_LABEL[s]}
              </button>
            ))}
          </div>
        </>
      )}
      <BlockDialog open={dialog === 'blocked'} onClose={() => setDialog(null)} loading={mut.isPending}
        onSubmit={(blocker) => mut.mutate({ to: 'blocked', version: task.version, blocker })} meId={me.user.id} />
      <ReasonDialog open={dialog === 'cancelled'} title="Cancel task" label="Why is this cancelled? (scope change note)" onClose={() => setDialog(null)} loading={mut.isPending}
        onSubmit={(reason) => mut.mutate({ to: 'cancelled', version: task.version, reason })} />
      <ReasonDialog open={dialog === 'reopen'} title={`Reopen "${task.title}"`} label="What needs rework? This is kept in the rework history." onClose={() => setDialog(null)} loading={mut.isPending}
        onSubmit={(reason) => mut.mutate({ reopen: true, reason })} />
      <ReasonDialog open={dialog === 'unblock'} title="Resolve blocker" label="How was it resolved?" optional onClose={() => setDialog(null)} loading={mut.isPending}
        onSubmit={(reason) => mut.mutate({ to: pending, version: task.version, resolution: reason || 'Unblocked' })} />
    </div>
  );
}

export function ReasonDialog({ open, onClose, onSubmit, title, label, loading, optional }: { open: boolean; onClose: () => void; onSubmit: (r: string) => void; title: string; label: string; loading?: boolean; optional?: boolean }) {
  const [reason, setReason] = useState('');
  return (
    <Modal open={open} onClose={onClose} title={title} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button>
      <Button variant="primary" loading={loading} disabled={!optional && !reason.trim()} onClick={() => onSubmit(reason.trim())}>Confirm</Button></>}>
      <Field label={label}>{(id) => <Textarea id={id} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} data-autofocus
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && (optional || reason.trim())) onSubmit(reason.trim()); }} />}</Field>
    </Modal>
  );
}

export function BlockDialog({ open, onClose, onSubmit, loading, meId }: { open: boolean; onClose: () => void; onSubmit: (b: any) => void; loading?: boolean; meId: string }) {
  const [reason, setReason] = useState(''); const [cause, setCause] = useState('dependency'); const [who, setWho] = useState(''); const [text, setText] = useState('');
  const today = useMe().today;
  const [follow, setFollow] = useState(() => { const d = new Date(today + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); });
  const users = useUsers();
  return (
    <Modal open={open} onClose={onClose} title="Mark as blocked" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button>
      <Button variant="primary" loading={loading} disabled={!reason.trim()} onClick={() => onSubmit({ reason: reason.trim(), cause, waitingOnUserId: who || null, waitingOnText: text, nextFollowUp: follow || null })}>Mark blocked</Button></>}>
      <div className="grid gap-3">
        <Field label="What is blocking it?">{(id) => <Textarea id={id} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} data-autofocus placeholder="e.g. Waiting for the client to confirm the API scope" />}</Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Cause">{(id) => <Select id={id} value={cause} onChange={(e) => setCause(e.target.value)}>
            {['dependency', 'client', 'requirement', 'access', 'technical', 'capacity', 'other'].map((c) => <option key={c} value={c}>{c[0].toUpperCase() + c.slice(1)}</option>)}</Select>}</Field>
          <Field label="Next follow-up">{(id) => <Input id={id} type="date" value={follow} onChange={(e) => setFollow(e.target.value)} />}</Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Waiting on (teammate)">{(id) => <Select id={id} value={who} onChange={(e) => setWho(e.target.value)}>
            <option value="">— nobody internal —</option>{(users.data ?? []).filter((u: any) => u.id !== meId).map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select>}</Field>
          <Field label="…or external party">{(id) => <Input id={id} value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Client IT team" />}</Field>
        </div>
      </div>
    </Modal>
  );
}

import { useQuery } from '@tanstack/react-query';
export function useUsers() { return useQuery({ queryKey: ['users'], queryFn: () => api.get('/api/users'), staleTime: 300_000 }); }
export function useProjects() { return useQuery({ queryKey: ['projects'], queryFn: () => api.get('/api/projects'), staleTime: 120_000 }); }
