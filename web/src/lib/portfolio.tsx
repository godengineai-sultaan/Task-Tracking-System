import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, onProductFocusRejected, setApiProductFocus } from './api';
import { useMe } from './session';

export interface Company { id: string; code: string; name: string; legal_name: string | null; cin: string | null; gstin: string | null; registered_address: string | null; website: string | null; version: number }
export interface Product {
  id: string; key: string; number: number | null; name: string; tagline: string; layer: string; revenue_engine: string; description: string;
  company_id: string | null; company_code: string | null; company_name: string | null; company_confirmed: boolean; website_url: string | null;
  visibility: 'members' | 'company'; status: 'active' | 'paused' | 'archived'; version: number; my_role: 'lead' | 'member' | 'viewer' | null;
  leads: { id: string; name: string }[]; member_count: number; open_tasks: number; overdue_tasks: number; blocked_tasks: number;
}
export interface Portfolio { tenantHasProducts: boolean; scope: 'all' | 'members'; canManage: boolean; companies: Company[]; products: Product[] }

/**
 * Routes whose lists follow the product focus (their API endpoints are in the server's FOCUS_PATHS).
 * Personal pages (My Day, recap, my analytics, calendar...) and single records are never filtered.
 */
export const FOCUS_ROUTES = ['/tasks', '/projects', '/recurring', '/templates', '/automations', '/objectives', '/leadership', '/insights', '/capacity',
  '/capacity/what-if', '/profitability', '/client-updates', '/integrations'];
export const isFocusRoute = (pathname: string) => FOCUS_ROUTES.includes(pathname.replace(/\/+$/, '') || '/');

interface Ctx {
  enabled: boolean; loading: boolean; portfolio: Portfolio | null; products: Product[]; companies: Company[];
  /** 'all' | 'none' | product id */
  focus: string; focusProduct: Product | null; setFocus: (focus: string) => void; product: (id: string | null | undefined) => Product | undefined;
}
const PortfolioCtx = createContext<Ctx>({ enabled: false, loading: false, portfolio: null, products: [], companies: [], focus: 'all', focusProduct: null, setFocus: () => {}, product: () => undefined });
/** Queries that do not depend on the focus keep their data when it changes. */
const FOCUS_FREE = new Set(['me', 'portfolio', 'product-prefs', 'users', 'notifications', 'branding']);

export function PortfolioProvider({ children }: { children: ReactNode }) {
  const me = useMe(); const qc = useQueryClient();
  const enabled = !!me.portfolio?.enabled && !me.user.roles.includes('customer');
  const storageKey = `tt.productFocus.${me.tenant.id}.${me.user.id}`;
  const [focus, setFocusState] = useState<string>(() => {
    let v = 'all';
    try { v = (enabled && localStorage.getItem(storageKey)) || 'all'; } catch { /* storage unavailable */ }
    setApiProductFocus(v); // before any child query runs
    return v;
  });
  const portfolio = useQuery<Portfolio>({ queryKey: ['portfolio'], queryFn: () => api.get('/api/portfolio'), enabled, staleTime: 60_000 });
  const prefs = useQuery<{ productFocus: string }>({ queryKey: ['product-prefs'], queryFn: () => api.get('/api/me/preferences'), enabled, staleTime: Infinity });

  const current = useRef(focus);
  const apply = useCallback((next: string, opts: { save?: boolean } = {}) => {
    if (current.current === next) return;
    current.current = next;
    setApiProductFocus(next);
    try { localStorage.setItem(storageKey, next); } catch { /* storage unavailable */ }
    setFocusState(next);
    // Lists refetch under the new focus; their stale data is cleared so the old scope is never shown under the new label.
    void qc.resetQueries({ predicate: (q) => !FOCUS_FREE.has(String(q.queryKey[0])) });
    if (opts.save !== false) api.put('/api/me/preferences', { productFocus: next }).then(() => qc.setQueryData(['product-prefs'], { productFocus: next })).catch(() => {});
  }, [qc, storageKey]);

  // First visit on this device: adopt the focus saved on the account.
  useEffect(() => {
    if (!prefs.data) return;
    let stored: string | null = null;
    try { stored = localStorage.getItem(storageKey); } catch { /* storage unavailable */ }
    if (stored === null && prefs.data.productFocus !== focus) apply(prefs.data.productFocus, { save: false });
  }, [prefs.data]);
  // A focus on a product that is no longer in scope falls back to all products.
  useEffect(() => {
    const p = portfolio.data;
    if (p && focus !== 'all' && focus !== 'none' && !p.products.some((x) => x.id === focus)) apply('all');
  }, [portfolio.data, focus]);
  useEffect(() => { onProductFocusRejected(() => apply('all')); return () => onProductFocusRejected(null); }, [apply]);

  const value = useMemo<Ctx>(() => {
    const products = portfolio.data?.products ?? [];
    const byId = new Map(products.map((p) => [p.id, p]));
    return {
      enabled: enabled && (portfolio.data?.tenantHasProducts ?? true), loading: portfolio.isLoading, portfolio: portfolio.data ?? null, products,
      companies: portfolio.data?.companies ?? [], focus: enabled ? focus : 'all', focusProduct: byId.get(focus) ?? null,
      setFocus: (f: string) => apply(f), product: (id) => (id ? byId.get(id) : undefined),
    };
  }, [enabled, portfolio.data, portfolio.isLoading, focus, apply]);
  return <PortfolioCtx.Provider value={value}>{children}</PortfolioCtx.Provider>;
}

export const usePortfolio = () => useContext(PortfolioCtx);

/** Products this person can file new work into: not archived, and not view-only. */
export function useWritableProducts() {
  const { products, portfolio } = usePortfolio();
  return products.filter((p) => p.status !== 'archived' && (portfolio?.scope === 'all' ? true : p.my_role ? p.my_role !== 'viewer' : p.visibility === 'company'));
}
/** Default product for a new record: the focused product when work can be filed there, else nothing chosen. */
export function useDefaultProduct() {
  const { focus } = usePortfolio(); const writable = useWritableProducts();
  return focus !== 'all' && focus !== 'none' && writable.some((p) => p.id === focus) ? focus : focus === 'none' ? 'none' : '';
}
export const scopeLabel = (focus: string, p: Product | null) => (focus === 'all' ? 'All products' : focus === 'none' ? 'Company-wide work' : p?.name ?? 'Product');

/** Group products by company for pickers ("Unassigned company" last). */
export function groupByCompany(products: Product[]) {
  const groups = new Map<string, { label: string; code: string | null; items: Product[] }>();
  for (const p of products) {
    const k = p.company_id ?? '';
    if (!groups.has(k)) groups.set(k, { label: p.company_name ?? 'Unassigned company', code: p.company_code, items: [] });
    groups.get(k)!.items.push(p);
  }
  return [...groups.entries()].sort(([a, x], [b, y]) => (a === '' ? 1 : b === '' ? -1 : x.label.localeCompare(y.label))).map(([, g]) => g);
}
