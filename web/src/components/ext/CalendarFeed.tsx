import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, CalendarClock, Copy, Link2, RotateCw } from 'lucide-react';
import { api } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { Badge, Button, Callout, Card, ErrorState, Field, Input, Modal, Skeleton, useToast } from '../ui';

interface FeedState { active: boolean; createdAt: string | null; lastUsedAt: string | null }

/** Read-only personal calendar feed: create, copy (shown once), rotate and revoke. */
export function CalendarFeedCard({ className }: { className?: string }) {
  const qc = useQueryClient(); const toast = useToast();
  const q = useQuery<FeedState>({ queryKey: ['calendar-feed'], queryFn: () => api.get('/api/calendar/feed') });
  const [fresh, setFresh] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'rotate' | 'revoke' | null>(null);
  const onError = (e: any) => toast({ tone: 'critical', text: e.message });
  const rotate = useMutation({ mutationFn: () => api.post<{ url: string }>('/api/calendar/feed/rotate'), onError,
    onSuccess: (r) => { setFresh(r.url); setConfirm(null); qc.invalidateQueries({ queryKey: ['calendar-feed'] }); toast({ tone: 'good', text: q.data?.active ? 'New feed address created. The old one no longer works.' : 'Feed address created' }); } });
  const revoke = useMutation({ mutationFn: () => api.del<FeedState>('/api/calendar/feed'), onError,
    onSuccess: (d) => { setFresh(null); setConfirm(null); qc.setQueryData(['calendar-feed'], d); toast({ tone: 'good', text: 'Feed revoked. Calendar apps can no longer read it.' }); } });
  const copy = () => fresh && navigator.clipboard?.writeText(fresh).then(() => toast({ tone: 'good', text: 'Feed address copied' }), () => toast({ tone: 'info', text: 'Select the address and copy it manually' }));

  return (
    <Card className={className} title={<span className="flex items-center gap-2"><CalendarClock className="size-4" aria-hidden />Calendar feed</span>}
      subtitle="Add your work to Google, Outlook or Apple Calendar as a read-only subscription.">
      <ul className="mb-3 grid gap-1 text-[13px] text-ink-2">
        <li>• Your open task due dates (title and a link only)</li>
        <li>• Today's intended outcomes</li>
        <li>• Your leave (shown as Leave, Training or Out of office)</li>
      </ul>
      <p className="mb-3 text-[12.5px] text-ink-3">Never includes task descriptions, comments or anyone else's data.</p>
      {q.isLoading ? <Skeleton className="h-16" /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : <>
        {fresh && (
          <div className="mb-3 grid gap-2">
            <Field label="Your feed address">{(id) => (
              <div className="flex gap-2">
                <Input id={id} readOnly value={fresh} className="min-w-0 flex-1 font-mono text-[12px]" onFocus={(e) => e.target.select()} />
                <Button icon={<Copy className="size-3.5" aria-hidden />} onClick={copy}>Copy</Button>
              </div>)}
            </Field>
            <Callout tone="warning">Shown only now. Anyone with this address can read these entries, so keep it private. If it leaks, rotate it.</Callout>
          </div>
        )}
        {q.data?.active ? (
          <div className="grid gap-3">
            <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-2">
              <Badge tone="good">Active</Badge>
              <span>Created {fmtDateTime(q.data.createdAt)} · {q.data.lastUsedAt ? `last read ${fmtDateTime(q.data.lastUsedAt)}` : 'not read by a calendar app yet'}</span>
            </div>
            {!fresh && <p className="text-[12.5px] text-ink-3">The address is stored only as a fingerprint and can't be shown again. Rotate to get a new one.</p>}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" icon={<RotateCw className="size-3.5" aria-hidden />} onClick={() => setConfirm('rotate')}>Rotate address</Button>
              <Button size="sm" variant="ghost" className="text-critical-ink" icon={<Ban className="size-3.5" aria-hidden />} onClick={() => setConfirm('revoke')}>Revoke</Button>
            </div>
          </div>
        ) : (
          <Button variant="primary" icon={<Link2 className="size-4" aria-hidden />} loading={rotate.isPending} onClick={() => rotate.mutate()}>Create feed address</Button>
        )}
      </>}
      <Modal open={!!confirm} onClose={() => setConfirm(null)} title={confirm === 'rotate' ? 'Rotate feed address?' : 'Revoke feed?'}
        footer={<><Button variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button>
          {confirm === 'rotate'
            ? <Button variant="primary" loading={rotate.isPending} onClick={() => rotate.mutate()}>Rotate</Button>
            : <Button variant="danger" loading={revoke.isPending} onClick={() => revoke.mutate()}>Revoke</Button>}</>}>
        <p className="text-[13px] text-ink-2">{confirm === 'rotate'
          ? 'A new address is created and the current one stops working immediately. Calendar apps using the old address need the new one.'
          : 'The address stops working immediately. You can create a new one later.'}</p>
      </Modal>
    </Card>
  );
}
