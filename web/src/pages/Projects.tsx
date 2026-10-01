import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderPlus, Lock } from 'lucide-react';
import { api } from '../lib/api';
import { fmtDate } from '../lib/format';
import { useMe, useRoles } from '../lib/session';
import { Badge, Button, Card, Empty, ErrorState, Field, Input, Modal, PageHeader, Select, Skeleton, Textarea, useToast } from '../components/ui';
import { useProjects, useUsers } from '../components/TaskStatus';
import { BudgetBadge } from '../components/ext/ProfitabilityParts';

export default function Projects() {
  const q = useProjects(); const r = useRoles(); const [open, setOpen] = useState(false);
  const me = useMe(); const budgetsVisible = r.costViewer || r.leadership || (q.data ?? []).some((p: any) => p.owner_id === me.user.id);
  const badges = useQuery<any[]>({ queryKey: ['budget-badges'], queryFn: () => api.get('/api/profitability/badges'), enabled: !r.customer && budgetsVisible, staleTime: 60_000 });
  return (
    <div>
      <PageHeader title="Projects" subtitle="Company projects plus private projects you belong to." actions={(r.sysAdmin || r.leadership || r.manager) && <Button variant="primary" icon={<FolderPlus className="size-4" />} onClick={() => setOpen(true)}>New project</Button>} />
      {q.isLoading ? <Skeleton className="h-64" /> : q.error ? <ErrorState error={q.error} /> : q.data.length === 0 ? <Card><Empty title="No projects yet" /></Card> : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{q.data.map((p: any) => (
          <Link key={p.id} to={`/projects/${p.id}`} className="rounded-xl bg-surface p-4 ring-1 ring-line transition hover:ring-accent">
            <div className="flex flex-wrap items-center gap-2"><Badge tone="info">{p.key}</Badge>{p.visibility === 'private' && <Badge icon={<Lock className="size-3" />}>Private</Badge>}{p.customer_name && <Badge>{p.customer_name}</Badge>}
              {p.status !== 'active' && <Badge tone="warning">{p.status.replace('_', ' ')}</Badge>}
              {(() => { const b = badges.data?.find((x: any) => x.projectId === p.id); return b && <BudgetBadge b={b} />; })()}</div>
            <h2 className="mt-2 text-[15px] font-semibold">{p.name}</h2>
            <p className="mt-1 line-clamp-2 text-[13px] text-ink-2">{p.business_outcome || p.description || 'No outcome set.'}</p>
            <div className="mt-3 flex items-center gap-3 text-[12px] text-ink-3"><span>{p.open_tasks} open</span><span>{p.done_tasks} done</span>{p.target_date && <span>Target {fmtDate(p.target_date)}</span>}<span className="ml-auto">{p.owner_name}</span></div>
          </Link>))}</div>)}
      <NewProject open={open} onClose={() => setOpen(false)} />
    </div>
  );
}

function NewProject({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient(); const toast = useToast(); const users = useUsers();
  const customers = useQuery({ queryKey: ['customers'], queryFn: () => api.get('/api/admin/customers'), enabled: open });
  const [f, setF] = useState<any>({ key: '', name: '', businessOutcome: '', visibility: 'company', customerId: '', ownerId: '', targetDate: '' });
  const m = useMutation({ mutationFn: () => api.post('/api/projects', { ...f, customerId: f.customerId || null, ownerId: f.ownerId || null, targetDate: f.targetDate || null }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['projects'] }); toast({ tone: 'good', text: 'Project created' }); onClose(); }, onError: (e: any) => toast({ tone: 'critical', text: e.message }) });
  return (
    <Modal open={open} onClose={onClose} title="New project" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} disabled={!f.key || !f.name} onClick={() => m.mutate()}>Create</Button></>}>
      <div className="grid gap-3">
        <div className="grid grid-cols-3 gap-3"><Field label="Key">{(id) => <Input id={id} value={f.key} maxLength={10} onChange={(e) => setF({ ...f, key: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') })} placeholder="WEB" />}</Field>
          <Field className="col-span-2" label="Name">{(id) => <Input id={id} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field></div>
        <Field label="Business outcome">{(id) => <Textarea id={id} rows={2} value={f.businessOutcome} onChange={(e) => setF({ ...f, businessOutcome: e.target.value })} placeholder="What result does this project move?" />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Visibility">{(id) => <Select id={id} value={f.visibility} onChange={(e) => setF({ ...f, visibility: e.target.value })}><option value="company">Company</option><option value="private">Private (members only)</option></Select>}</Field>
          <Field label="Client (optional)">{(id) => <Select id={id} value={f.customerId} onChange={(e) => setF({ ...f, customerId: e.target.value })}><option value="">Internal</option>{(customers.data ?? []).map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>}</Field>
          <Field label="Owner">{(id) => <Select id={id} value={f.ownerId} onChange={(e) => setF({ ...f, ownerId: e.target.value })}><option value="">Me</option>{(users.data ?? []).map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select>}</Field>
          <Field label="Target date">{(id) => <Input id={id} type="date" value={f.targetDate} onChange={(e) => setF({ ...f, targetDate: e.target.value })} />}</Field>
        </div>
      </div>
    </Modal>
  );
}
