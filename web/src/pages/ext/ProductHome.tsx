import { useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { Badge, Card, PageError, PageHeader, Skeleton } from '../../components/ui';

/** Product home (placeholder): the full product page (KPIs, activity, work) is built by the product home feature. */
export default function ProductHome() {
  const { id } = useParams();
  const q = useQuery<any>({ queryKey: ['product', id], queryFn: () => api.get(`/api/products/${id}`) });
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.error) return <PageError title="Product" error={q.error} onRetry={() => q.refetch()} />;
  const p = q.data.product;
  return (
    <div>
      <PageHeader title={p.name} subtitle={p.tagline} eyebrow={<span className="flex items-center gap-2">{p.company_name ?? 'Unassigned company'}
        {p.company_id && !p.company_confirmed && <Badge tone="warning">Provisional</Badge>}</span>} />
      <Card title="About"><p className="text-sm leading-relaxed text-ink-2">{p.description || 'No description yet.'}</p></Card>
    </div>
  );
}
