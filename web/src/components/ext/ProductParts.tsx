import { Boxes, Building2 } from 'lucide-react';
import { groupByCompany, scopeLabel, usePortfolio, useWritableProducts } from '../../lib/portfolio';
import { Badge, Select } from '../ui';

/** Product name for a record, shown only while viewing all products (under a product focus every row is that product). */
export function ProductBadge({ productId, className }: { productId: string | null | undefined; className?: string }) {
  const { enabled, focus, product } = usePortfolio();
  const p = product(productId);
  if (!enabled || focus !== 'all' || !p) return null;
  return <Badge className={className} icon={<Boxes className="size-3" aria-hidden />}>{p.name}</Badge>;
}

/** Small chip in the page header of list pages that follow the product focus, with a way back to all products. */
export function ScopeChip() {
  const { enabled, focus, focusProduct, setFocus } = usePortfolio();
  if (!enabled || focus === 'all') return null;
  const text = focus === 'none' ? 'Company-wide work' : `${scopeLabel(focus, focusProduct)} workspace`;
  return (
    <div className="mb-1.5 flex flex-wrap items-center gap-2" data-testid="scope-chip">
      <span className="inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-2.5 py-0.5 text-[12px] font-medium text-accent-ink">
        {focus === 'none' ? <Building2 className="size-3.5" aria-hidden /> : <Boxes className="size-3.5" aria-hidden />}{text}</span>
      <button type="button" className="text-[12px] font-medium text-ink-2 underline underline-offset-2 hover:text-ink" onClick={() => setFocus('all')}>Show all products</button>
    </div>
  );
}

/**
 * Product picker for forms. value: '' (nothing chosen yet), 'none' (company-wide) or a product id.
 * Lists only products this person can add work to, grouped by company.
 */
export function ProductSelect({ id, value, onChange, required, disabled, placeholder = 'Choose a product…' }:
  { id: string; value: string; onChange: (v: string) => void; required?: boolean; disabled?: boolean; placeholder?: string }) {
  const writable = useWritableProducts();
  const groups = groupByCompany(writable);
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} required={required} aria-required={required || undefined}>
      {(required || value === '') && <option value="" disabled={required}>{placeholder}</option>}
      <option value="none">Company-wide (no product)</option>
      {groups.map((g) => (
        <optgroup key={g.label} label={g.label}>
          {g.items.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </optgroup>
      ))}
    </Select>
  );
}
/** Request value for a ProductSelect choice: null for company-wide or unchosen. */
export const productParam = (v: string) => (v && v !== 'none' ? v : null);
