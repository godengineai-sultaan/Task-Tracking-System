import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CloudUpload, RefreshCw, TriangleAlert, WifiOff } from 'lucide-react';
import { useMe, useRoles } from '../../lib/session';
import { bindOutbox, discardCapture, dismissUpdate, onSynced, reloadForUpdate, retryCapture, syncOutbox, usePwa } from '../../pwa';
import { Button } from '../ui';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Offline / sync / update status strip shown under the header. Renders nothing when there is nothing to say. */
export function PwaStatus() {
  const me = useMe(); const qc = useQueryClient();
  const s = usePwa();
  const [review, setReview] = useState(false);
  const [notice, setNotice] = useState('');
  const customer = useRoles().customer;
  useEffect(() => { void bindOutbox(me.user.id, !customer); }, [me.user.id, customer]); // clients have no quick capture, so no offline capture either
  useEffect(() => onSynced((r) => {
    qc.invalidateQueries();
    const warn = r.flatMap((x) => x.warnings);
    setNotice(`${plural(r.length, 'offline capture', 'offline captures')} synced${warn.length ? ` · ${warn.join(' · ')}` : ''}`);
  }), [qc]);
  useEffect(() => { if (!notice) return; const t = setTimeout(() => setNotice(''), 6000); return () => clearTimeout(t); }, [notice]);
  const pending = s.items.filter((i) => i.status === 'pending');
  const failed = s.items.filter((i) => i.status === 'failed');
  useEffect(() => { if (!failed.length) setReview(false); }, [failed.length]);
  const visible = !s.online || s.items.length > 0 || s.updateReady || !!notice;

  return (
    <div role="region" aria-label="Connection and sync status" className={visible ? 'sticky top-14 z-10 border-b border-line bg-surface-2 px-4 py-2 text-[13px] sm:px-6' : 'sr-only'}>
      <div className="mx-auto flex w-full max-w-[1400px] flex-wrap items-center gap-x-4 gap-y-2">
        {!s.online && <p className="flex items-center gap-2 text-ink-2"><WifiOff className="size-4 shrink-0" aria-hidden />
          <span><span className="font-medium text-ink">You're offline.</span> Quick capture still works; captures sync when you reconnect.</span></p>}
        <p role="status" aria-live="polite" className="flex items-center gap-2 empty:hidden">
          {pending.length > 0 && <><CloudUpload className="size-4 shrink-0 text-accent-ink" aria-hidden />
            <span className="font-medium">{s.syncing ? `Syncing ${plural(pending.length, 'capture', 'captures')}…` : `${plural(pending.length, 'capture', 'captures')} waiting to sync`}</span></>}
          {!pending.length && notice && <span className="text-good-ink">{notice}</span>}
        </p>
        {pending.length > 0 && <Button size="sm" variant="ghost" disabled={!s.online || s.syncing} loading={s.syncing} onClick={() => void syncOutbox()}>Sync now</Button>}
        {failed.length > 0 && <div className="flex items-center gap-2">
          <TriangleAlert className="size-4 shrink-0 text-warning-ink" aria-hidden />
          <span className="font-medium text-warning-ink">{plural(failed.length, 'capture needs', 'captures need')} attention</span>
          <Button size="sm" variant="ghost" aria-expanded={review} onClick={() => setReview((v) => !v)}>{review ? 'Hide' : 'Review'}</Button>
        </div>}
        {s.updateReady && <div className="flex items-center gap-2 sm:ml-auto">
          <RefreshCw className="size-4 shrink-0 text-accent-ink" aria-hidden /><span>A new version of the app is available.</span>
          <Button size="sm" variant="primary" onClick={reloadForUpdate}>Reload</Button>
          <Button size="sm" variant="ghost" onClick={dismissUpdate}>Later</Button>
        </div>}
      </div>
      {review && failed.length > 0 && <ul className="mx-auto mt-2 w-full max-w-[1400px] space-y-2">
        {failed.map((i) => <FailedCapture key={i.clientRequestId} id={i.clientRequestId} text={i.text} error={i.error ?? ''} online={s.online} />)}
      </ul>}
    </div>
  );
}

function FailedCapture({ id, text, error, online }: { id: string; text: string; error: string; online: boolean }) {
  const [value, setValue] = useState(text);
  return (
    <li className="rounded-lg bg-surface p-3 ring-1 ring-line">
      <label htmlFor={`cap-${id}`} className="text-[12px] font-medium text-ink-3">Capture text</label>
      <input id={`cap-${id}`} value={value} onChange={(e) => setValue(e.target.value)} maxLength={500}
        className="mt-1 h-9 w-full rounded-lg bg-surface-2 px-3 text-[14px] ring-1 ring-inset ring-line focus:outline-none focus:ring-2 focus:ring-accent" />
      <p className="mt-1 text-[12px] text-critical-ink">{error}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" variant="primary" disabled={!online || !value.trim()} onClick={() => void retryCapture(id, value.trim())}>Retry</Button>
        <Button size="sm" variant="ghost" onClick={() => void discardCapture(id)}>Discard</Button>
      </div>
    </li>
  );
}
