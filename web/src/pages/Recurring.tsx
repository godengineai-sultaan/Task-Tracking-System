import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Repeat } from 'lucide-react';
import { api } from '../lib/api';
import { CATEGORY_LABEL, PRIORITY_LABEL, fmtDate, hm } from '../lib/format';
import { useMe } from '../lib/session';
import { Badge, Button, Card, Checkbox, Empty, ErrorState, Field, Input, Modal, PageHeader, Select, Skeleton, Textarea, useToast } from '../components/ui';
import { useProjects, useUsers } from '../components/TaskStatus';

const RULE: Record<string, string> = { daily: 'Every day', weekdays: 'Every weekday', weekly: 'Weekly', monthly: 'Monthly' };
const WD = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export default function Recurring() {
  const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['recurring'], queryFn: () => api.get('/api/recurring') });
  const [open, setOpen] = useState(false);
  const toggle = useMutation({ mutationFn: (t: any) => api.patch(`/api/recurring/${t.id}`, { active: !t.active }), onSuccess: () => qc.invalidateQueries({ queryKey: ['recurring'] }), onError: (e: any) => toast({ tone: 'critical', text: e.message }) });
  return (
    <div>
      <PageHeader title="Recurring work" subtitle="Each rule creates one task per occurrence — never duplicates — so routine admin, finance and reviews don't need re-typing."
        actions={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>New recurring task</Button>} />
      {q.isLoading ? <Skeleton className="h-48" /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : q.data.length === 0 ? <Card><Empty icon={<Repeat className="size-6" />} title="No recurring work yet" /></Card> : (
        <Card padded={false}><ul className="divide-y divide-line">{q.data.map((t: any) => (
          <li key={t.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1"><div className="font-medium">{t.title}</div>
              <div className="text-[12px] text-ink-3">{RULE[t.rule]}{t.rule === 'weekly' && ` on ${WD[t.weekday ?? 1]}`}{t.rule === 'monthly' && ` on day ${t.month_day ?? 1}`} · {t.owner_name}{t.project_name && ` · ${t.project_name}`}{t.estimate_minutes && ` · ${hm(t.estimate_minutes)}`}{t.last_generated_date && ` · generated through ${fmtDate(t.last_generated_date)}`}</div></div>
            <Badge>{CATEGORY_LABEL[t.category]}</Badge>
            <Checkbox checked={t.active} onChange={() => toggle.mutate(t)} label={t.active ? 'Active' : 'Paused'} />
          </li>))}</ul></Card>)}
      <NewRecurring open={open} onClose={() => setOpen(false)} />
    </div>
  );
}

function NewRecurring({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient(); const toast = useToast(); const me = useMe(); const users = useUsers(); const projects = useProjects();
  const [f, setF] = useState<any>({ title: '', description: '', rule: 'weekly', weekday: 5, monthDay: 1, category: 'admin', priority: 'medium', estimateMinutes: '', projectId: '', ownerId: '', checklist: '' });
  const m = useMutation({
    mutationFn: () => api.post('/api/recurring', { ...f, estimateMinutes: f.estimateMinutes ? Number(f.estimateMinutes) : null, projectId: f.projectId || null, ownerId: f.ownerId || undefined,
      weekday: f.rule === 'weekly' ? Number(f.weekday) : null, monthDay: f.rule === 'monthly' ? Number(f.monthDay) : null, checklist: f.checklist.split('\n').map((s: string) => s.trim()).filter(Boolean) }),
    onSuccess: () => { qc.invalidateQueries(); toast({ tone: 'good', text: 'Recurring task created — today\'s occurrence will appear shortly' }); onClose(); }, onError: (e: any) => toast({ tone: 'critical', text: e.message }),
  });
  const team = (users.data ?? []).filter((u: any) => u.id === me.user.id || me.user.managedUserIds.includes(u.id) || me.user.roles.includes('routine_admin'));
  return (
    <Modal open={open} onClose={onClose} title="New recurring task" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!f.title} loading={m.isPending} onClick={() => m.mutate()}>Create</Button></>}>
      <div className="grid gap-3">
        <Field label="Title">{(id) => <Input id={id} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Weekly vendor payment run" />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Repeats">{(id) => <Select id={id} value={f.rule} onChange={(e) => setF({ ...f, rule: e.target.value })}>{Object.entries(RULE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}</Field>
          {f.rule === 'weekly' && <Field label="On">{(id) => <Select id={id} value={f.weekday} onChange={(e) => setF({ ...f, weekday: e.target.value })}>{WD.slice(1).map((d, i) => <option key={d} value={i + 1}>{d}</option>)}</Select>}</Field>}
          {f.rule === 'monthly' && <Field label="Day of month (1–28)">{(id) => <Input id={id} type="number" min={1} max={28} value={f.monthDay} onChange={(e) => setF({ ...f, monthDay: e.target.value })} />}</Field>}
          <Field label="Owner">{(id) => <Select id={id} value={f.ownerId} onChange={(e) => setF({ ...f, ownerId: e.target.value })}><option value="">Me</option>{team.filter((u: any) => u.id !== me.user.id).map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select>}</Field>
          <Field label="Project">{(id) => <Select id={id} value={f.projectId} onChange={(e) => setF({ ...f, projectId: e.target.value })}><option value="">None</option>{(projects.data ?? []).map((p: any) => <option key={p.id} value={p.id}>{p.key} · {p.name}</option>)}</Select>}</Field>
          <Field label="Category">{(id) => <Select id={id} value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{Object.entries(CATEGORY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}</Field>
          <Field label="Priority">{(id) => <Select id={id} value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>{Object.entries(PRIORITY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}</Field>
          <Field label="Estimate (minutes)">{(id) => <Input id={id} type="number" min={1} value={f.estimateMinutes} onChange={(e) => setF({ ...f, estimateMinutes: e.target.value })} />}</Field>
        </div>
        <Field label="Checklist (one step per line)">{(id) => <Textarea id={id} rows={3} value={f.checklist} onChange={(e) => setF({ ...f, checklist: e.target.value })} />}</Field>
      </div>
    </Modal>
  );
}
