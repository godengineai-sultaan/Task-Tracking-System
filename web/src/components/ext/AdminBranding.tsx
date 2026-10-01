import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ImageUp, RotateCcw, Trash2, TriangleAlert } from 'lucide-react';
import { api } from '../../lib/api';
import { Badge, Button, Callout, Card, ErrorState, Field, Input, Modal, Skeleton, useToast } from '../ui';
import { HEX, LogoTile, MIN_CONTRAST, accentPalette, contrastWithWhite, nearestAccessibleShade, useBranding } from './BrandMark';

const MAX_LOGO = 200 * 1024;
const isDark = () => document.documentElement.getAttribute('data-theme') === 'dark'
  || (document.documentElement.getAttribute('data-theme') !== 'light' && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches);
/** Re-render the preview when the theme toggle or the system theme changes. */
function useIsDark() {
  const [dark, setDark] = useState(isDark);
  useEffect(() => {
    const upd = () => setDark(isDark());
    const mo = new MutationObserver(upd); mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)'); mq?.addEventListener('change', upd);
    return () => { mo.disconnect(); mq?.removeEventListener('change', upd); };
  }, []);
  return dark;
}

/** Admin tab: organization display name, accessible accent colour and logo. */
export default function AdminBranding() {
  const q = useBranding(); const qc = useQueryClient(); const toast = useToast();
  const [name, setName] = useState(''); const [hex, setHex] = useState(''); const [hexTouched, setHexTouched] = useState(false);
  const dark = useIsDark();
  const [logoError, setLogoError] = useState<string | null>(null); const [confirmRemove, setConfirmRemove] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const b = q.data;
  useEffect(() => { if (b) { setName(b.displayName); setHex(b.accent ?? ''); } }, [b?.version, b?.displayName]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = () => { qc.invalidateQueries({ queryKey: ['branding'] }); qc.invalidateQueries({ queryKey: ['me'] }); };
  const save = useMutation({
    mutationFn: (accent: string | null) => api.put('/api/branding', { displayName: name.trim(), accent, version: b!.version }),
    onSuccess: () => { refresh(); toast({ tone: 'good', text: 'Branding saved' }); },
    onError: (e: any) => { if (e.status === 409) refresh(); toast({ tone: 'critical', text: e.message }); },
  });
  const upload = useMutation({
    mutationFn: (f: File) => { const fd = new FormData(); fd.append('file', f, f.name); return api.post('/api/branding/logo', fd); },
    onSuccess: () => { setLogoError(null); refresh(); toast({ tone: 'good', text: 'Logo updated' }); },
    onError: (e: any) => setLogoError(e.message),
  });
  const remove = useMutation({
    mutationFn: () => api.del('/api/branding/logo'),
    onSuccess: () => { setConfirmRemove(false); refresh(); toast({ tone: 'good', text: 'Logo removed' }); },
    onError: (e: any) => toast({ tone: 'critical', text: e.message }),
  });

  if (q.isLoading) return <Skeleton className="h-96" />;
  if (q.error || !b) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;

  const value = hex.trim().toLowerCase();
  const valid = value === '' || HEX.test(value);
  const effective = value || b.defaultAccent;
  const ratio = valid ? contrastWithWhite(effective) : null;
  const passes = ratio !== null && ratio >= MIN_CONTRAST;
  const suggestion = valid && !passes ? nearestAccessibleShade(effective) : null;
  const nameOk = name.trim().length >= 2;
  const dirty = name.trim() !== b.displayName || (value || null) !== b.accent;
  // Preview the colour that would be saved; for a failing colour, preview the suggested shade instead.
  const shown = passes ? effective : suggestion;
  const pal = shown ? accentPalette(shown)[dark ? 'dark' : 'light'] : null;
  const previewVars = pal ? ({ '--accent': pal.accent, '--accent-ink': pal.ink, '--accent-soft': pal.soft } as CSSProperties) : undefined;

  const pick = (f: File | undefined) => {
    if (!f) return;
    if (!/\.(png|svg|jpe?g)$/i.test(f.name)) return setLogoError('Upload a PNG, SVG or JPEG image.');
    if (f.size > MAX_LOGO) return setLogoError(`That file is ${Math.ceil(f.size / 1024)} KB. Logos must be 200 KB or smaller.`);
    setLogoError(null); upload.mutate(f);
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,360px)] lg:items-start">
      <Card title="Brand identity" subtitle="Shown in the sidebar, the client portal and the header of every PDF.">
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (passes && nameOk && dirty) save.mutate(value || null); }}>
          <Field label="Display name" hint="Your organization's name as people and clients see it." error={nameOk ? null : 'Use at least 2 characters.'}>
            {(id) => <Input id={id} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />}
          </Field>
          <Field label="Accent colour (hex)" hint={value ? undefined : `Using the default accent ${b.defaultAccent}.`}
            error={valid || (!hexTouched && value.length < 7) ? null : 'Use a 6-digit hex colour such as #256abf.'}>
            {(id) => (
              <div className="flex flex-wrap items-center gap-2">
                <input type="color" aria-label="Pick accent colour" value={valid ? effective : b.defaultAccent} onChange={(e) => setHex(e.target.value)}
                  className="h-9 w-12 shrink-0 cursor-pointer rounded-lg bg-surface ring-1 ring-inset ring-line-strong" />
                <Input id={id} value={hex} placeholder={b.defaultAccent} onChange={(e) => { setHex(e.target.value); setHexTouched(false); }} onBlur={() => setHexTouched(true)} className="w-32 font-mono" spellCheck={false} autoComplete="off" />
                {value && <Button type="button" variant="ghost" size="sm" icon={<RotateCcw className="size-3.5" aria-hidden />} onClick={() => setHex('')}>Use default</Button>}
              </div>
            )}
          </Field>
          <div role="status">{ratio !== null && (passes
            ? <p className="flex items-center gap-1.5 text-[13px] text-good-ink"><CheckCircle2 className="size-4" aria-hidden />White text on {effective} has {ratio.toFixed(2)}:1 contrast (meets the 4.5:1 minimum).</p>
            : <Callout tone="warning" icon={<TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />}>
                <p>White text on {effective} has only {ratio.toFixed(2)}:1 contrast; buttons and badges need at least 4.5:1, so this colour can't be saved.</p>
                {suggestion && <div className="mt-2 flex flex-wrap items-center gap-2">
                  <span className="inline-block size-5 rounded ring-1 ring-line" style={{ background: suggestion }} aria-hidden />
                  <span>Nearest accessible shade: <span className="font-mono">{suggestion}</span> ({contrastWithWhite(suggestion).toFixed(2)}:1)</span>
                  <Button type="button" size="sm" onClick={() => setHex(suggestion)}>Use {suggestion}</Button>
                </div>}
              </Callout>)}</div>
          <div className="flex items-center justify-end gap-2 border-t border-line pt-3">
            {dirty && <Button type="button" variant="ghost" onClick={() => { setName(b.displayName); setHex(b.accent ?? ''); }}>Discard changes</Button>}
            <Button type="submit" variant="primary" loading={save.isPending} disabled={!dirty || !passes || !nameOk}>Save branding</Button>
          </div>
        </form>
      </Card>

      <div className="space-y-4">
        <Card title="Preview" subtitle={`How the accent looks in the current ${dark ? 'dark' : 'light'} theme.`}>
          {pal ? (
            <div style={previewVars} className="space-y-3">
              {!passes && <p className="text-[12.5px] text-ink-2">Showing the suggested shade <span className="font-mono">{shown}</span>, because {effective} can't be used.</p>}
              <div className="flex items-center gap-2"><LogoTile name={name || b.displayName} logoUrl={b.logo?.url} /><span className="truncate text-[13px] font-semibold">{name || b.displayName}</span></div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex h-9 items-center rounded-lg bg-accent px-3.5 text-sm font-medium text-on-accent">Primary action</span>
                <Badge tone="info">Info badge</Badge><Badge tone="accent">Accent badge</Badge>
              </div>
              <div className="rounded-lg bg-accent-soft px-2 py-1.5 text-[13.5px] font-medium text-accent-ink">Selected navigation item</div>
            </div>
          ) : <p className="text-[13px] text-ink-3">Choose an accessible colour to see a preview.</p>}
        </Card>

        <Card title="Logo" subtitle="PNG, SVG or JPEG, up to 200 KB.">
          <div className="flex items-center gap-3">
            <LogoTile name={b.displayName} logoUrl={b.logo?.url} size={56} alt={b.logo ? 'Current logo' : `${b.displayName} initials`} />
            <div className="min-w-0 text-[13px] text-ink-2">{b.logo ? `Current logo (${b.logo.mime === 'image/svg+xml' ? 'SVG' : b.logo.mime === 'image/png' ? 'PNG' : 'JPEG'})` : 'No logo yet: initials on the accent colour are shown.'}</div>
          </div>
          <input ref={fileRef} type="file" accept=".png,.svg,.jpg,.jpeg,image/png,image/svg+xml,image/jpeg" className="sr-only" aria-label="Logo file" tabIndex={-1}
            onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />
          <div className="mt-3 flex flex-wrap gap-2">
            <Button type="button" icon={<ImageUp className="size-4" aria-hidden />} loading={upload.isPending} onClick={() => fileRef.current?.click()}>{b.logo ? 'Replace logo' : 'Upload logo'}</Button>
            {b.logo && <Button type="button" variant="ghost" icon={<Trash2 className="size-4" aria-hidden />} onClick={() => setConfirmRemove(true)}>Remove</Button>}
          </div>
          {logoError && <p className="mt-2 text-[12.5px] text-critical-ink" role="alert">{logoError}</p>}
          <p className="mt-3 text-[12px] leading-relaxed text-ink-3">The logo is stored privately and only shown to people signed in to this organization, including clients in the portal.
            SVGs containing scripts, event handlers, embedded content or external links are rejected. PDFs embed PNG and JPEG logos; with an SVG logo, PDFs show the name only.</p>
        </Card>
      </div>

      <Modal open={confirmRemove} onClose={() => setConfirmRemove(false)} title="Remove the logo?"
        footer={<><Button onClick={() => setConfirmRemove(false)}>Cancel</Button><Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>Remove logo</Button></>}>
        <p className="text-sm text-ink-2">Initials on the accent colour will be shown instead. You can upload a new logo at any time.</p>
      </Modal>
    </div>
  );
}
