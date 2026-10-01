import { useQuery } from '@tanstack/react-query';
import { CheckCircle2 } from 'lucide-react';
import { api } from '../lib/api';
import { fmtDate } from '../lib/format';
import { Badge, Card, Empty, ErrorState, PageHeader, Skeleton, StatusBadge } from '../components/ui';

export default function Portal() {
  const q = useQuery({ queryKey: ['portal'], queryFn: () => api.get('/api/customer/portal') });
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.error) return <ErrorState error={q.error} />;
  const d = q.data;
  return (
    <div>
      <PageHeader title="Your projects" subtitle="Milestones and deliverables your project team has chosen to share with you." />
      {d.projects.length === 0 ? <Card><Empty title="No shared projects yet" /></Card> : d.projects.map((p: any) => {
        const ms = d.milestones.filter((m: any) => m.project_id === p.id); const ts = d.tasks.filter((t: any) => t.project_id === p.id);
        return (
          <Card key={p.id} className="mb-4" title={`${p.name}`} subtitle={p.business_outcome} actions={p.target_date && <Badge tone="info">Target {fmtDate(p.target_date)}</Badge>}>
            <div className="grid gap-4 md:grid-cols-2">
              <div><p className="mb-2 text-[12px] font-medium text-ink-3">Milestones</p><ul className="space-y-1.5">{ms.map((m: any) => <li key={m.id} className="flex items-center gap-2 text-[13px]">
                {m.status === 'done' ? <CheckCircle2 className="size-4 text-good-ink" aria-label="Done" /> : <span className="size-4 rounded-full ring-2 ring-line-strong" aria-label="Open" />}<span className="flex-1">{m.name}</span><span className="text-ink-3">{fmtDate(m.due_date)}</span></li>)}</ul></div>
              <div><p className="mb-2 text-[12px] font-medium text-ink-3">Shared deliverables</p>{ts.length === 0 ? <p className="text-[13px] text-ink-3">Nothing shared yet.</p> :
                <ul className="space-y-1.5">{ts.map((t: any) => <li key={t.id} className="flex items-center gap-2 text-[13px]"><span className="flex-1">{t.title}</span><StatusBadge status={t.status} /></li>)}</ul>}</div>
            </div>
          </Card>);
      })}
    </div>
  );
}
