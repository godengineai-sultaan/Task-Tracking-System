import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Download, FileSpreadsheet, LayoutGrid, ShieldCheck, Table2, Users } from 'lucide-react';
import { api, qs } from '../../lib/api';
import { addDays, hm, pct } from '../../lib/format';
import { useMe, useRoles } from '../../lib/session';
import { Badge, Button, Callout, Card, Checkbox, Empty, ErrorState, IconButton, Input, PageHeader, Segmented, Skeleton, Stat, cx, useToast } from '../../components/ui';
import { PersonCard, ReviewModal, TeamTable, mondayOf, weekRange, type ReviewAction } from '../../components/ext/TeamReviewPerson';
import { MyWeeklyReviews } from '../../components/ext/TeamReviewMine';
import { downloadExport } from '../util';

const FILTERS: { key: string; label: string; test: (p: any) => boolean }[] = [
  { key: 'all', label: 'Everyone', test: () => true },
  { key: 'attention', label: 'Needs attention', test: (p) => p.flags.needsAttention },
  { key: 'recaps', label: 'Missing recaps', test: (p) => p.flags.missingRecaps },
  { key: 'blocked', label: 'Blocked', test: (p) => p.flags.blocked },
  { key: 'unreviewed', label: 'Not reviewed yet', test: (p) => p.flags.unreviewed },
];

export default function TeamReview() {
  const me = useMe(); const r = useRoles(); const toast = useToast();
  const [sp, setSp] = useSearchParams();
  const set = (o: Record<string, string | null>) => { const n = new URLSearchParams(sp); for (const [k, v] of Object.entries(o)) v ? n.set(k, v) : n.delete(k); setSp(n, { replace: true }); };
  const tab = r.canReview && sp.get('tab') !== 'mine' ? 'team' : 'mine';
  const thisWeek = mondayOf(me.today), lastWeek = addDays(thisWeek, -7);
  // A hand-edited or stale ?week= must not crash the page (date helpers throw on invalid dates).
  const wp = sp.get('week'); const validWeek = !!wp && /^\d{4}-\d{2}-\d{2}$/.test(wp) && !Number.isNaN(Date.parse(`${wp}T12:00:00Z`));
  const week = mondayOf(validWeek ? wp! : lastWeek);
  const includeMe = sp.get('me') === '1';
  const exp = (format: 'pdf' | 'csv') => downloadExport(api, { format, report: 'team_weekly', params: { date: week, includeMe: includeMe || undefined } }, toast)
    .catch((e) => toast({ tone: 'critical', text: e.message }));

  return (
    <div>
      {tab === 'team'
        ? <PageHeader eyebrow={r.routineAdmin ? 'Main administrator · company-wide' : 'Team manager · your teams'} title="Weekly team review"
            subtitle="One explainable summary per person for the week, in alphabetical order. Acknowledge, discuss or follow up — people are never ranked."
            actions={<><Button icon={<Download className="size-4" aria-hidden />} onClick={() => exp('pdf')}>PDF</Button><Button icon={<FileSpreadsheet className="size-4" aria-hidden />} onClick={() => exp('csv')}>CSV</Button></>} />
        : <PageHeader eyebrow="Your weeks" title="My weekly reviews" subtitle="Notes from your manager or the main administrator about your recorded weeks. You can respond to each one." />}
      {r.canReview && <div className="mb-4"><Segmented label="Show" value={tab} onChange={(v) => set({ tab: v === 'mine' ? 'mine' : null })}
        options={[{ value: 'team', label: 'Team week' }, { value: 'mine', label: 'My weekly reviews' }]} /></div>}
      {tab === 'team' ? <TeamWeek week={week} thisWeek={thisWeek} lastWeek={lastWeek} includeMe={includeMe} set={set} sp={sp} /> : <MyWeeklyReviews highlightWeek={validWeek ? week : null} />}
    </div>
  );
}

function TeamWeek({ week, thisWeek, lastWeek, includeMe, set, sp }: { week: string; thisWeek: string; lastWeek: string; includeMe: boolean; set: (o: Record<string, string | null>) => void; sp: URLSearchParams }) {
  const me = useMe();
  const filter = FILTERS.find((f) => f.key === sp.get('filter')) ?? FILTERS[0];
  const view = sp.get('view') === 'table' ? 'table' : 'cards';
  const [reviewing, setReviewing] = useState<{ p: any; action: ReviewAction } | null>(null);
  const q = useQuery({ queryKey: ['team-review', week, includeMe], queryFn: () => api.get(`/api/team-review${qs({ week, includeMe: includeMe ? 1 : undefined })}`) });
  const d = q.data;
  const shown = d ? d.people.filter(filter.test) : [];
  const t = d?.totals;
  const range = weekRange(week);
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex items-center gap-1">
          <IconButton label="Previous week" onClick={() => set({ week: addDays(week, -7) })}><ChevronLeft className="size-4" /></IconButton>
          <Input aria-label="Any date in the week" type="date" className="h-8 w-40" max={me.today} value={week} onChange={(e) => e.target.value && set({ week: mondayOf(e.target.value) })} />
          <IconButton label="Next week" className="disabled:opacity-40" disabled={addDays(week, 7) > me.today} onClick={() => set({ week: addDays(week, 7) })}><ChevronRight className="size-4" /></IconButton>
        </div>
        <span className="text-[13px] font-medium text-ink-2">{range}</span>
        {week === thisWeek && <Badge tone="warning">In progress — figures are provisional</Badge>}
        {week !== lastWeek && <Button size="sm" variant="ghost" onClick={() => set({ week: null })}>Last week</Button>}
        {week !== thisWeek && <Button size="sm" variant="ghost" onClick={() => set({ week: thisWeek })}>This week</Button>}
        <div className="flex flex-wrap items-center gap-3 sm:ml-auto">
          <Checkbox checked={includeMe} onChange={(v) => set({ me: v ? '1' : null })} label="Include me" />
          <Segmented label="Layout" value={view} onChange={(v) => set({ view: v === 'table' ? 'table' : null })}
            options={[{ value: 'cards', label: <span className="inline-flex items-center gap-1"><LayoutGrid className="size-3.5" aria-hidden />Cards</span> },
              { value: 'table', label: <span className="inline-flex items-center gap-1"><Table2 className="size-3.5" aria-hidden />Table</span> }]} />
        </div>
      </div>

      {q.isLoading ? <div className="space-y-4"><div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">{[...Array(6)].map((_, i) => <Skeleton key={i} className="h-24" />)}</div>
        <div className="grid gap-4 xl:grid-cols-2"><Skeleton className="h-96" /><Skeleton className="h-96" /></div></div>
      : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} />
      : <>
        <section aria-label="Team totals" className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <Stat label="Intended outcomes accepted" value={`${t.outcomes.acceptedPlanned}/${t.outcomes.intended}`} sub={`${pct(t.outcomes.plannedCompletion)} planned completion`} hint={d.definitions.planned_commitment_completion} />
          <Stat label="Accepted outcomes" value={t.outcomes.accepted} sub={`${t.outcomes.carryovers} carryovers`} hint={d.definitions.accepted_outcome} />
          <Stat label="Logging coverage" value={pct(t.time.loggingCoverage)} sub={`${hm(t.time.unknownMinutes)} unknown, not idle`} hint={d.definitions.logging_coverage} />
          <Stat label="Blocked time" value={hm(t.time.blockedMinutes)} sub={`${t.openBlockers} open blocker${t.openBlockers === 1 ? '' : 's'}`} tone={t.openBlockers ? 'warning' : undefined} hint={d.definitions.blocker_share} />
          <Stat label="Deadlines met" value={t.deadlines.met} sub={`${t.deadlines.late} late · ${t.deadlines.overdue} overdue`} tone={t.deadlines.overdue ? 'critical' : undefined} />
          <Stat label="Recaps confirmed" value={pct(t.recaps.completion)} sub={`${t.recaps.confirmed}/${t.recaps.required} · ${t.recaps.missing} missing`} tone={t.recaps.missing ? 'warning' : undefined} />
        </section>

        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div role="group" aria-label="Filter people" className="flex flex-wrap gap-1.5">
            {FILTERS.map((f) => {
              const n = d.people.filter(f.test).length; const active = f.key === filter.key;
              return (
                <button key={f.key} type="button" aria-pressed={active} onClick={() => set({ filter: f.key === 'all' ? null : f.key })}
                  className={cx('inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium ring-1 ring-inset',
                    active ? 'bg-accent-soft text-accent-ink ring-accent' : 'bg-surface text-ink-2 ring-line-strong hover:bg-surface-2 hover:text-ink')}>
                  {f.label}<span className="tabular rounded-full bg-surface-2 px-1.5 text-[11px] text-ink-2">{n}</span>
                </button>
              );
            })}
          </div>
          <p className="text-[12px] text-ink-3"><Users className="mr-1 inline size-3.5 align-[-2px]" aria-hidden />{t.reviewedByYou} of {t.people - (includeMe ? 1 : 0)} reviewed by you · alphabetical, not ranked</p>
        </div>

        {d.people.length === 0
          ? <Card><Empty icon={<Users className="size-6" />} title="Nobody to review in this scope">People you manage (or, for the main administrator, every employee) appear here once they are active members of a team.</Empty></Card>
          : shown.length === 0
            ? <Card><Empty title="Nobody matches this filter" action={<Button size="sm" onClick={() => set({ filter: null })}>Show everyone</Button>}>Try another filter or week.</Empty></Card>
            : view === 'table'
              ? <TeamTable people={shown} week={week} range={range} onReview={(p, action) => setReviewing({ p, action })} />
              : <div className="grid items-start gap-4 xl:grid-cols-2">{shown.map((p: any) => <PersonCard key={p.user.id} p={p} week={week} onReview={(x, action) => setReviewing({ p: x, action })} />)}</div>}

        <div className="mt-4"><Callout tone="neutral" icon={<ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden />}>{d.note} Each assessment lists the facts and assumptions it rests on; there is no single productivity score. Records come from plans, recaps, confirmed time, blockers and accepted tasks — never screens, keystrokes or browsing.</Callout></div>
      </>}
      <ReviewModal person={reviewing?.p ?? null} initial={reviewing?.action ?? 'acknowledge'} week={week} today={me.today} onClose={() => setReviewing(null)} />
    </>
  );
}
