import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FlaskConical, Loader2, RotateCcw, Save, Trash2, X } from 'lucide-react';
import { api } from '../../lib/api';
import { fmtDate, hm } from '../../lib/format';
import { useMe, useRoles } from '../../lib/session';
import { Badge, Button, Callout, Card, Checkbox, Empty, ErrorState, Field, IconButton, Input, Modal, PageHeader, Segmented, Select, Skeleton, Stat, cx, useToast } from '../../components/ui';
import { CHANGE_TYPES, ChangeModal, describeChange, type Change, type ChangeType, type CtxPerson, type CtxTask } from '../../components/ext/WhatIfChanges';
import { PersonLoadChart, type PersonResult } from '../../components/ext/WhatIfCharts';

const HORIZONS = [{ value: '7', label: '1 wk' }, { value: '14', label: '2 wks' }, { value: '28', label: '4 wks' }, { value: '56', label: '8 wks' }];
const OUTCOME: Record<string, { label: string; tone: 'critical' | 'good' | 'warning' | 'info' | 'neutral'; rank: number }> = {
  newly_late: { label: 'Becomes late', tone: 'critical', rank: 0 }, added: { label: 'New work', tone: 'info', rank: 1 }, later: { label: 'Finishes later', tone: 'warning', rank: 2 },
  recovered: { label: 'Back on time', tone: 'good', rank: 3 }, earlier: { label: 'Finishes earlier', tone: 'good', rank: 4 }, same: { label: 'Same finish', tone: 'neutral', rank: 5 },
};
interface Saved { id: string; name: string; horizon_days: number; people: string[]; changes: Change[]; unestimated_minutes: number; version: number; updated_at: string }

export default function WhatIf() {
  const me = useMe(); const roles = useRoles(); const toast = useToast(); const qc = useQueryClient();
  const [sp] = useSearchParams();
  const ctx = useQuery({ queryKey: ['whatif-context'], queryFn: () => api.get<{ today: string; people: CtxPerson[]; tasks: CtxTask[]; defaults: string[] }>('/api/whatif/context') });
  const [start, setStart] = useState(sp.get('start') || me.today);
  const [horizon, setHorizon] = useState(HORIZONS.some((h) => h.value === sp.get('horizon')) ? sp.get('horizon')! : '14');
  const [people, setPeople] = useState<string[] | null>(null);
  const [unest, setUnest] = useState('60');
  const [changes, setChanges] = useState<Change[]>([]);
  const [adding, setAdding] = useState<ChangeType | null>(null);
  const [loaded, setLoaded] = useState<{ id: string; name: string; version: number } | null>(null);
  const [saving, setSaving] = useState(false); const [deleting, setDeleting] = useState(false);

  useEffect(() => { if (ctx.data && people === null) setPeople(ctx.data.defaults); }, [ctx.data, people]);
  const peopleMap = useMemo(() => new Map((ctx.data?.people ?? []).map((p) => [p.id, p.name])), [ctx.data]);
  const taskMap = useMemo(() => new Map((ctx.data?.tasks ?? []).map((t) => [t.id, t])), [ctx.data]);
  const unestN = Number(unest);
  const unestOk = unest !== '' && Number.isInteger(unestN) && unestN >= 0 && unestN <= 6000;
  const input = { start, horizonDays: Number(horizon), people: people ?? [], changes, unestimatedMinutes: unestOk ? unestN : 60 };
  const sim = useQuery({ queryKey: ['whatif-sim', input], queryFn: () => api.post('/api/whatif/simulate', input), enabled: !!people?.length && !!start,
    placeholderData: keepPreviousData, retry: false });
  const saved = useQuery({ queryKey: ['whatif-scenarios'], queryFn: () => api.get<Saved[]>('/api/whatif/scenarios') });

  const load = (id: string) => {
    const s = saved.data?.find((x) => x.id === id);
    if (!s || !ctx.data) return;
    const inScope = s.people.filter((p) => peopleMap.has(p));
    setPeople(inScope.length ? inScope : ctx.data.defaults); setHorizon(HORIZONS.some((h) => h.value === String(s.horizon_days)) ? String(s.horizon_days) : '14');
    setChanges(s.changes); setUnest(String(s.unestimated_minutes)); setLoaded({ id: s.id, name: s.name, version: s.version });
    if (inScope.length < s.people.length) toast({ tone: 'info', text: 'Some people in this scenario are no longer in your planning scope and were left out.' });
  };
  const reset = () => { setChanges([]); setLoaded(null); setUnest('60'); if (ctx.data) setPeople(ctx.data.defaults); };
  const del = useMutation({
    mutationFn: () => api.del(`/api/whatif/scenarios/${loaded!.id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['whatif-scenarios'] }); toast({ tone: 'good', text: `Deleted "${loaded!.name}"` }); setLoaded(null); setDeleting(false); },
    onError: (e: any) => toast({ tone: 'critical', text: e.message }),
  });

  if (ctx.isLoading) return <div><PageHeader title="What-if planner" /><Skeleton className="h-96" /></div>;
  if (ctx.error) return <div><PageHeader title="What-if planner" /><ErrorState error={ctx.error} onRetry={() => ctx.refetch()} /></div>;
  const c = ctx.data!;
  const sel = new Set(people ?? []);
  const toggle = (id: string, on: boolean) => setPeople((p) => (on ? [...(p ?? []), id] : (p ?? []).filter((x) => x !== id)));

  return (
    <div>
      <PageHeader eyebrow={roles.canReview || roles.leadership ? <Link to="/capacity" className="hover:underline">Team capacity</Link> : 'Planning'} title="What-if planner"
        subtitle="Try leave, reassignments, allocation, deadline and new-work changes on a copy of the plan. Nothing here changes real tasks, calendars or leave."
        actions={<>
          <Select aria-label="Load a saved scenario" className="h-9 w-52" value={loaded?.id ?? ''} onChange={(e) => { if (e.target.value) load(e.target.value); }} disabled={saved.isLoading}>
            <option value="">{saved.data?.length ? 'Saved scenarios…' : 'No saved scenarios'}</option>
            {saved.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
          <Button icon={<Save className="size-4" aria-hidden />} onClick={() => setSaving(true)}>Save</Button>
          {loaded && <IconButton label={`Delete scenario ${loaded.name}`} onClick={() => setDeleting(true)}><Trash2 className="size-4" /></IconButton>}
        </>} />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
        <div className="space-y-4">
          <Card title="Setup">
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-1">
                <Field label="Start date">{(id) => <Input id={id} type="date" value={start} onChange={(e) => e.target.value && setStart(e.target.value)} />}</Field>
                <div className="space-y-1.5"><div className="text-[13px] font-medium text-ink-2">Horizon</div><Segmented label="Horizon" value={horizon} onChange={setHorizon} options={HORIZONS} /></div>
              </div>
              <fieldset>
                <legend className="mb-1.5 flex w-full items-center justify-between text-[13px] font-medium text-ink-2">
                  <span>People ({sel.size})</span>
                  {c.people.length > 1 && <span className="flex gap-1">
                    <Button size="sm" variant="ghost" onClick={() => setPeople(c.people.map((p) => p.id))}>All</Button>
                    <Button size="sm" variant="ghost" onClick={() => setPeople([])}>None</Button></span>}
                </legend>
                <div className="max-h-60 space-y-1.5 overflow-y-auto rounded-lg bg-surface-2 p-2.5">
                  {c.people.map((p) => <div key={p.id}><Checkbox checked={sel.has(p.id)} onChange={(on) => toggle(p.id, on)} label={<>{p.name}{p.id === me.user.id && <span className="text-ink-3"> (you)</span>}</>} /></div>)}
                </div>
              </fieldset>
              <Field label="Assumed time for unestimated tasks (minutes)" error={unestOk ? null : 'Use a whole number from 0 to 6000.'}
                hint="An explicit assumption for open tasks with no estimate, or whose estimate is used up by logged time.">
                {(id) => <Input id={id} type="number" inputMode="numeric" min={0} max={6000} step={15} value={unest} onChange={(e) => setUnest(e.target.value)} />}
              </Field>
            </div>
          </Card>

          <Card title="Changes" subtitle="Hypothetical only" actions={(changes.length > 0 || loaded) ? <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" aria-hidden />} onClick={reset}>Reset</Button> : undefined}>
            {changes.length === 0 ? <p className="mb-3 text-[13px] text-ink-3">No changes yet. Add one below to compare the scenario against today's plan.</p> : (
              <ul className="mb-3 space-y-2" aria-label="Scenario changes">
                {changes.map((ch, i) => {
                  const dsc = describeChange(ch, peopleMap, taskMap); const meta = CHANGE_TYPES.find((x) => x.type === ch.type)!; const Icon = meta.icon;
                  return (
                    <li key={i} className="flex items-start gap-2.5 rounded-lg bg-surface-2 px-2.5 py-2">
                      <Icon className="mt-0.5 size-4 shrink-0 text-accent-ink" aria-hidden />
                      <div className="min-w-0 flex-1"><div className="text-[12px] text-ink-3">{meta.label}</div><div className="break-words text-[13px] font-medium">{dsc.title}</div><div className="text-[12px] text-ink-2">{dsc.detail}</div></div>
                      <IconButton label={`Remove change: ${dsc.title}`} className="size-7" onClick={() => setChanges((x) => x.filter((_, j) => j !== i))}><X className="size-3.5" /></IconButton>
                    </li>);
                })}
              </ul>)}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-2">
              {CHANGE_TYPES.map((t) => <Button key={t.type} size="sm" icon={<t.icon className="size-3.5" aria-hidden />} onClick={() => setAdding(t.type)} disabled={changes.length >= 50}>{t.label}</Button>)}
            </div>
          </Card>
        </div>

        <div className="min-w-0 space-y-4" aria-live="polite" aria-busy={sim.isFetching}>
          {!people?.length ? <Card><Empty icon={<FlaskConical className="size-6" />} title="Pick at least one person">Choose whose plan to simulate in Setup.</Empty></Card>
            : sim.isLoading ? <><div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-20" />)}</div><Skeleton className="h-64" /></>
            : sim.error && !sim.data ? <ErrorState error={sim.error} onRetry={() => sim.refetch()} />
            : sim.data ? <Results data={sim.data} names={peopleMap} fetching={sim.isFetching} error={sim.error} onRetry={() => sim.refetch()} /> : null}
        </div>
      </div>

      <ChangeModal type={adding} onClose={() => setAdding(null)} onAdd={(ch) => setChanges((x) => [...x, ch])} start={start}
        people={c.people} tasks={c.tasks} />
      {saving && <SaveDialog loaded={loaded} onClose={() => setSaving(false)} body={{ horizonDays: Number(horizon), people: people ?? [], changes, unestimatedMinutes: input.unestimatedMinutes }}
        onSaved={(s) => { setLoaded({ id: s.id, name: s.name, version: s.version }); setSaving(false); }} />}
      <Modal open={deleting} onClose={() => setDeleting(false)} title="Delete saved scenario?"
        footer={<><Button variant="ghost" onClick={() => setDeleting(false)}>Cancel</Button><Button variant="danger" loading={del.isPending} onClick={() => del.mutate()}>Delete</Button></>}>
        <p className="text-sm">"{loaded?.name}" will be removed from your saved scenarios. Real tasks and calendars are not affected.</p>
      </Modal>
    </div>
  );
}

function SaveDialog({ loaded, body, onClose, onSaved }: { loaded: { id: string; name: string; version: number } | null; body: object; onClose: () => void; onSaved: (s: Saved) => void }) {
  const [name, setName] = useState(loaded?.name ?? ''); const qc = useQueryClient(); const toast = useToast();
  const overwrite = !!loaded && name.trim() === loaded.name;
  const m = useMutation({
    mutationFn: () => (overwrite ? api.put<Saved>(`/api/whatif/scenarios/${loaded!.id}`, { ...body, name: name.trim(), version: loaded!.version }) : api.post<Saved>('/api/whatif/scenarios', { ...body, name: name.trim() })),
    onSuccess: (s) => { qc.invalidateQueries({ queryKey: ['whatif-scenarios'] }); toast({ tone: 'good', text: `Saved "${s.name}"` }); onSaved(s); },
    onError: (e: any) => toast({ tone: 'critical', text: e.message }),
  });
  return (
    <Modal open onClose={onClose} title="Save scenario"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!name.trim()} loading={m.isPending} onClick={() => m.mutate()}>{overwrite ? 'Update scenario' : 'Save as new'}</Button></>}>
      <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) m.mutate(); }} className="space-y-2">
        <Field label="Scenario name" hint="Only you can see your saved scenarios. Saving stores the hypothetical changes, not a decision.">
          {(id) => <Input id={id} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="e.g. Rahul out next week" />}</Field>
      </form>
    </Modal>
  );
}

function finishText(o: any, end: string) {
  if (!o) return '—';
  return o.finish ? fmtDate(o.finish, { weekday: 'short', day: 'numeric', month: 'short' }) : `After ${fmtDate(end)}`;
}

function Results({ data, names, fetching, error, onRetry }: { data: any; names: Map<string, string>; fetching: boolean; error: unknown; onRetry: () => void }) {
  const [filter, setFilter] = useState<'changed' | 'late' | 'all'>('changed');
  const s = data.summary;
  const who = (id: string | null) => (id ? names.get(id) ?? data.people.find((p: PersonResult) => p.id === id)?.name ?? '—' : '—');
  const rows = (data.tasks as any[]).filter((t) => filter === 'all' || (filter === 'late' ? t.scenario.late || t.baseline?.late
      : t.change !== 'same' || t.ownerId !== t.baselineOwnerId || t.dueDate !== t.baselineDueDate))
    .sort((a, b) => OUTCOME[a.change].rank - OUTCOME[b.change].rank || String(a.scenario.finish ?? '9999').localeCompare(String(b.scenario.finish ?? '9999')));
  const spare = (side: 'baseline' | 'scenario') => data.people.reduce((n: number, p: PersonResult) => n + p[side].spareMinutes, 0);
  return (
    <>
      {error ? <ErrorState error={error} onRetry={onRetry} /> : null}
      <div className="flex items-center justify-between gap-2 text-[12px] text-ink-3">
        <span>{fmtDate(data.start, { weekday: 'short', day: 'numeric', month: 'short' })} – {fmtDate(data.end, { weekday: 'short', day: 'numeric', month: 'short' })} · {data.people.length} {data.people.length === 1 ? 'person' : 'people'} · {s.tasks} open tasks</span>
        {fetching && <span className="inline-flex items-center gap-1" role="status"><Loader2 className="size-3.5 animate-spin" aria-hidden />Updating…</span>}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Projected late" value={<span className="tabular">{s.baselineLate} → {s.scenarioLate}</span>} sub="baseline → scenario"
          tone={s.scenarioLate > s.baselineLate ? 'critical' : undefined} hint="Open tasks projected to finish after their due date (includes tasks already overdue)." />
        <Stat label="Become late" value={<span className="tabular">{s.newlyLate}</span>} tone={s.newlyLate ? 'critical' : undefined} sub="on time in the baseline" />
        <Stat label="Back on time" value={<span className="tabular">{s.recovered}</span>} sub="late in the baseline" />
        <Stat label="Unclaimed capacity" value={<span className="tabular">{hm(spare('scenario'))}</span>} sub={`baseline ${hm(spare('baseline'))}`}
          hint="Available time not yet claimed by known open work. A planning figure, not a measure of anyone being idle." />
      </div>

      <Card title="Findings" subtitle="Plain-language summary of what the changes do">
        <ul className="space-y-1.5 text-[13px] leading-relaxed">
          {data.findings.map((f: string, i: number) => <li key={i} className="flex gap-2"><span aria-hidden className="mt-2 size-1.5 shrink-0 rounded-full bg-ink-3" />{f}</li>)}
        </ul>
        <details className="mt-3 rounded-lg bg-surface-2 px-3 py-2 text-[13px]">
          <summary className="cursor-pointer font-medium text-ink-2">Assumptions behind this projection</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-ink-2">{data.assumptions.map((a: string, i: number) => <li key={i}>{a}</li>)}</ul>
        </details>
      </Card>

      <Card title="Load by person" subtitle="Baseline vs scenario over the horizon">
        <PersonLoadChart people={data.people} />
      </Card>

      <Card title="Tasks" padded={false} actions={<Segmented label="Task filter" value={filter} onChange={setFilter}
        options={[{ value: 'changed', label: 'Changed' }, { value: 'late', label: 'Late' }, { value: 'all', label: 'All' }]} />}>
        {rows.length === 0 ? <Empty title={filter === 'changed' ? 'No task changes in this scenario' : filter === 'late' ? 'No task is projected late' : 'No open tasks'}>
          {filter === 'changed' ? 'Add a change, or switch to All to see every projected finish.' : 'Open tasks for the selected people appear here.'}</Empty> : (
          <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Task projections">
            <table className="w-full min-w-[760px] text-[13px]">
              <caption className="sr-only">Projected finish per task, baseline and scenario</caption>
              <thead className="border-b border-line text-left text-[12px] text-ink-3"><tr>
                <th scope="col" className="px-4 py-2 font-medium">Task</th><th scope="col" className="px-2 py-2 font-medium">Owner</th><th scope="col" className="px-2 py-2 font-medium">Due</th>
                <th scope="col" className="px-2 py-2 font-medium">Baseline finish</th><th scope="col" className="px-2 py-2 font-medium">Scenario finish</th>
                <th scope="col" className="px-2 py-2 font-medium">Shift</th><th scope="col" className="px-2 py-2 pr-4 font-medium">Outcome</th></tr></thead>
              <tbody className="divide-y divide-line">{rows.map((t) => (
                <tr key={t.key} data-testid="whatif-task-row" className="align-top">
                  <td className="max-w-[260px] px-4 py-2">
                    {t.id ? <Link to={`/tasks/${t.id}`} className="font-medium hover:underline">{t.title}</Link> : <span className={cx('font-medium', !t.visible && 'text-ink-3')}>{t.title}</span>}
                    <div className="flex flex-wrap gap-1 text-[11px] text-ink-3">
                      {t.number && <span>#{t.number}</span>}
                      <span>{hm(t.remainingMinutes)} left</span>
                      {t.assumption && <Badge>assumed</Badge>}{t.blocked && <Badge tone="critical">blocked</Badge>}{t.awaitingReview && <Badge tone="warning">in review</Badge>}
                    </div>
                  </td>
                  <td className="px-2 py-2">{t.baselineOwnerId && t.baselineOwnerId !== t.ownerId ? <>{who(t.baselineOwnerId)} → <span className="font-medium">{who(t.ownerId)}</span></> : who(t.ownerId)}</td>
                  <td className="px-2 py-2 tabular">{t.baselineDueDate !== t.dueDate && t.baseline ? <>{fmtDate(t.baselineDueDate)} → <span className="font-medium">{fmtDate(t.dueDate)}</span></> : fmtDate(t.dueDate)}</td>
                  <td className={cx('px-2 py-2 tabular', t.baseline?.late && 'text-critical-ink')}>{finishText(t.baseline, data.end)}{t.baseline?.late && <span className="sr-only"> (late)</span>}</td>
                  <td className={cx('px-2 py-2 tabular', t.scenario.late && 'font-medium text-critical-ink')}>{finishText(t.scenario, data.end)}{t.scenario.late && <span className="sr-only"> (late)</span>}
                    {t.scenario.lateDays ? <div className="text-[11px]">{t.scenario.lateDays}d after due</div> : null}</td>
                  <td className="px-2 py-2 tabular">{t.shiftDays ? `${t.shiftDays > 0 ? '+' : '−'}${Math.abs(t.shiftDays)}d` : t.baseline && !t.baseline.finish !== !t.scenario.finish ? (t.scenario.finish ? 'earlier' : 'beyond horizon') : '—'}</td>
                  <td className="px-2 py-2 pr-4"><Badge tone={OUTCOME[t.change].tone}>{OUTCOME[t.change].label}</Badge></td>
                </tr>))}</tbody>
            </table>
          </div>)}
      </Card>

      {data.unestimated.length > 0 && (
        <Card title="Tasks without a usable estimate" subtitle={`Each assumed to need ${hm(data.unestimatedMinutes)} — change the assumption in Setup`}>
          <ul className="divide-y divide-line text-[13px]">{data.unestimated.map((u: any) => (
            <li key={u.key} className="flex flex-wrap items-center justify-between gap-2 py-2 first:pt-0 last:pb-0">
              <span className="min-w-0">{u.id ? <Link to={`/tasks/${u.id}`} className="font-medium hover:underline">{u.title}</Link> : <span className="font-medium">{u.title}</span>}
                <span className="text-ink-3"> · {who(u.ownerId)}</span></span>
              <span className="text-[12px] text-ink-3">{u.reason}</span>
            </li>))}</ul>
        </Card>)}
      <Callout tone="neutral">A projection to support a planning conversation, not a performance measure. People are never ranked, and nothing is changed until someone edits the real tasks, leave or due dates.</Callout>
    </>
  );
}
