import { useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, CircleDashed, FlaskConical, Plus, Search, Trash2, XCircle } from 'lucide-react';
import { api, qs } from '../../lib/api';
import { CATEGORY_LABEL, PRIORITY_LABEL, STATUSES, STATUS_LABEL } from '../../lib/format';
import { useMe } from '../../lib/session';
import { Badge, Button, Callout, Field, IconButton, Input, Modal, Segmented, Select, Spinner, StatusBadge, Textarea, cx, useToast } from '../ui';
import { useProjects, useUsers } from '../TaskStatus';

// ---------- Rule model (mirrors server/src/services/ext/automation.ts) ----------
export type Trigger = { type: string; from?: string | null; to?: string | null; decision?: string | null; days?: number };
export type Conditions = { projectIds?: string[]; categories?: string[]; priorities?: string[]; tags?: string[]; ownerIds?: string[]; statuses?: string[] };
export type Action = { type: string; target?: string; owner?: string; userId?: string | null; message?: string; title?: string; dueInDays?: number | null; priority?: string; text?: string };
export interface Draft { id?: string; version?: number; name: string; description: string; enabled: boolean; scope: 'company' | 'team'; trigger: Trigger; conditions: Conditions; actions: Action[]; preset?: string | null }
export interface Lookups { projects: Map<string, string>; users: Map<string, string>; ownerName?: string }

export const TRIGGERS = [
  { value: 'task.created', label: 'A task is created' },
  { value: 'task.status_changed', label: 'A task changes status' },
  { value: 'blocker.raised', label: 'A blocker is raised' },
  { value: 'task.reviewed', label: 'A task is reviewed' },
  { value: 'task.reopened', label: 'A task is reopened' },
  { value: 'task.due_soon', label: 'A task is due soon (checked hourly)' },
  { value: 'task.overdue', label: 'A task is overdue (checked hourly)' },
];
export const TRIGGER_SHORT: Record<string, string> = {
  'task.created': 'Task created', 'task.status_changed': 'Status changed', 'blocker.raised': 'Blocker raised', 'task.reviewed': 'Task reviewed',
  'task.reopened': 'Task reopened', 'task.due_soon': 'Due soon', 'task.overdue': 'Overdue',
};
const ACTION_TYPES = [
  { value: 'notify', label: 'Send a notification' },
  { value: 'create_follow_up', label: 'Create a follow-up task' },
  { value: 'set_priority', label: 'Set priority' },
  { value: 'set_reviewer', label: 'Set a reviewer (review required)' },
  { value: 'add_checklist_item', label: 'Add a checklist item' },
  { value: 'add_comment', label: 'Post a comment' },
  { value: 'assign', label: 'Assign to someone' },
];
const TARGETS = [{ value: 'owner', label: 'The task owner' }, { value: 'manager', label: 'The owner\'s manager' }, { value: 'reviewer', label: 'The reviewer' }, { value: 'user', label: 'A specific person' }];
const DEFAULT_ACTION: Record<string, Action> = {
  notify: { type: 'notify', target: 'owner', message: '' },
  create_follow_up: { type: 'create_follow_up', title: 'Follow up: {task.title}', owner: 'owner', dueInDays: 2 },
  set_priority: { type: 'set_priority', priority: 'high' },
  set_reviewer: { type: 'set_reviewer', target: 'manager' },
  add_checklist_item: { type: 'add_checklist_item', text: '' },
  add_comment: { type: 'add_comment', text: '' },
  assign: { type: 'assign', userId: '' },
};
export const TEMPLATE_HINT = 'You can use {task.title}, {task.number}, {task.due}, {project.key} and {owner.name}.';

export function emptyDraft(scope: 'company' | 'team'): Draft {
  return { name: '', description: '', enabled: true, scope, trigger: { type: 'task.status_changed', from: null, to: 'blocked' }, conditions: {}, actions: [{ ...DEFAULT_ACTION.notify, target: 'manager' }] };
}
export function draftFrom(r: any): Draft {
  return { id: r.id, version: r.version, name: r.name, description: r.description ?? '', enabled: r.enabled ?? true, scope: r.scope, trigger: { ...r.trigger },
    conditions: { ...(r.conditions ?? {}) }, actions: (r.actions ?? []).map((a: Action) => ({ ...a })), preset: r.preset ?? r.key ?? null };
}

// ---------- Plain-language description ----------
const orList = (xs: string[]) => xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1]}`;
const andList = (xs: string[]) => xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
const quote = (s = '', n = 48) => `"${s.length > n ? `${s.slice(0, n - 1)}…` : s}"`;
const who = (target: string | undefined, userId: string | null | undefined, l: Lookups) =>
  target === 'owner' ? 'the owner' : target === 'manager' ? 'the owner\'s manager' : target === 'reviewer' ? 'the reviewer' : (userId && l.users.get(userId)) || 'someone (choose a person)';

function taskPhrase(c: Conditions, l: Lookups) {
  const adj = [c.priorities?.length && orList(c.priorities.map((p) => PRIORITY_LABEL[p].toLowerCase())),
    c.categories?.length && orList(c.categories.map((x) => CATEGORY_LABEL[x].toLowerCase()))].filter(Boolean) as string[];
  const noun = [...adj, 'task'].join(' ');
  let s = `${/^[aeiou]/i.test(noun) ? 'an' : 'a'} ${noun}`;
  if (c.projectIds?.length) s += ` in ${orList(c.projectIds.map((id) => l.projects.get(id) ?? 'a private project'))}`;
  if (c.ownerIds?.length) s += ` owned by ${orList(c.ownerIds.map((id) => l.users.get(id) ?? 'someone'))}`;
  if (c.tags?.length) s += ` tagged ${orList(c.tags.map((t) => `#${t}`))}`;
  if (c.statuses?.length) s += ` with status ${orList(c.statuses.map((x) => STATUS_LABEL[x]))}`;
  return s;
}
function triggerPhrase(t: Trigger, tp: string) {
  switch (t.type) {
    case 'task.created': return `When ${tp} is created`;
    case 'task.status_changed':
      return t.from && t.to ? `When ${tp} moves from ${STATUS_LABEL[t.from]} to ${STATUS_LABEL[t.to]}` : t.to ? `When ${tp} moves to ${STATUS_LABEL[t.to]}`
        : t.from ? `When ${tp} moves out of ${STATUS_LABEL[t.from]}` : `When ${tp} changes status`;
    case 'blocker.raised': return `When a blocker is raised on ${tp}`;
    case 'task.reviewed': return t.decision === 'changes_requested' ? `When a reviewer requests changes on ${tp}` : t.decision === 'accepted' ? `When a reviewer accepts ${tp}` : `When ${tp} is reviewed`;
    case 'task.reopened': return `When ${tp} is reopened`;
    case 'task.due_soon': { const d = t.days ?? 1; return d === 0 ? `When ${tp} is due today` : d === 1 ? `When ${tp} is due by tomorrow` : `When ${tp} is due within ${d} days`; }
    case 'task.overdue': { const d = t.days ?? 1; return d === 1 ? `When ${tp} is a day overdue` : `When ${tp} is ${d} days overdue`; }
    default: return `When ${tp} changes`;
  }
}
function actionPhrase(a: Action, l: Lookups) {
  switch (a.type) {
    case 'notify': return `notify ${who(a.target, a.userId, l)}`;
    case 'create_follow_up': return `create a follow-up ${quote(a.title)} for ${who(a.owner, a.userId, l)}${a.dueInDays === null || a.dueInDays === undefined ? '' : a.dueInDays === 0 ? ' due the same day' : ` due in ${a.dueInDays} day${a.dueInDays === 1 ? '' : 's'}`}`;
    case 'set_priority': return `set priority to ${PRIORITY_LABEL[a.priority ?? 'medium']}`;
    case 'set_reviewer': return `make ${who(a.target, a.userId, l)} the reviewer`;
    case 'add_checklist_item': return `add ${quote(a.text)} to the checklist`;
    case 'add_comment': return `post the comment ${quote(a.text)}`;
    case 'assign': return `assign it to ${(a.userId && l.users.get(a.userId)) || 'someone (choose a person)'}`;
    default: return a.type;
  }
}
/** "When a task in WEB moves to Blocked, notify the owner's manager." */
export function describeRule(r: Pick<Draft, 'trigger' | 'conditions' | 'actions' | 'scope'>, l: Lookups) {
  const s = `${triggerPhrase(r.trigger, taskPhrase(r.conditions ?? {}, l))}, ${andList((r.actions ?? []).map((a) => actionPhrase(a, l)))}.`;
  return r.scope === 'team' ? `${s} Only for tasks owned by ${l.ownerName ? `${l.ownerName}'s` : 'your'} team.` : s;
}
export function useLookups() {
  const users = useUsers(); const projects = useProjects();
  return useMemo<Lookups>(() => ({
    users: new Map((users.data ?? []).map((u: any) => [u.id, u.name])),
    projects: new Map((projects.data ?? []).map((p: any) => [p.id, p.key])),
  }), [users.data, projects.data]);
}

// ---------- Small controls ----------
function ChipGroup({ label, options, value, onChange }: { label: string; options: { value: string; label: string }[]; value: string[] | undefined; onChange: (v: string[]) => void }) {
  const cur = value ?? [];
  return (
    <fieldset>
      <legend className="text-[13px] font-medium text-ink-2">{label}</legend>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {options.map((o) => {
          const on = cur.includes(o.value);
          return <button key={o.value} type="button" aria-pressed={on} onClick={() => onChange(on ? cur.filter((x) => x !== o.value) : [...cur, o.value])}
            className={cx('rounded-full px-2.5 py-1 text-[12.5px] font-medium ring-1 ring-inset', on ? 'bg-accent-soft text-accent-ink ring-accent' : 'bg-surface text-ink-2 ring-line-strong hover:bg-surface-2')}>{o.label}</button>;
        })}
      </div>
    </fieldset>
  );
}
function PickList({ label, options, value, onChange, placeholder }: { label: string; options: { value: string; label: string }[]; value: string[] | undefined; onChange: (v: string[]) => void; placeholder: string }) {
  const cur = value ?? [];
  const byId = new Map(options.map((o) => [o.value, o.label]));
  return (
    <Field label={label}>{(id) => (
      <div className="space-y-1.5">
        <Select id={id} value="" onChange={(e) => e.target.value && onChange([...cur, e.target.value])}>
          <option value="">{placeholder}</option>
          {options.filter((o) => !cur.includes(o.value)).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </Select>
        {cur.length > 0 && <ul className="flex flex-wrap gap-1.5">{cur.map((v) => (
          <li key={v} className="inline-flex items-center gap-1 rounded-full bg-accent-soft py-0.5 pl-2.5 pr-1 text-[12.5px] font-medium text-accent-ink">
            {byId.get(v) ?? 'Unavailable'}
            <button type="button" aria-label={`Remove ${byId.get(v) ?? 'item'}`} onClick={() => onChange(cur.filter((x) => x !== v))} className="rounded-full p-0.5 hover:bg-surface"><XCircle className="size-3.5" aria-hidden /></button>
          </li>))}</ul>}
      </div>)}
    </Field>
  );
}
function Step({ n, title, hint, children }: { n: number; title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="rounded-xl bg-surface-2/60 p-3.5 ring-1 ring-line sm:p-4" aria-labelledby={`step-${n}`}>
      <div className="mb-3 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span aria-hidden className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-accent text-[11px] font-semibold text-on-accent">{n}</span>
        <h3 id={`step-${n}`} className="whitespace-nowrap text-[14px] font-semibold">{title}</h3>
        {hint && <span className="text-[12px] text-ink-3">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

// ---------- Builder ----------
export function RuleBuilder({ open, onClose, initial, permissions }: { open: boolean; onClose: () => void; initial: Draft; permissions: { company: boolean; team: boolean } }) {
  const qc = useQueryClient(); const toast = useToast(); const me = useMe();
  const users = useUsers(); const projects = useProjects(); const lookups = useLookups();
  const [d, setD] = useState<Draft>(initial);
  const [tagText, setTagText] = useState((initial.conditions.tags ?? []).join(', '));
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const editing = !!d.id;
  const teamIds = new Set([me.user.id, ...me.user.managedUserIds]);
  const people = (users.data ?? []).filter((u: any) => d.scope === 'company' || teamIds.has(u.id)).map((u: any) => ({ value: u.id, label: u.name }));
  const owners = d.scope === 'team' ? people.filter((p: any) => p.value !== me.user.id) : people;
  const setTrigger = (t: Partial<Trigger>) => setD({ ...d, trigger: { ...d.trigger, ...t } });
  const setCond = (k: keyof Conditions, v: string[]) => setD({ ...d, conditions: { ...d.conditions, [k]: v } });
  const setAction = (i: number, a: Action) => setD({ ...d, actions: d.actions.map((x, j) => (j === i ? a : x)) });
  const needsUser = (a: Action) => (a.type === 'assign' || a.target === 'user' || a.owner === 'user') && !a.userId;
  const missing = !d.name.trim() ? 'Give the rule a name' : d.actions.some(needsUser) ? 'Choose a person for each action that needs one'
    : d.actions.some((a) => ['add_checklist_item', 'add_comment'].includes(a.type) && !a.text?.trim()) ? 'Fill in the text for each action'
    : d.actions.some((a) => a.type === 'create_follow_up' && !a.title?.trim()) ? 'Give the follow-up task a title' : null;
  const payload = () => {
    const conditions: Conditions = {};
    for (const [k, v] of Object.entries({ ...d.conditions, tags: tagText.split(',').map((t) => t.trim().replace(/^#/, '')).filter(Boolean) }))
      if (Array.isArray(v) && v.length) (conditions as any)[k] = v;
    const actions = d.actions.map((a) => {
      const out: any = { ...a };
      if (a.type === 'notify' && !a.message?.trim()) delete out.message;
      if (!(a.type === 'assign' || a.target === 'user' || a.owner === 'user')) delete out.userId;
      if (a.type === 'create_follow_up' && !a.priority) delete out.priority;
      return out;
    });
    return { name: d.name.trim(), description: d.description, enabled: d.enabled, scope: d.scope, trigger: d.trigger, conditions, actions, preset: d.preset ?? null };
  };
  const save = useMutation({
    mutationFn: () => editing ? api.put(`/api/automations/${d.id}`, { ...payload(), version: d.version }) : api.post('/api/automations', payload()),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['automations'] }); toast({ tone: 'good', text: editing ? 'Rule saved' : `Rule "${d.name.trim()}" created${d.enabled ? ' and running' : ''}` }); onClose(); },
    onError: (e: any) => setError(e.message),
  });
  const preview = describeRule({ ...payload(), scope: d.scope } as Draft, { ...lookups, ownerName: d.scope === 'team' ? me.user.name : undefined });
  const t = d.trigger;

  return (
    <Modal open={open} onClose={onClose} width="max-w-3xl" title={editing ? 'Edit automation rule' : 'New automation rule'}
      footer={<>
        {missing && <span className="mr-auto self-center text-[12px] text-ink-3">{missing}</span>}
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!!missing} loading={save.isPending} onClick={() => { setError(null); save.mutate(); }}>{editing ? 'Save rule' : 'Create rule'}</Button>
      </>}>
      <div className="grid gap-4">
        {error && <Callout tone="critical">{error}</Callout>}
        <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <Field label="Rule name">{(id) => <Input id={id} value={d.name} maxLength={120} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder="Escalate blocked finance tasks" data-autofocus />}</Field>
          {editing || !(permissions.company && permissions.team)
            ? <div className="text-[13px] text-ink-2"><span className="block text-[13px] font-medium text-ink-2">Scope</span><Badge tone={d.scope === 'company' ? 'info' : 'neutral'} className="mt-2">{d.scope === 'company' ? 'Company-wide' : 'My team'}</Badge></div>
            : <div><span className="mb-1.5 block text-[13px] font-medium text-ink-2">Scope</span>
                <Segmented label="Scope" value={d.scope} onChange={(v) => setD({ ...d, scope: v, conditions: { ...d.conditions, ownerIds: [] } })}
                  options={[{ value: 'company', label: 'Company-wide' }, { value: 'team', label: 'My team' }]} /></div>}
        </div>

        <div className="z-10 -mx-1 bg-surface px-1 pb-1 sm:sticky sm:-top-4 sm:pt-1">
          <div aria-live="polite" className="rounded-xl bg-accent-soft px-4 py-3 text-accent-ink">
            <div className="text-[11px] font-semibold uppercase tracking-wide">In plain words</div>
            <p className="mt-1 text-[14px] leading-relaxed">{preview}</p>
          </div>
        </div>

        <Step n={1} title="When">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Trigger">{(id) => <Select id={id} value={t.type} onChange={(e) => setD({ ...d, trigger: { type: e.target.value, ...(e.target.value.startsWith('task.due') || e.target.value === 'task.overdue' ? { days: 1 } : {}) } })}>
              {TRIGGERS.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}</Select>}</Field>
            {t.type === 'task.status_changed' && <div className="grid grid-cols-2 gap-3">
              <Field label="From">{(id) => <Select id={id} value={t.from ?? ''} onChange={(e) => setTrigger({ from: e.target.value || null })}><option value="">Any status</option>{STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}</Select>}</Field>
              <Field label="To">{(id) => <Select id={id} value={t.to ?? ''} onChange={(e) => setTrigger({ to: e.target.value || null })}><option value="">Any status</option>{STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}</Select>}</Field>
            </div>}
            {t.type === 'task.reviewed' && <Field label="Review outcome">{(id) => <Select id={id} value={t.decision ?? ''} onChange={(e) => setTrigger({ decision: e.target.value || null })}>
              <option value="">Any outcome</option><option value="changes_requested">Changes requested</option><option value="accepted">Accepted</option></Select>}</Field>}
            {t.type === 'task.due_soon' && <Field label="Days before the due date" hint="0 = due today. Fires once per task and due date.">{(id) =>
              <Input id={id} type="number" min={0} max={30} value={t.days ?? 1} onChange={(e) => setTrigger({ days: Math.max(0, Math.min(30, Number(e.target.value) || 0)) })} />}</Field>}
            {t.type === 'task.overdue' && <Field label="Days overdue" hint="Fires once per task and due date (looks back 30 days).">{(id) =>
              <Input id={id} type="number" min={1} max={30} value={t.days ?? 1} onChange={(e) => setTrigger({ days: Math.max(1, Math.min(30, Number(e.target.value) || 1)) })} />}</Field>}
          </div>
        </Step>

        <Step n={2} title="Only if" hint="Optional. Each filter matches any of its choices.">
          <div className="grid gap-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <PickList label="Project" placeholder="Any project. Add one…" value={d.conditions.projectIds} onChange={(v) => setCond('projectIds', v)}
                options={(projects.data ?? []).filter((p: any) => p.status !== 'archived').map((p: any) => ({ value: p.id, label: `${p.key} · ${p.name}` }))} />
              <PickList label={d.scope === 'team' ? 'Owner (your team)' : 'Owner'} placeholder="Anyone. Add a person…" value={d.conditions.ownerIds} onChange={(v) => setCond('ownerIds', v)} options={owners} />
            </div>
            <ChipGroup label="Category" value={d.conditions.categories} onChange={(v) => setCond('categories', v)} options={Object.entries(CATEGORY_LABEL).map(([value, label]) => ({ value, label }))} />
            <ChipGroup label="Priority" value={d.conditions.priorities} onChange={(v) => setCond('priorities', v)} options={Object.entries(PRIORITY_LABEL).map(([value, label]) => ({ value, label }))} />
            <ChipGroup label="Status (after the change)" value={d.conditions.statuses} onChange={(v) => setCond('statuses', v)} options={STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] }))} />
            <Field label="Tags" hint="Comma-separated, for example a11y, client">{(id) => <Input id={id} value={tagText} onChange={(e) => setTagText(e.target.value)} placeholder="Any tag" />}</Field>
          </div>
        </Step>

        <Step n={3} title="Then">
          <ol className="grid gap-3">
            {d.actions.map((a, i) => (
              <li key={i} className="rounded-lg bg-surface p-3 ring-1 ring-line">
                <div className="flex items-end gap-2">
                  <Field label={`Action ${i + 1}`} className="flex-1">{(id) => <Select id={id} value={a.type} onChange={(e) => setAction(i, { ...DEFAULT_ACTION[e.target.value] })}>
                    {ACTION_TYPES.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}</Select>}</Field>
                  <IconButton label={`Remove action ${i + 1}`} disabled={d.actions.length === 1} className="mb-0.5 disabled:opacity-40" onClick={() => setD({ ...d, actions: d.actions.filter((_, j) => j !== i) })}>
                    <Trash2 className="size-4" aria-hidden /></IconButton>
                </div>
                <div className="mt-3"><ActionFields a={a} onChange={(x) => setAction(i, x)} people={people} /></div>
              </li>
            ))}
          </ol>
          <Button className="mt-3" size="sm" icon={<Plus className="size-4" aria-hidden />} disabled={d.actions.length >= 6}
            onClick={() => setD({ ...d, actions: [...d.actions, { ...DEFAULT_ACTION.notify }] })}>Add action</Button>
        </Step>

        <label className="inline-flex items-center gap-2 text-sm"><input type="checkbox" className="size-4 accent-[var(--accent)]" checked={d.enabled} onChange={(e) => setD({ ...d, enabled: e.target.checked })} />Turn the rule on when saved</label>

        <div className="rounded-xl ring-1 ring-line">
          <button type="button" aria-expanded={testing} onClick={() => setTesting(!testing)} className="flex w-full items-center gap-2 px-4 py-3 text-left text-[14px] font-medium">
            <FlaskConical className="size-4 text-ink-3" aria-hidden />Test against a task<span className="ml-auto text-[12px] font-normal text-ink-3">Dry run, changes nothing</span>
          </button>
          {testing && <div className="border-t border-line p-4">{missing ? <p className="text-[13px] text-ink-3">{missing} to test it.</p>
            : <TestPanel rule={payload()} ruleId={d.id} />}</div>}
        </div>
      </div>
    </Modal>
  );
}

function ActionFields({ a, onChange, people }: { a: Action; onChange: (a: Action) => void; people: { value: string; label: string }[] }) {
  const person = (labelText: string) => (
    <Field label={labelText}>{(id) => <Select id={id} value={a.userId ?? ''} onChange={(e) => onChange({ ...a, userId: e.target.value })}>
      <option value="">Choose a person…</option>{people.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</Select>}</Field>
  );
  switch (a.type) {
    case 'notify': return (
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Notify">{(id) => <Select id={id} value={a.target} onChange={(e) => onChange({ ...a, target: e.target.value })}>{TARGETS.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}</Select>}</Field>
        {a.target === 'user' && person('Person')}
        <Field label="Message (optional)" hint={TEMPLATE_HINT} className="sm:col-span-2">{(id) => <Input id={id} value={a.message ?? ''} maxLength={300} placeholder="Rule name: task title" onChange={(e) => onChange({ ...a, message: e.target.value })} />}</Field>
      </div>);
    case 'create_follow_up': return (
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Follow-up title" hint={TEMPLATE_HINT} className="sm:col-span-2">{(id) => <Input id={id} value={a.title ?? ''} maxLength={200} onChange={(e) => onChange({ ...a, title: e.target.value })} />}</Field>
        <Field label="Owner">{(id) => <Select id={id} value={a.owner} onChange={(e) => onChange({ ...a, owner: e.target.value })}>{TARGETS.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}</Select>}</Field>
        {a.owner === 'user' && person('Person')}
        <Field label="Due in (days)" hint="Leave empty for no due date">{(id) => <Input id={id} type="number" min={0} max={365} value={a.dueInDays ?? ''}
          onChange={(e) => onChange({ ...a, dueInDays: e.target.value === '' ? null : Math.max(0, Math.min(365, Number(e.target.value) || 0)) })} />}</Field>
        <Field label="Priority">{(id) => <Select id={id} value={a.priority ?? ''} onChange={(e) => onChange({ ...a, priority: e.target.value || undefined })}>
          <option value="">Same as the task</option>{Object.entries(PRIORITY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}</Field>
      </div>);
    case 'set_priority': return (
      <Field label="New priority">{(id) => <Select id={id} value={a.priority} onChange={(e) => onChange({ ...a, priority: e.target.value })}>{Object.entries(PRIORITY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}</Field>);
    case 'set_reviewer': return (
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Reviewer">{(id) => <Select id={id} value={a.target} onChange={(e) => onChange({ ...a, target: e.target.value })}>
          <option value="manager">The owner's manager</option><option value="user">A specific person</option></Select>}</Field>
        {a.target === 'user' && person('Person')}
      </div>);
    case 'add_checklist_item': return <Field label="Checklist item" hint={TEMPLATE_HINT}>{(id) => <Input id={id} value={a.text ?? ''} maxLength={300} onChange={(e) => onChange({ ...a, text: e.target.value })} />}</Field>;
    case 'add_comment': return <Field label="Comment" hint={`Posted as a system comment naming this rule. ${TEMPLATE_HINT}`}>{(id) => <Textarea id={id} rows={2} value={a.text ?? ''} maxLength={2000} onChange={(e) => onChange({ ...a, text: e.target.value })} />}</Field>;
    case 'assign': return person('Assign to');
    default: return null;
  }
}

// ---------- Dry run ----------
export function TestPanel({ rule, ruleId }: { rule?: unknown; ruleId?: string }) {
  const [term, setTerm] = useState('');
  const [taskId, setTaskId] = useState<string | null>(null);
  const tasks = useQuery({ queryKey: ['automation-task-search', term], queryFn: () => api.get(`/api/tasks${qs({ q: term.trim() || undefined, limit: 8, includeDone: '1' })}`), staleTime: 30_000 });
  const run = useMutation({ mutationFn: (id: string) => api.post('/api/automations/test', { taskId: id, ...(rule ? { rule } : {}), ...(ruleId ? { ruleId } : {}) }) });
  const pick = (id: string) => { setTaskId(id); run.mutate(id); };
  const r: any = run.data;
  return (
    <div className="grid gap-3">
      <Field label="Find a task">{(id) => (
        <div className="relative"><Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-ink-3" aria-hidden />
          <Input id={id} className="pl-8" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Search by title" /></div>)}</Field>
      {tasks.isLoading ? <Spinner label="Finding tasks" /> : tasks.error ? <Callout tone="critical">{(tasks.error as any).message}</Callout>
        : (tasks.data ?? []).length === 0 ? <p className="text-[13px] text-ink-3">No tasks match.</p> : (
        <ul className="grid max-h-56 gap-1 overflow-y-auto" aria-label="Tasks to test against">
          {(tasks.data ?? []).map((t: any) => (
            <li key={t.id}><button type="button" aria-pressed={taskId === t.id} onClick={() => pick(t.id)}
              className={cx('flex w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px]', taskId === t.id ? 'bg-accent-soft text-accent-ink' : 'hover:bg-surface-2')}>
              <span className="shrink-0 text-ink-3">#{t.number}</span><span className="min-w-0 flex-1 truncate">{t.title}</span>
              {t.project_key && <span className="hidden shrink-0 text-[12px] text-ink-3 sm:inline">{t.project_key}</span>}<StatusBadge status={t.status} />
            </button></li>))}
        </ul>)}
      {run.isPending && <Spinner label="Running the dry run" />}
      {run.error && <Callout tone="critical">{(run.error as any).message}</Callout>}
      {r && !run.isPending && <DryRunResult r={r} onRetry={() => taskId && run.mutate(taskId)} />}
    </div>
  );
}
function DryRunResult({ r, onRetry }: { r: any; onRetry: () => void }) {
  return (
    <div className="grid gap-3 rounded-lg bg-surface p-3 ring-1 ring-line" aria-live="polite">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={r.wouldRun ? 'good' : 'neutral'} icon={r.wouldRun ? <CheckCircle2 className="size-3.5" aria-hidden /> : <CircleDashed className="size-3.5" aria-hidden />}>
          {r.wouldRun ? 'Would run' : 'Would not run'}</Badge>
        <span className="min-w-0 flex-1 truncate text-[13px] text-ink-2">on #{r.task.number} {r.task.title}</span>
        <Button size="sm" variant="ghost" onClick={onRetry}>Test again</Button>
      </div>
      <div>
        <h4 className="text-[12px] font-semibold uppercase tracking-wide text-ink-3">Checks</h4>
        <ul className="mt-1 grid gap-1">{r.checks.map((c: any) => (
          <li key={c.label} className="flex items-start gap-2 text-[13px]">
            {c.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-good-ink" aria-label="Passed" /> : <XCircle className="mt-0.5 size-4 shrink-0 text-critical-ink" aria-label="Failed" />}
            <span><b className="font-medium">{c.label}:</b> <span className="text-ink-2">{c.detail}</span></span>
          </li>))}</ul>
      </div>
      <div>
        <h4 className="text-[12px] font-semibold uppercase tracking-wide text-ink-3">{r.wouldRun ? 'It would' : 'If it matched, it would'}</h4>
        <ol className="mt-1 grid list-decimal gap-1 pl-5 text-[13px]">{r.actions.map((a: any, i: number) => (
          <li key={i}>{a.summary}{a.skip && <span className="text-ink-3"> (skipped: {a.skip})</span>}</li>))}</ol>
      </div>
      <p className="text-[12px] text-ink-3">{r.note}</p>
    </div>
  );
}
