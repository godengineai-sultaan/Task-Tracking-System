import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, ChevronLeft, ClipboardCheck, Copy, FolderInput, GitBranch, LayoutTemplate, ListChecks, Lock, Paperclip, Pencil, Play, Plus, Search } from 'lucide-react';
import { api, qs } from '../../lib/api';
import { CATEGORY_LABEL, PRIORITY_LABEL, fmtDate, fmtDateTime, hm } from '../../lib/format';
import { Badge, Button, Callout, Card, Empty, ErrorState, Field, Input, Modal, PageHeader, Segmented, Select, Skeleton, Spinner, cx, useFocusHeading, useToast } from '../../components/ui';
import { useProjects } from '../../components/TaskStatus';
import { CategoryIcon, TEMPLATE_CATEGORIES, TEMPLATE_CATEGORY_LABEL, offsetLabel, plural, spanLabel } from '../../components/ext/TemplatesShared';
import { TemplateEditor } from '../../components/ext/TemplatesEditor';
import { ApplyWizard } from '../../components/ext/TemplatesApply';

/** Task template library: gallery, detail, editor and apply wizard (state lives in the URL: ?t=<id>&mode=edit|new). */
export default function Templates() {
  const [sp, setSp] = useSearchParams();
  const id = sp.get('t'); const mode = sp.get('mode');
  const go = (next: Record<string, string>) => setSp(next);
  if (mode === 'new') return <NewTemplate onDone={(tid) => go(tid ? { t: tid } : {})} />;
  if (id) return <TemplateDetail key={id} id={id} editing={mode === 'edit'} go={go} />;
  return <Gallery go={go} />;
}

function Gallery({ go }: { go: (p: Record<string, string>) => void }) {
  const [text, setText] = useState(''); const [q, setQ] = useState('');
  const [category, setCategory] = useState(''); const [view, setView] = useState<'active' | 'archived'>('active');
  const [fromProject, setFromProject] = useState(false);
  useEffect(() => { const h = setTimeout(() => setQ(text.trim()), 250); return () => clearTimeout(h); }, [text]);
  const list = useQuery({
    queryKey: ['templates', { q, category, view }],
    queryFn: () => api.get(`/api/templates${qs({ q, category, archived: view === 'archived' ? '1' : undefined })}`),
    placeholderData: keepPreviousData,
  });
  const filtered = !!(q || category);
  return (
    <div>
      <PageHeader title="Templates" subtitle="Reusable playbooks. Apply one to create real tasks with owners, working-day due dates, checklists and dependencies."
        actions={<>
          <Button icon={<FolderInput className="size-4" />} onClick={() => setFromProject(true)}>Save from project</Button>
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => go({ mode: 'new' })}>New template</Button>
        </>} />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 basis-56">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-ink-3" aria-hidden />
          <Input type="search" aria-label="Search templates" placeholder="Search names, descriptions and steps" className="pl-8" value={text} onChange={(e) => setText(e.target.value)} />
        </div>
        <Select aria-label="Category" className="w-auto min-w-40 flex-none" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">All categories</option>
          {TEMPLATE_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </Select>
        <Segmented label="Show" value={view} onChange={setView} options={[{ value: 'active', label: 'In use' }, { value: 'archived', label: 'Archived' }]} />
      </div>
      {list.isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-40" />)}</div>
      ) : list.error ? <ErrorState error={list.error} onRetry={() => list.refetch()} />
        : list.data.templates.length === 0 ? (
          <Card><Empty icon={<LayoutTemplate className="size-6" />} title={filtered ? 'No templates match' : view === 'archived' ? 'Nothing archived' : 'No templates yet'}
            action={filtered ? <Button onClick={() => { setText(''); setQ(''); setCategory(''); }}>Clear filters</Button>
              : view === 'active' ? <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => go({ mode: 'new' })}>New template</Button> : undefined}>
            {filtered ? 'Try another word or category.' : view === 'archived' ? 'Archived templates appear here and can be restored.' : 'Create one, or save a finished project as a template.'}
          </Empty></Card>
        ) : (
          <ul className={cx('grid gap-3 transition-opacity sm:grid-cols-2 xl:grid-cols-3', list.isPlaceholderData && 'opacity-60')} aria-label="Templates" aria-busy={list.isPlaceholderData}>
            {list.data.templates.map((t: any) => (
              <li key={t.id}>
                <Link to={`/templates?t=${t.id}`} className="flex h-full flex-col rounded-xl bg-surface p-4 ring-1 ring-line shadow-card transition hover:ring-accent focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none">
                  <div className="flex items-start gap-3">
                    <CategoryIcon category={t.category} />
                    <div className="min-w-0 flex-1">
                      <h2 className="text-[15px] leading-snug font-semibold break-words">{t.name}</h2>
                      <div className="mt-1 flex flex-wrap gap-1">
                        <Badge>{TEMPLATE_CATEGORY_LABEL[t.category]}</Badge>
                        {t.is_starter && <Badge tone="info">Starter</Badge>}
                        {t.visibility === 'private' && <Badge icon={<Lock className="size-3" aria-hidden />}>Private</Badge>}
                        {t.archived_at && <Badge tone="warning">Archived</Badge>}
                      </div>
                    </div>
                  </div>
                  <p className="mt-2 line-clamp-2 flex-1 text-[13px] text-ink-2">{t.description || 'No description.'}</p>
                  <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-ink-3">
                    <span>{plural(t.item_count, 'step')}</span>
                    {t.total_estimate_minutes > 0 && <span>{hm(t.total_estimate_minutes)} estimated</span>}
                    <span>{spanLabel(t.span_days)}</span>
                    <span>{t.times_applied ? `Used ${plural(t.times_applied, 'time')}` : 'Not used yet'}</span>
                  </div>
                </Link>
              </li>))}
          </ul>
        )}
      <p className="sr-only" role="status">{list.data && !list.isPlaceholderData ? plural(list.data.templates.length, 'template') + (filtered ? ' match' : '') : ''}</p>
      <FromProjectModal open={fromProject} canPublish={!!list.data?.canPublish} onClose={() => setFromProject(false)} onCreated={(tid) => go({ t: tid, mode: 'edit' })} />
    </div>
  );
}

function NewTemplate({ onDone }: { onDone: (id?: string) => void }) {
  const list = useQuery({ queryKey: ['templates', { q: '', category: '', view: 'active' }], queryFn: () => api.get('/api/templates') });
  return (
    <div>
      <BackLink />
      <PageHeader title="New template" subtitle="Describe the steps once; apply them whenever the work comes round again." />
      {list.isLoading ? <Spinner /> : <TemplateEditor template={null} items={[]} canPublish={!!list.data?.canPublish} onCancel={() => onDone()} onSaved={(id) => onDone(id)} />}
    </div>
  );
}

const BackLink = () => (
  <Link to="/templates" className="mb-3 inline-flex items-center gap-1 rounded-md text-[13px] font-medium text-ink-2 hover:text-ink">
    <ChevronLeft className="size-4" aria-hidden />All templates
  </Link>
);

function TemplateDetail({ id, editing, go }: { id: string; editing: boolean; go: (p: Record<string, string>) => void }) {
  const qc = useQueryClient(); const toast = useToast(); const nav = useNavigate();
  const q = useQuery({ queryKey: ['template', id], queryFn: () => api.get(`/api/templates/${id}`) });
  const [applying, setApplying] = useState(false);
  const [versionView, setVersionView] = useState<number | null>(null);
  const [appView, setAppView] = useState<string | null>(null);
  useFocusHeading(editing, !!q.data); // opening the template (or its editor) moves focus to its title
  const err = (e: any) => toast({ tone: 'critical', text: e.message });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['templates'] }); qc.invalidateQueries({ queryKey: ['template', id] }); };
  const duplicate = useMutation({ mutationFn: () => api.post(`/api/templates/${id}/duplicate`, {}),
    onSuccess: (t: any) => { qc.invalidateQueries({ queryKey: ['templates'] }); toast({ tone: 'good', text: 'Private copy created. Edit it to make it yours.' }); nav(`/templates?t=${t.id}`); }, onError: err });
  const archive = useMutation({ mutationFn: (archived: boolean) => api.post(`/api/templates/${id}/archive`, { archived }),
    onSuccess: (_r, archived) => { refresh(); toast({ tone: 'good', text: archived ? 'Archived. Tasks already created are not affected.' : 'Restored', action: archived ? { label: 'Undo', run: () => archive.mutate(false) } : undefined }); },
    onError: err });

  if (q.isLoading) return <div><BackLink /><Skeleton className="mb-4 h-16" /><Skeleton className="h-96" /></div>;
  if (q.error) return <div><BackLink />{[400, 404].includes((q.error as any).status) ? <Card><Empty title="Template not found">It may be private to someone else, or the link is wrong.</Empty></Card> : <ErrorState error={q.error} onRetry={() => q.refetch()} />}</div>;
  const { template: t, items, versions, usage, myApplications, canPublish } = q.data;

  if (editing) {
    if (!t.can_edit || t.archived_at) return <div><BackLink /><Callout tone="warning">You can't edit this template{t.archived_at ? ' while it is archived' : ''}. Duplicate it to make your own copy.</Callout></div>;
    return (
      <div>
        <BackLink />
        <PageHeader eyebrow={`Editing version ${t.version}`} title={t.name} />
        <TemplateEditor template={t} items={items} canPublish={canPublish} onCancel={() => go({ t: id })} onSaved={() => go({ t: id })} />
      </div>
    );
  }

  const totalEstimate = items.reduce((s: number, i: any) => s + (i.estimate_minutes ?? 0), 0);
  const span = items.reduce((m: number | null, i: any) => (i.due_offset_days === null ? m : Math.max(m ?? 0, i.due_offset_days)), null);
  return (
    <div>
      <BackLink />
      <PageHeader
        eyebrow={<span className="inline-flex items-center gap-2"><CategoryIcon category={t.category} size="sm" />{TEMPLATE_CATEGORY_LABEL[t.category]}</span>}
        title={t.name} subtitle={t.description}
        actions={<>
          {t.can_edit && !t.archived_at && <Button icon={<Pencil className="size-4" />} onClick={() => go({ t: id, mode: 'edit' })}>Edit</Button>}
          <Button icon={<Copy className="size-4" />} loading={duplicate.isPending} onClick={() => duplicate.mutate()}>Duplicate</Button>
          {t.can_edit && <Button variant="ghost" icon={t.archived_at ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />} loading={archive.isPending}
            onClick={() => archive.mutate(!t.archived_at)}>{t.archived_at ? 'Restore' : 'Archive'}</Button>}
          <Button variant="primary" icon={<Play className="size-4" />} disabled={!!t.archived_at} onClick={() => setApplying(true)}>Apply template</Button>
        </>} />
      {t.archived_at && <div className="mb-4"><Callout tone="warning">Archived on {fmtDate(t.archived_at)}. Restore it to apply or edit it.</Callout></div>}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2" padded={false} title={`${plural(items.length, 'step')}`}
          subtitle={[totalEstimate ? `${hm(totalEstimate)} estimated` : null, spanLabel(span)].filter(Boolean).join(' · ')}>
          <ol className="divide-y divide-line">
            {items.map((i: any) => (
              <li key={i.position} className="flex gap-3 px-4 py-3">
                <span aria-hidden className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-2 text-[12px] font-semibold text-ink-2 ring-1 ring-line">{i.position}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-x-3">
                    <h3 className="min-w-0 text-sm font-medium break-words"><span className="sr-only">Step {i.position}: </span>{i.title}</h3>
                    <span className="shrink-0 text-[12px] font-medium whitespace-nowrap text-ink-2">{offsetLabel(i.due_offset_days)}</span>
                  </div>
                  {i.description && <p className="mt-0.5 text-[13px] text-ink-2">{i.description}</p>}
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[12px] text-ink-3">
                    <Badge>{CATEGORY_LABEL[i.category]}</Badge>
                    {i.priority !== 'medium' && <Badge tone={i.priority === 'urgent' ? 'critical' : i.priority === 'high' ? 'warning' : 'neutral'}>{PRIORITY_LABEL[i.priority]}</Badge>}
                    {i.estimate_minutes && <span>{hm(i.estimate_minutes)}</span>}
                    {i.owner_hint && <span>Owner: {i.owner_hint}</span>}
                    {i.depends_on.length > 0 && <Badge icon={<GitBranch className="size-3" aria-hidden />}>After step {i.depends_on.join(', ')}</Badge>}
                    {i.requires_review && <Badge tone="warning" icon={<ClipboardCheck className="size-3" aria-hidden />}>Review</Badge>}
                    {i.requires_evidence && <Badge tone="info" icon={<Paperclip className="size-3" aria-hidden />}>Evidence</Badge>}
                  </div>
                  {i.checklist.length > 0 && (
                    <details className="mt-1.5 text-[13px]">
                      <summary className="inline-flex cursor-pointer items-center gap-1 rounded text-[12px] font-medium text-accent-ink"><ListChecks className="size-3.5" aria-hidden />Checklist ({i.checklist.length})</summary>
                      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-ink-2">{i.checklist.map((c: string, ci: number) => <li key={ci}>{c}</li>)}</ul>
                    </details>)}
                </div>
              </li>))}
          </ol>
        </Card>
        <div className="space-y-4">
          <Card title="About">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[13px]">
              <dt className="text-ink-3">Version</dt><dd>{t.version}</dd>
              <dt className="text-ink-3">Who can use it</dt><dd>{t.visibility === 'company' ? 'Everyone in the company' : 'Only you (private)'}</dd>
              <dt className="text-ink-3">Made by</dt><dd>{t.is_starter && !t.created_by_name ? 'Starter template' : t.created_by_name ?? 'Unknown'}</dd>
              <dt className="text-ink-3">Updated</dt><dd>{fmtDateTime(t.updated_at)}</dd>
              <dt className="text-ink-3">Used</dt><dd>{usage.count ? `${plural(usage.count, 'time')}, last ${fmtDate(usage.last_applied_at)}` : 'Not yet'}</dd>
            </dl>
            {!t.can_edit && <p className="mt-3 text-[12px] text-ink-3">{t.visibility === 'company' ? 'Managers and system admins edit company templates.' : ''} Duplicate it to make a copy you can change.</p>}
          </Card>
          <Card title="Your recent uses">
            {myApplications.length === 0 ? <p className="text-[13px] text-ink-3">You haven't applied this template yet.</p> : (
              <ul className="space-y-2">{myApplications.map((ap: any) => (
                <li key={ap.id} className="flex items-center gap-2 text-[13px]">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">Started {fmtDate(ap.start_date)}{ap.project_key && ` · ${ap.project_key}`}</div>
                    <div className="text-[12px] text-ink-3">{plural(ap.task_count, 'task')} · version {ap.template_version} · {fmtDateTime(ap.created_at)}</div>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => setAppView(ap.id)} aria-label={`View tasks created on ${fmtDate(ap.created_at)}`}>View tasks</Button>
                </li>))}</ul>)}
          </Card>
          <Card title="Version history">
            <ul className="space-y-2">{versions.map((v: any) => (
              <li key={v.version} className="flex items-start gap-2 text-[13px]">
                <Badge tone={v.version === t.version ? 'info' : 'neutral'}>v{v.version}</Badge>
                <div className="min-w-0 flex-1">
                  <div className="break-words">{v.change_note || 'No note'}</div>
                  <div className="text-[12px] text-ink-3">{v.created_by_name ?? 'System'} · {fmtDateTime(v.created_at)} · {plural(v.item_count, 'step')}</div>
                </div>
                {v.version !== t.version && <Button size="sm" variant="ghost" onClick={() => setVersionView(v.version)} aria-label={`View version ${v.version}`}>View</Button>}
              </li>))}</ul>
          </Card>
        </div>
      </div>
      <ApplyWizard template={t} items={items} open={applying} onClose={() => setApplying(false)} />
      <VersionModal templateId={id} version={versionView} onClose={() => setVersionView(null)} />
      <ApplicationModal id={appView} onClose={() => setAppView(null)} />
    </div>
  );
}

function VersionModal({ templateId, version, onClose }: { templateId: string; version: number | null; onClose: () => void }) {
  const q = useQuery({ queryKey: ['template-version', templateId, version], queryFn: () => api.get(`/api/templates/${templateId}/versions/${version}`), enabled: version !== null });
  return (
    <Modal open={version !== null} onClose={onClose} title={`Version ${version}`}>
      {q.isLoading ? <Spinner /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : q.data && (
        <div className="space-y-2 text-[13px]">
          <p><span className="font-medium">{q.data.snapshot.name}</span>{q.data.change_note && <span className="text-ink-3"> · {q.data.change_note}</span>}</p>
          <ol className="list-decimal space-y-1 pl-5">{q.data.snapshot.items.map((i: any, n: number) => (
            <li key={n}>{i.title} <span className="text-ink-3">· {offsetLabel(i.dueOffsetDays)}{i.dependsOn?.length ? ` · after step ${i.dependsOn.join(', ')}` : ''}</span></li>))}</ol>
        </div>)}
    </Modal>
  );
}

function ApplicationModal({ id, onClose }: { id: string | null; onClose: () => void }) {
  const q = useQuery({ queryKey: ['template-application', id], queryFn: () => api.get(`/api/template-applications/${id}`), enabled: !!id });
  return (
    <Modal open={!!id} onClose={onClose} title="Tasks created from this template">
      {q.isLoading ? <Spinner /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : q.data && (
        q.data.tasks.length === 0 ? <Empty title="No tasks visible">The tasks may have been moved somewhere you can no longer see.</Empty> : (
          <ul className="divide-y divide-line text-[13px]">{q.data.tasks.map((t: any) => (
            <li key={t.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 py-2">
              <Link to={`/tasks/${t.id}`} className="min-w-0 basis-full font-medium text-accent-ink hover:underline sm:flex-1 sm:basis-0"><span className="text-ink-3">#{t.number}</span> {t.title}</Link>
              <span className="text-ink-2">{t.owner_name}</span>
              <span className="text-ink-3">{t.due_date ? fmtDate(t.due_date) : 'No due date'}</span>
            </li>))}</ul>))}
    </Modal>
  );
}

function FromProjectModal({ open, canPublish, onClose, onCreated }: { open: boolean; canPublish: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const qc = useQueryClient(); const toast = useToast(); const projects = useProjects();
  const [f, setF] = useState({ projectId: '', name: '', category: 'other', visibility: 'private' });
  useEffect(() => { if (open) setF({ projectId: '', name: '', category: 'other', visibility: 'private' }); }, [open]);
  const m = useMutation({ mutationFn: () => api.post('/api/templates/from-project', f),
    onSuccess: (t: any) => { qc.invalidateQueries({ queryKey: ['templates'] }); toast({ tone: 'good', text: 'Template saved. Review the steps and offsets.' }); onClose(); onCreated(t.id); } });
  const pick = (projectId: string) => {
    const p = (projects.data ?? []).find((x: any) => x.id === projectId);
    setF({ ...f, projectId, name: f.name || (p ? `${p.name} playbook`.slice(0, 120) : '') });
  };
  return (
    <Modal open={open} onClose={onClose} title="Save a project as a template"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} disabled={!f.projectId || !f.name.trim()} onClick={() => m.mutate()}>Save template</Button></>}>
      <div className="grid gap-3">
        <Field label="Project">{(id) => <Select id={id} value={f.projectId} onChange={(e) => pick(e.target.value)} disabled={projects.isLoading}>
          <option value="">Choose a project</option>
          {(projects.data ?? []).map((p: any) => <option key={p.id} value={p.id}>{p.key} · {p.name}</option>)}</Select>}</Field>
        <Field label="Template name">{(id) => <Input id={id} value={f.name} maxLength={120} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Category">{(id) => <Select id={id} value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
            {TEMPLATE_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</Select>}</Field>
          <Field label="Who can use it" hint={canPublish ? undefined : 'Managers and system admins publish company templates.'}>{(id) => <Select id={id} value={f.visibility} onChange={(e) => setF({ ...f, visibility: e.target.value })}>
            <option value="private">Only me (private)</option>
            <option value="company" disabled={!canPublish}>Everyone in the company</option></Select>}</Field>
        </div>
        <Callout tone="neutral">
          Copies the project's tasks that you can see (cancelled ones are skipped): titles, estimates, checklists, review and evidence flags, and dependencies.
          Due dates become working-day offsets from the earliest due date. People are not copied; each step keeps the owner's job title as a hint.
        </Callout>
        {m.error && <Callout tone="critical">{(m.error as any).message}</Callout>}
      </div>
    </Modal>
  );
}
