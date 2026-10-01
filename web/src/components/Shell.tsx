import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { Command } from 'cmdk';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, BarChart3, Briefcase, CalendarCheck2, CalendarDays, ClipboardList, Gauge, LayoutDashboard, LogOut, Menu, Moon, Plug, Plus, Search, Settings,
  ShieldCheck, Sun, Users, ListChecks, FolderKanban, Repeat, LayoutTemplate, Workflow, CalendarRange, Target, LineChart, Wallet, Send, Boxes } from 'lucide-react';
import { BrandMark } from './ext/BrandMark';
import { api } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { useMe, useRoles } from '../lib/session';
import { QuickCapture } from './QuickCapture';
import { PwaStatus } from './ext/PwaStatus';
import { clearOfflineData, confirmSignOut, usePwa } from '../pwa';
import { Avatar, IconButton, Kbd, PageScopeContext, StatusDot, cx, useEscape } from './ui';
import { ProductSwitcher } from './ext/ProductSwitcher';
import { ScopeChip } from './ext/ProductParts';
import { isFocusRoute, usePortfolio } from '../lib/portfolio';

type NavItem = { to: string; label: string; icon: ReactNode; show: boolean };
/** One name for the routine view everywhere (nav and command palette): company-wide for the main admin, team-scoped for managers. */
const routineLabel = (r: { routineAdmin: boolean }) => (r.routineAdmin ? 'Daily routine' : 'Team routine');

export function Shell() {
  const me = useMe(); const r = useRoles(); const nav = useNavigate(); const loc = useLocation(); const qc = useQueryClient(); const pf = usePortfolio();
  const [capture, setCapture] = useState(false); const [palette, setPalette] = useState(false); const [mobileNav, setMobileNav] = useState(false); const [bell, setBell] = useState(false);
  const bellRef = useRef<HTMLButtonElement>(null);
  const [theme, setTheme] = useState<string>(() => { try { return localStorage.getItem('theme') ?? ''; } catch { return ''; } });
  useEffect(() => {
    if (theme) document.documentElement.setAttribute('data-theme', theme); else document.documentElement.removeAttribute('data-theme');
    try { theme ? localStorage.setItem('theme', theme) : localStorage.removeItem('theme'); } catch { /* storage unavailable */ }
  }, [theme]);
  useEffect(() => { setMobileNav(false); }, [loc.pathname]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const typing = /input|textarea|select/i.test((e.target as HTMLElement)?.tagName) || (e.target as HTMLElement)?.isContentEditable;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((v) => !v); }
      else if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'q' && !r.customer) { e.preventDefault(); setCapture(true); }
      else if (!typing && e.key === '/' ) { e.preventDefault(); setPalette(true); }
    };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, [r.customer]);

  const items: { group: string; items: NavItem[] }[] = r.customer ? [{ group: '', items: [{ to: '/portal', label: 'Projects', icon: <Briefcase className="size-4" />, show: true }] }] : [
    { group: 'Work', items: [
      { to: '/', label: 'My Day', icon: <CalendarCheck2 className="size-4" />, show: true },
      { to: '/tasks', label: 'Tasks', icon: <ListChecks className="size-4" />, show: true },
      { to: '/projects', label: 'Projects', icon: <FolderKanban className="size-4" />, show: true },
      { to: '/recap', label: 'Daily recap', icon: <ClipboardList className="size-4" />, show: true },
      { to: '/analytics', label: 'My Analytics', icon: <BarChart3 className="size-4" />, show: true },
      { to: '/templates', label: 'Templates', icon: <LayoutTemplate className="size-4" />, show: true },
    ] },
    { group: 'Oversight', items: [
      { to: '/admin/routine', label: routineLabel(r), icon: <LayoutDashboard className="size-4" />, show: r.canReview },
      { to: '/capacity', label: 'Team capacity', icon: <Users className="size-4" />, show: r.canReview || r.leadership },
      { to: '/team-review', label: r.canReview ? 'Weekly team review' : 'My weekly reviews', icon: <CalendarRange className="size-4" />, show: true },
      { to: '/blockers', label: 'Blocker escalation', icon: <ShieldCheck className="size-4" />, show: r.canReview || r.sysAdmin },
      { to: '/insights', label: 'Insights', icon: <LineChart className="size-4" />, show: r.canReview || r.leadership },
      { to: '/leadership', label: 'Leadership', icon: <Gauge className="size-4" />, show: r.leadership || r.routineAdmin },
      { to: '/portfolio', label: 'Portfolio', icon: <Boxes className="size-4" />, show: pf.enabled && (r.leadership || r.routineAdmin || r.sysAdmin || (me.portfolio?.leadOf.length ?? 0) > 0) },
      { to: '/objectives', label: 'Objectives', icon: <Target className="size-4" />, show: true },
      { to: '/profitability', label: 'Profitability', icon: <Wallet className="size-4" />, show: r.costViewer || r.leadership || me.user.ownsProjects },
      { to: '/client-updates', label: 'Client updates', icon: <Send className="size-4" />, show: r.leadership || r.sysAdmin || me.user.ownsClientProjects },
    ] },
    { group: 'Setup', items: [
      { to: '/calendar', label: 'Calendar & leave', icon: <CalendarDays className="size-4" />, show: true },
      { to: '/recurring', label: 'Recurring work', icon: <Repeat className="size-4" />, show: true },
      { to: '/automations', label: 'Automations', icon: <Workflow className="size-4" />, show: r.sysAdmin || r.manager },
      { to: '/integrations', label: 'Integrations', icon: <Plug className="size-4" />, show: true },
      { to: '/admin', label: 'Administration', icon: <ShieldCheck className="size-4" />, show: r.sysAdmin },
    ] },
  ];
  const sidebar = (
    <nav aria-label="Main" className="flex h-full flex-col gap-4 overflow-y-auto px-3 py-4">
      <div className="flex items-center gap-2 px-2">
        <BrandMark />
        <div className="min-w-0"><div className="truncate text-[13px] font-semibold">{me.tenant.name}</div><div className="text-[11px] capitalize text-ink-3">{me.tenant.plan} plan</div></div>
      </div>
      {!r.customer && <button onClick={() => { setMobileNav(false); setCapture(true); }} className="mx-1 flex h-9 items-center gap-2 rounded-lg bg-accent px-3 text-sm font-medium text-on-accent shadow-sm hover:brightness-110">
        <Plus className="size-4" aria-hidden />Quick capture<span className="ml-auto"><Kbd>Q</Kbd></span></button>}
      {items.map((g) => {
        const vis = g.items.filter((i) => i.show);
        if (!vis.length) return null;
        return (
          <div key={g.group}>
            {g.group && <div className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-wide text-ink-3">{g.group}</div>}
            <ul className="space-y-0.5">{vis.map((i) => (
              <li key={i.to}><NavLink to={i.to} end={i.to === '/' || i.to === '/admin'} className={({ isActive }) => cx('flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13.5px]',
                isActive ? 'bg-accent-soft font-medium text-accent-ink' : 'text-ink-2 hover:bg-surface-2 hover:text-ink')}>{i.icon}{i.label}</NavLink></li>
            ))}</ul>
          </div>
        );
      })}
      <div className="mt-auto space-y-1 border-t border-line pt-3">
        <NavLink to="/settings" className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-surface-2">
          <Avatar name={me.user.name} size={26} /><div className="min-w-0"><div className="truncate text-[13px] font-medium">{me.user.name}</div><div className="truncate text-[11px] text-ink-3">{me.user.title || me.user.email}</div></div>
          <Settings className="ml-auto size-4 text-ink-3" aria-hidden />
        </NavLink>
        <button onClick={async () => { if (!confirmSignOut()) return; try { await api.post('/api/auth/logout'); } catch { window.alert('Signing out needs a connection. Nothing was deleted; try again when you are back online.'); return; } await clearOfflineData(); qc.clear(); nav('/login'); }} className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13px] text-ink-2 hover:bg-surface-2">
          <LogOut className="size-4" aria-hidden />Sign out</button>
      </div>
    </nav>
  );
  return (
    <div className="flex h-full">
      <aside className="hidden w-60 shrink-0 border-r border-line bg-surface lg:sticky lg:top-0 lg:block lg:h-screen">{sidebar}</aside>
      {mobileNav && <MobileDrawer onClose={() => setMobileNav(false)}>{sidebar}</MobileDrawer>}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-line bg-surface/90 px-3 backdrop-blur sm:px-5">
          <IconButton label="Open navigation" className="lg:hidden" onClick={() => setMobileNav(true)}><Menu className="size-5" /></IconButton>
          {!r.customer && <ProductSwitcher />}
          <button onClick={() => setPalette(true)} className="flex h-9 max-w-md flex-1 items-center gap-2 rounded-lg bg-surface-2 px-3 text-left text-sm text-ink-3 ring-1 ring-inset ring-line hover:ring-line-strong">
            <Search className="size-4" aria-hidden /><span className="flex-1 truncate">Search tasks, projects, actions…</span><span className="hidden sm:inline"><Kbd>⌘K</Kbd></span>
          </button>
          <div className="ml-auto flex items-center gap-1">
            <IconButton label={`Theme: ${theme || 'system'}`} onClick={() => setTheme(theme === '' ? 'dark' : theme === 'dark' ? 'light' : '')}>
              {theme === 'dark' ? <Moon className="size-4" /> : theme === 'light' ? <Sun className="size-4" /> : <span className="text-[11px] font-semibold">A</span>}</IconButton>
            <div className="relative">
              <IconButton ref={bellRef} label={`Notifications${me.unreadNotifications ? ` (${me.unreadNotifications} unread)` : ''}`} aria-haspopup="dialog" aria-expanded={bell} onClick={() => setBell((v) => !v)}>
                <Bell className="size-4" />{me.unreadNotifications > 0 && <span className="absolute right-1 top-1 size-2 rounded-full bg-critical" />}</IconButton>
              {bell && <Notifications anchor={bellRef} onClose={(refocus) => { setBell(false); if (refocus) bellRef.current?.focus(); }} />}
            </div>
          </div>
        </header>
        <PwaStatus />
        <main id="main" className={cx('mx-auto w-full max-w-[1400px] flex-1 px-4 py-5 sm:px-6 lg:pb-8', r.customer ? 'pb-8' : 'pb-[calc(6rem+env(safe-area-inset-bottom))]')}>
          <PageScopeContext.Provider value={isFocusRoute(loc.pathname) ? <ScopeChip /> : null}><Outlet /></PageScopeContext.Provider></main>
      </div>
      {!r.customer && <BottomNav onCapture={() => setCapture(true)} onMore={() => setMobileNav(true)} moreOpen={mobileNav} />}
      <QuickCapture open={capture} onClose={() => setCapture(false)} defaults={{ addToMyDay: loc.pathname === '/' }} />
      <CommandPalette open={palette} onClose={() => setPalette(false)} onCapture={() => { setPalette(false); setCapture(true); }} />
    </div>
  );
}

/** Phone/tablet navigation (< 1024px): the four daily destinations plus capture, above the home indicator. */
function BottomNav({ onCapture, onMore, moreOpen }: { onCapture: () => void; onMore: () => void; moreOpen: boolean }) {
  const waiting = usePwa().items.length;
  const tab = 'flex h-full flex-col items-center justify-center gap-0.5 rounded-lg text-[11px] font-medium focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent';
  const link = (to: string, label: string, icon: ReactNode) => (
    <li><NavLink to={to} end={to === '/'} className={({ isActive }) => cx(tab, isActive ? 'text-accent-ink' : 'text-ink-3 hover:text-ink')}>
      {({ isActive }) => <><span className={cx('flex h-7 w-12 items-center justify-center rounded-full', isActive && 'bg-accent-soft')}>{icon}</span>{label}</>}</NavLink></li>
  );
  return (
    <nav aria-label="Mobile" className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden">
      <ul className="mx-auto grid h-16 max-w-lg grid-cols-5 px-1 py-1">
        {link('/', 'My Day', <CalendarCheck2 className="size-5" aria-hidden />)}
        {link('/tasks', 'Tasks', <ListChecks className="size-5" aria-hidden />)}
        <li><button type="button" aria-label="Quick capture" onClick={onCapture} className={cx(tab, 'w-full text-ink-2')}>
          <span className="relative flex size-9 items-center justify-center rounded-full bg-accent text-on-accent shadow-md"><Plus className="size-5" aria-hidden />
            {waiting > 0 && <span aria-hidden className="absolute -right-1.5 -top-1 min-w-4 rounded-full bg-surface px-1 text-center text-[10px] font-semibold leading-4 text-accent-ink ring-1 ring-accent">{waiting}</span>}</span>
          Capture</button></li>
        {link('/recap', 'Recap', <ClipboardList className="size-5" aria-hidden />)}
        <li><button type="button" onClick={onMore} aria-haspopup="dialog" aria-expanded={moreOpen} className={cx(tab, 'w-full text-ink-3 hover:text-ink')}>
          <span className="flex h-7 w-12 items-center justify-center"><Menu className="size-5" aria-hidden /></span>More</button></li>
      </ul>
    </nav>
  );
}

/** The full navigation as a modal panel on phones and tablets (from More or the menu button): focus moves in, stays in, Escape closes, focus returns. */
function MobileDrawer({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    (ref.current?.querySelector<HTMLElement>('a[aria-current="page"]') ?? ref.current?.querySelector<HTMLElement>('a, button'))?.focus();
    const h = (e: KeyboardEvent) => {
      if (document.querySelectorAll('[aria-modal="true"]').length > 1) return; // a dialog opened on top (e.g. quick capture) handles its own keys
      if (e.key === 'Escape') { onClose(); return; }
      const f = ref.current ? [...ref.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')] : [];
      if (e.key !== 'Tab' || !f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    };
    window.addEventListener('keydown', h);
    return () => { window.removeEventListener('keydown', h); if (prev?.isConnected) prev.focus(); };
  }, []);
  return (
    <div className="fixed inset-0 z-40 bg-black/30 lg:hidden" onClick={onClose}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label="Navigation" className="h-full w-72 max-w-[85vw] bg-surface pb-[env(safe-area-inset-bottom)] shadow-2xl" onClick={(e) => e.stopPropagation()}>{children}</div>
    </div>
  );
}

/** Notifications popover: a non-modal dialog. Focus moves to its heading on open; Escape closes it and returns focus to the bell.
 *  A press anywhere outside also closes it without swallowing that press (no invisible backdrop over the page). */
function Notifications({ onClose, anchor }: { onClose: (refocus: boolean) => void; anchor: React.RefObject<HTMLElement | null> }) {
  const qc = useQueryClient(); const nav = useNavigate();
  const q = useQuery({ queryKey: ['notifications'], queryFn: () => api.get('/api/notifications') });
  const heading = useRef<HTMLHeadingElement>(null); const panel = useRef<HTMLDivElement>(null);
  useEffect(() => { api.post('/api/notifications/read', {}).then(() => qc.invalidateQueries({ queryKey: ['me'] })); }, []);
  useEffect(() => {
    heading.current?.focus();
    const outside = (e: PointerEvent) => { const t = e.target as Node; if (!panel.current?.contains(t) && !anchor.current?.contains(t)) onClose(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, []);
  useEscape(() => onClose(true), true);
  return (
    <>
      <div ref={panel} role="dialog" aria-labelledby="notifications-title" className="absolute right-0 z-40 mt-2 w-[min(92vw,380px)] rounded-xl bg-surface shadow-2xl ring-1 ring-line">
        <h2 id="notifications-title" ref={heading} tabIndex={-1} className="border-b border-line px-4 py-2.5 text-sm font-semibold outline-none">Notifications</h2>
        <ul className="max-h-[60vh] overflow-y-auto">
          {(q.data ?? []).length === 0 && <li className="px-4 py-6 text-center text-[13px] text-ink-3">You're all caught up.</li>}
          {(q.data ?? []).map((n: any) => (
            <li key={n.id}><button onClick={() => { onClose(false); if (n.link) nav(n.link); }} className="w-full px-4 py-2.5 text-left hover:bg-surface-2">
              <div className="flex items-center gap-2 text-[13px] font-medium">{!n.read_at && <span className="size-1.5 rounded-full bg-accent" />}{n.title}</div>
              {n.body && <div className="mt-0.5 line-clamp-2 text-[12px] text-ink-3">{n.body}</div>}
              <div className="mt-0.5 text-[11px] text-ink-3">{fmtDateTime(n.created_at)}</div>
            </button></li>
          ))}
        </ul>
      </div>
    </>
  );
}

function CommandPalette({ open, onClose, onCapture }: { open: boolean; onClose: () => void; onCapture: () => void }) {
  const nav = useNavigate(); const r = useRoles();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => { const t = setTimeout(() => setDebounced(q), 120); return () => clearTimeout(t); }, [q]);
  useEffect(() => { if (open) setQ(''); }, [open]);
  const search = useQuery({ queryKey: ['search', debounced], queryFn: () => api.get(`/api/search?q=${encodeURIComponent(debounced)}`), enabled: open && debounced.trim().length > 1 });
  if (!open) return null;
  const go = (to: string) => { onClose(); nav(to); };
  const actions = [
    { label: 'Quick capture a task', hint: 'Q', run: onCapture, show: !r.customer },
    { label: 'Go to My Day', run: () => go('/'), show: !r.customer },
    { label: 'Open task board', run: () => go('/tasks?view=board'), show: !r.customer },
    { label: 'Write today\'s recap', run: () => go('/recap'), show: !r.customer },
    { label: 'My weekly report', run: () => go('/analytics?kind=week'), show: !r.customer },
    { label: routineLabel(r), run: () => go('/admin/routine'), show: r.canReview },
    { label: 'Team capacity', run: () => go('/capacity'), show: r.canReview || r.leadership },
    { label: 'What-if planner', run: () => go('/capacity/what-if'), show: !r.customer },
    { label: 'Leadership delivery', run: () => go('/leadership'), show: r.leadership || r.routineAdmin },
    { label: 'Record leave', run: () => go('/calendar'), show: !r.customer },
  ].filter((a) => a.show);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[12vh]" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <Command label="Command menu" shouldFilter={false} className="w-full max-w-xl overflow-hidden rounded-2xl bg-surface shadow-2xl ring-1 ring-line"
        onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
        <div className="flex items-center gap-2 border-b border-line px-4"><Search className="size-4 text-ink-3" aria-hidden />
          <Command.Input autoFocus value={q} onValueChange={setQ} placeholder="Search or run an action…" className="h-12 flex-1 bg-transparent text-[15px] outline-none" /></div>
        <Command.List className="max-h-[50vh] overflow-y-auto p-2">
          <Command.Empty className="px-3 py-6 text-center text-[13px] text-ink-3">{search.isFetching ? 'Searching…' : 'No results.'}</Command.Empty>
          <Command.Group heading="Actions" className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:text-ink-3">
            {actions.filter((a) => !q || a.label.toLowerCase().includes(q.toLowerCase())).map((a) => (
              <Command.Item key={a.label} onSelect={a.run} className="flex cursor-pointer items-center rounded-lg px-3 py-2 text-[13.5px] data-[selected=true]:bg-accent-soft data-[selected=true]:text-accent-ink">
                {a.label}{a.hint && <span className="ml-auto"><Kbd>{a.hint}</Kbd></span>}</Command.Item>
            ))}
          </Command.Group>
          {(search.data?.tasks?.length ?? 0) > 0 && <Command.Group heading="Tasks" className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:text-ink-3">
            {search.data.tasks.map((t: any) => (
              <Command.Item key={t.id} value={t.id} onSelect={() => go(`/tasks/${t.id}`)} className="flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-[13.5px] data-[selected=true]:bg-accent-soft">
                <StatusDot status={t.status} /><span className="truncate">{t.title}</span><span className="ml-auto text-[12px] text-ink-3">{t.project_key ?? ''} #{t.number}</span></Command.Item>
            ))}</Command.Group>}
          {(search.data?.projects?.length ?? 0) > 0 && <Command.Group heading="Projects" className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:text-ink-3">
            {search.data.projects.map((p: any) => (
              <Command.Item key={p.id} value={p.id} onSelect={() => go(`/projects/${p.id}`)} className="cursor-pointer rounded-lg px-3 py-2 text-[13.5px] data-[selected=true]:bg-accent-soft">{p.key} · {p.name}</Command.Item>
            ))}</Command.Group>}
        </Command.List>
      </Command>
    </div>
  );
}
