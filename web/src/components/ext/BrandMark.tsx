import { Building2 } from 'lucide-react';

/** Sidebar brand mark. Owned by the 'clientbrand' feature area (tenant logo / accent). */
export function BrandMark() {
  return <div className="flex size-8 items-center justify-center rounded-lg bg-accent text-on-accent"><Building2 className="size-4" aria-hidden /></div>;
}
