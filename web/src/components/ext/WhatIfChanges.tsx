import { useState } from 'react';
import { ArrowRightLeft, CalendarClock, CalendarOff, Gauge, PlusSquare } from 'lucide-react';
import { addDays, fmtDate, hm, PRIORITY_LABEL } from '../../lib/format';
import { Button, Field, Input, Modal, Select } from '../ui';

export type Change =
  | { type: 'leave'; userId: string; start: string; end: string }
  | { type: 'reassign'; taskId: string; toUserId: string }
  | { type: 'allocation'; userId: string; percent: number }
  | { type: 'deadline'; taskId: string; dueDate: string }
  | { type: 'add_task'; ownerId: string; title: string; estimateMinutes: number; dueDate?: string | null; priority?: string };
export type ChangeType = Change['type'];
export interface CtxPerson { id: string; name: string; title?: string }
export interface CtxTask { id: string; number: number; title: string; owner_id: string; status: string; priority: string; due_date: string | null; estimate_minutes: number | null }

export const CHANGE_TYPES: { type: ChangeType; label: string; hint: string; icon: typeof CalendarOff }[] = [
  { type: 'leave', label: 'Leave', hint: 'Someone is away for some days', icon: CalendarOff },
  { type: 'reassign', label: 'Reassign', hint: 'Move a task to someone else', icon: ArrowRightLeft },
  { type: 'allocation', label: 'Allocation', hint: 'Share of time available for this work', icon: Gauge },
  { type: 'deadline', label: 'Deadline', hint: 'Move a due date', icon: CalendarClock },
  { type: 'add_task', label: 'New work', hint: 'Add a hypothetical task', icon: PlusSquare },
];

const d = (v?: string | null) => fmtDate(v, { weekday: 'short', day: 'numeric', month: 'short' });
export function describeChange(c: Change, people: Map<string, string>, tasks: Map<string, CtxTask>) {
  const who = (id: string) => people.get(id) ?? 'Someone outside your list';
  const task = (id: string) => { const t = tasks.get(id); return t ? `#${t.number} ${t.title}` : 'A task that is no longer open'; };
  switch (c.type) {
    case 'leave': return { title: `${who(c.userId)} on leave`, detail: c.start === c.end ? d(c.start) : `${d(c.start)} – ${d(c.end)}` };
    case 'reassign': return { title: task(c.taskId), detail: `Reassigned to ${who(c.toUserId)}` };
    case 'allocation': return { title: `${who(c.userId)} at ${c.percent}%`, detail: 'Share of available time for these tasks' };
    case 'deadline': return { title: task(c.taskId), detail: `Due ${d(c.dueDate)}` };
    case 'add_task': return { title: `New: ${c.title}`, detail: `${hm(c.estimateMinutes)} for ${who(c.ownerId)}${c.dueDate ? `, due ${d(c.dueDate)}` : ''}` };
  }
}

function TaskSelect({ id, value, onChange, people, tasks }: { id: string; value: string; onChange: (v: string) => void; people: CtxPerson[]; tasks: CtxTask[] }) {
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Choose a task…</option>
      {people.map((p) => {
        const own = tasks.filter((t) => t.owner_id === p.id);
        return own.length ? <optgroup key={p.id} label={p.name}>{own.map((t) => (
          <option key={t.id} value={t.id}>#{t.number} {t.title}{t.due_date ? ` (due ${fmtDate(t.due_date)})` : ''}</option>))}</optgroup> : null;
      })}
    </Select>
  );
}
function PersonSelect({ id, value, onChange, people, exclude }: { id: string; value: string; onChange: (v: string) => void; people: CtxPerson[]; exclude?: string }) {
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Choose a person…</option>
      {people.filter((p) => p.id !== exclude).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
    </Select>
  );
}

/** Friendly form for one hypothetical change. Nothing is saved: the change only feeds the simulation. */
type FormProps = { onClose: () => void; onAdd: (c: Change) => void; people: CtxPerson[]; tasks: CtxTask[]; start: string };
export function ChangeModal({ type, ...rest }: FormProps & { type: ChangeType | null }) {
  return type ? <ChangeForm key={type} type={type} {...rest} /> : null;
}
function ChangeForm({ type, onClose, onAdd, people, tasks, start }: FormProps & { type: ChangeType }) {
  const [f, setF] = useState<Record<string, string>>(() =>
    ({ person: people[0]?.id ?? '', start, end: addDays(start, 4), percent: '50', due: addDays(start, 7), hours: '4', priority: 'medium', task: '', to: '', title: '' }));
  const set = (k: string) => (v: string) => setF((x) => ({ ...x, [k]: v }));
  const meta = CHANGE_TYPES.find((c) => c.type === type)!;
  const task = tasks.find((t) => t.id === f.task);
  let change: Change | null = null; let error: string | null = null;
  if (type === 'leave') {
    if (f.person && f.start && f.end) change = { type, userId: f.person, start: f.start, end: f.end };
    if (f.start && f.end && f.end < f.start) { error = 'The last day must be on or after the first day.'; change = null; }
  } else if (type === 'reassign') {
    if (f.task && f.to) change = { type, taskId: f.task, toUserId: f.to };
  } else if (type === 'allocation') {
    const p = Number(f.percent);
    if (f.person && Number.isInteger(p) && p >= 0 && p <= 100) change = { type, userId: f.person, percent: p };
    else if (f.percent !== '') error = 'Use a whole number from 0 to 100.';
  } else if (type === 'deadline') {
    if (f.task && f.due) change = { type, taskId: f.task, dueDate: f.due };
  } else {
    const mins = Math.round(Number(f.hours) * 60);
    if (f.hours && !(mins >= 1 && mins <= 6000)) error = 'Estimate must be between 1 minute and 100 hours.';
    else if (f.person && f.title.trim() && mins) change = { type, ownerId: f.person, title: f.title.trim(), estimateMinutes: mins, dueDate: f.due || null, priority: f.priority };
  }
  const submit = () => { if (change) { onAdd(change); onClose(); } };
  return (
    <Modal open onClose={onClose} title={`Add change: ${meta.label}`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!change} onClick={submit}>Add to scenario</Button></>}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <p className="text-[13px] text-ink-3">{meta.hint}. This only changes the simulation, never real records.</p>
        {(type === 'leave' || type === 'allocation') && <Field label="Person">{(id) => <PersonSelect id={id} value={f.person} onChange={set('person')} people={people} />}</Field>}
        {type === 'leave' && <div className="grid grid-cols-2 gap-3">
          <Field label="First day">{(id) => <Input id={id} type="date" value={f.start} onChange={(e) => set('start')(e.target.value)} />}</Field>
          <Field label="Last day" error={error}>{(id) => <Input id={id} type="date" value={f.end} onChange={(e) => set('end')(e.target.value)} />}</Field>
        </div>}
        {type === 'allocation' && <Field label="Share of available time (%)" error={error} hint="100% = all scheduled working time goes to these tasks. 0% = none.">{(id) => (
          <div className="flex items-center gap-3">
            <input aria-label="Allocation slider" type="range" min={0} max={100} step={5} value={Number(f.percent) || 0} onChange={(e) => set('percent')(e.target.value)} className="flex-1 accent-[var(--accent)]" />
            <Input id={id} type="number" inputMode="numeric" min={0} max={100} className="w-20" value={f.percent} onChange={(e) => set('percent')(e.target.value)} />
          </div>)}</Field>}
        {(type === 'reassign' || type === 'deadline') && <Field label="Task" hint={task ? `Owner: ${people.find((p) => p.id === task.owner_id)?.name ?? '—'} · due ${task.due_date ? fmtDate(task.due_date) : 'not set'} · estimate ${task.estimate_minutes ? hm(task.estimate_minutes) : 'none'}` : undefined}>
          {(id) => <TaskSelect id={id} value={f.task} onChange={set('task')} people={people} tasks={tasks} />}</Field>}
        {type === 'reassign' && <Field label="Reassign to">{(id) => <PersonSelect id={id} value={f.to} onChange={set('to')} people={people} exclude={task?.owner_id} />}</Field>}
        {type === 'deadline' && <Field label="New due date">{(id) => <Input id={id} type="date" value={f.due} onChange={(e) => set('due')(e.target.value)} />}</Field>}
        {type === 'add_task' && <>
          <Field label="Title">{(id) => <Input id={id} value={f.title} maxLength={300} placeholder="e.g. Urgent client fix" onChange={(e) => set('title')(e.target.value)} />}</Field>
          <Field label="Owner">{(id) => <PersonSelect id={id} value={f.person} onChange={set('person')} people={people} />}</Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Estimate (hours)" error={error}>{(id) => <Input id={id} type="number" inputMode="decimal" min={0.25} max={100} step={0.25} value={f.hours} onChange={(e) => set('hours')(e.target.value)} />}</Field>
            <Field label="Due date">{(id) => <Input id={id} type="date" value={f.due} onChange={(e) => set('due')(e.target.value)} />}</Field>
          </div>
          <Field label="Priority">{(id) => <Select id={id} value={f.priority} onChange={(e) => set('priority')(e.target.value)}>
            {Object.entries(PRIORITY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}</Field>
        </>}
        <button type="submit" hidden aria-hidden tabIndex={-1} />
      </form>
    </Modal>
  );
}
