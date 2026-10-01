import { useState } from 'react';
import { Navigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, Copy, KeyRound, Plug, RefreshCw, Upload } from 'lucide-react';
import { api } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { useRoles } from '../lib/session';
import { Badge, Button, Callout, Card, ErrorState, Field, Input, Modal, PageHeader, Select, Skeleton, useToast } from '../components/ui';
import { CalendarSubscription } from '../components/ext/CalendarSubscription';
import { CalendarFeedCard } from '../components/ext/CalendarFeed';

const KIND: Record<string, string> = { ics_calendar: 'Calendar (ICS file)', issues: 'Issue tracker', helpdesk: 'Helpdesk', code: 'Code host' };

export default function Integrations() {
  const r = useRoles(); const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['integrations'], queryFn: () => api.get('/api/integrations') });
  const [created, setCreated] = useState<any>(null); const [newOpen, setNewOpen] = useState(false); const [events, setEvents] = useState<any>(null);
  const create = useMutation({ mutationFn: (b: any) => api.post('/api/integrations', b), onSuccess: (c: any) => { qc.invalidateQueries({ queryKey: ['integrations'] }); if (c.secret) setCreated(c); setNewOpen(false); }, onError: (e: any) => toast({ tone: 'critical', text: e.message }) });
  const status = useMutation({ mutationFn: ({ id, status }: any) => api.patch(`/api/integrations/${id}`, { status }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['integrations'] }); qc.invalidateQueries({ queryKey: ['calendar-subscription'] }); }, onError: (e: any) => toast({ tone: 'critical', text: e.message }) });
  const upload = useMutation({ mutationFn: ({ id, ics }: any) => api.post(`/api/integrations/${id}/ics`, { ics }),
    onSuccess: (r: any) => { qc.invalidateQueries(); toast({ tone: 'good', text: `${r.received} events read (${r.duplicates} already imported). Past meetings appear as suggestions in My Day.` }); }, onError: (e: any) => toast({ tone: 'critical', text: e.message }) });
  if (r.customer) return <Navigate to="/portal" replace />;
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.error) return <ErrorState error={q.error} />;
  const mine = q.data.connections.filter((c: any) => c.user_id); const org = q.data.connections.filter((c: any) => !c.user_id);
  const cal = mine.find((c: any) => c.kind === 'ics_calendar');
  // One step: the first upload also creates the personal calendar connection.
  const uploadFile = async (f: File) => {
    try { upload.mutate({ id: cal?.id ?? (await create.mutateAsync({ kind: 'ics_calendar', name: 'My work calendar (ICS)' })).id, ics: await f.text() }); } catch { /* create's onError already showed a toast */ }
  };
  return (
    <div>
      <PageHeader title="Integrations" subtitle="Opt-in and scope-limited. Events become suggestions you confirm — they are never treated as proof of time or accepted work." />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={<span className="flex items-center gap-2"><CalendarDays className="size-4" aria-hidden />My work calendar</span>} subtitle="Upload an .ics export or subscribe by its secret address. Only titles and times are kept — no descriptions, attendees or locations. Private events show as “Private event”.">
          {cal && <p className="mb-3 text-[13px] text-ink-2">Last import: {cal.last_sync_at ? fmtDateTime(cal.last_sync_at) : 'never'} · {cal.events} event{cal.events === 1 ? '' : 's'} {cal.last_error && <span className="text-critical-ink">· {cal.last_error}</span>}</p>}
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg bg-surface-2 px-3 py-2 text-[13px] font-medium ring-1 ring-line hover:ring-accent focus-within:ring-2 focus-within:ring-accent">
            <Upload className="size-4" aria-hidden />{upload.isPending || create.isPending ? 'Reading file…' : 'Upload .ics file'}<input type="file" accept=".ics,text/calendar" className="sr-only" disabled={upload.isPending || create.isPending} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) uploadFile(f); }} /></label>
          {cal && <div className="mt-3 flex flex-wrap gap-2"><Button size="sm" variant="ghost" onClick={() => setEvents(cal)}>View sync log</Button>
            <Button size="sm" variant="ghost" loading={status.isPending} onClick={() => status.mutate({ id: cal.id, status: cal.status === 'active' ? 'paused' : 'active' })}>{cal.status === 'active' ? 'Pause calendar' : 'Resume calendar'}</Button></div>}
          {!r.customer && <CalendarSubscription />}
        </Card>
        {!r.customer && <CalendarFeedCard />}
        {r.sysAdmin && <Card title="Shared contract" subtitle={`Schema ${q.data.schemaVersion}. Machine-to-machine deliveries are signed per connection.`}>
          <pre tabIndex={0} role="region" aria-label="Example signed delivery" className="overflow-x-auto rounded-lg bg-surface-2 p-3 text-[11.5px] leading-relaxed">{`POST {inboundUrl}
X-Timestamp: <unix seconds>
X-Signature: sha256=HMAC_SHA256(secret, "<timestamp>.<raw body>")

{ "event_id": "...", "event_type": "issue.assigned",
  "schema_version": "1.0", "tenant_id": "<org id>",
  "resource_id": "ISS-42", "resource_version": "2",
  "occurred_at": "...", "correlation_id": "...",
  "payload": { "title": "...", "issue_ref": "ISS-42",
               "assignee_email": "...", "url": "..." } }`}</pre>
          <p className="mt-2 text-[12px] text-ink-3">Repeated deliveries are de-duplicated; related events (e.g. many commits on one issue) are grouped into one suggestion. Payloads containing password/token/secret fields are rejected and not stored.</p>
        </Card>}
        {r.sysAdmin && <Card className="lg:col-span-2" title={<span className="flex items-center gap-2"><Plug className="size-4" aria-hidden />Organization connections</span>} actions={<Button size="sm" variant="primary" onClick={() => setNewOpen(true)}>Add connection</Button>} padded={false}>
          <ul className="divide-y divide-line">{org.length === 0 && <li className="px-4 py-4 text-[13px] text-ink-3">No organization connections.</li>}{org.map((c: any) => (
            <li key={c.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1"><div className="flex items-center gap-2 font-medium">{c.name}<Badge>{KIND[c.kind]}</Badge><Badge tone={c.status === 'active' ? 'good' : c.status === 'revoked' ? 'critical' : 'warning'}>{c.status}</Badge></div>
                <div className="mt-0.5 truncate text-[12px] text-ink-3">{c.events} events · {c.not_applied} not applied · last {c.last_sync_at ? fmtDateTime(c.last_sync_at) : 'never'}{c.last_error && <span className="text-critical-ink"> · {c.last_error}</span>}</div>
                <code className="mt-1 block truncate text-[11px] text-ink-3">{c.inboundUrl}</code></div>
              <Button size="sm" variant="ghost" icon={<Copy className="size-3.5" />} onClick={() => navigator.clipboard?.writeText(c.inboundUrl).then(() => toast({ tone: 'good', text: 'URL copied' }))}>URL</Button>
              <Button size="sm" variant="ghost" onClick={() => setEvents(c)}>Sync log</Button>
              {c.status !== 'revoked' && <Button size="sm" variant="ghost" onClick={() => status.mutate({ id: c.id, status: c.status === 'active' ? 'paused' : 'active' })}>{c.status === 'active' ? 'Pause' : 'Resume'}</Button>}
              {c.status !== 'revoked' && <Button size="sm" variant="ghost" className="text-critical-ink" onClick={() => confirm(`Revoke ${c.name}? Deliveries will be refused.`) && status.mutate({ id: c.id, status: 'revoked' })}>Revoke</Button>}
            </li>))}</ul>
        </Card>}
      </div>
      <NewConnection open={newOpen} onClose={() => setNewOpen(false)} onCreate={(b) => create.mutate(b)} loading={create.isPending} />
      <Modal open={!!created} onClose={() => setCreated(null)} title="Connection created" footer={<Button variant="primary" onClick={() => setCreated(null)}>I've stored the secret</Button>}>
        <Callout tone="warning" icon={<KeyRound className="mt-0.5 size-4 shrink-0" />}>This signing secret is shown <b>once</b>. Store it in the sending system's secret store. It is kept encrypted here and can't be displayed again.</Callout>
        <Field className="mt-3" label="Signing secret">{(id) => <Input id={id} readOnly value={created?.secret ?? ''} onFocus={(e) => e.target.select()} />}</Field>
      </Modal>
      <EventsModal conn={events} onClose={() => setEvents(null)} />
    </div>
  );
}

function NewConnection({ open, onClose, onCreate, loading }: { open: boolean; onClose: () => void; onCreate: (b: any) => void; loading: boolean }) {
  const [kind, setKind] = useState('issues'); const [name, setName] = useState('');
  return (
    <Modal open={open} onClose={onClose} title="Add organization connection" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!name} loading={loading} onClick={() => onCreate({ kind, name })}>Create</Button></>}>
      <div className="grid gap-3">
        <Field label="Type">{(id) => <Select id={id} value={kind} onChange={(e) => setKind(e.target.value)}>{Object.entries(KIND).filter(([k]) => k !== 'ics_calendar').map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}</Field>
        <Field label="Name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        {['issues', 'helpdesk', 'code'].includes(kind) && <Callout tone="neutral">Events become suggestions for the assignee. Related events (e.g. many commits) are grouped under one suggestion; nothing is created without confirmation.</Callout>}
      </div>
    </Modal>
  );
}

function EventsModal({ conn, onClose }: { conn: any; onClose: () => void }) {
  const qc = useQueryClient(); const toast = useToast(); const r = useRoles();
  const q = useQuery({ queryKey: ['events', conn?.id], queryFn: () => api.get(`/api/integrations/${conn.id}/events`), enabled: !!conn });
  const re = useMutation({ mutationFn: (id: string) => api.post(`/api/integrations/events/${id}/reprocess`), onSuccess: () => { qc.invalidateQueries({ queryKey: ['events'] }); toast({ tone: 'good', text: 'Queued for reprocessing' }); }, onError: (e: any) => toast({ tone: 'critical', text: e.message }) });
  return (
    <Modal open={!!conn} onClose={onClose} title={`Sync log — ${conn?.name ?? ''}`} width="max-w-3xl">
      {q.isLoading ? <Skeleton className="h-40" /> : (q.data ?? []).length === 0 ? <p className="text-[13px] text-ink-3">No events received yet.</p> : (
        <table className="w-full text-[12.5px]"><thead className="text-left text-ink-3"><tr><th className="py-1 font-medium">Received</th><th className="font-medium">Type</th><th className="font-medium">Status</th><th className="font-medium">Result</th><th /></tr></thead>
          <tbody className="divide-y divide-line">{q.data.map((e: any) => (
            <tr key={e.id}><td className="py-1.5 pr-2 whitespace-nowrap">{fmtDateTime(e.received_at)}</td><td className="pr-2">{e.event_type}</td>
              <td className="pr-2"><Badge tone={e.status === 'applied' ? 'good' : e.status === 'rejected' ? 'critical' : e.status === 'suggested' ? 'info' : 'neutral'}>{e.status}</Badge></td>
              <td className="pr-2 text-ink-2">{e.result}</td>
              <td>{r.sysAdmin && ['ignored'].includes(e.status) && <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3" />} onClick={() => re.mutate(e.id)}>Retry</Button>}</td></tr>))}</tbody></table>)}
    </Modal>
  );
}
