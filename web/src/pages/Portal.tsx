import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { ArrowLeft, CheckCircle2, ChevronRight, Download, Newspaper } from 'lucide-react';
import { api } from '../lib/api';
import { fmtDate } from '../lib/format';
import { Badge, Card, Empty, ErrorState, PageHeader, Skeleton, StatusBadge } from '../components/ui';
import { ClientUpdateView, periodText, type ClientUpdate } from '../components/ext/ClientbrandUpdateView';

export default function Portal() {
  const [sp] = useSearchParams();
  const updateId = sp.get('update');
  if (updateId) return <UpdateDetail id={updateId} />;
  return <PortalHome />;
}

function PortalHome() {
  const q = useQuery({ queryKey: ['portal'], queryFn: () => api.get('/api/customer/portal') });
  // Published updates for the client's own projects (the API never returns drafts or other clients' updates).
  const updates = useQuery({ queryKey: ['portal', 'updates'], queryFn: () => api.get<ClientUpdate[]>('/api/client-updates') });
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data;
  return (
    <div>
      <PageHeader title="Your projects" subtitle="Milestones and deliverables your project team has chosen to share with you." />
      {d.projects.length === 0 ? <Card><Empty title="No shared projects yet" /></Card> : d.projects.map((p: any) => {
        const ms = d.milestones.filter((m: any) => m.project_id === p.id); const ts = d.tasks.filter((t: any) => t.project_id === p.id);
        return (
          <Card key={p.id} className="mb-4" title={`${p.name}`} subtitle={p.business_outcome} actions={p.target_date && <Badge tone="info">Target {fmtDate(p.target_date)}</Badge>}>
            <ProjectUpdates q={updates} projectId={p.id} />
            <div className="grid gap-4 md:grid-cols-2">
              <div><p className="mb-2 text-[12px] font-medium text-ink-3">Milestones</p><ul className="space-y-1.5">{ms.map((m: any) => <li key={m.id} className="flex items-center gap-2 text-[13px]">
                {m.status === 'done' ? <CheckCircle2 className="size-4 text-good-ink" aria-label="Done" /> : <span role="img" className="size-4 shrink-0 rounded-full ring-2 ring-line-strong" aria-label="Open" />}<span className="flex-1">{m.name}</span><span className="text-ink-3">{fmtDate(m.due_date)}</span></li>)}</ul></div>
              <div><p className="mb-2 text-[12px] font-medium text-ink-3">Shared deliverables</p>{ts.length === 0 ? <p className="text-[13px] text-ink-3">Nothing shared yet.</p> :
                <ul className="space-y-1.5">{ts.map((t: any) => <li key={t.id} className="flex items-center gap-2 text-[13px]"><span className="flex-1">{t.title}</span><StatusBadge status={t.status} /></li>)}</ul>}</div>
            </div>
          </Card>);
      })}
    </div>
  );
}

function ProjectUpdates({ q, projectId }: { q: UseQueryResult<ClientUpdate[]>; projectId: string }) {
  const list = (q.data ?? []).filter((u) => u.projectId === projectId);
  return (
    <div className="mb-4 rounded-lg bg-surface-2 p-3">
      <p className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium text-ink-3"><Newspaper className="size-3.5" aria-hidden />Project updates</p>
      {q.isLoading ? <Skeleton className="h-10" /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} />
        : !list.length ? <p className="text-[13px] text-ink-3">No updates published yet. Your project team's weekly updates will appear here.</p> : (
          <ul className="divide-y divide-line">{list.slice(0, 6).map((u, i) => (
            <li key={u.id}>
              <Link to={`/portal?update=${u.id}`} className="flex items-center gap-3 rounded-md px-1 py-2 hover:bg-surface-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-[13.5px] font-medium text-ink">Update for {periodText(u.periodStart, u.periodEnd)}{i === 0 && <Badge tone="info">Latest</Badge>}</div>
                  <div className="truncate text-[12.5px] text-ink-3">{u.summary.split('\n')[0]}</div>
                </div>
                <span className="hidden shrink-0 text-[12px] text-ink-3 sm:inline">{u.publishedAt ? `Published ${fmtDate(u.publishedAt)}` : ''}</span>
                <ChevronRight className="size-4 shrink-0 text-ink-3" aria-hidden />
              </Link>
            </li>
          ))}</ul>
        )}
    </div>
  );
}

function UpdateDetail({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['portal', 'update', id], queryFn: () => api.get<ClientUpdate>(`/api/client-updates/${id}`) });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Link to="/portal" className="inline-flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium text-ink-2 hover:bg-surface-2 hover:text-ink"><ArrowLeft className="size-4" aria-hidden />Your projects</Link>
        <span className="ml-auto" />
        {q.data && <a href={`/api/client-updates/${id}/pdf`} download className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-surface px-3.5 text-sm font-medium text-ink ring-1 ring-inset ring-line-strong hover:bg-surface-2">
          <Download className="size-4" aria-hidden />Download PDF</a>}
      </div>
      {q.isLoading ? <Skeleton className="h-96" /> : q.error ? ((q.error as any).status === 404
        ? <Card><Empty title="This update isn't available">It may have been withdrawn by your project team. <Link className="text-accent-ink underline" to="/portal">Back to your projects</Link></Empty></Card>
        : <ErrorState error={q.error} onRetry={() => q.refetch()} />)
        : <Card><ClientUpdateView u={q.data!} headingLevel={1} /></Card>}
    </div>
  );
}
