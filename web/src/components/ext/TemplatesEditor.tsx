import { useEffect, useRef, useState } from 'react';
import { useBlocker } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ChevronDown, Plus, Trash2, X } from 'lucide-react';
import { api } from '../../lib/api';
import { CATEGORY_LABEL, PRIORITY_LABEL } from '../../lib/format';
import { Button, Callout, Card, Checkbox, Field, IconButton, Input, Select, Textarea, cx, useToast } from '../ui';
import { TEMPLATE_CATEGORIES, offsetLabel } from './TemplatesShared';

interface Draft {
  key: string; title: string; description: string; category: string; priority: string; estimateMinutes: string; dueOffsetDays: string;
  ownerHint: string; checklist: string[]; requiresReview: boolean; requiresEvidence: boolean; deps: string[]; open: boolean;
}
let seq = 0;
const blank = (): Draft => ({
  key: `n${++seq}`, title: '', description: '', category: 'delivery', priority: 'medium', estimateMinutes: '', dueOffsetDays: '0', ownerHint: '',
  checklist: [], requiresReview: false, requiresEvidence: false, deps: [], open: true,
});
const fromItem = (i: any): Draft => ({
  key: `p${i.position}`, title: i.title, description: i.description ?? '', category: i.category, priority: i.priority,
  estimateMinutes: i.estimate_minutes ? String(i.estimate_minutes) : '', dueOffsetDays: i.due_offset_days === null ? '' : String(i.due_offset_days),
  ownerHint: i.owner_hint ?? '', checklist: i.checklist ?? [], requiresReview: i.requires_review, requiresEvidence: i.requires_evidence,
  deps: (i.depends_on ?? []).map((p: number) => `p${p}`), open: false,
});
const intOrNull = (s: string) => (s.trim() === '' ? null : Number(s));

function problems(d: Draft) {
  const out: Record<string, string> = {};
  if (!d.title.trim()) out.title = 'Give the step a title';
  const off = intOrNull(d.dueOffsetDays);
  if (off !== null && (!Number.isInteger(off) || off < 0 || off > 365)) out.offset = 'Whole days from 0 to 365, or empty';
  const est = intOrNull(d.estimateMinutes);
  if (est !== null && (!Number.isInteger(est) || est < 1 || est > 100000)) out.estimate = 'Whole minutes, at least 1';
  return out;
}

/** Create or edit a template. Steps keep stable keys so reordering never breaks dependencies. */
export function TemplateEditor({ template, items, canPublish, onCancel, onSaved }: {
  template: any | null; items: any[]; canPublish: boolean; onCancel: () => void; onSaved: (id: string) => void;
}) {
  const qc = useQueryClient(); const toast = useToast();
  const [meta, setMeta] = useState({
    name: template?.name ?? '', description: template?.description ?? '', category: template?.category ?? 'other',
    visibility: template?.visibility ?? 'private', changeNote: '',
  });
  const [steps, setSteps] = useState<Draft[]>(() => (items.length ? items.map(fromItem) : [blank()]));
  const [tried, setTried] = useState(false);
  const [error, setError] = useState<{ message: string; stale?: boolean } | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [focusKey, setFocusKey] = useState<string | null>(null);

  // Leaving with unsaved edits asks first (in-app navigation and tab close); saving or an explicit discard skips the prompt.
  const snapshot = JSON.stringify([meta, steps.map((d) => ({ ...d, open: undefined }))]);
  const initial = useRef(snapshot); const leaving = useRef(false);
  const dirty = snapshot !== initial.current;
  const blocker = useBlocker(({ currentLocation: c, nextLocation: n }) => dirty && !leaving.current && (c.pathname !== n.pathname || c.search !== n.search));
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    if (window.confirm('Discard your unsaved changes to this template?')) blocker.proceed(); else blocker.reset();
  }, [blocker.state]);
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);
  useEffect(() => { if (attempt) formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(); }, [attempt]);

  const patch = (key: string, p: Partial<Draft>) => setSteps((s) => s.map((d) => (d.key === key ? { ...d, ...p } : d)));
  const move = (i: number, dir: -1 | 1) => setSteps((s) => { const n = [...s]; [n[i], n[i + dir]] = [n[i + dir], n[i]]; return n; });
  const remove = (key: string) => {
    const i = steps.findIndex((d) => d.key === key);
    setSteps((s) => s.filter((d) => d.key !== key).map((d) => ({ ...d, deps: d.deps.filter((k) => k !== key) })));
    setFocusKey((steps[i + 1] ?? steps[i - 1])?.key ?? null); // the removed step's buttons are gone: keep focus nearby
  };
  const add = () => { const b = blank(); setSteps((s) => [...s, b]); setFocusKey(b.key); };

  const invalid = !meta.name.trim() || steps.some((d) => Object.keys(problems(d)).length > 0);
  const save = useMutation({
    mutationFn: () => {
      const pos = new Map(steps.map((d, i) => [d.key, i + 1]));
      const body = {
        name: meta.name.trim(), description: meta.description, category: meta.category, visibility: meta.visibility,
        items: steps.map((d) => ({
          title: d.title.trim(), description: d.description, category: d.category, priority: d.priority,
          estimateMinutes: intOrNull(d.estimateMinutes), dueOffsetDays: intOrNull(d.dueOffsetDays), ownerHint: d.ownerHint.trim(),
          checklist: d.checklist.map((c) => c.trim()).filter(Boolean), requiresReview: d.requiresReview, requiresEvidence: d.requiresEvidence,
          dependsOn: d.deps.map((k) => pos.get(k)!).filter(Boolean),
        })),
      };
      return template ? api.put(`/api/templates/${template.id}`, { ...body, version: template.version, changeNote: meta.changeNote.trim() }) : api.post('/api/templates', body);
    },
    onSuccess: (t: any) => {
      qc.invalidateQueries({ queryKey: ['templates'] }); qc.invalidateQueries({ queryKey: ['template', t.id] });
      toast({ tone: 'good', text: template ? `Saved as version ${t.version}` : 'Template created' });
      leaving.current = true; onSaved(t.id);
    },
    onError: (e: any) => setError({ message: e.message, stale: e.status === 409 }),
  });
  const submit = () => { setTried(true); setError(null); if (invalid) setAttempt((n) => n + 1); else save.mutate(); };

  return (
    <form ref={formRef} className="space-y-4" onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate>
      <Card title="Template details">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" className="sm:col-span-2" error={tried && !meta.name.trim() ? 'Name the template' : null}>{(id) =>
            <Input id={id} value={meta.name} maxLength={120} aria-invalid={tried && !meta.name.trim()} onChange={(e) => setMeta({ ...meta, name: e.target.value })} placeholder="e.g. Client renewal" />}</Field>
          <Field label="Description" className="sm:col-span-2" hint="When to use it and what it achieves.">{(id) =>
            <Textarea id={id} rows={2} value={meta.description} maxLength={5000} onChange={(e) => setMeta({ ...meta, description: e.target.value })} />}</Field>
          <Field label="Category">{(id) => <Select id={id} value={meta.category} onChange={(e) => setMeta({ ...meta, category: e.target.value })}>
            {TEMPLATE_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</Select>}</Field>
          <Field label="Who can use it" hint={canPublish ? 'Company templates can be edited by managers and system admins.' : 'Managers and system admins publish company templates.'}>{(id) =>
            <Select id={id} value={meta.visibility} onChange={(e) => setMeta({ ...meta, visibility: e.target.value })}>
              <option value="private">Only me (private)</option>
              <option value="company" disabled={!canPublish && meta.visibility !== 'company'}>Everyone in the company</option>
            </Select>}</Field>
        </div>
      </Card>

      <Card title={`Steps (${steps.length})`} subtitle="Due dates count the owner's working days from the start date chosen when applying.">
        <ol className="space-y-3">
          {steps.map((d, i) => (
            <StepEditor key={d.key} d={d} n={i + 1} total={steps.length} others={steps.filter((o) => o.key !== d.key).map((o) => ({ key: o.key, label: `${steps.indexOf(o) + 1}. ${o.title || 'Untitled step'}` }))}
              errors={tried ? problems(d) : {}} onChange={(p) => patch(d.key, p)} onMove={(dir) => move(i, dir)} onRemove={() => remove(d.key)}
              focusTitle={focusKey === d.key} onFocused={() => setFocusKey(null)} />
          ))}
        </ol>
        <Button type="button" className="mt-3" icon={<Plus className="size-4" />} onClick={add} disabled={steps.length >= 100}>Add step</Button>
      </Card>

      {template && (
        <Card>
          <Field label="What changed? (optional)" hint={`Saving creates version ${template.version + 1}. Tasks already created keep the version they came from.`}>{(id) =>
            <Input id={id} value={meta.changeNote} maxLength={500} onChange={(e) => setMeta({ ...meta, changeNote: e.target.value })} placeholder="e.g. Added the payroll step" />}</Field>
        </Card>
      )}

      {error && <Callout tone="critical">{error.message}{error.stale && <> <button type="button" className="font-semibold underline" onClick={() => { qc.invalidateQueries({ queryKey: ['template', template?.id] }); leaving.current = true; onCancel(); }}>Discard my changes and reload</button></>}</Callout>}
      {tried && invalid && !error && <Callout tone="warning">Fix the highlighted fields before saving.</Callout>}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="primary" loading={save.isPending}>{template ? 'Save new version' : 'Create template'}</Button>
      </div>
    </form>
  );
}

function StepEditor({ d, n, total, others, errors, onChange, onMove, onRemove, focusTitle, onFocused }: {
  d: Draft; n: number; total: number; others: { key: string; label: string }[]; errors: Record<string, string>;
  onChange: (p: Partial<Draft>) => void; onMove: (dir: -1 | 1) => void; onRemove: () => void; focusTitle: boolean; onFocused: () => void;
}) {
  const [item, setItem] = useState('');
  const titleRef = useRef<HTMLInputElement>(null); const upRef = useRef<HTMLButtonElement>(null); const downRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (focusTitle) { titleRef.current?.focus(); onFocused(); } }, [focusTitle]);
  // A move button that just became disabled (step reached the top or bottom) would drop keyboard focus: hand it to its sibling.
  useEffect(() => {
    const a = document.activeElement;
    if (n === 1 && a === upRef.current) downRef.current?.focus();
    else if (n === total && a === downRef.current) upRef.current?.focus();
  }, [n, total]);
  const addItem = () => { if (item.trim()) { onChange({ checklist: [...d.checklist, item.trim()] }); setItem(''); } };
  const label = d.title.trim() || `step ${n}`;
  const flags = [d.requiresReview && 'review', d.requiresEvidence && 'evidence', d.checklist.length && `${d.checklist.length} checklist`, d.deps.length && `after ${d.deps.length}`].filter(Boolean);
  return (
    <li className={cx('rounded-xl bg-surface-2/50 p-3 ring-1 ring-line', Object.keys(errors).length > 0 && 'ring-critical')}>
      <div role="group" aria-label={`Step ${n}: ${label}`}>
        <div className="flex items-start gap-2">
          <span aria-hidden className="mt-7 inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-surface text-[12px] font-semibold text-ink-2 ring-1 ring-line">{n}</span>
          <div className="grid min-w-0 flex-1 grid-cols-2 gap-2 sm:grid-cols-[minmax(0,1fr)_8rem_8rem]">
            <Field label={`Step ${n} title`} error={errors.title} className="col-span-2 sm:col-span-1">{(id) => <Input ref={titleRef} id={id} value={d.title} maxLength={300} aria-invalid={!!errors.title} onChange={(e) => onChange({ title: e.target.value })} placeholder="What needs doing" />}</Field>
            <Field label="Due (work day)" error={errors.offset} hint={offsetLabel(intOrNull(d.dueOffsetDays))}>{(id) =>
              <Input id={id} type="number" inputMode="numeric" min={0} max={365} aria-invalid={!!errors.offset} value={d.dueOffsetDays} onChange={(e) => onChange({ dueOffsetDays: e.target.value })} />}</Field>
            <Field label="Estimate (min)" error={errors.estimate}>{(id) =>
              <Input id={id} type="number" inputMode="numeric" min={1} aria-invalid={!!errors.estimate} value={d.estimateMinutes} onChange={(e) => onChange({ estimateMinutes: e.target.value })} />}</Field>
          </div>
          <div className="mt-6 flex shrink-0 flex-col gap-0.5 sm:flex-row">
            <IconButton ref={upRef} type="button" label={`Move ${label} up`} disabled={n === 1} onClick={() => onMove(-1)} className="disabled:opacity-30"><ArrowUp className="size-4" /></IconButton>
            <IconButton ref={downRef} type="button" label={`Move ${label} down`} disabled={n === total} onClick={() => onMove(1)} className="disabled:opacity-30"><ArrowDown className="size-4" /></IconButton>
            <IconButton type="button" label={`Remove ${label}`} disabled={total === 1} onClick={onRemove} className="hover:text-critical-ink disabled:opacity-30"><Trash2 className="size-4" /></IconButton>
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 pl-8">
          <button type="button" aria-expanded={d.open} onClick={() => onChange({ open: !d.open })}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[13px] font-medium text-accent-ink hover:bg-surface-2">
            <ChevronDown className={cx('size-3.5 transition-transform', d.open && 'rotate-180')} aria-hidden />{d.open ? 'Hide details' : 'More details'}
          </button>
          {!d.open && flags.length > 0 && <span className="text-[12px] text-ink-3">{flags.join(' · ')}</span>}
        </div>
        {d.open && (
          <div className="mt-2 grid gap-3 pl-8 sm:grid-cols-2">
            <Field label="Owner hint" hint="A role, not a person, e.g. Finance lead.">{(id) =>
              <Input id={id} value={d.ownerHint} maxLength={80} onChange={(e) => onChange({ ownerHint: e.target.value })} />}</Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Category">{(id) => <Select id={id} value={d.category} onChange={(e) => onChange({ category: e.target.value })}>
                {Object.entries(CATEGORY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}</Field>
              <Field label="Priority">{(id) => <Select id={id} value={d.priority} onChange={(e) => onChange({ priority: e.target.value })}>
                {Object.entries(PRIORITY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}</Field>
            </div>
            <Field label="Description" className="sm:col-span-2">{(id) =>
              <Textarea id={id} rows={2} value={d.description} maxLength={5000} onChange={(e) => onChange({ description: e.target.value })} />}</Field>
            <div className="flex flex-wrap gap-x-5 gap-y-2 sm:col-span-2">
              <Checkbox checked={d.requiresReview} onChange={(v) => onChange({ requiresReview: v })} label="Needs review before Done" />
              <Checkbox checked={d.requiresEvidence} onChange={(v) => onChange({ requiresEvidence: v })} label="Needs evidence attached" />
            </div>
            <fieldset className="min-w-0">
              <legend className="mb-1.5 text-[13px] font-medium text-ink-2">Checklist</legend>
              {d.checklist.length > 0 && <ul className="mb-2 space-y-1">{d.checklist.map((c, ci) => (
                <li key={ci} className="flex items-center gap-1">
                  <Input aria-label={`Checklist item ${ci + 1}`} className="h-8" value={c} maxLength={300}
                    onChange={(e) => onChange({ checklist: d.checklist.map((x, xi) => (xi === ci ? e.target.value : x)) })} />
                  <IconButton type="button" label={`Remove checklist item ${ci + 1}`} onClick={() => onChange({ checklist: d.checklist.filter((_, xi) => xi !== ci) })}><X className="size-4" /></IconButton>
                </li>))}</ul>}
              <div className="flex gap-1">
                <Input aria-label={`New checklist item for ${label}`} className="h-8" value={item} maxLength={300} placeholder="Add a checklist item"
                  onChange={(e) => setItem(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addItem(); } }} />
                <Button type="button" size="sm" className="h-8" onClick={addItem} disabled={!item.trim() || d.checklist.length >= 50}>Add</Button>
              </div>
            </fieldset>
            <fieldset className="min-w-0">
              <legend className="mb-1.5 text-[13px] font-medium text-ink-2">Starts after</legend>
              {others.length === 0 ? <p className="text-[12px] text-ink-3">Add another step to set dependencies.</p> : (
                <div className="max-h-40 space-y-1.5 overflow-y-auto">{others.map((o) => (
                  <div key={o.key}><Checkbox checked={d.deps.includes(o.key)} label={<span className="break-words">{o.label}</span>}
                    onChange={(v) => onChange({ deps: v ? [...d.deps, o.key] : d.deps.filter((k) => k !== o.key) })} /></div>))}
                </div>)}
            </fieldset>
          </div>
        )}
      </div>
    </li>
  );
}
