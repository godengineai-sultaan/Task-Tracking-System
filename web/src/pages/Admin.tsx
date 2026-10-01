import { useEffect, useState } from 'react';
import { Navigate, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Copy, RotateCcw, ShieldAlert, UserPlus } from 'lucide-react';
import { api } from '../lib/api';
import AdminEscalation from '../components/ext/AdminEscalation';
import AdminBranding from '../components/ext/AdminBranding';
import { CATEGORY_LABEL, fmtDateTime, hm, pct } from '../lib/format';
import { Badge, Button, Callout, Card, Checkbox, ErrorState, Field, Input, Modal, NoAccess, PageHeader, Segmented, Select, Skeleton, Stat, Textarea, useToast } from '../components/ui';
import { useRoles } from '../lib/session';

const ROLES = [['member', 'Member'], ['manager', 'Manager'], ['leadership', 'Leadership'], ['routine_admin', 'Main admin (all staff records)'], ['system_admin', 'System admin'], ['cost_viewer', 'Cost viewer'], ['customer', 'Client (portal only)']];
type Tab = 'org' | 'people' | 'teams' | 'profiles' | 'escalation' | 'branding' | 'audit' | 'jobs' | 'ops';
const MODULES: [string, string][] = [['tasks', 'Tasks'], ['analytics', 'Analytics'], ['admin_routine', 'Admin routine'], ['integrations', 'Integrations'], ['customer_portal', 'Client portal'], ['ai_drafting', 'AI drafting']];

export default function Admin() {
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') as Tab) || (sp.get('onboarding') ? 'org' : 'org');
  const r = useRoles();
  if (!r.sysAdmin) {
    // Managers reach blocker aging on its own page; older links to the escalation tab still land there.
    if (tab === 'escalation' && r.canReview) return <Navigate to="/blockers" replace />;
    return <div><PageHeader title="Administration" /><NoAccess>Administration is for system admins.</NoAccess></div>;
  }
  return (
    <div>
      <PageHeader title="Administration" subtitle="Organization policy, people and access, and operational health." />
      {sp.get('onboarding') && <div className="mb-4"><Callout tone="good" icon={<CheckCircle2 className="mt-0.5 size-4 shrink-0" />}>Your organization is ready. Next: confirm the working schedule and policy below, add departments and teams, then invite people from the People tab.</Callout></div>}
      <div className="mb-4 overflow-x-auto"><Segmented label="Section" value={tab} onChange={(v) => setSp({ tab: v })} options={[
        { value: 'org', label: 'Organization' }, { value: 'people', label: 'People' }, { value: 'teams', label: 'Teams & departments' }, { value: 'profiles', label: 'Role profiles' }, { value: 'escalation', label: 'Escalation' }, { value: 'branding', label: 'Branding' },
        { value: 'audit', label: 'Audit' }, { value: 'jobs', label: 'Jobs' }, { value: 'ops', label: 'Operations' }]} /></div>
      {tab === 'org' && <Org />}{tab === 'people' && <People />}{tab === 'teams' && <Teams />}{tab === 'profiles' && <Profiles />}{tab === 'escalation' && <AdminEscalation />}{tab === 'branding' && <AdminBranding />}
      {tab === 'audit' && <Audit />}{tab === 'jobs' && <Jobs />}{tab === 'ops' && <Ops />}
    </div>
  );
}
const useErr = () => { const t = useToast(); return (e: any) => t({ tone: 'critical', text: e.message }); };

function Org() {
  const qc = useQueryClient(); const toast = useToast(); const err = useErr();
  const q = useQuery({ queryKey: ['tenant'], queryFn: () => api.get('/api/admin/tenant') });
  const [f, setF] = useState<any>(null);
  useEffect(() => { if (q.data) setF({ name: q.data.name, legalName: q.data.legal_name ?? '', timezone: q.data.timezone, contactEmail: q.data.contact_email ?? '', address: q.data.address ?? '',
    logoUrl: q.data.logo_url ?? '', plan: q.data.plan, seatLimit: q.data.seat_limit, modules: q.data.modules, settings: q.data.settings }); }, [q.data]);
  const save = useMutation({ mutationFn: () => api.patch('/api/admin/tenant', { ...f, legalName: f.legalName || null, contactEmail: f.contactEmail || null, address: f.address || null, logoUrl: f.logoUrl || null, onboarded: true }),
    onSuccess: () => { qc.invalidateQueries(); toast({ tone: 'good', text: 'Organization settings saved' }); }, onError: err });
  const retention = useMutation({ mutationFn: () => api.post('/api/admin/retention/run'), onSuccess: (r: any) => toast({ tone: 'good', text: r.note }), onError: err });
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (q.isLoading || !f) return <Skeleton className="h-96" />;
  const s = f.settings; const setS = (k: string, v: any) => setF({ ...f, settings: { ...s, [k]: v } });
  const toggleList = (k: string, cat: string) => setS(k, (s[k] ?? []).includes(cat) ? s[k].filter((x: string) => x !== cat) : [...(s[k] ?? []), cat]);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Company details" subtitle="Missing facts stay empty until supplied — nothing is invented.">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Display name">{(id) => <Input id={id} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
          <Field label="Legal name">{(id) => <Input id={id} value={f.legalName} onChange={(e) => setF({ ...f, legalName: e.target.value })} />}</Field>
          <Field label="Time zone">{(id) => <Input id={id} value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })} />}</Field>
          <Field label="Contact email">{(id) => <Input id={id} type="email" value={f.contactEmail} onChange={(e) => setF({ ...f, contactEmail: e.target.value })} />}</Field>
          <Field className="sm:col-span-2" label="Address">{(id) => <Textarea id={id} rows={2} value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} />}</Field>
          <Field className="sm:col-span-2" label="Approved logo URL">{(id) => <Input id={id} type="url" value={f.logoUrl} onChange={(e) => setF({ ...f, logoUrl: e.target.value })} />}</Field>
        </div>
      </Card>
      <Card title="Plan, seats & modules" subtitle={`${q.data.seats.active} active staff seats of ${q.data.seat_limit} · ${q.data.seats.customers} client accounts (not counted)`}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Plan">{(id) => <Select id={id} value={f.plan} onChange={(e) => setF({ ...f, plan: e.target.value })}><option value="team">Team</option><option value="organization">Organization</option><option value="enterprise">Enterprise</option></Select>}</Field>
          <Field label="Seat limit">{(id) => <Input id={id} type="number" min={1} value={f.seatLimit} onChange={(e) => setF({ ...f, seatLimit: Number(e.target.value) })} />}</Field>
        </div>
        <div className="mt-3 grid gap-1.5">{MODULES.map(([m, label]) =>
          <Checkbox key={m} checked={f.modules.includes(m)} onChange={(v) => setF({ ...f, modules: v ? [...f.modules, m] : f.modules.filter((x: string) => x !== m) })} label={label} />)}</div>
        <p className="mt-3 text-[12px] text-ink-3">Entitlements are configuration only in this build — billing/payments are an external dependency and nothing is charged.</p>
      </Card>
      <Card title="Visibility & work policy">
        <div className="space-y-2.5">
          <Checkbox checked={s.founders_visible_to_routine_admin !== false} onChange={(v) => setS('founders_visible_to_routine_admin', v)} label="Founders' daily routines are visible to the main administrator" />
          <Checkbox checked={s.include_meetings_in_work_policy !== false} onChange={(v) => setS('include_meetings_in_work_policy', v)} label="Show meeting titles in the admin routine timeline" />
          <Field label="Minimum logging coverage before a day can be assessed" hint="Below this, the report shows Insufficient Data rather than guessing.">{(id) => <Input id={id} type="number" min={0} max={100} className="w-28"
            value={Math.round((s.coverage_threshold ?? 0.5) * 100)} onChange={(e) => setS('coverage_threshold', Number(e.target.value) / 100)} />}</Field>
          <div><p className="mb-1 text-[13px] font-medium text-ink-2">Evidence required for categories</p><div className="flex flex-wrap gap-x-4 gap-y-1">{Object.entries(CATEGORY_LABEL).map(([k, v]) => <Checkbox key={k} checked={(s.evidence_required_categories ?? []).includes(k)} onChange={() => toggleList('evidence_required_categories', k)} label={v} />)}</div></div>
          <div><p className="mb-1 text-[13px] font-medium text-ink-2">Review required for categories</p><div className="flex flex-wrap gap-x-4 gap-y-1">{Object.entries(CATEGORY_LABEL).map(([k, v]) => <Checkbox key={k} checked={(s.review_required_categories ?? []).includes(k)} onChange={() => toggleList('review_required_categories', k)} label={v} />)}</div></div>
        </div>
      </Card>
      <Card title="Data, AI & retention">
        <div className="space-y-2.5">
          <Checkbox checked={!!s.ai_enabled} onChange={(v) => setS('ai_enabled', v)} label="Allow optional AI drafting (task drafts, recap drafts — always reviewed by the person)" />
          <p className="text-[12px] text-ink-3">Requires AI to be configured by your server operator. Drafts send only the person's own task titles/notes; prompts are versioned and every run is logged.</p>
          <Checkbox checked={!!s.voice_capture_enabled} onChange={(v) => setS('voice_capture_enabled', v)} label="Allow voice capture in quick capture (off by default; people choose whether to use the microphone)" />
          <p className="text-[12px] text-ink-3">Shows a microphone button in quick capture on browsers with built-in speech recognition. The browser's speech service turns speech into text; only the transcript is used and confirmed by the person. No audio reaches or is stored by this app.</p>
          <Field label="Retention for telemetry, notifications and ignored integration events (days)">{(id) => <Input id={id} type="number" min={30} max={3650} className="w-28" value={s.retention_days ?? 730} onChange={(e) => setS('retention_days', Number(e.target.value))} />}</Field>
          <Button size="sm" loading={retention.isPending} onClick={() => retention.mutate()}>Run retention now</Button>
        </div>
      </Card>
      <div className="flex flex-wrap gap-2 lg:col-span-2"><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save organization settings</Button>
        <a href="/api/admin/export-data"><Button>Download organization data (JSON)</Button></a></div>
    </div>
  );
}

function People() {
  const qc = useQueryClient(); const toast = useToast(); const err = useErr();
  const users = useQuery({ queryKey: ['admin-users'], queryFn: () => api.get('/api/admin/users') });
  const inv = useQuery({ queryKey: ['invitations'], queryFn: () => api.get('/api/admin/invitations') });
  const depts = useQuery({ queryKey: ['departments'], queryFn: () => api.get('/api/admin/departments') });
  const profiles = useQuery({ queryKey: ['role-profiles'], queryFn: () => api.get('/api/admin/role-profiles') });
  const customers = useQuery({ queryKey: ['customers'], queryFn: () => api.get('/api/admin/customers') });
  const [edit, setEdit] = useState<any>(null); const [invite, setInvite] = useState(false); const [link, setLink] = useState<string | null>(null);
  const save = useMutation({ mutationFn: (b: any) => api.patch(`/api/admin/users/${b.id}`, b.patch), onSuccess: () => { qc.invalidateQueries(); setEdit(null); toast({ tone: 'good', text: 'Access updated — recorded in the audit log' }); }, onError: err });
  const revoke = useMutation({ mutationFn: (id: string) => api.post(`/api/admin/invitations/${id}/revoke`), onSuccess: () => qc.invalidateQueries({ queryKey: ['invitations'] }) });
  if (users.error) return <ErrorState error={users.error} onRetry={() => users.refetch()} />;
  if (users.isLoading) return <Skeleton className="h-96" />;
  return (
    <div className="space-y-4">
      <Card title="People" actions={<Button size="sm" variant="primary" icon={<UserPlus className="size-3.5" />} onClick={() => setInvite(true)}>Invite</Button>} padded={false}>
        <div className="overflow-x-auto"><table className="w-full min-w-[820px] text-[13px]">
          <thead className="border-b border-line text-left text-[12px] text-ink-3"><tr><th className="px-4 py-2 font-medium">Person</th><th className="px-3 py-2 font-medium">Roles</th><th className="px-3 py-2 font-medium">Department · profile</th><th className="px-3 py-2 font-medium">Security</th><th className="px-3 py-2 font-medium">Status</th><th /></tr></thead>
          <tbody className="divide-y divide-line">{users.data.map((u: any) => (
            <tr key={u.id}><td className="px-4 py-2"><div className="font-medium">{u.name}{u.is_founder && <Badge className="ml-1.5" tone="info">Founder</Badge>}</div><div className="text-[12px] text-ink-3">{u.email} · {u.title}</div></td>
              <td className="px-3 py-2"><div className="flex flex-wrap gap-1">{u.roles.map((r: string) => <Badge key={r} tone={r === 'routine_admin' || r === 'system_admin' ? 'warning' : 'neutral'}>{r.replace('_', ' ')}</Badge>)}</div></td>
              <td className="px-3 py-2 text-[12px]">{u.department ?? '—'} · {u.role_profile ?? 'Default'}{u.customer && ` · ${u.customer}`}</td>
              <td className="px-3 py-2 text-[12px]">{u.mfa_enabled ? <Badge tone="good">MFA</Badge> : <span className="text-ink-3">No MFA</span>}<div className="text-ink-3">{u.last_login_at ? `last ${fmtDateTime(u.last_login_at)}` : 'never signed in'}</div></td>
              <td className="px-3 py-2"><Badge tone={u.status === 'active' ? 'good' : 'neutral'}>{u.status}</Badge></td>
              <td className="px-3 py-2 text-right"><Button size="sm" onClick={() => setEdit({ ...u })}>Edit</Button></td></tr>))}</tbody></table></div>
      </Card>
      <Card title="Invitations" subtitle="Email delivery is not configured — share the one-time link directly." padded={false}>
        <ul className="divide-y divide-line">{(inv.data ?? []).length === 0 && <li className="px-4 py-3 text-[13px] text-ink-3">No invitations.</li>}{(inv.data ?? []).map((i: any) => (
          <li key={i.id} className="flex items-center gap-3 px-4 py-2 text-[13px]"><span className="flex-1"><b>{i.name}</b> · {i.email} · {i.roles.join(', ')}</span>
            <Badge tone={i.accepted_at ? 'good' : i.revoked_at ? 'neutral' : new Date(i.expires_at) < new Date() ? 'warning' : 'info'}>{i.accepted_at ? 'Accepted' : i.revoked_at ? 'Revoked' : new Date(i.expires_at) < new Date() ? 'Expired' : 'Pending'}</Badge>
            {!i.accepted_at && !i.revoked_at && <Button size="sm" variant="ghost" onClick={() => revoke.mutate(i.id)}>Revoke</Button>}</li>))}</ul>
      </Card>
      <Modal open={!!edit} onClose={() => setEdit(null)} title={`Access — ${edit?.name ?? ''}`} footer={<><Button variant="ghost" onClick={() => setEdit(null)}>Cancel</Button>
        <Button variant="primary" loading={save.isPending} onClick={() => save.mutate({ id: edit.id, patch: { roles: edit.roles, title: edit.title, departmentId: edit.department_id, roleProfileId: edit.role_profile_id, customerId: edit.customer_id, isFounder: edit.is_founder, status: edit.status } })}>Save</Button></>}>
        {edit && <div className="grid gap-3">
          <div><p className="mb-1.5 text-[13px] font-medium text-ink-2">Roles</p><div className="grid grid-cols-2 gap-1.5">{ROLES.map(([k, v]) => <Checkbox key={k} checked={edit.roles.includes(k)} onChange={(c) => setEdit({ ...edit, roles: c ? [...edit.roles, k] : edit.roles.filter((r: string) => r !== k) })} label={v} />)}</div>
            <p className="mt-1.5 text-[12px] text-ink-3">Main admin sees every employee's recorded routine. It is separate from system administration.</p></div>
          <Field label="Title">{(id) => <Input id={id} value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} />}</Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Department">{(id) => <Select id={id} value={edit.department_id ?? ''} onChange={(e) => setEdit({ ...edit, department_id: e.target.value || null })}><option value="">None</option>{(depts.data ?? []).map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select>}</Field>
            <Field label="Role profile">{(id) => <Select id={id} value={edit.role_profile_id ?? ''} onChange={(e) => setEdit({ ...edit, role_profile_id: e.target.value || null })}><option value="">Default</option>{(profiles.data ?? []).map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select>}</Field>
            {edit.roles.includes('customer') && <Field label="Client organization">{(id) => <Select id={id} value={edit.customer_id ?? ''} onChange={(e) => setEdit({ ...edit, customer_id: e.target.value || null })}><option value="">None</option>{(customers.data ?? []).map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select>}</Field>}
            <Field label="Status">{(id) => <Select id={id} value={edit.status} onChange={(e) => setEdit({ ...edit, status: e.target.value })}><option value="active">Active</option><option value="deactivated">Deactivated (signs out immediately)</option></Select>}</Field>
          </div>
          <Checkbox checked={edit.is_founder} onChange={(v) => setEdit({ ...edit, is_founder: v })} label="Founder / co-founder" />
        </div>}
      </Modal>
      {users.data.some(() => true) && <CostRates users={users.data} />}
      <InviteModal open={invite} onClose={() => setInvite(false)} depts={depts.data ?? []} onLink={setLink} />
      <Modal open={!!link} onClose={() => setLink(null)} title="Invitation link" footer={<Button variant="primary" onClick={() => setLink(null)}>Done</Button>}>
        <p className="text-[13px] text-ink-2">Send this one-time link to the person. It expires in 7 days and is shown only now.</p>
        <div className="mt-3 flex gap-2"><Input readOnly value={link ?? ''} onFocus={(e) => e.target.select()} /><Button icon={<Copy className="size-4" />} onClick={() => navigator.clipboard?.writeText(link!).then(() => toast({ tone: 'good', text: 'Copied' }))}>Copy</Button></div>
      </Modal>
    </div>
  );
}
function InviteModal({ open, onClose, depts, onLink }: { open: boolean; onClose: () => void; depts: any[]; onLink: (l: string) => void }) {
  const qc = useQueryClient(); const err = useErr();
  const [f, setF] = useState<any>({ name: '', email: '', roles: ['member'], departmentId: '' });
  const m = useMutation({ mutationFn: () => api.post('/api/admin/invitations', { ...f, departmentId: f.departmentId || null }), onSuccess: (r: any) => { qc.invalidateQueries({ queryKey: ['invitations'] }); onClose(); onLink(r.link); setF({ name: '', email: '', roles: ['member'], departmentId: '' }); }, onError: err });
  return (
    <Modal open={open} onClose={onClose} title="Invite a person" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!f.name || !f.email || !f.roles.length} loading={m.isPending} onClick={() => m.mutate()}>Create invitation</Button></>}>
      <div className="grid gap-3">
        <div className="grid grid-cols-2 gap-3"><Field label="Name">{(id) => <Input id={id} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
          <Field label="Email">{(id) => <Input id={id} type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />}</Field></div>
        <Field label="Department">{(id) => <Select id={id} value={f.departmentId} onChange={(e) => setF({ ...f, departmentId: e.target.value })}><option value="">None</option>{depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select>}</Field>
        <div className="grid grid-cols-2 gap-1.5">{ROLES.map(([k, v]) => <Checkbox key={k} checked={f.roles.includes(k)} onChange={(c) => setF({ ...f, roles: c ? [...f.roles, k] : f.roles.filter((r: string) => r !== k) })} label={v} />)}</div>
      </div>
    </Modal>
  );
}

function Teams() {
  const qc = useQueryClient(); const err = useErr();
  const teams = useQuery({ queryKey: ['teams'], queryFn: () => api.get('/api/admin/teams') });
  const users = useQuery({ queryKey: ['admin-users'], queryFn: () => api.get('/api/admin/users') });
  const depts = useQuery({ queryKey: ['departments'], queryFn: () => api.get('/api/admin/departments') });
  const customers = useQuery({ queryKey: ['customers'], queryFn: () => api.get('/api/admin/customers') });
  const staff = (users.data ?? []).filter((u: any) => u.status === 'active' && !u.roles.includes('customer'));
  const inv = () => qc.invalidateQueries();
  const [nt, setNt] = useState({ name: '', managerId: '', departmentId: '' }); const [nd, setNd] = useState(''); const [nc, setNc] = useState('');
  const addTeam = useMutation({ mutationFn: () => api.post('/api/admin/teams', { name: nt.name, managerId: nt.managerId || null, departmentId: nt.departmentId || null }), onSuccess: () => { setNt({ name: '', managerId: '', departmentId: '' }); inv(); }, onError: err });
  const setMgr = useMutation({ mutationFn: ({ id, managerId }: any) => api.patch(`/api/admin/teams/${id}`, { managerId: managerId || null }), onSuccess: inv, onError: err });
  const addMember = useMutation({ mutationFn: ({ id, userId }: any) => api.post(`/api/admin/teams/${id}/members`, { userId }), onSuccess: inv, onError: err });
  const delMember = useMutation({ mutationFn: ({ id, userId }: any) => api.del(`/api/admin/teams/${id}/members/${userId}`), onSuccess: inv, onError: err });
  const addDept = useMutation({ mutationFn: () => api.post('/api/admin/departments', { name: nd }), onSuccess: () => { setNd(''); inv(); }, onError: err });
  const addCust = useMutation({ mutationFn: () => api.post('/api/admin/customers', { name: nc }), onSuccess: () => { setNc(''); inv(); }, onError: err });
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        {(teams.data ?? []).map((t: any) => (
          <Card key={t.id} title={t.name} subtitle={t.department_name ?? undefined} actions={<Select aria-label="Manager" className="h-8 w-48" value={t.manager_id ?? ''} onChange={(e) => setMgr.mutate({ id: t.id, managerId: e.target.value })}>
            <option value="">No manager</option>{staff.map((u: any) => <option key={u.id} value={u.id}>Manager: {u.name}</option>)}</Select>}>
            <div className="flex flex-wrap gap-1.5">{t.members.map((m: any) => <Badge key={m.id}>{m.name}<button aria-label={`Remove ${m.name}`} className="ml-1 text-ink-3 hover:text-critical-ink" onClick={() => delMember.mutate({ id: t.id, userId: m.id })}>×</button></Badge>)}</div>
            <Select aria-label="Add member" className="mt-3 h-8 w-56" value="" onChange={(e) => e.target.value && addMember.mutate({ id: t.id, userId: e.target.value })}>
              <option value="">Add member…</option>{staff.filter((u: any) => !t.members.some((m: any) => m.id === u.id)).map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select>
            <p className="mt-2 text-[12px] text-ink-3">The manager sees these members' routines, reports and capacity — nobody else's.</p>
          </Card>))}
        <Card title="New team"><div className="flex flex-wrap gap-2"><Input aria-label="Team name" className="h-8 w-48" placeholder="Team name" value={nt.name} onChange={(e) => setNt({ ...nt, name: e.target.value })} />
          <Select aria-label="Manager" className="h-8 w-44" value={nt.managerId} onChange={(e) => setNt({ ...nt, managerId: e.target.value })}><option value="">Manager…</option>{staff.map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select>
          <Select aria-label="Department" className="h-8 w-40" value={nt.departmentId} onChange={(e) => setNt({ ...nt, departmentId: e.target.value })}><option value="">Department…</option>{(depts.data ?? []).map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select>
          <Button size="sm" variant="primary" disabled={!nt.name} onClick={() => addTeam.mutate()}>Create</Button></div></Card>
      </div>
      <div className="space-y-4">
        <Card title="Departments"><ul className="space-y-1 text-[13px]">{(depts.data ?? []).map((d: any) => <li key={d.id}>{d.name}</li>)}</ul>
          <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); addDept.mutate(); }}><Input aria-label="New department" className="h-8" value={nd} onChange={(e) => setNd(e.target.value)} placeholder="New department" /><Button size="sm" type="submit" disabled={!nd}>Add</Button></form></Card>
        <Card title="Clients"><ul className="space-y-1 text-[13px]">{(customers.data ?? []).map((d: any) => <li key={d.id}>{d.name}</li>)}</ul>
          <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); addCust.mutate(); }}><Input aria-label="New client" className="h-8" value={nc} onChange={(e) => setNc(e.target.value)} placeholder="New client" /><Button size="sm" type="submit" disabled={!nc}>Add</Button></form></Card>
      </div>
    </div>
  );
}

function Profiles() {
  const qc = useQueryClient(); const toast = useToast(); const err = useErr();
  const q = useQuery({ queryKey: ['role-profiles'], queryFn: () => api.get('/api/admin/role-profiles') });
  const save = useMutation({ mutationFn: (p: any) => (p.id ? api.put(`/api/admin/role-profiles/${p.id}`, p) : api.post('/api/admin/role-profiles', p)), onSuccess: () => { qc.invalidateQueries({ queryKey: ['role-profiles'] }); toast({ tone: 'good', text: 'Profile saved — assessments use it immediately' }); }, onError: err });
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => { if (q.data) setRows([...q.data.map((p: any) => ({ id: p.id, name: p.name, description: p.description, commitmentTarget: p.commitment_target, coverageTarget: p.coverage_target, judgeByClosedTasks: p.judge_by_closed_tasks, outcomeGuidance: p.outcome_guidance })),
    { name: '', description: '', commitmentTarget: 0.6, coverageTarget: 0.5, judgeByClosedTasks: true, outcomeGuidance: '' }]); }, [q.data]);
  return (
    <div className="space-y-3">
      <Callout tone="neutral">Role profiles set the commitments that On Track / Needs Attention explanations use. Sales, engineering, operations and founders need different expectations — e.g. founders aren't judged by closed-task counts.</Callout>
      {rows.map((p, i) => (
        <Card key={p.id ?? 'new'} title={p.id ? p.name : 'New profile'}>
          <div className="grid gap-3 sm:grid-cols-4">
            <Field label="Name">{(id) => <Input id={id} value={p.name} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />}</Field>
            <Field label="Commitment target %">{(id) => <Input id={id} type="number" min={0} max={100} value={Math.round(p.commitmentTarget * 100)} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, commitmentTarget: Number(e.target.value) / 100 } : x)))} />}</Field>
            <Field label="Min. coverage to assess %">{(id) => <Input id={id} type="number" min={0} max={100} value={Math.round(p.coverageTarget * 100)} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, coverageTarget: Number(e.target.value) / 100 } : x)))} />}</Field>
            <div className="pt-6"><Checkbox checked={p.judgeByClosedTasks} onChange={(v) => setRows(rows.map((x, j) => (j === i ? { ...x, judgeByClosedTasks: v } : x)))} label="Use planned completion" /></div>
            <Field className="sm:col-span-4" label="Interpretation guidance shown with assessments">{(id) => <Input id={id} value={p.outcomeGuidance} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, outcomeGuidance: e.target.value } : x)))} />}</Field>
          </div>
          <Button className="mt-3" size="sm" variant={p.id ? 'secondary' : 'primary'} disabled={!p.name} onClick={() => save.mutate(p)}>{p.id ? 'Save' : 'Create'}</Button>
        </Card>))}
    </div>
  );
}

function Audit() {
  const toast = useToast(); const [action, setAction] = useState('');
  const q = useQuery({ queryKey: ['audit', action], queryFn: () => api.get(`/api/admin/audit${action ? `?action=${encodeURIComponent(action)}` : ''}`) });
  const verify = useMutation({ mutationFn: () => api.get('/api/admin/audit/verify'), onSuccess: (r: any) => toast({ tone: r.ok ? 'good' : 'critical', text: r.ok ? `Hash chain intact across ${r.checked} events` : `Chain broken at event ${r.brokenAt}` }) });
  return (
    <Card title="Audit log" subtitle="Append-only, hash-chained per organization. Edits and deletes are blocked at the database." actions={<>
      <Input aria-label="Filter by action" className="h-8 w-48" placeholder="Action prefix, e.g. task." value={action} onChange={(e) => setAction(e.target.value)} />
      <Button size="sm" loading={verify.isPending} onClick={() => verify.mutate()} icon={<ShieldAlert className="size-3.5" />}>Verify chain</Button></>} padded={false}>
      {q.isLoading ? <Skeleton className="h-64" /> : q.error ? <div className="p-4"><ErrorState error={q.error} onRetry={() => q.refetch()} /></div> : <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-[12.5px]">
        <thead className="border-b border-line text-left text-ink-3"><tr><th className="px-4 py-2 font-medium">When</th><th className="px-3 py-2 font-medium">Actor</th><th className="px-3 py-2 font-medium">Action</th><th className="px-3 py-2 font-medium">Resource</th><th className="px-3 py-2 font-medium">Authority · reason</th><th className="px-3 py-2 font-medium">Outcome</th></tr></thead>
        <tbody className="divide-y divide-line">{(q.data ?? []).map((e: any) => (
          <tr key={e.id}><td className="whitespace-nowrap px-4 py-1.5 tabular">{fmtDateTime(e.at)}</td><td className="px-3 py-1.5">{e.actor_name ?? 'System'}</td><td className="px-3 py-1.5 font-medium">{e.action}</td>
            <td className="px-3 py-1.5 text-ink-2">{e.resource_type}{e.resource_version ? ` v${e.resource_version}` : ''}</td><td className="max-w-[260px] truncate px-3 py-1.5 text-ink-2" title={e.reason ?? ''}>{[e.authority, e.reason].filter(Boolean).join(' · ') || '—'}</td>
            <td className="px-3 py-1.5"><Badge tone={e.outcome === 'success' ? 'good' : e.outcome === 'failure' || e.outcome === 'rejected' ? 'critical' : 'neutral'}>{e.outcome}</Badge></td></tr>))}</tbody></table></div>}
    </Card>
  );
}

function Jobs() {
  const qc = useQueryClient(); const err = useErr();
  const q = useQuery({ queryKey: ['jobs'], queryFn: () => api.get('/api/admin/jobs'), refetchInterval: 5000 });
  const retry = useMutation({ mutationFn: (id: string) => api.post(`/api/admin/jobs/${id}/retry`), onSuccess: () => qc.invalidateQueries({ queryKey: ['jobs'] }), onError: err });
  return (
    <Card title="Background jobs" subtitle="Durable queue with retries and exponential backoff. Dead-lettered jobs can be retried after fixing the cause." padded={false}>
      {q.isLoading ? <Skeleton className="h-64" /> : q.error ? <div className="p-4"><ErrorState error={q.error} onRetry={() => q.refetch()} /></div> : <div className="overflow-x-auto"><table className="w-full min-w-[720px] text-[12.5px]">
        <thead className="border-b border-line text-left text-ink-3"><tr><th className="px-4 py-2 font-medium">Created</th><th className="px-3 py-2 font-medium">Kind</th><th className="px-3 py-2 font-medium">Status</th><th className="px-3 py-2 font-medium">Attempts</th><th className="px-3 py-2 font-medium">Last error</th><th /></tr></thead>
        <tbody className="divide-y divide-line">{q.data.map((j: any) => (
          <tr key={j.id}><td className="whitespace-nowrap px-4 py-1.5 tabular">{fmtDateTime(j.created_at)}</td><td className="px-3 py-1.5 font-medium">{j.kind}</td>
            <td className="px-3 py-1.5"><Badge tone={j.status === 'succeeded' ? 'good' : j.status === 'dead' ? 'critical' : j.status === 'running' ? 'info' : 'neutral'}>{j.status}</Badge></td>
            <td className="px-3 py-1.5 tabular">{j.attempts}/{j.max_attempts}</td><td className="max-w-[320px] truncate px-3 py-1.5 text-critical-ink" title={j.last_error ?? ''}>{j.last_error ?? ''}</td>
            <td className="px-3 py-1.5">{j.status === 'dead' && <Button size="sm" icon={<RotateCcw className="size-3" />} onClick={() => retry.mutate(j.id)}>Retry</Button>}</td></tr>))}</tbody></table></div>}
    </Card>
  );
}

function Ops() {
  const q = useQuery({ queryKey: ['ops'], queryFn: () => api.get('/api/admin/operations') });
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data; const lo = d.loggingOverhead;
  return (
    <div className="space-y-4">
      <Callout tone="neutral">Product and operational health for this organization ({d.window}). Aggregates only — kept separate from individual staff analytics.</Callout>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Median daily logging overhead" value={lo.median_ms != null ? hm(lo.median_ms / 60000) : 'No data'} sub={`target < 2m · p90 ${lo.p90_ms != null ? hm(lo.p90_ms / 60000) : '—'} · ${lo.user_days} user-days`} tone={lo.median_ms > lo.target_ms ? 'warning' : undefined} hint={lo.note} />
        <Stat label="Weekly active staff" value={`${d.activation.weekly_active}/${d.activation.active_staff}`} />
        <Stat label="Confirmed recaps" value={d.recap.confirmed} sub={`${d.recap.users} people · ${d.recap.corrected} corrected`} />
        <Stat label="Open blockers" value={d.blockers.open} sub={`median age ${hm(d.blockers.median_age_h * 60)}`} />
        <Stat label="Deadline reliability" value={d.deadlines.met + d.deadlines.late ? pct(d.deadlines.met / (d.deadlines.met + d.deadlines.late)) : 'N/A'} sub={`${d.deadlines.met} met · ${d.deadlines.late} late · ${d.deadlines.overdue} overdue`} />
        <Stat label="Evidence coverage" value={d.evidence.required ? pct(d.evidence.with_evidence / d.evidence.required) : 'N/A'} sub={`${d.evidence.required} accepted outcomes required evidence`} />
        <Stat label="Manager follow-ups" value={d.managerFollowUps} />
        <Stat label="Job queue" value={`${d.jobs.queued} queued`} sub={`${d.jobs.dead} dead-lettered · oldest ready ${d.jobs.oldest_ready_age_s}s · ${d.jobs.succeeded_24h} ok in 24h`} tone={d.jobs.dead ? 'critical' : undefined} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Overhead by flow"><ul className="space-y-1 text-[13px]">{lo.byFlow.map((f: any) => <li key={f.flow} className="flex justify-between"><span className="capitalize">{f.flow.replace('_', ' ')}</span><span className="tabular">{f.n} × median {(f.median_ms / 1000).toFixed(0)}s</span></li>)}</ul></Card>
        <Card title="AI usage"><p className="text-[13px]">{d.ai.runs} runs · {d.ai.failed} failed · {d.ai.input_tokens + d.ai.output_tokens} tokens</p><p className="text-[12px] text-ink-3">Accepted {d.ai.accepted} · edited {d.ai.edited} · rejected {d.ai.rejected}</p></Card>
        <Card className="lg:col-span-2" title="Integration health"><ul className="space-y-1 text-[13px]">{d.integrations.map((c: any) => <li key={c.id} className="flex flex-wrap justify-between gap-2"><span>{c.name} <Badge>{c.status}</Badge></span><span className="text-ink-3">{c.events} events · {c.rejected} rejected{c.last_error && ` · ${c.last_error}`}</span></li>)}</ul></Card>
      </div>
    </div>
  );
}

function CostRates({ users }: { users: any[] }) {
  const qc = useQueryClient(); const err = useErr();
  const q = useQuery({ queryKey: ['cost-rates'], queryFn: () => api.get('/api/admin/cost-rates'), retry: false });
  const [f, setF] = useState({ userId: '', hourlyRate: '', currency: 'INR', effectiveFrom: new Date().toISOString().slice(0, 10) });
  const m = useMutation({ mutationFn: () => api.post('/api/admin/cost-rates', { ...f, hourlyRate: Number(f.hourlyRate) }), onSuccess: () => { setF({ ...f, userId: '', hourlyRate: '' }); qc.invalidateQueries({ queryKey: ['cost-rates'] }); }, onError: err });
  if (q.error) return null; // only cost viewers can see rates
  return (
    <Card title="Cost rates (confidential)" subtitle="Used only for project cost analysis by cost viewers. Amounts are never written to the audit log or shown in staff analytics.">
      <ul className="space-y-1 text-[13px]">{(q.data ?? []).map((c: any) => <li key={c.id} className="flex justify-between"><span>{c.user_name}</span><span className="tabular">{c.currency} {c.hourly_rate}/h from {c.effective_from}</span></li>)}</ul>
      <form className="mt-3 flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <Select aria-label="Person" className="h-8 w-44" value={f.userId} onChange={(e) => setF({ ...f, userId: e.target.value })}><option value="">Person…</option>{users.filter((u) => !u.roles.includes('customer')).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select>
        <Input aria-label="Hourly rate" type="number" min={0} className="h-8 w-28" value={f.hourlyRate} onChange={(e) => setF({ ...f, hourlyRate: e.target.value })} placeholder="Rate/h" />
        <Input aria-label="Currency" className="h-8 w-20" maxLength={3} value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value.toUpperCase() })} />
        <Input aria-label="Effective from" type="date" className="h-8 w-40" value={f.effectiveFrom} onChange={(e) => setF({ ...f, effectiveFrom: e.target.value })} />
        <Button size="sm" type="submit" disabled={!f.userId || !f.hourlyRate}>Add rate</Button>
      </form>
    </Card>
  );
}
