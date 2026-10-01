import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link2, Pause, Play, RefreshCw, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { Badge, Button, Callout, ErrorState, Field, Input, Modal, Skeleton, useToast } from '../ui';

interface Sub { id: string; host: string; status: 'active' | 'paused'; lastFetchAt: string | null; lastSuccessAt: string | null; lastStatus: 'ok' | 'not_modified' | 'error' | null;
  lastError: string | null; lastResult: { received?: number; duplicates?: number; unreadable?: number; notModified?: boolean }; failures: number }
interface State { connectionId: string | null; connectionStatus: string | null; subscription: Sub | null }

function resultText(s: Sub) {
  if (s.lastStatus === 'not_modified' || s.lastResult?.notModified) return 'No changes since the previous check.';
  const n = s.lastResult?.received ?? 0, d = s.lastResult?.duplicates ?? 0;
  const u = s.lastResult?.unreadable ?? 0;
  return `${n} new meeting${n === 1 ? '' : 's'} offered as suggestions${d ? `, ${d} already seen` : ''}.${u ? ` ${u} entr${u === 1 ? 'y' : 'ies'} with an unreadable repeat rule skipped.` : ''}`;
}

/** Subscribe to a calendar's secret iCal (ICS) address. The address is stored encrypted; only its host is ever shown back. */
export function CalendarSubscription() {
  const qc = useQueryClient(); const toast = useToast();
  const q = useQuery<State>({ queryKey: ['calendar-subscription'], queryFn: () => api.get('/api/calendar/subscription') });
  const [url, setUrl] = useState(''); const [editing, setEditing] = useState(false); const [confirmRemove, setConfirmRemove] = useState(false);
  const apply = (d: State) => { qc.setQueryData(['calendar-subscription'], d); qc.invalidateQueries({ queryKey: ['integrations'] }); qc.invalidateQueries({ queryKey: ['suggestions'] }); };
  const onError = (e: any) => toast({ tone: 'critical', text: e.message });
  const save = useMutation({ mutationFn: () => api.put<State>('/api/calendar/subscription', { url: url.trim() }), onError,
    onSuccess: (d) => {
      apply(d); setUrl(''); setEditing(false);
      toast(d.subscription?.lastStatus === 'error' ? { tone: 'critical', text: `Saved, but the first check failed: ${d.subscription.lastError}` } : { tone: 'good', text: 'Calendar subscribed. It is checked every hour.' });
    } });
  const sync = useMutation({ mutationFn: () => api.post<State>('/api/calendar/subscription/sync'), onError,
    onSuccess: (d) => { apply(d); const s = d.subscription!; toast(s.lastStatus === 'error' ? { tone: 'critical', text: s.lastError ?? 'Sync failed' } : { tone: 'good', text: resultText(s) }); } });
  const status = useMutation({ mutationFn: (st: 'active' | 'paused') => api.patch<State>('/api/calendar/subscription', { status: st }), onError, onSuccess: apply });
  const remove = useMutation({ mutationFn: () => api.del<State>('/api/calendar/subscription'), onError,
    onSuccess: (d) => { apply(d); setConfirmRemove(false); toast({ tone: 'good', text: 'Subscription removed. The stored address was deleted.' }); } });

  if (q.isLoading) return <Skeleton className="h-24" />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const s = q.data?.subscription ?? null;
  const connPaused = q.data?.connectionStatus === 'paused';

  const form = (
    <form className="grid gap-2" onSubmit={(e) => { e.preventDefault(); if (url.trim()) save.mutate(); }}>
      <Field label="Secret address in iCal format" hint={<>Google Calendar: Settings › your calendar › Integrate calendar. Outlook: Settings › Shared calendars › Publish a calendar › ICS link. Must start with https://. Stored encrypted; only the host is shown here.</>}>
        {(id) => <Input id={id} type="url" inputMode="url" autoComplete="off" spellCheck={false} placeholder="https://calendar.example.com/…/basic.ics" value={url} onChange={(e) => setUrl(e.target.value)} />}
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" size="sm" icon={<Link2 className="size-3.5" aria-hidden />} loading={save.isPending} disabled={!url.trim()}>{s ? 'Save new address' : 'Subscribe'}</Button>
        {s && <Button type="button" size="sm" variant="ghost" onClick={() => { setEditing(false); setUrl(''); }}>Cancel</Button>}
      </div>
    </form>
  );

  return (
    <section aria-labelledby="cal-sub-h" className="mt-4 border-t border-line pt-4">
      <h3 id="cal-sub-h" className="text-[13.5px] font-semibold text-ink">Subscribe by address</h3>
      <p className="mt-0.5 mb-3 text-[12.5px] text-ink-3">Checked every hour. Meetings from the last 7 days become suggestions in My Day after they end; nothing is recorded until you confirm it.</p>
      {!s || editing ? form : (
        <div className="grid gap-3">
          <div className="flex flex-wrap items-center gap-2 text-[13px]">
            <Badge tone={s.status === 'paused' || connPaused ? 'neutral' : s.lastStatus === 'error' ? 'critical' : 'good'}>
              {s.status === 'paused' ? 'Paused' : connPaused ? 'Calendar paused' : s.lastStatus === 'error' ? 'Sync failing' : 'Active · hourly'}</Badge>
            <code className="min-w-0 truncate rounded bg-surface-2 px-1.5 py-0.5 text-[12px] text-ink-2" title="Only the host of the stored address is shown">{s.host}</code>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12.5px]">
            <dt className="text-ink-3">Last checked</dt><dd className="text-ink-2">{s.lastFetchAt ? fmtDateTime(s.lastFetchAt) : 'Not yet'}</dd>
            <dt className="text-ink-3">Last success</dt><dd className="text-ink-2">{s.lastSuccessAt ? fmtDateTime(s.lastSuccessAt) : 'Not yet'}</dd>
            {s.lastSuccessAt && <><dt className="text-ink-3">Result</dt><dd className="text-ink-2">{resultText(s)}</dd></>}
          </dl>
          {connPaused && s.status === 'active' && <Callout tone="info">Your calendar connection is paused, so this address is not checked. Resume the calendar above to sync again.</Callout>}
          {s.lastStatus === 'error' && <Callout tone="critical"><b>Last check failed{s.failures > 1 ? ` (${s.failures} times in a row)` : ''}:</b> {s.lastError}</Callout>}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" icon={<RefreshCw className="size-3.5" aria-hidden />} loading={sync.isPending} disabled={s.status === 'paused' || connPaused} onClick={() => sync.mutate()}>Sync now</Button>
            <Button size="sm" variant="ghost" icon={s.status === 'active' ? <Pause className="size-3.5" aria-hidden /> : <Play className="size-3.5" aria-hidden />} loading={status.isPending}
              onClick={() => status.mutate(s.status === 'active' ? 'paused' : 'active')}>{s.status === 'active' ? 'Pause syncing' : 'Resume syncing'}</Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>Change address</Button>
            <Button size="sm" variant="ghost" className="text-critical-ink" icon={<Trash2 className="size-3.5" aria-hidden />} onClick={() => setConfirmRemove(true)}>Remove</Button>
          </div>
        </div>
      )}
      <Modal open={confirmRemove} onClose={() => setConfirmRemove(false)} title="Remove calendar subscription?"
        footer={<><Button variant="ghost" onClick={() => setConfirmRemove(false)}>Cancel</Button><Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>Remove</Button></>}>
        <p className="text-[13px] text-ink-2">The stored address is deleted and hourly checks stop. Meetings you already confirmed stay recorded; open suggestions stay until you decide on them.</p>
      </Modal>
    </section>
  );
}
