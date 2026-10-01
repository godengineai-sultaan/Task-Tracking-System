import { createContext, useContext, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export interface Me {
  user: { id: string; name: string; email: string; title: string; roles: string[]; is_founder: boolean; mfa_enabled: boolean; managedUserIds: string[]; effectiveTimezone: string; timezone: string | null;
    /** Owns an active project (opens Profitability) / an active client project (prepares client updates). */
    ownsProjects: boolean; ownsClientProjects: boolean };
  tenant: { id: string; slug: string; name: string; timezone: string; plan: string; seat_limit: number; modules: string[]; settings: any; logo_url: string | null; onboarded_at: string | null };
  unreadNotifications: number; today: string;
  ai: { available: boolean; configured: boolean; enabledByTenant: boolean; note: string; model: string };
  /** Applied on first paint; the full branding query (/api/branding) refreshes it. */
  branding: { accent: string | null; logoUrl: string | null };
}
const Ctx = createContext<Me | null>(null);
export function useMeQuery() { return useQuery({ queryKey: ['me'], queryFn: () => api.get<Me>('/api/me'), retry: false, staleTime: 60_000 }); }
export function MeProvider({ me, children }: { me: Me; children: ReactNode }) { return <Ctx.Provider value={me}>{children}</Ctx.Provider>; }
export function useMe() { const m = useContext(Ctx); if (!m) throw new Error('No session'); return m; }
export function useRoles() {
  const me = useMe();
  const r = new Set(me.user.roles);
  return {
    customer: r.has('customer'), sysAdmin: r.has('system_admin'), routineAdmin: r.has('routine_admin'), leadership: r.has('leadership'),
    manager: me.user.managedUserIds.length > 0, costViewer: r.has('cost_viewer'),
    canReview: r.has('routine_admin') || me.user.managedUserIds.length > 0,
  };
}
