import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileUp, Upload } from 'lucide-react';
import { api } from '../../lib/api';
import { fmtDate, fmtDateTime } from '../../lib/format';
import { Badge, Button, Callout, Field, Input, Modal, Segmented, useToast } from '../ui';

interface Item { date: string; name: string; status: 'new' | 'exists'; existingName?: string; past: boolean }
interface Preview { id: string; sourceLabel: string; items: Item[]; warnings: string[]; counts: { total: number; new: number; existing: number } }

/** Admin wizard: upload an .ics file or give an https address, preview the all-day dates found, then confirm the selected ones. */
export function HolidayImport() {
  const [open, setOpen] = useState(false);
  return <>
    <Button size="sm" icon={<Upload className="size-3.5" aria-hidden />} onClick={() => setOpen(true)}>Import</Button>
    {open && <Wizard onClose={() => setOpen(false)} />}
  </>;
}

function Wizard({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient(); const toast = useToast();
  const [source, setSource] = useState<'file' | 'url'>('file');
  const [file, setFile] = useState<File | null>(null); const [url, setUrl] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const load = useMutation({
    mutationFn: async () => api.post<Preview>('/api/calendar/holidays/import/preview',
      source === 'file' ? { source, ics: await file!.text(), fileName: file!.name } : { source, url: url.trim() }),
    onSuccess: (p) => { setPreview(p); setSelected(new Set(p.items.filter((i) => i.status === 'new' && !i.past).map((i) => i.date))); },
  });
  const confirm = useMutation({
    mutationFn: () => api.post<{ imported: number; skipped: number }>(`/api/calendar/holidays/import/${preview!.id}/confirm`, { dates: [...selected] }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['holidays'] }); qc.invalidateQueries({ queryKey: ['holiday-imports'] });
      toast({ tone: 'good', text: `Imported ${r.imported} holiday${r.imported === 1 ? '' : 's'}${r.skipped ? ` (${r.skipped} already existed)` : ''}` });
      onClose();
    },
    onError: (e: any) => toast({ tone: 'critical', text: e.message }),
  });
  const toggle = (d: string, on: boolean) => { const s = new Set(selected); if (on) s.add(d); else s.delete(d); setSelected(s); };
  const selectable = preview?.items.filter((i) => i.status === 'new') ?? [];
  const tooBig = file && file.size > 5 * 1024 * 1024;
  const loadError = (load.error as any)?.message ?? null;
  // Step changes: focus the preview summary (so it is read before anything can be confirmed), or the source field after Back.
  const summaryRef = useRef<HTMLParagraphElement>(null); const sourceRef = useRef<HTMLInputElement>(null); const hadPreview = useRef(false);
  useEffect(() => {
    if (preview) summaryRef.current?.focus(); else if (hadPreview.current) sourceRef.current?.focus();
    hadPreview.current = !!preview;
  }, [preview]);

  const footer = !preview
    ? <><Button key="cancel" variant="ghost" onClick={onClose}>Cancel</Button>
        <Button key="preview" variant="primary" loading={load.isPending} disabled={source === 'file' ? !file || !!tooBig : !url.trim()} onClick={() => load.mutate()}>Preview</Button></>
    : <><Button key="back" variant="ghost" onClick={() => { setPreview(null); load.reset(); }}>Back</Button>
        <Button key="import" variant="primary" loading={confirm.isPending} disabled={selected.size === 0} onClick={() => confirm.mutate()}>
          Import {selected.size} holiday{selected.size === 1 ? '' : 's'}</Button></>;

  return (
    <Modal open onClose={onClose} title="Import holidays" width="max-w-2xl" footer={footer}>
      {!preview ? (
        <div className="grid gap-4">
          <p className="text-[13px] text-ink-2">Reads all-day entries from a calendar file. Dates and names come only from the file, and nothing is added until you confirm. Existing holidays are never changed.</p>
          <Segmented label="Import source" value={source} onChange={(v) => { setSource(v); load.reset(); }} options={[{ value: 'file', label: 'Upload .ics file' }, { value: 'url', label: 'From https address' }]} />
          {source === 'file' ? (
            <Field label="Calendar file (.ics)" error={tooBig ? 'The file is larger than 5 MB.' : loadError} hint={file ? `${file.name} · ${Math.max(1, Math.round(file.size / 1024))} KB` : 'Exported from your calendar app or a public holiday calendar.'}>
              {(id) => <input ref={sourceRef} id={id} type="file" aria-invalid={!!(tooBig || loadError) || undefined} accept=".ics,text/calendar"
                className="block w-full rounded-lg bg-surface text-[13px] text-ink-2 ring-1 ring-inset ring-line-strong file:mr-3 file:rounded-l-lg file:border-0 file:bg-surface-2 file:px-3 file:py-2 file:text-[13px] file:font-medium file:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                onChange={(e) => { setFile(e.target.files?.[0] ?? null); load.reset(); }} />}
            </Field>
          ) : (
            <Field label="Calendar address" error={loadError} hint="Must start with https://. Private and internal network addresses are refused.">
              {(id) => <Input ref={sourceRef} id={id} type="url" aria-invalid={!!loadError || undefined} inputMode="url" autoComplete="off" spellCheck={false} placeholder="https://calendar.example.com/holidays.ics" value={url} onChange={(e) => { setUrl(e.target.value); load.reset(); }} />}
            </Field>
          )}
        </div>
      ) : (
        <div className="grid gap-3">
          <p ref={summaryRef} tabIndex={-1} className="rounded text-[13px] text-ink-2">
            <b className="text-ink">{preview.counts.total}</b> date{preview.counts.total === 1 ? '' : 's'} found in <b className="text-ink">{preview.sourceLabel}</b>: {preview.counts.new} new, {preview.counts.existing} already {preview.counts.existing === 1 ? 'a holiday' : 'holidays'}. Past dates are not selected by default.
          </p>
          {preview.warnings.length > 0 && <Callout tone="warning"><ul className="grid gap-0.5">{preview.warnings.map((w) => <li key={w}>{w}</li>)}</ul></Callout>}
          {preview.items.length === 0 ? (
            <div className="rounded-lg bg-surface-2 px-4 py-8 text-center text-[13px] text-ink-3"><FileUp className="mx-auto mb-2 size-5" aria-hidden />No all-day dates were found in this file.</div>
          ) : <>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set(selectable.map((i) => i.date)))}>Select all new</Button>
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Select none</Button>
            </div>
            <div className="max-h-[45vh] overflow-auto rounded-lg ring-1 ring-line">
              <table className="w-full text-[13px]">
                <caption className="sr-only">Holidays found in the file</caption>
                <thead className="sticky top-0 bg-surface-2 text-left text-[12px] text-ink-3">
                  <tr><th scope="col" className="w-10 px-3 py-2 font-medium"><span className="sr-only">Import</span></th><th scope="col" className="py-2 pr-3 font-medium">Date</th>
                    <th scope="col" className="py-2 pr-3 font-medium">Name in file</th><th scope="col" className="py-2 pr-3 font-medium">Status</th></tr>
                </thead>
                <tbody className="divide-y divide-line">{preview.items.map((i) => (
                  <tr key={i.date} className={i.status === 'exists' ? 'text-ink-3' : ''}>
                    <td className="px-3 py-2"><input type="checkbox" className="size-4 accent-[var(--accent)]" aria-label={`Import ${i.name} on ${i.date}`}
                      disabled={i.status === 'exists'} checked={selected.has(i.date)} onChange={(e) => toggle(i.date, e.target.checked)} /></td>
                    <td className="py-2 pr-3 tabular sm:whitespace-nowrap">{fmtDate(i.date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</td>
                    <td className="py-2 pr-3 break-words">{i.name}</td>
                    <td className="py-2 pr-3">{i.status === 'exists' ? <Badge className="whitespace-normal!">Already: {i.existingName}</Badge> : i.past ? <Badge tone="warning">Past date</Badge> : <Badge tone="good">New</Badge>}</td>
                  </tr>))}</tbody>
              </table>
            </div>
          </>}
          {confirm.error && <Callout tone="critical">{(confirm.error as any).message}</Callout>}
        </div>
      )}
    </Modal>
  );
}

/** Recently confirmed imports (admins). */
export function RecentHolidayImports() {
  const q = useQuery<any[]>({ queryKey: ['holiday-imports'], queryFn: () => api.get('/api/calendar/holidays/imports') });
  if (!q.data?.length) return null;
  return (
    <div className="mt-4 border-t border-line pt-3">
      <h3 className="mb-1.5 text-[12px] font-medium uppercase tracking-wide text-ink-3">Recent imports</h3>
      <ul className="grid gap-1 text-[12.5px] text-ink-2">{q.data.map((i) => (
        <li key={i.id} className="flex flex-wrap gap-x-2"><span className="font-medium text-ink">{i.source_label}</span>
          <span>{i.imported_count} added{i.skipped_count ? `, ${i.skipped_count} already existed` : ''}</span>
          <span className="text-ink-3">{fmtDateTime(i.confirmed_at)}{i.confirmed_by_name ? ` by ${i.confirmed_by_name}` : ''}</span></li>))}</ul>
    </div>
  );
}
