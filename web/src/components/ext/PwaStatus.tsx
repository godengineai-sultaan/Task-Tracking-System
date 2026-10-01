import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CloudUpload, RefreshCw, TriangleAlert, WifiOff } from 'lucide-react';
import { fmtDateTime } from '../../lib/format';
import { useMe, useRoles } from '../../lib/session';
import { bindOutbox, discardCapture, dismissUpdate, onSynced, reloadForUpdate, retryCapture, syncOutbox, usePwa } from '../../pwa';
import { Button, cx } from '../ui';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Offline / sync / update status strip shown under the header. Renders nothing when there is nothing to say. */
export function PwaStatus() {
  const me = useMe(); const qc = useQueryClient();
  const s = usePwa();
  const [review, setReview] = useState(false);
  const [notice, setNotice] = useState('');
  const strip = useRef<HTMLDivElement>(null);
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

  // The live status line stays mounted (so updates are announced); the landmark only exists while there is something to say.
  // While captures are being reviewed the strip scrolls with the page, so a long list never pins over the content on a phone.
  return (
    <div ref={strip} tabIndex={-1} role={visible ? 'region' : undefined} aria-label={visible ? 'Connection and sync status' : undefined}
      className={visible ? cx(!review && 'sticky top-14 z-10', 'border-b border-line bg-surface-2 px-4 py-2 text-[13px] focus:outline-none sm:px-6') : 'sr-only'}>
      <div className="mx-auto flex w-full max-w-[1400px] flex-wrap items-center gap-x-4 gap-y-2">
        {!s.online && <p className="flex items-center gap-2 text-ink-2"><WifiOff className="size-4 shrink-0" aria-hidden />
          <span><span className="font-medium text-ink">You're offline.</span> {customer ? 'Reconnect to see the latest project updates.' : 'Quick capture still works; captures sync when you reconnect.'}</span></p>}
        <p role="status" aria-live="polite" className="flex items-center gap-2 empty:hidden">
          {pending.length > 0 && <><CloudUpload className="size-4 shrink-0 text-accent-ink" aria-hidden />
            <span className="font-medium">{s.syncing ? `Syncing ${plural(pending.length, 'capture', 'captures')}…` : `${plural(pending.length, 'capture', 'captures')} waiting to sync`}</span></>}
          {!pending.length && notice && <span className="text-good-ink">{notice}</span>}
        </p>
        {pending.length > 0 && s.online && <Button size="sm" variant="ghost" disabled={s.syncing} loading={s.syncing} onClick={() => void syncOutbox()}>Sync now</Button>}
        {failed.length > 0 && <div className="flex items-center gap-2">
          <TriangleAlert className="size-4 shrink-0 text-warning-ink" aria-hidden />
          <span className="font-medium text-warning-ink">{plural(failed.length, 'capture needs', 'captures need')} attention</span>
          <Button size="sm" variant="ghost" aria-expanded={review} aria-controls="failed-captures" onClick={() => setReview((v) => !v)}>{review ? 'Hide' : 'Review'}</Button>
        </div>}
        {s.updateReady && <div className="flex items-center gap-2 sm:ml-auto">
          <RefreshCw className="size-4 shrink-0 text-accent-ink" aria-hidden /><span>A new version of the app is available.</span>
          <Button size="sm" variant="primary" onClick={reloadForUpdate}>Reload</Button>
          <Button size="sm" variant="ghost" onClick={dismissUpdate}>Later</Button>
        </div>}
      </div>
      {review && failed.length > 0 && <ul id="failed-captures" aria-label="Captures that need attention" className="mx-auto mt-2 w-full max-w-[1400px] space-y-2">
        {failed.map((i) => <FailedCapture key={i.clientRequestId} id={i.clientRequestId} text={i.text} capturedAt={i.capturedAt} error={i.error ?? ''} online={s.online}
          onDone={() => strip.current?.focus()} />)}
      </ul>}
    </div>
  );
}

function FailedCapture({ id, text, capturedAt, error, online, onDone }: { id: string; text: string; capturedAt: string; error: string; online: boolean; onDone: () => void }) {
  const [value, setValue] = useState(text);
  const [confirming, setConfirming] = useState(false);
  const keep = useRef<HTMLButtonElement>(null); const discard = useRef<HTMLButtonElement>(null); const asked = useRef(false);
  useEffect(() => { if (confirming) { asked.current = true; keep.current?.focus(); } else if (asked.current) discard.current?.focus(); }, [confirming]);
  return (
    <li className="rounded-lg bg-surface p-3 ring-1 ring-line">
      <label htmlFor={`cap-${id}`} className="text-[12px] font-medium text-ink-3">Captured {fmtDateTime(capturedAt)}</label>
      <input id={`cap-${id}`} value={value} onChange={(e) => setValue(e.target.value)} maxLength={500} aria-describedby={`cap-${id}-error`}
        className="mt-1 h-9 w-full rounded-lg bg-surface-2 px-3 text-[14px] ring-1 ring-inset ring-line focus:outline-none focus:ring-2 focus:ring-accent" />
      <p id={`cap-${id}-error`} className="mt-1 text-[12px] text-critical-ink">{error}</p>
      {confirming
        ? <div key="confirm" role="group" aria-label="Confirm discard" className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-[13px] text-ink-2">Delete this capture from this device? It cannot be recovered.</span>
          <Button size="sm" variant="danger" onClick={() => { onDone(); void discardCapture(id); }}>Discard capture</Button>
          <Button ref={keep} size="sm" variant="ghost" onClick={() => setConfirming(false)}>Keep</Button>
        </div>
        : <div key="actions" className="mt-2 flex flex-wrap gap-2">
          <Button size="sm" variant="primary" disabled={!online || !value.trim()} onClick={() => { onDone(); void retryCapture(id, value.trim()); }}>Retry</Button>
          <Button ref={discard} size="sm" variant="ghost" onClick={() => setConfirming(true)}>Discard</Button>
        </div>}
    </li>
  );
}
