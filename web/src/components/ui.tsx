import { createContext, forwardRef, useCallback, useContext, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes,
  type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, CheckCircle2, CircleHelp, Info, Loader2, Lock, X, XCircle, MinusCircle } from 'lucide-react';
import { ASSESSMENT, STATUS_LABEL, initials } from '../lib/format';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

// ---------- Buttons ----------
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-on-accent hover:brightness-110 shadow-sm',
  secondary: 'bg-surface text-ink ring-1 ring-inset ring-line-strong hover:bg-surface-2',
  ghost: 'text-ink-2 hover:bg-surface-2 hover:text-ink',
  subtle: 'bg-surface-2 text-ink hover:bg-surface-3',
  danger: 'bg-critical text-white hover:brightness-110',
};
export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; loading?: boolean; icon?: ReactNode }>(
  ({ variant = 'secondary', size = 'md', loading, icon, className, children, disabled, ...rest }, ref) => (
    <button ref={ref} disabled={disabled || loading}
      className={cx('inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-[filter,background-color] disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap',
        size === 'sm' ? 'h-7 px-2.5 text-[13px]' : 'h-9 px-3.5 text-sm', VARIANTS[variant], className)} {...rest}>
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  ));
export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: string }>(({ label, className, children, ...rest }, ref) => (
  <button ref={ref} aria-label={label} title={label} className={cx('inline-flex size-8 items-center justify-center rounded-lg text-ink-2 hover:bg-surface-2 hover:text-ink', className)} {...rest}>{children}</button>
));

// ---------- Form controls ----------
const control = 'rounded-lg bg-surface text-ink ring-1 ring-inset ring-line-strong placeholder:text-ink-3 focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-60';
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...p }, ref) =>
  <input ref={ref} className={cx(control, 'h-9 px-3 text-sm', !/\bw-/.test(className ?? '') && 'w-full', className)} {...p} />);
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...p }, ref) =>
  <textarea ref={ref} className={cx(control, 'w-full px-3 py-2 text-sm leading-relaxed', className)} {...p} />);
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(({ className, children, ...p }, ref) =>
  <select ref={ref} className={cx(control, 'h-9 pl-2.5 pr-8 text-sm', !/\bw-/.test(className ?? '') && 'w-full', className)} {...p}>{children}</select>);

export function Field({ label, hint, error, children, className }: { label: string; hint?: ReactNode; error?: string | null; children: (id: string) => ReactNode; className?: string }) {
  const id = useId();
  return (
    <div className={cx('space-y-1.5', className)}>
      <label htmlFor={id} className="block text-[13px] font-medium text-ink-2">{label}</label>
      {children(id)}
      {error ? <p className="text-[12px] text-critical-ink" role="alert">{error}</p> : hint ? <p className="text-[12px] text-ink-3">{hint}</p> : null}
    </div>
  );
}
export function Checkbox({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; disabled?: boolean }) {
  return (
    <label className={cx('inline-flex items-center gap-2 text-sm', disabled ? 'opacity-60' : 'cursor-pointer')}>
      <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

// ---------- Surfaces ----------
export function Card({ title, actions, children, className, padded = true, subtitle }: { title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; padded?: boolean }) {
  return (
    <section className={cx('rounded-xl bg-surface ring-1 ring-line shadow-card', className)}>
      {(title || actions) && (
        <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0">
            {title && <h2 className="text-[15px] font-semibold text-ink">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-[13px] text-ink-3">{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={padded ? 'p-4' : ''}>{children}</div>
    </section>
  );
}
export function PageHeader({ title, subtitle, actions, eyebrow }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        {eyebrow && <div className="mb-1 text-[12px] font-medium uppercase tracking-wide text-ink-3">{eyebrow}</div>}
        <h1 className="text-[22px] font-semibold leading-tight text-ink">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-ink-2">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

// ---------- Badges ----------
type Tone = 'good' | 'warning' | 'serious' | 'critical' | 'neutral' | 'info' | 'accent';
const TONES: Record<Tone, string> = {
  good: 'bg-good-soft text-good-ink', warning: 'bg-warning-soft text-warning-ink', serious: 'bg-serious-soft text-serious-ink',
  critical: 'bg-critical-soft text-critical-ink', neutral: 'bg-neutral-soft text-neutral-ink', info: 'bg-accent-soft text-accent-ink', accent: 'bg-accent text-on-accent',
};
export function Badge({ tone = 'neutral', children, icon, className }: { tone?: Tone; children: ReactNode; icon?: ReactNode; className?: string }) {
  return <span className={cx('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] font-medium leading-4 whitespace-nowrap', TONES[tone], className)}>{icon}{children}</span>;
}
const STATUS_TONE: Record<string, Tone> = { backlog: 'neutral', planned: 'neutral', in_progress: 'info', blocked: 'critical', in_review: 'warning', done: 'good', cancelled: 'neutral' };
const STATUS_DOT: Record<string, string> = { backlog: 'border-ink-3 border-dashed', planned: 'border-ink-3', in_progress: 'border-accent bg-[conic-gradient(var(--accent)_50%,transparent_0)]',
  blocked: 'border-critical bg-critical', in_review: 'border-warning bg-[conic-gradient(var(--warning)_75%,transparent_0)]', done: 'border-good bg-good', cancelled: 'border-ink-3 bg-ink-3' };
export function StatusDot({ status }: { status: string }) {
  return <span aria-hidden className={cx('inline-block size-3 shrink-0 rounded-full border-2', STATUS_DOT[status])} />;
}
export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={STATUS_TONE[status]} icon={<StatusDot status={status} />}>{STATUS_LABEL[status] ?? status}</Badge>;
}
export function AssessmentBadge({ label, size = 'sm' }: { label: string; size?: 'sm' | 'lg' }) {
  const a = ASSESSMENT[label] ?? { label, tone: 'neutral' };
  const Icon = label === 'on_track' ? CheckCircle2 : label === 'needs_attention' ? AlertTriangle : label === 'not_applicable' ? MinusCircle : CircleHelp;
  return <Badge tone={a.tone as Tone} className={size === 'lg' ? 'px-2.5 py-1 text-[13px]' : ''} icon={<Icon className={size === 'lg' ? 'size-4' : 'size-3.5'} aria-hidden />}>{a.label}</Badge>;
}
export function Avatar({ name, size = 24 }: { name: string; size?: number }) {
  const hue = [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 0);
  return <span aria-hidden className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white"
    style={{ width: size, height: size, fontSize: size * 0.4, background: `oklch(0.46 0.11 ${hue})` }}>{initials(name)}</span>;
}
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-line-strong bg-surface-2 px-1 py-px font-sans text-[11px] text-ink-2">{children}</kbd>;
}

// ---------- States ----------
export function Spinner({ label = 'Loading' }: { label?: string }) {
  return <div className="flex items-center gap-2 p-6 text-sm text-ink-3" role="status"><Loader2 className="size-4 animate-spin" aria-hidden />{label}…</div>;
}
export function Skeleton({ className }: { className?: string }) { return <div className={cx('animate-pulse rounded-md bg-surface-2', className)} />; }
export function Empty({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-10 text-center">
      {icon && <div className="mb-3 text-ink-3">{icon}</div>}
      <p className="text-sm font-medium text-ink">{title}</p>
      {children && <div className="mt-1 max-w-sm text-[13px] text-ink-3">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
/** The signed-in account may not see this. Not an error: there is nothing to retry. */
export function NoAccess({ title = 'Not available for your account', children }: { title?: string; children?: ReactNode }) {
  return <div className="rounded-xl bg-surface ring-1 ring-line"><Empty icon={<Lock className="size-6" aria-hidden />} title={title}>{children}</Empty></div>;
}
/** Retry can only help when the server or the connection failed (status 0 or 5xx), never for a refusal or a bad link. */
const retryable = (error: any) => !error?.status || error.status >= 500;
export function ErrorState({ error, onRetry }: { error: any; onRetry?: () => void }) {
  if (error?.status === 403) return <NoAccess>{error.message}</NoAccess>;
  return (
    <div role="alert" className="flex items-start gap-3 rounded-xl bg-critical-soft p-4 text-sm text-critical-ink">
      <XCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="flex-1"><p className="font-medium">Couldn't load this</p><p className="mt-0.5 opacity-90">{error?.message ?? String(error)}</p></div>
      {onRetry && retryable(error) && <Button size="sm" onClick={onRetry}>Retry</Button>}
    </div>
  );
}
/** A page whose main data failed to load keeps its title (one h1 per page), then shows no-access or the error. */
export function PageError({ title, error, onRetry }: { title: ReactNode; error: any; onRetry?: () => void }) {
  return <div><PageHeader title={title} /><ErrorState error={error} onRetry={onRetry} /></div>;
}
/** Move focus to the page's h1 when an in-page view opens (e.g. ?t=… or ?update=…), as drawers and dialogs already do. */
export function useFocusHeading(key: unknown, ready: boolean) {
  useEffect(() => {
    if (!ready) return;
    const h = document.querySelector<HTMLElement>('main h1');
    if (!h) return;
    h.tabIndex = -1; h.classList.add('outline-none'); h.focus();
  }, [key, ready]);
}
export function Callout({ tone = 'info', children, icon }: { tone?: 'info' | 'warning' | 'good' | 'critical' | 'neutral'; children: ReactNode; icon?: ReactNode }) {
  const I = tone === 'warning' ? AlertTriangle : tone === 'good' ? CheckCircle2 : tone === 'critical' ? XCircle : Info;
  return <div className={cx('flex items-start gap-2.5 rounded-lg px-3 py-2.5 text-[13px] leading-relaxed', TONES[tone])}>{icon ?? <I className="mt-0.5 size-4 shrink-0" aria-hidden />}<div className="min-w-0 flex-1">{children}</div></div>;
}

// ---------- Overlays ----------
export function useEscape(onClose: () => void, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose, active]);
}
function useFocusTrap(ref: React.RefObject<HTMLElement | null>, open: boolean) {
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>('[data-autofocus]') ?? el?.querySelector<HTMLElement>('input:not([type=hidden]), textarea, select') ?? el?.querySelector<HTMLElement>('button');
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !el) return;
      const f = [...el.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), textarea, select, [tabindex]:not([tabindex="-1"])')];
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    };
    el?.addEventListener('keydown', onKey);
    return () => { el?.removeEventListener('keydown', onKey); prev?.focus?.(); };
  }, [open]);
}
export function Modal({ open, onClose, title, children, footer, width = 'max-w-lg' }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; width?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEscape(onClose, open); useFocusTrap(ref, open);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-start sm:p-4 sm:pt-[10vh]" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined}
        className={cx('flex max-h-[90vh] w-full flex-col rounded-t-2xl bg-surface shadow-2xl ring-1 ring-line sm:rounded-2xl', width)}>
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          <IconButton label="Close" onClick={onClose}><X className="size-4" /></IconButton>
        </div>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>, document.body);
}
/** `label` names the dialog for assistive tech when `title` is not a plain name (e.g. a link); otherwise the title names it. */
export function Drawer({ open, onClose, title, label, children, width = 'max-w-2xl' }: { open: boolean; onClose: () => void; title: ReactNode; label?: string; children: ReactNode; width?: string }) {
  const ref = useRef<HTMLDivElement>(null); const titleId = useId();
  useEscape(onClose, open); useFocusTrap(ref, open);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={label} aria-labelledby={label ? undefined : titleId} className={cx('flex h-full w-full flex-col bg-surface shadow-2xl ring-1 ring-line', width)}>
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <div id={titleId} className="min-w-0 text-[13px] text-ink-3">{title}</div>
          <IconButton label="Close" onClick={onClose}><X className="size-4" /></IconButton>
        </div>
        <div className="flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>, document.body);
}

// ---------- Tabs / segmented ----------
export function Segmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode }[]; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg bg-surface-2 p-0.5 ring-1 ring-inset ring-line">
      {options.map((o) => (
        <button key={o.value} role="radio" aria-checked={value === o.value} onClick={() => onChange(o.value)}
          className={cx('rounded-md px-2.5 py-1 text-[13px] font-medium', value === o.value ? 'bg-surface text-ink shadow-sm ring-1 ring-line' : 'text-ink-2 hover:text-ink')}>{o.label}</button>
      ))}
    </div>
  );
}

// ---------- Toasts ----------
type ToastT = { id: number; tone: 'good' | 'critical' | 'info'; text: string; action?: { label: string; run: () => void } };
const ToastCtx = createContext<(t: Omit<ToastT, 'id'>) => void>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastT[]>([]);
  const push = useCallback((t: Omit<ToastT, 'id'>) => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x.slice(-3), { ...t, id }]);
    setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), t.tone === 'critical' ? 7000 : 4000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed bottom-24 left-1/2 z-[60] flex w-[min(92vw,420px)] -translate-x-1/2 flex-col gap-2 lg:bottom-6">
        {items.map((t) => (
          <div key={t.id} className={cx('pointer-events-auto flex items-center gap-3 rounded-xl px-4 py-3 text-sm shadow-xl ring-1',
            t.tone === 'critical' ? 'bg-critical-soft text-critical-ink ring-critical/30' : 'bg-ink text-bg ring-black/10')}>
            {t.tone === 'good' ? <CheckCircle2 className="size-4 shrink-0" /> : t.tone === 'critical' ? <XCircle className="size-4 shrink-0" /> : <Info className="size-4 shrink-0" />}
            <span className="flex-1">{t.text}</span>
            {t.action && <button className="font-semibold underline" onClick={t.action.run}>{t.action.label}</button>}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

// ---------- Stat tile ----------
export function Stat({ label, value, sub, delta, tone, hint }: { label: string; value: ReactNode; sub?: ReactNode; delta?: { text: string; good?: boolean | null }; tone?: Tone; hint?: string }) {
  return (
    <div className="rounded-xl bg-surface p-3.5 ring-1 ring-line" title={hint}>
      <div className="flex items-center gap-1 text-[12px] font-medium text-ink-3">{label}{hint && <CircleHelp className="size-3" aria-label={hint} />}</div>
      <div className={cx('mt-1 text-[22px] font-semibold leading-tight', tone === 'critical' && 'text-critical-ink', tone === 'warning' && 'text-warning-ink')}>{value}</div>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12px] text-ink-3">
        {sub}
        {delta && <span className={cx('font-medium', delta.good === true ? 'text-good-ink' : delta.good === false ? 'text-critical-ink' : 'text-ink-2')}>{delta.text}</span>}
      </div>
    </div>
  );
}
