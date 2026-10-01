import type { ReactNode } from 'react';
import { Handshake, Landmark, LayoutTemplate, Rocket, Settings2, ShoppingCart, UserPlus, Users } from 'lucide-react';
import { cx } from '../ui';

export const TEMPLATE_CATEGORIES: { value: string; label: string; icon: (c: string) => ReactNode }[] = [
  { value: 'people', label: 'People', icon: (c) => <UserPlus className={c} aria-hidden /> },
  { value: 'finance', label: 'Finance', icon: (c) => <Landmark className={c} aria-hidden /> },
  { value: 'procurement', label: 'Procurement', icon: (c) => <ShoppingCart className={c} aria-hidden /> },
  { value: 'client', label: 'Client delivery', icon: (c) => <Handshake className={c} aria-hidden /> },
  { value: 'team', label: 'Team rituals', icon: (c) => <Users className={c} aria-hidden /> },
  { value: 'product', label: 'Product', icon: (c) => <Rocket className={c} aria-hidden /> },
  { value: 'operations', label: 'Operations', icon: (c) => <Settings2 className={c} aria-hidden /> },
  { value: 'other', label: 'Other', icon: (c) => <LayoutTemplate className={c} aria-hidden /> },
];
export const TEMPLATE_CATEGORY_LABEL: Record<string, string> = Object.fromEntries(TEMPLATE_CATEGORIES.map((c) => [c.value, c.label]));

export function CategoryIcon({ category, size = 'md' }: { category: string; size?: 'sm' | 'md' }) {
  const c = TEMPLATE_CATEGORIES.find((x) => x.value === category) ?? TEMPLATE_CATEGORIES[TEMPLATE_CATEGORIES.length - 1];
  return (
    <span className={cx('inline-flex shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-ink', size === 'sm' ? 'size-7' : 'size-9')}>
      {c.icon(size === 'sm' ? 'size-3.5' : 'size-4')}
    </span>
  );
}

export const offsetLabel = (n: number | null | undefined) => (n === null || n === undefined ? 'No due date' : n === 0 ? 'Start day' : `Day +${n}`);
export const spanLabel = (n: number | null | undefined) =>
  n === null || n === undefined ? 'No due dates' : n === 0 ? 'Done in a day' : `Spans ${n} working day${n === 1 ? '' : 's'}`;
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Idempotency key for one apply attempt; a retry with the same key never duplicates tasks. */
export function newApplyKey() {
  try { if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID(); } catch { /* insecure context */ }
  return `apply-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
