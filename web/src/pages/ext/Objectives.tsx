import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Plus, Search, Target } from 'lucide-react';
import { pct } from '../../lib/format';
import { useMe } from '../../lib/session';
import { Avatar, Button, Card, Empty, ErrorState, Input, PageHeader, Segmented, Select, Skeleton, Stat, cx } from '../../components/ui';
import { BASIS, FORECAST, ForecastBadge, MeterKey, ProgressMeter, periodText, useObjectivesOverview, type ForecastStatus } from '../../components/ext/ObjectivesUI';
import { NewObjectiveModal } from '../../components/ext/ObjectivesNewModal';

export default function Objectives() {
  const me = useMe();
  const q = useObjectivesOverview();
  const [scope, setScope] = useState<'active' | 'closed' | 'all'>('active');
  const [health, setHealth] = useState(''); const [owner, setOwner] = useState(''); const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const items: any[] = q.data?.items ?? [];
  const owners = useMemo(() => [...new Map(items.filter((o) => o.owner_id).map((o) => [o.owner_id, o.owner_name])).entries()].sort((a, b) => String(a[1]).localeCompare(String(b[1]))), [items]);
  const shown = items.filter((o) => (scope === 'all' || (scope === 'active' ? o.status === 'active' : o.status !== 'active'))
    && (!health || o.forecast?.status === health) && (!owner || o.owner_id === (owner === 'me' ? me.user.id : owner))
    && (!text || `${o.title} ${o.description}`.toLowerCase().includes(text.toLowerCase())));
  const counts = items.filter((o) => o.status === 'active').reduce((m: Record<string, number>, o) => { m[o.forecast?.status] = (m[o.forecast?.status] ?? 0) + 1; return m; }, {});

  return (
    <div>
      <PageHeader title="Objectives" subtitle="Company goals, the work linked to them, and an explained early warning. Status comes from recorded work and reported key results, never from monitoring people."
        actions={q.data?.permissions.canCreate && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>New objective</Button>} />
      {q.isLoading ? <div className="space-y-3"><Skeleton className="h-20" /><Skeleton className="h-28" /><Skeleton className="h-28" /></div>
        : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4" role="group" aria-label="Active objectives by status (select to filter)">
            {(['on_track', 'at_risk', 'off_track', 'insufficient_data'] as ForecastStatus[]).map((s) => (
              <button key={s} type="button" aria-pressed={health === s} onClick={() => { setHealth(health === s ? '' : s); setScope('active'); }}
                className={cx('cursor-pointer rounded-xl text-left hover:*:ring-line-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent', health === s && 'ring-2 ring-accent')}>
                <Stat label={FORECAST[s].label} value={counts[s] ?? 0} sub={health === s ? 'Showing these · select to clear' : 'active objectives'} tone={s === 'off_track' && counts[s] ? 'critical' : s === 'at_risk' && counts[s] ? 'warning' : undefined} />
              </button>))}
          </div>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Segmented label="Objective lifecycle" value={scope} onChange={setScope} options={[{ value: 'active', label: 'Active' }, { value: 'closed', label: 'Closed' }, { value: 'all', label: 'All' }]} />
            <Select aria-label="Filter by forecast status" className="h-8 w-auto" value={health} onChange={(e) => setHealth(e.target.value)}>
              <option value="">Any status</option>{Object.entries(FORECAST).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</Select>
            <Select aria-label="Filter by owner" className="h-8 w-auto max-w-[12rem]" value={owner} onChange={(e) => setOwner(e.target.value)}>
              <option value="">Any owner</option><option value="me">Owned by me</option>{owners.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</Select>
            <div className="relative min-w-0 flex-1 basis-40">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-3" aria-hidden />
              <Input aria-label="Search objectives" placeholder="Search objectives" className="h-8 w-full pl-8" value={text} onChange={(e) => setText(e.target.value)} />
            </div>
          </div>
          {shown.length === 0 ? (
            <Card><Empty icon={<Target className="size-6" />} title={items.length ? 'No objectives match these filters' : 'No objectives yet'}
              action={items.length ? <Button size="sm" onClick={() => { setScope('all'); setHealth(''); setOwner(''); setText(''); }}>Clear filters</Button>
                : q.data.permissions.canCreate ? <Button variant="primary" size="sm" onClick={() => setOpen(true)}>Create the first objective</Button> : undefined}>
              {items.length ? 'Try another status, owner or search.' : 'Leadership sets objectives; milestones and key results show how work moves them.'}</Empty></Card>
          ) : (
            <><MeterKey className="mb-2" /><ul className="space-y-3" aria-label="Objectives">{shown.map((o) => <ObjectiveRow key={o.id} o={o} />)}</ul></>
          )}
        </>)}
      <NewObjectiveModal open={open} onClose={() => setOpen(false)} />
    </div>
  );
}

function ObjectiveRow({ o }: { o: any }) {
  const f = o.forecast;
  return (
    <li className="rounded-xl bg-surface p-4 ring-1 ring-line transition focus-within:ring-accent hover:ring-line-strong">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 basis-64">
          <Link to={`/objectives/${o.id}`} className="text-[15px] font-semibold text-ink hover:underline">{o.title}</Link>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-3">
            {o.owner_name ? <span className="inline-flex items-center gap-1.5"><Avatar name={o.owner_name} size={18} />{o.owner_name}</span> : <span>No owner</span>}
            <span>{periodText(o.period_start, o.period_end)}</span>
          </div>
        </div>
        <ForecastBadge status={f?.status} lifecycle={o.status} />
      </div>
      <div className="mt-3 flex items-center gap-3">
        <div className="min-w-0 flex-1"><ProgressMeter value={o.progress} expected={f?.expected} status={f?.status} label={`Progress of ${o.title}`} /></div>
        <span className="w-12 shrink-0 text-right text-[13px] font-medium tabular">{o.progress === null ? 'N/A' : pct(o.progress)}</span>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-ink-3">
        <span>{o.milestones ? `${o.milestonesDone}/${o.milestones} milestones` : 'No linked milestones'}</span>
        {o.tasks > 0 && <span>{o.tasksDone}/{o.tasks} tasks accepted · {BASIS[o.workBasis]}</span>}
        <span>{o.keyResults} key result{o.keyResults === 1 ? '' : 's'}</span>
        {f?.expected != null && <span>Expected now {pct(f.expected)}</span>}
        {o.latestCheckin && <span>{o.latestCheckin.by_owner ? 'Owner confidence' : 'Latest confidence'} {o.latestCheckin.confidence}/5{!o.latestCheckin.by_owner && o.latestCheckin.author_name ? ` (${o.latestCheckin.author_name})` : ''}</span>}
      </div>
      {f && f.status !== 'on_track' && f.reasons[0] && <p className="mt-2 text-[13px] text-ink-2">{f.reasons[0]}</p>}
    </li>
  );
}
