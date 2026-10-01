import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Boxes, Building2, Check, ChevronDown, Layers, Search } from 'lucide-react';
import { groupByCompany, scopeLabel, usePortfolio, type Product } from '../../lib/portfolio';
import { cx } from '../ui';

type Opt = { value: string; label: string; hint?: string; icon: 'all' | 'none' | 'product' };

/**
 * Header product switcher: "All products", "Company-wide work" or one product (in this person's scope), grouped by company.
 * A button opens a popover with a filter box (combobox) driving a listbox: arrows move, Enter chooses, Escape closes and returns focus.
 * The choice is remembered (account preference + this device) and sent as the product focus with every request.
 */
export function ProductSwitcher() {
  const { enabled, products, focus, focusProduct, setFocus } = usePortfolio();
  const [open, setOpen] = useState(false); const [q, setQ] = useState(''); const [active, setActive] = useState(0);
  const btn = useRef<HTMLButtonElement>(null); const panel = useRef<HTMLDivElement>(null); const input = useRef<HTMLInputElement>(null);
  const base = useId(); const listId = `${base}-list`;
  const optId = (v: string) => `${base}-opt-${v}`;

  const needle = q.trim().toLowerCase();
  const matches = (p: Product) => !needle || [p.name, p.key, p.company_code ?? '', p.company_name ?? '', p.layer].some((x) => x.toLowerCase().includes(needle));
  const top: Opt[] = [{ value: 'all', label: 'All products', icon: 'all' as const }, { value: 'none', label: 'Company-wide work', hint: 'Work not tied to a product', icon: 'none' as const }]
    .filter((o) => !needle || o.label.toLowerCase().includes(needle));
  const groups = useMemo(() => groupByCompany(products.filter(matches)), [products, needle]);
  const flat: Opt[] = [...top, ...groups.flatMap((g) => g.items.map((p) => ({ value: p.id, label: p.name, hint: p.company_code ?? undefined, icon: 'product' as const })))];

  useEffect(() => {
    if (!open) return;
    setQ(''); setActive(Math.max(0, [{ value: 'all' }, { value: 'none' }, ...groupByCompany(products).flatMap((g) => g.items.map((p) => ({ value: p.id })))].findIndex((o) => o.value === focus)));
    input.current?.focus();
    const outside = (e: PointerEvent) => { const t = e.target as Node; if (!panel.current?.contains(t) && !btn.current?.contains(t)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  useEffect(() => { setActive((i) => Math.min(i, Math.max(0, flat.length - 1))); }, [flat.length]);
  useEffect(() => { if (open && flat[active]) document.getElementById(optId(flat[active].value))?.scrollIntoView({ block: 'nearest' }); }, [active, open]);

  if (!enabled) return null;
  const close = (refocus = true) => { setOpen(false); if (refocus) btn.current?.focus(); };
  const choose = (v: string) => { setFocus(v); close(); };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(flat.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
    else if (e.key === 'End') { e.preventDefault(); setActive(flat.length - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); if (flat[active]) choose(flat[active].value); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Tab') setOpen(false);
  };
  const label = scopeLabel(focus, focusProduct);
  const option = (o: Opt) => {
    const i = flat.findIndex((x) => x.value === o.value);
    const Icon = o.icon === 'all' ? Layers : o.icon === 'none' ? Building2 : Boxes;
    return (
      <li key={o.value} id={optId(o.value)} role="option" aria-selected={o.value === focus}
        className={cx('flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13.5px]', i === active ? 'bg-accent-soft text-accent-ink' : 'text-ink')}
        onMouseDown={(e) => e.preventDefault()} onMouseMove={() => setActive(i)} onClick={() => choose(o.value)}>
        <Icon className="size-4 shrink-0 text-ink-3" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{o.label}</span>
        {o.hint && <span className="shrink-0 text-[11px] text-ink-3">{o.hint}</span>}
        {o.value === focus && <Check className="size-4 shrink-0" aria-hidden />}
      </li>
    );
  };
  return (
    <div className="relative shrink-0">
      <button ref={btn} type="button" aria-haspopup="listbox" aria-expanded={open} aria-label={`Product scope: ${label}`} title={`Product scope: ${label}`}
        onClick={() => setOpen((v) => !v)} onKeyDown={(e) => { if (e.key === 'ArrowDown' && !open) { e.preventDefault(); setOpen(true); } }}
        className={cx('flex h-9 max-w-[42vw] items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium ring-1 ring-inset sm:max-w-64',
          focus === 'all' ? 'bg-surface text-ink ring-line-strong hover:bg-surface-2' : 'bg-accent-soft text-accent-ink ring-accent/30')}>
        {focus === 'none' ? <Building2 className="size-4 shrink-0" aria-hidden /> : focus === 'all' ? <Layers className="size-4 shrink-0" aria-hidden /> : <Boxes className="size-4 shrink-0" aria-hidden />}
        <span className="truncate">{label}</span>
        {focusProduct?.company_code && <span className="hidden shrink-0 rounded bg-surface px-1 text-[11px] text-ink-2 ring-1 ring-line sm:inline">{focusProduct.company_code}</span>}
        <ChevronDown className="size-3.5 shrink-0 opacity-70" aria-hidden />
      </button>
      {open && (
        <div ref={panel} className="absolute left-0 z-40 mt-2 w-[min(92vw,360px)] rounded-xl bg-surface shadow-2xl ring-1 ring-line">
          <div className="flex items-center gap-2 border-b border-line px-3">
            <Search className="size-4 text-ink-3" aria-hidden />
            <input ref={input} role="combobox" aria-expanded="true" aria-controls={listId} aria-autocomplete="list" aria-label="Find a product"
              aria-activedescendant={flat[active] ? optId(flat[active].value) : undefined} value={q} onChange={(e) => { setQ(e.target.value); setActive(0); }} onKeyDown={onKey}
              placeholder="Find a product…" autoComplete="off" className="h-10 flex-1 bg-transparent text-[14px] outline-none" />
          </div>
          <ul id={listId} role="listbox" aria-label="Product scope" className="max-h-[60vh] overflow-y-auto p-1.5">
            {top.map(option)}
            {groups.map((g) => {
              const gid = `${base}-g-${g.code ?? 'none'}`;
              return (
                <li key={gid} role="presentation" className="mt-1">
                  <div id={gid} role="presentation" className="px-2.5 pb-0.5 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-3">{g.code ? `${g.code} · ${g.label}` : g.label}</div>
                  <ul role="group" aria-labelledby={gid}>{g.items.map((p) => option({ value: p.id, label: p.name, hint: p.company_confirmed ? undefined : p.company_code ? 'provisional' : undefined, icon: 'product' }))}</ul>
                </li>
              );
            })}
          </ul>
          {flat.length === 0 && <p className="px-3 pb-3 text-[13px] text-ink-3" role="status">No products match "{q}".</p>}
        </div>
      )}
    </div>
  );
}
