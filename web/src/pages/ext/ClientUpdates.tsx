import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Download, Eye, FilePlus2, PencilLine, RefreshCw, Send, Trash2, Undo2, Users, X } from 'lucide-react';
import { api, qs } from '../../lib/api';
import { fmtDate, fmtDateTime } from '../../lib/format';
import { useRoles } from '../../lib/session';
import { Badge, Button, Callout, Card, Checkbox, Empty, ErrorState, Field, IconButton, Input, Modal, PageHeader, Segmented, Skeleton, Textarea, cx, useToast } from '../../components/ui';
import { useBranding } from '../../components/ext/BrandMark';
import { ClientUpdateView, periodText, type ClientUpdate } from '../../components/ext/ClientbrandUpdateView';

type StaffUpdate = ClientUpdate & { status: 'draft' | 'published'; version: number; source: 'manual' | 'scheduled'; updatedAt: string; createdByName: string | null; updatedByName: string | null; canEdit: boolean };
interface ClientProject { id: string; key: string; name: string; status: string; target_date: string | null; owner_name: string | null; customer_name: string; shared_tasks: number; drafts: number; last_published_at: string | null; client_users: number }

/** Staff page: prepare weekly client updates from client-visible project data, preview them exactly as the client will, publish explicitly. */
export default function ClientUpdates() {
  const [sp, setSp] = useSearchParams();
  const updateId = sp.get('update');
  const projects = useQuery({ queryKey: ['client-updates', 'projects'], queryFn: () => api.get<ClientProject[]>('/api/client-updates/projects') });
  const projectId = sp.get('project') ?? projects.data?.[0]?.id ?? null;
  const set = (o: Record<string, string | null>) => { const n = new URLSearchParams(sp); for (const [k, v] of Object.entries(o)) v ? n.set(k, v) : n.delete(k); setSp(n); };

  return (
    <div>
      <PageHeader title="Client updates" subtitle="Weekly reports for clients, built only from milestones and tasks marked as shared with the client. Nothing is sent automatically: publishing makes an update visible in the client portal." />
      {projects.isLoading ? <div className="grid gap-4 lg:grid-cols-[300px_1fr]"><Skeleton className="h-72" /><Skeleton className="h-72" /></div>
        : projects.error ? <ErrorState error={projects.error} onRetry={() => projects.refetch()} />
        : !projects.data!.length ? <Card><Empty icon={<Users className="size-6" />} title="No client projects you can update">
            Client updates are available for projects linked to a client that you own (leadership and system admins see all). Link a project to a client from <Link className="text-accent-ink underline" to="/projects">Projects</Link>.</Empty></Card>
        : (
          <div className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
            <div className={cx('space-y-4', updateId && 'hidden lg:block')}>
              <ProjectList projects={projects.data!} selected={projectId} onSelect={(id) => set({ project: id, update: null })} />
              <WeeklySetting />
            </div>
            <div className="min-w-0">
              {updateId ? <Editor id={updateId} onClose={() => set({ update: null })} />
                : projectId && <UpdateList project={projects.data!.find((p) => p.id === projectId) ?? projects.data![0]} onOpen={(id) => set({ update: id })} />}
            </div>
          </div>
        )}
    </div>
  );
}

function ProjectList({ projects, selected, onSelect }: { projects: ClientProject[]; selected: string | null; onSelect: (id: string) => void }) {
  return (
    <Card title="Client projects" padded={false} className="overflow-hidden">
      <ul className="divide-y divide-line">{projects.map((p) => (
        <li key={p.id}>
          <button onClick={() => onSelect(p.id)} aria-current={p.id === selected ? 'true' : undefined}
            className={cx('w-full px-4 py-3 text-left hover:bg-surface-2', p.id === selected && 'bg-accent-soft')}>
            <div className="flex items-center gap-2"><Badge tone="info">{p.key}</Badge><span className={cx('min-w-0 flex-1 truncate text-[13.5px] font-medium', p.id === selected ? 'text-accent-ink' : 'text-ink')}>{p.name}</span>
              {p.drafts > 0 && <Badge tone="warning">{p.drafts} draft{p.drafts > 1 ? 's' : ''}</Badge>}</div>
            <div className={cx('mt-1 text-[12px]', p.id === selected ? 'text-ink-2' : 'text-ink-3')}>{p.customer_name}{p.owner_name ? ` · Owner ${p.owner_name}` : ''}</div>
            <div className={cx('text-[12px]', p.id === selected ? 'text-ink-2' : 'text-ink-3')}>{p.last_published_at ? `Last published ${fmtDate(p.last_published_at)}` : 'Nothing published yet'} · {p.shared_tasks} shared task{p.shared_tasks === 1 ? '' : 's'}</div>
          </button>
        </li>
      ))}</ul>
    </Card>
  );
}

function WeeklySetting() {
  const r = useRoles(); const b = useBranding(); const qc = useQueryClient(); const toast = useToast();
  const m = useMutation({
    mutationFn: (v: boolean) => api.put('/api/client-updates/settings', { weeklyDrafts: v }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['branding'] }), onError: (e: any) => toast({ tone: 'critical', text: e.message }),
  });
  if (!(r.leadership || r.sysAdmin) || !b.data) return null;
  return (
    <Card>
      <Checkbox checked={!!b.data.weeklyDrafts} disabled={m.isPending} onChange={(v) => m.mutate(v)} label="Prepare drafts every Friday" />
      <p className="mt-1.5 text-[12px] text-ink-3">From Friday noon, a draft is prepared for each active client project and its owner is notified. Drafts are never published automatically.</p>
    </Card>
  );
}

function UpdateList({ project, onOpen }: { project: ClientProject; onOpen: (id: string) => void }) {
  const qc = useQueryClient(); const toast = useToast();
  const list = useQuery({ queryKey: ['client-updates', 'list', project.id], queryFn: () => api.get<StaffUpdate[]>(`/api/client-updates${qs({ projectId: project.id })}`) });
  const create = useMutation({
    mutationFn: () => api.post<StaffUpdate & { created: boolean }>('/api/client-updates', { projectId: project.id }),
    onSuccess: (u) => { qc.invalidateQueries({ queryKey: ['client-updates'] }); if (!u.created) toast({ tone: 'info', text: 'This week already has an update. Opening it.' }); onOpen(u.id); },
    onError: (e: any) => toast({ tone: 'critical', text: e.message }),
  });
  return (
    <Card title={`${project.name} · ${project.customer_name}`} subtitle={`${project.client_users} client user${project.client_users === 1 ? '' : 's'} can read published updates in the portal.`}
      actions={<Button variant="primary" icon={<FilePlus2 className="size-4" aria-hidden />} loading={create.isPending} onClick={() => create.mutate()}>Prepare this week's draft</Button>} padded={false}>
      {list.isLoading ? <div className="p-4"><Skeleton className="h-32" /></div> : list.error ? <div className="p-4"><ErrorState error={list.error} onRetry={() => list.refetch()} /></div>
        : !list.data!.length ? <Empty title="No updates yet">Prepare a draft for this week. It collects milestone progress and shared deliverables; you add the summary.</Empty> : (
          <ul className="divide-y divide-line">{list.data!.map((u) => (
            <li key={u.id}>
              <button onClick={() => onOpen(u.id)} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-left hover:bg-surface-2">
                <span className="min-w-0 flex-1 basis-40 text-[13.5px] font-medium text-ink">{periodText(u.periodStart, u.periodEnd)}</span>
                {u.status === 'published' ? <Badge tone="good">Published</Badge> : <Badge tone="warning">Draft</Badge>}
                {u.source === 'scheduled' && u.status === 'draft' && <Badge>Auto-prepared</Badge>}
                <span className="text-[12px] text-ink-3">{u.status === 'published' ? `Published ${fmtDateTime(u.publishedAt)}` : `Updated ${fmtDateTime(u.updatedAt)}`}</span>
              </button>
            </li>
          ))}</ul>
        )}
    </Card>
  );
}

function Editor({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['client-updates', 'one', id], queryFn: () => api.get<StaffUpdate>(`/api/client-updates/${id}`) });
  const [summary, setSummary] = useState(''); const [view, setView] = useState<'edit' | 'preview'>('edit');
  const [publishOpen, setPublishOpen] = useState(false); const [unpublishOpen, setUnpublishOpen] = useState(false); const [discardOpen, setDiscardOpen] = useState(false);
  const [reason, setReason] = useState('');
  const u = q.data;
  useEffect(() => { if (u) setSummary(u.summary); }, [u?.id, u?.version]); // eslint-disable-line react-hooks/exhaustive-deps

  const done = (msg: string) => (next: StaffUpdate) => { qc.setQueryData(['client-updates', 'one', id], next); qc.invalidateQueries({ queryKey: ['client-updates', 'list'] }); qc.invalidateQueries({ queryKey: ['client-updates', 'projects'] }); toast({ tone: 'good', text: msg }); };
  const fail = (e: any) => { if (e.status === 409) q.refetch(); toast({ tone: 'critical', text: e.message }); };
  const save = useMutation({ mutationFn: (b: { summary?: string; removeItemIds?: string[] }) => api.patch<StaffUpdate>(`/api/client-updates/${id}`, { version: u!.version, ...b }), onSuccess: done('Draft saved'), onError: fail });
  const refresh = useMutation({ mutationFn: () => api.post<StaffUpdate>(`/api/client-updates/${id}/refresh`, { version: u!.version }), onSuccess: done('Highlights refreshed from project data'), onError: fail });
  const publish = useMutation({ mutationFn: () => api.post<StaffUpdate>(`/api/client-updates/${id}/publish`, { version: u!.version }), onSuccess: (n) => { setPublishOpen(false); done('Published to the client portal')(n); }, onError: fail });
  const unpublish = useMutation({ mutationFn: () => api.post<StaffUpdate>(`/api/client-updates/${id}/unpublish`, { version: u!.version, reason }), onSuccess: (n) => { setUnpublishOpen(false); setReason(''); done('Unpublished: the client no longer sees this update')(n); }, onError: fail });
  const discard = useMutation({ mutationFn: () => api.del(`/api/client-updates/${id}`, { version: u!.version }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['client-updates'] }); toast({ tone: 'good', text: 'Draft discarded' }); onClose(); }, onError: fail });

  if (q.isLoading) return <Skeleton className="h-96" />;
  if (q.error || !u) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const draft = u.status === 'draft';
  const editable = draft && u.canEdit;
  const dirty = summary !== u.summary;
  const items = u.highlights.milestones.length + u.highlights.completed.length + u.highlights.upcoming.length;
  const removable = editable && view === 'edit' ? (itemId: string, label: string) => (
    <IconButton label={`Leave out "${label}"`} className="size-7" disabled={save.isPending || dirty} onClick={() => save.mutate({ removeItemIds: [itemId] })}><X className="size-3.5" /></IconButton>) : undefined;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" icon={<ArrowLeft className="size-4" aria-hidden />} onClick={onClose}>All updates</Button>
        <span className="ml-auto" />
        <Segmented label="View" value={view} onChange={setView} options={[{ value: 'edit', label: <span className="inline-flex items-center gap-1"><PencilLine className="size-3.5" aria-hidden />Edit</span> },
          { value: 'preview', label: <span className="inline-flex items-center gap-1"><Eye className="size-3.5" aria-hidden />Preview as client</span> }]} />
      </div>
      <Card>
        <div className="flex flex-wrap items-center gap-2">
          {draft ? <Badge tone="warning">Draft · not visible to the client</Badge> : <Badge tone="good">Published · visible in the client portal</Badge>}
          {u.source === 'scheduled' && <Badge>Auto-prepared</Badge>}
          <span className="text-[12px] text-ink-3">Version {u.version} · last change {fmtDateTime(u.updatedAt)}{u.updatedByName ? ` by ${u.updatedByName}` : ''}</span>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {editable && <Button variant="primary" icon={<Send className="size-4" aria-hidden />} disabled={dirty || !u.summary.trim()} onClick={() => setPublishOpen(true)}>Publish to client</Button>}
          {editable && <Button icon={<RefreshCw className="size-4" aria-hidden />} loading={refresh.isPending} disabled={dirty} onClick={() => refresh.mutate()}>Refresh from project data</Button>}
          <a href={`/api/client-updates/${u.id}/pdf`} download className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-surface px-3.5 text-sm font-medium text-ink ring-1 ring-inset ring-line-strong hover:bg-surface-2">
            <Download className="size-4" aria-hidden />{draft ? 'Draft PDF' : 'PDF'}</a>
          {!draft && u.canEdit && <Button icon={<Undo2 className="size-4" aria-hidden />} onClick={() => setUnpublishOpen(true)}>Unpublish</Button>}
          {editable && <Button variant="ghost" icon={<Trash2 className="size-4" aria-hidden />} onClick={() => setDiscardOpen(true)}>Discard draft</Button>}
        </div>
        {editable && (dirty || !u.summary.trim()) && <p className="mt-2 text-[12px] text-ink-3">{dirty ? 'Save the summary before publishing.' : 'Write a summary for the client before publishing.'}</p>}
      </Card>

      {view === 'edit' && editable && (
        <Card title="Summary for the client" subtitle="In your words: progress, decisions needed from the client, and what comes next. Keep internal matters out.">
          <form onSubmit={(e) => { e.preventDefault(); save.mutate({ summary }); }} className="space-y-2">
            <Field label="Summary" hint={`${summary.length}/8000`}>{(fid) => <Textarea id={fid} rows={6} maxLength={8000} value={summary} onChange={(e) => setSummary(e.target.value)} />}</Field>
            <div className="flex justify-end gap-2">
              {dirty && <Button type="button" variant="ghost" onClick={() => setSummary(u.summary)}>Undo changes</Button>}
              <Button type="submit" variant="primary" loading={save.isPending} disabled={!dirty}>Save draft</Button>
            </div>
          </form>
        </Card>
      )}
      {view === 'edit' && editable && <Callout>Highlights only include milestones and tasks shared with the client. Use the remove buttons to leave items out; "Refresh from project data" rebuilds the list. {items === 0 && 'Nothing is shared with the client in this project yet.'}</Callout>}

      <Card className={cx(view === 'preview' && 'ring-2 ring-accent')}>
        {view === 'preview' && <p className="mb-3 text-[12px] font-medium uppercase tracking-wide text-ink-3">Exactly what {u.customerName ?? 'the client'} will see</p>}
        <ClientUpdateView u={view === 'edit' ? { ...u, summary } : u} removable={removable} />
      </Card>

      <Modal open={publishOpen} onClose={() => setPublishOpen(false)} title="Publish this update?"
        footer={<><Button onClick={() => setPublishOpen(false)}>Cancel</Button><Button variant="primary" loading={publish.isPending} onClick={() => publish.mutate()}>Publish</Button></>}>
        <div className="space-y-2 text-sm text-ink-2">
          <p><strong className="text-ink">{u.customerName}</strong> will see this update for <strong className="text-ink">{u.projectName}</strong> ({periodText(u.periodStart, u.periodEnd)}) in their portal, and client users get an in-app notification.</p>
          <p>Nothing is emailed. You can unpublish later if you need to correct it.</p>
        </div>
      </Modal>
      <Modal open={unpublishOpen} onClose={() => setUnpublishOpen(false)} title="Unpublish this update?"
        footer={<><Button onClick={() => setUnpublishOpen(false)}>Cancel</Button><Button variant="danger" loading={unpublish.isPending} disabled={reason.trim().length < 3} onClick={() => unpublish.mutate()}>Unpublish</Button></>}>
        <p className="mb-3 text-sm text-ink-2">The client will no longer see it. It returns to draft so you can correct and republish it. The reason is kept in the audit log.</p>
        <Field label="Reason">{(fid) => <Input id={fid} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />}</Field>
      </Modal>
      <Modal open={discardOpen} onClose={() => setDiscardOpen(false)} title="Discard this draft?"
        footer={<><Button onClick={() => setDiscardOpen(false)}>Cancel</Button><Button variant="danger" loading={discard.isPending} onClick={() => discard.mutate()}>Discard draft</Button></>}>
        <p className="text-sm text-ink-2">The draft and its summary are removed. Project data is not affected and you can prepare a new draft at any time.</p>
      </Modal>
    </div>
  );
}
