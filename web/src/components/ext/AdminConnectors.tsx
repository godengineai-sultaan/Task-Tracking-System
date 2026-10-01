import { Plug } from 'lucide-react';
import { Card, Empty } from '../ui';

/** Administration > Connectors (placeholder): product data connectors are configured here by the connectors feature. */
export default function AdminConnectors() {
  return (
    <Card title="Product data connectors" subtitle="Bring product metrics and activity evidence into each product.">
      <Empty icon={<Plug className="size-6" aria-hidden />} title="No connectors yet">Connectors for product metrics and activity are not configured in this version.</Empty>
    </Card>
  );
}
