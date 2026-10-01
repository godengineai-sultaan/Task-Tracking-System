import { StrictMode, lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Navigate, Outlet, RouterProvider, useLocation } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './index.css';
import { MeProvider, useMeQuery, useRoles } from './lib/session';
import { Shell } from './components/Shell';
import { PortfolioProvider } from './lib/portfolio';
import { ErrorState, Spinner, ToastProvider } from './components/ui';
import { JoinPage, LoginPage, SignupPage } from './pages/Auth';
import { initPwa } from './pwa';

const MyDay = lazy(() => import('./pages/MyDay'));
const Tasks = lazy(() => import('./pages/Tasks'));
const TaskPage = lazy(() => import('./pages/TaskDetail'));
const Recap = lazy(() => import('./pages/Recap'));
const Analytics = lazy(() => import('./pages/Analytics'));
const Routine = lazy(() => import('./pages/Routine'));
const PersonDay = lazy(() => import('./pages/PersonDay'));
const Capacity = lazy(() => import('./pages/Capacity'));
const Leadership = lazy(() => import('./pages/Leadership'));
const Projects = lazy(() => import('./pages/Projects'));
const ProjectDetail = lazy(() => import('./pages/ProjectDetail'));
const CalendarPage = lazy(() => import('./pages/Calendar'));
const Recurring = lazy(() => import('./pages/Recurring'));
const Integrations = lazy(() => import('./pages/Integrations'));
const Admin = lazy(() => import('./pages/Admin'));
const Settings = lazy(() => import('./pages/Settings'));
const Portal = lazy(() => import('./pages/Portal'));
const Templates = lazy(() => import('./pages/ext/Templates'));
const Automations = lazy(() => import('./pages/ext/Automations'));
const TeamReview = lazy(() => import('./pages/ext/TeamReview'));
const Objectives = lazy(() => import('./pages/ext/Objectives'));
const ObjectiveDetail = lazy(() => import('./pages/ext/ObjectiveDetail'));
const WhatIf = lazy(() => import('./pages/ext/WhatIf'));
const Profitability = lazy(() => import('./pages/ext/Profitability'));
const ClientUpdates = lazy(() => import('./pages/ext/ClientUpdates'));
const Insights = lazy(() => import('./pages/ext/Insights'));
const Blockers = lazy(() => import('./pages/Blockers'));
const Portfolio = lazy(() => import('./pages/ext/Portfolio'));
const ProductHome = lazy(() => import('./pages/ext/ProductHome'));

const qc = new QueryClient({ defaultOptions: { queries: { retry: (n, e: any) => n < 2 && (!e?.status || e.status >= 500), refetchOnWindowFocus: true, staleTime: 15_000 } } });

function Authed() {
  const me = useMeQuery(); const loc = useLocation();
  if (me.isLoading) return <Spinner label="Loading your workspace" />;
  if (me.error) {
    if ((me.error as any).status === 401) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
    return <div className="p-6"><ErrorState error={me.error} onRetry={() => me.refetch()} /></div>;
  }
  return <MeProvider me={me.data!}><PortfolioProvider><Shell /></PortfolioProvider></MeProvider>;
}
const page = (el: React.ReactNode) => <Suspense fallback={<Spinner />}>{el}</Suspense>;
/** Client (customer) accounts only have the portal and their settings: every staff page sends them to the portal. */
function StaffOnly() { return useRoles().customer ? <Navigate to="/portal" replace /> : <Outlet />; }

const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  { path: '/signup', element: <SignupPage /> },
  { path: '/join/:slug/:token', element: <JoinPage /> },
  { path: '/', element: <Authed />, children: [
    { path: 'settings', element: page(<Settings />) },
    { path: 'portal', element: page(<Portal />) },
    { element: <StaffOnly />, children: [
      { index: true, element: page(<MyDay />) },
      { path: 'tasks', element: page(<Tasks />) },
      { path: 'tasks/:id', element: page(<TaskPage />) },
      { path: 'recap', element: page(<Recap />) },
      { path: 'analytics', element: page(<Analytics />) },
      { path: 'analytics/:userId', element: page(<Analytics />) },
      { path: 'admin/routine', element: page(<Routine />) },
      { path: 'admin/routine/:userId', element: page(<PersonDay />) },
      { path: 'capacity', element: page(<Capacity />) },
      { path: 'leadership', element: page(<Leadership />) },
      { path: 'projects', element: page(<Projects />) },
      { path: 'projects/:id', element: page(<ProjectDetail />) },
      { path: 'calendar', element: page(<CalendarPage />) },
      { path: 'recurring', element: page(<Recurring />) },
      { path: 'integrations', element: page(<Integrations />) },
      { path: 'admin', element: page(<Admin />) },
      { path: 'templates', element: page(<Templates />) },
      { path: 'automations', element: page(<Automations />) },
      { path: 'team-review', element: page(<TeamReview />) },
      { path: 'objectives', element: page(<Objectives />) },
      { path: 'objectives/:id', element: page(<ObjectiveDetail />) },
      { path: 'capacity/what-if', element: page(<WhatIf />) },
      { path: 'profitability', element: page(<Profitability />) },
      { path: 'client-updates', element: page(<ClientUpdates />) },
      { path: 'insights', element: page(<Insights />) },
      { path: 'blockers', element: page(<Blockers />) },
      { path: 'portfolio', element: page(<Portfolio />) },
      { path: 'products/:id', element: page(<ProductHome />) },
    ] },
    { path: '*', element: <div className="p-10 text-center text-ink-3">Page not found.</div> },
  ] },
]);

initPwa();
createRoot(document.getElementById('root')!).render(
  <StrictMode><QueryClientProvider client={qc}><ToastProvider><RouterProvider router={router} /></ToastProvider></QueryClientProvider></StrictMode>,
);
