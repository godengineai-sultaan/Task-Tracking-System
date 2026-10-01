import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, PackagePlus, Users } from 'lucide-react';
import { api } from '../../lib/api';
import type { Company, Portfolio, Product } from '../../lib/portfolio';
import { Badge, Button, Callout, Card, Drawer, Empty, ErrorState, Field, Input, Modal, Select, Skeleton, Textarea, useToast } from '../ui';
import { useUsers } from '../TaskStatus';

/** Administration > Portfolio: companies (legal details), products (company, visibility, status, members) and catalog provisioning. */
export default function AdminPortfolio() {
  const q = useQuery<Portfolio>({ queryKey: ['portfolio'], queryFn: () => api.get('/api/portfolio') });
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (q.isLoading || !q.data) return <Skeleton className="h-96" />;
  return (
    <div className="grid gap-4">
      {q.data.products.length > 0 && <ProductsCard products={q.data.products} companies={q.data.companies} />}
      {q.data.companies.length > 0 && <CompaniesCard companies={q.data.companies} />}
      <ProvisionCard empty={q.data.products.length === 0} />
    </div>
  );
}

const useErr = () => { const t = useToast(); return (e: any) => t({ tone: 'critical', text: e.message }); };
function usePortfolioRefresh() {
  const qc = useQueryClient();
  return () => Promise.all([qc.invalidateQueries({ queryKey: ['portfolio'] }), qc.invalidateQueries({ queryKey: ['me'] })]);
}

// ---------- Provisioning ----------
const countLine = (c: Record<string, number>) => Object.entries(c).filter(([, v]) => v > 0).map(([k, v]) => `${v} ${k}`).join(', ') || 'nothing';
function ProvisionCard({ empty }: { empty: boolean }) {
  const toast = useToast(); const err = useErr(); const refresh = usePortfolioRefresh(); const qc = useQueryClient();
  const [preview, setPreview] = useState<any>(null);
  const dry = useMutation({ mutationFn: () => api.get('/api/admin/portfolio/provision'), onSuccess: setPreview, onError: err });
  const run = useMutation({
    mutationFn: () => api.post('/api/admin/portfolio/provision'),
    onSuccess: (r: any) => {
      setPreview(null); refresh(); qc.invalidateQueries({ queryKey: ['templates'] });
      toast({ tone: 'good', text: `Catalog provisioned: products ${countLine(r.products)}; playbooks ${countLine(r.templates)}.` });
    }, onError: err,
  });
  return (
    <Card title="Provision from catalog" subtitle="The LORD portfolio catalog: 2 companies and 32 products, each with KPI definitions and three playbooks. Safe to run again: existing records are updated, never duplicated.">
      {empty && <div className="mb-3"><Callout tone="info">This organization has no products yet. Preview the catalog, then apply it.</Callout></div>}
      <p className="mb-3 text-[13px] text-ink-3">Products start without a company and visible to their members only. Company legal details stay empty until you enter them; nothing is invented.</p>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => dry.mutate()} loading={dry.isPending}>Preview changes</Button>
        <Button variant="primary" icon={<PackagePlus className="size-4" />} loading={run.isPending} onClick={() => run.mutate()}>Apply catalog</Button>
      </div>
      {preview && (
        <div className="mt-4 rounded-lg bg-surface-2 p-3 text-[13px]" aria-live="polite" data-testid="provision-preview">
          <p className="font-medium">Dry run for catalog {preview.catalogVersion} (nothing was saved)</p>
          <ul className="mt-1.5 space-y-0.5 text-ink-2">
            <li>Companies: {preview.companies.created} to create, {preview.companies.existing} already present</li>
            <li>Products: {countLine(preview.products)}</li>
            <li>KPI definitions: {countLine(preview.kpis)}</li>
            <li>Playbooks: {countLine({ created: preview.templates.created, updated: preview.templates.updated, unchanged: preview.templates.unchanged, 'edited in the app (kept)': preview.templates.customized })}</li>
          </ul>
          {preview.customizedTemplates?.length > 0 && <p className="mt-1.5 text-ink-3">Kept as edited: {preview.customizedTemplates.join('; ')}</p>}
        </div>
      )}
    </Card>
  );
}

// ---------- Companies ----------
function CompaniesCard({ companies }: { companies: Company[] }) {
  const [editing, setEditing] = useState<Company | null>(null);
  return (
    <Card title="Companies" subtitle="Legal details are entered by an administrator. Empty means not supplied yet." padded={false}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-[13px]">
          <thead className="border-b border-line text-left text-[12px] text-ink-3"><tr>
            <th className="px-4 py-2 font-medium">Company</th><th className="px-3 py-2 font-medium">Legal name</th><th className="px-3 py-2 font-medium">CIN</th>
            <th className="px-3 py-2 font-medium">GSTIN</th><th className="px-3 py-2 font-medium">Website</th><th className="px-3 py-2"><span className="sr-only">Actions</span></th></tr></thead>
          <tbody className="divide-y divide-line">{companies.map((c) => (
            <tr key={c.id}>
              <td className="px-4 py-2"><span className="font-medium">{c.name}</span> <Badge>{c.code}</Badge></td>
              <td className="px-3 py-2">{c.legal_name ?? <span className="text-ink-3">Not supplied</span>}</td>
              <td className="px-3 py-2 tabular">{c.cin ?? <span className="text-ink-3">—</span>}</td>
              <td className="px-3 py-2 tabular">{c.gstin ?? <span className="text-ink-3">—</span>}</td>
              <td className="px-3 py-2">{c.website ?? <span className="text-ink-3">—</span>}</td>
              <td className="px-3 py-2 text-right"><Button size="sm" onClick={() => setEditing(c)} aria-label={`Edit ${c.name}`}>Edit</Button></td>
            </tr>))}</tbody>
        </table>
      </div>
      {editing && <CompanyModal company={editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}
function CompanyModal({ company, onClose }: { company: Company; onClose: () => void }) {
  const toast = useToast(); const err = useErr(); const refresh = usePortfolioRefresh();
  const [f, setF] = useState({ name: company.name, legalName: company.legal_name ?? '', cin: company.cin ?? '', gstin: company.gstin ?? '', registeredAddress: company.registered_address ?? '', website: company.website ?? '' });
  const save = useMutation({
    mutationFn: () => api.patch(`/api/companies/${company.id}`, { version: company.version, name: f.name, legalName: f.legalName || null, cin: f.cin || null, gstin: f.gstin || null,
      registeredAddress: f.registeredAddress || null, website: f.website || null }),
    onSuccess: () => { refresh(); toast({ tone: 'good', text: `${f.name} saved` }); onClose(); }, onError: err,
  });
  return (
    <Modal open onClose={onClose} title={`Edit ${company.name}`} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} disabled={!f.name.trim()} onClick={() => save.mutate()}>Save</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Display name">{(id) => <Input id={id} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
        <Field label="Legal name">{(id) => <Input id={id} value={f.legalName} onChange={(e) => setF({ ...f, legalName: e.target.value })} />}</Field>
        <Field label="CIN" hint="21-character corporate identity number">{(id) => <Input id={id} value={f.cin} maxLength={21} onChange={(e) => setF({ ...f, cin: e.target.value.toUpperCase() })} />}</Field>
        <Field label="GSTIN" hint="15-character GST number">{(id) => <Input id={id} value={f.gstin} maxLength={15} onChange={(e) => setF({ ...f, gstin: e.target.value.toUpperCase() })} />}</Field>
        <Field className="sm:col-span-2" label="Registered address">{(id) => <Textarea id={id} rows={2} value={f.registeredAddress} onChange={(e) => setF({ ...f, registeredAddress: e.target.value })} />}</Field>
        <Field className="sm:col-span-2" label="Website">{(id) => <Input id={id} type="url" value={f.website} placeholder="https://" onChange={(e) => setF({ ...f, website: e.target.value })} />}</Field>
      </div>
    </Modal>
  );
}

// ---------- Products ----------
function ProductsCard({ products, companies }: { products: Product[]; companies: Company[] }) {
  const toast = useToast(); const err = useErr(); const refresh = usePortfolioRefresh();
  const [q, setQ] = useState(''); const [open, setOpen] = useState<string | null>(null);
  const shown = useMemo(() => products.filter((p) => !q.trim() || `${p.name} ${p.key} ${p.layer} ${p.company_code ?? ''}`.toLowerCase().includes(q.trim().toLowerCase())), [products, q]);
  const patch = useMutation({
    mutationFn: ({ p, body }: { p: Product; body: Record<string, unknown> }) => api.patch(`/api/products/${p.id}`, { version: p.version, ...body }),
    onSuccess: async (_r, { p, body }) => {
      await refresh(); // keep the row disabled until the new version is loaded
      toast({ tone: 'good', text: 'companyConfirmed' in body ? `${p.name}: company confirmed` : 'companyId' in body ? `${p.name}: company set (provisional until confirmed)` : `${p.name} updated` });
    }, onError: err,
  });
  const provisional = products.filter((p) => p.company_id && !p.company_confirmed).length;
  const selected = products.find((p) => p.id === open) ?? null;
  return (
    <Card title="Products" subtitle={`${products.length} products${provisional ? ` · ${provisional} with a provisional company — please confirm` : ''}`} padded={false}
      actions={<Input aria-label="Filter products" className="h-8 w-44" placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} />}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1120px] text-[13px]">
          <thead className="border-b border-line text-left text-[12px] text-ink-3"><tr>
            <th className="w-10 px-4 py-2 font-medium">#</th><th className="px-3 py-2 font-medium">Product</th><th className="px-3 py-2 font-medium">Layer</th>
            <th className="px-3 py-2 font-medium">Company</th><th className="px-3 py-2 font-medium">Visibility</th><th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Leads</th><th className="px-3 py-2"><span className="sr-only">Actions</span></th></tr></thead>
          <tbody className="divide-y divide-line">{shown.map((p) => (
            <tr key={p.id} data-testid={`product-row-${p.key}`}>
              <td className="px-4 py-2 tabular text-ink-3">{p.number}</td>
              <td className="px-3 py-2"><div className="font-medium">{p.name}</div><div className="text-[11px] text-ink-3">{p.key}</div></td>
              <td className="px-3 py-2 text-ink-2">{p.layer}</td>
              <td className="px-3 py-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Select aria-label={`Company for ${p.name}`} className="h-8 w-60" value={p.company_id ?? ''} disabled={patch.isPending}
                    onChange={(e) => patch.mutate({ p, body: { companyId: e.target.value || null } })}>
                    <option value="">Unassigned</option>
                    {companies.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
                  </Select>
                  {p.company_id && (p.company_confirmed
                    ? <Badge tone="good" icon={<CheckCircle2 className="size-3" aria-hidden />}>Confirmed</Badge>
                    : <><Badge tone="warning">Provisional</Badge>
                      <Button size="sm" variant="subtle" disabled={patch.isPending} onClick={() => patch.mutate({ p, body: { companyConfirmed: true } })} aria-label={`Confirm company for ${p.name}`}>Confirm</Button></>)}
                </div>
              </td>
              <td className="px-3 py-2"><Select aria-label={`Visibility of ${p.name}`} className="h-8 w-40" value={p.visibility} disabled={patch.isPending}
                onChange={(e) => patch.mutate({ p, body: { visibility: e.target.value } })}><option value="members">Members only</option><option value="company">All staff</option></Select></td>
              <td className="px-3 py-2"><Select aria-label={`Status of ${p.name}`} className="h-8 w-32" value={p.status} disabled={patch.isPending}
                onChange={(e) => patch.mutate({ p, body: { status: e.target.value } })}><option value="active">Active</option><option value="paused">Paused</option><option value="archived">Archived</option></Select></td>
              <td className="px-3 py-2 text-ink-2">{p.leads.map((l) => l.name).join(', ') || <span className="text-ink-3">No lead</span>}</td>
              <td className="px-3 py-2 text-right"><Button size="sm" icon={<Users className="size-3.5" aria-hidden />} onClick={() => setOpen(p.id)} aria-label={`Members and settings of ${p.name}`}>{p.member_count}</Button></td>
            </tr>))}</tbody>
        </table>
        {shown.length === 0 && <Empty title="No products match the filter" />}
      </div>
      <Drawer open={!!selected} onClose={() => setOpen(null)} title={selected ? `Product · ${selected.name}` : ''} label={selected ? `${selected.name} settings and members` : 'Product'} width="max-w-xl">
        {selected && <ProductPanel product={selected} />}
      </Drawer>
    </Card>
  );
}

function ProductPanel({ product }: { product: Product }) {
  const toast = useToast(); const err = useErr(); const refresh = usePortfolioRefresh(); const qc = useQueryClient(); const users = useUsers();
  const [f, setF] = useState({ name: product.name, tagline: product.tagline, websiteUrl: product.website_url ?? '' });
  useEffect(() => setF({ name: product.name, tagline: product.tagline, websiteUrl: product.website_url ?? '' }), [product.id, product.version]);
  const members = useQuery<any[]>({ queryKey: ['product-members', product.id], queryFn: () => api.get(`/api/products/${product.id}/members`) });
  const [add, setAdd] = useState({ userId: '', role: 'member' });
  const save = useMutation({ mutationFn: () => api.patch(`/api/products/${product.id}`, { version: product.version, name: f.name, tagline: f.tagline, websiteUrl: f.websiteUrl || null }),
    onSuccess: () => { refresh(); toast({ tone: 'good', text: 'Product saved' }); }, onError: err });
  const after = () => { qc.invalidateQueries({ queryKey: ['product-members', product.id] }); refresh(); };
  const setRole = useMutation({ mutationFn: (b: { userId: string; role: string }) => api.post(`/api/products/${product.id}/members`, b),
    onSuccess: () => { after(); setAdd({ userId: '', role: 'member' }); toast({ tone: 'good', text: 'Membership saved' }); }, onError: err });
  const remove = useMutation({ mutationFn: (userId: string) => api.del(`/api/products/${product.id}/members/${userId}`),
    onSuccess: (r: any) => { after(); toast({ tone: 'good', text: r.openTasksOwned ? `Removed. They still own ${r.openTasksOwned} open task(s) in this product — reassign them.` : 'Removed from the product' }); }, onError: err });
  const memberIds = new Set((members.data ?? []).map((m) => m.user_id));
  return (
    <div className="space-y-5 p-5">
      <section className="space-y-3">
        <h3 className="text-[14px] font-semibold">Settings</h3>
        <Field label="Name">{(id) => <Input id={id} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
        <Field label="Tagline">{(id) => <Input id={id} value={f.tagline} onChange={(e) => setF({ ...f, tagline: e.target.value })} />}</Field>
        <Field label="Website">{(id) => <Input id={id} type="url" placeholder="https://" value={f.websiteUrl} onChange={(e) => setF({ ...f, websiteUrl: e.target.value })} />}</Field>
        <Button variant="primary" size="sm" loading={save.isPending} disabled={!f.name.trim()} onClick={() => save.mutate()}>Save settings</Button>
      </section>
      <section className="space-y-3">
        <h3 className="text-[14px] font-semibold">Members</h3>
        <p className="text-[12px] text-ink-3">Leads manage members. Members and leads see and add work in this product; viewers read only. System admins, the main admin and leadership see every product.</p>
        {members.isLoading ? <Skeleton className="h-24" /> : members.error ? <ErrorState error={members.error} /> : (
          <ul className="divide-y divide-line rounded-lg ring-1 ring-line">
            {(members.data ?? []).length === 0 && <li className="px-3 py-3 text-[13px] text-ink-3">No members yet.</li>}
            {(members.data ?? []).map((m) => (
              <li key={m.user_id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{m.name}<span className="ml-1 font-normal text-ink-3">{m.title}</span></span>
                <Select aria-label={`Role of ${m.name}`} className="h-8 w-32" value={m.role} onChange={(e) => setRole.mutate({ userId: m.user_id, role: e.target.value })}>
                  <option value="lead">Lead</option><option value="member">Member</option><option value="viewer">Viewer</option></Select>
                <Button size="sm" variant="ghost" onClick={() => remove.mutate(m.user_id)} aria-label={`Remove ${m.name}`}>Remove</Button>
              </li>))}
          </ul>
        )}
        <div className="flex flex-wrap items-end gap-2">
          <Field className="min-w-48 flex-1" label="Add a person">{(id) => <Select id={id} value={add.userId} onChange={(e) => setAdd({ ...add, userId: e.target.value })}>
            <option value="">Choose…</option>{(users.data ?? []).filter((u: any) => !memberIds.has(u.id)).map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select>}</Field>
          <Field label="Role">{(id) => <Select id={id} className="w-32" value={add.role} onChange={(e) => setAdd({ ...add, role: e.target.value })}>
            <option value="lead">Lead</option><option value="member">Member</option><option value="viewer">Viewer</option></Select>}</Field>
          <Button disabled={!add.userId} loading={setRole.isPending} onClick={() => setRole.mutate(add)}>Add</Button>
        </div>
      </section>
    </div>
  );
}
