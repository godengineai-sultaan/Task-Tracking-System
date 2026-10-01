import { Link } from 'react-router';
import { Boxes } from 'lucide-react';
import { groupByCompany, usePortfolio } from '../../lib/portfolio';
import { Badge, Card, Empty, PageHeader, Skeleton } from '../../components/ui';

/** Portfolio (placeholder): the umbrella view across products and companies is built by the portfolio dashboard feature. */
export default function Portfolio() {
  const { enabled, loading, products } = usePortfolio();
  return (
    <div>
      <PageHeader title="Portfolio" subtitle="Products you can see, grouped by company. Records of work only: nothing here ranks people." />
      {!enabled ? <Card><Empty icon={<Boxes className="size-6" aria-hidden />} title="This organization does not track products yet">A system admin can provision the product catalog in Administration.</Empty></Card>
        : loading ? <Skeleton className="h-64" /> : (
          <div className="space-y-4">{groupByCompany(products).map((g) => (
            <Card key={g.label} title={g.code ? `${g.code} · ${g.label}` : g.label} padded={false}>
              <ul className="divide-y divide-line">{g.items.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5">
                  <Link to={`/products/${p.id}`} className="font-medium hover:underline">{p.name}</Link>
                  {!p.company_confirmed && p.company_id && <Badge tone="warning">Provisional company</Badge>}
                  <span className="ml-auto text-[12px] text-ink-3">{p.open_tasks} open · {p.overdue_tasks} overdue · {p.blocked_tasks} blocked</span>
                </li>))}</ul>
            </Card>))}</div>
        )}
    </div>
  );
}
