import type { ReactNode } from 'react';
import { CalendarClock, CheckCircle2, Flag } from 'lucide-react';
import { fmtDate } from '../../lib/format';
import { Badge, cx } from '../ui';
import { LogoTile, useBranding } from './BrandMark';

/** Client-facing shape returned by the API (identical for the portal, the staff preview and the PDF). */
export interface ClientUpdate {
  id: string; projectId: string; projectName: string; projectKey: string; customerName: string | null;
  periodStart: string; periodEnd: string; summary: string; publishedAt: string | null; publishedByName: string | null;
  highlights: {
    generatedAt: string;
    project: { name: string; key: string; outcome: string; targetDate: string | null; status: string };
    milestones: { id: string; name: string; dueDate: string | null; status: string; done: number; total: number }[];
    completed: { id: string; title: string; milestone: string | null; completedOn: string }[];
    upcoming: { id: string; title: string; milestone: string | null; dueDate: string | null; status: string }[];
  };
}

/** Client-friendly status words (no internal workflow jargon). */
export const CLIENT_STATUS: Record<string, { label: string; tone: 'neutral' | 'info' | 'warning' | 'good' }> = {
  backlog: { label: 'Not started', tone: 'neutral' }, planned: { label: 'Planned', tone: 'neutral' }, in_progress: { label: 'In progress', tone: 'info' },
  blocked: { label: 'Waiting', tone: 'warning' }, in_review: { label: 'In review', tone: 'info' }, done: { label: 'Done', tone: 'good' },
};
export const periodText = (s: string, e: string) => `${fmtDate(s)} – ${fmtDate(e, { day: 'numeric', month: 'short', year: 'numeric' })}`;

function Section({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <section className="border-t border-line pt-4">
      <h3 className="mb-2.5 flex items-center gap-2 text-[14px] font-semibold text-ink">{icon}{title}</h3>
      {children}
    </section>
  );
}

/** The update exactly as the client sees it. `removable` (staff drafts only) adds remove buttons to items. */
export function ClientUpdateView({ u, removable, headingLevel = 2 }: { u: ClientUpdate; removable?: (id: string, label: string) => ReactNode; headingLevel?: 1 | 2 }) {
  const b = useBranding();
  const h = u.highlights;
  const H = headingLevel === 1 ? 'h1' : 'h2';
  const org = b.data?.displayName ?? '';
  return (
    <article className="space-y-4" aria-label={`${u.projectName} update`}>
      <header className="flex items-start gap-3">
        <LogoTile name={org || u.projectName} logoUrl={b.data?.logo?.url} size={40} alt={org ? `${org} logo` : ''} />
        <div className="min-w-0 flex-1">
          {org && <p className="text-[12px] font-medium text-ink-3">From {org}{u.customerName ? ` for ${u.customerName}` : ''}</p>}
          <H className="text-[19px] font-semibold leading-tight text-ink">{u.projectName} — project update</H>
          <p className="mt-0.5 text-[13px] text-ink-2">{periodText(u.periodStart, u.periodEnd)}
            {u.publishedAt && <span className="text-ink-3"> · Published {fmtDate(u.publishedAt, { day: 'numeric', month: 'short' })}{u.publishedByName ? ` by ${u.publishedByName}` : ''}</span>}</p>
        </div>
      </header>

      <div>
        <h3 className="sr-only">Summary</h3>
        {u.summary.trim() ? <p className="whitespace-pre-wrap text-[14px] leading-relaxed text-ink">{u.summary}</p>
          : <p className="text-[13px] italic text-ink-3">No summary written yet.</p>}
      </div>

      <Section title="Milestone progress" icon={<Flag className="size-4 text-ink-3" aria-hidden />}>
        {h.milestones.length === 0 ? <p className="text-[13px] text-ink-3">No shared milestones yet.</p> : (
          <ul className="space-y-3">{h.milestones.map((m) => {
            const pct = m.total ? Math.round((m.done / m.total) * 100) : 0;
            return (
              <li key={m.id}>
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                  <span className="min-w-0 text-[13.5px] font-medium text-ink">{m.name}</span>
                  <span className="flex items-center gap-2 text-[12.5px] text-ink-3">
                    {m.status === 'done' ? <Badge tone="good">Complete</Badge> : m.dueDate ? `Due ${fmtDate(m.dueDate)}` : 'No due date'}
                    {removable?.(m.id, m.name)}
                  </span>
                </div>
                <div className="mt-1.5 flex items-center gap-2.5">
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuemin={0} aria-valuemax={m.total} aria-valuenow={m.done}
                    aria-label={`${m.name}: ${m.done} of ${m.total} shared items done`}>
                    <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="tabular w-36 shrink-0 text-right text-[12.5px] text-ink-2">{m.done} of {m.total} done ({pct}%)</span>
                </div>
              </li>
            );
          })}</ul>
        )}
      </Section>

      <Section title="Completed this period" icon={<CheckCircle2 className="size-4 text-good-ink" aria-hidden />}>
        {h.completed.length === 0 ? <p className="text-[13px] text-ink-3">No shared deliverables were completed in this period.</p> : (
          <ul className="divide-y divide-line">{h.completed.map((t) => (
            <li key={t.id} className="flex items-start gap-2 py-2 text-[13.5px]">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-good-ink" aria-hidden />
              <div className="min-w-0 flex-1"><span className="text-ink">{t.title}</span>{t.milestone && <span className="block text-[12px] text-ink-3">{t.milestone}</span>}</div>
              <span className="shrink-0 text-[12.5px] text-ink-3">{fmtDate(t.completedOn)}</span>
              {removable?.(t.id, t.title)}
            </li>
          ))}</ul>
        )}
      </Section>

      <Section title="Coming up" icon={<CalendarClock className="size-4 text-ink-3" aria-hidden />}>
        {h.upcoming.length === 0 ? <p className="text-[13px] text-ink-3">No upcoming shared work scheduled.</p> : (
          <ul className="divide-y divide-line">{h.upcoming.map((t) => {
            const s = CLIENT_STATUS[t.status] ?? { label: t.status, tone: 'neutral' as const };
            return (
              <li key={t.id} className="flex flex-wrap items-start gap-x-2 gap-y-1 py-2 text-[13.5px]">
                <div className="min-w-0 flex-1 basis-48"><span className="text-ink">{t.title}</span>{t.milestone && <span className="block text-[12px] text-ink-3">{t.milestone}</span>}</div>
                <span className="flex shrink-0 items-center gap-2"><Badge tone={s.tone}>{s.label}</Badge>
                  <span className={cx('w-20 text-right text-[12.5px] text-ink-3')}>{t.dueDate ? `Due ${fmtDate(t.dueDate)}` : 'No date'}</span>
                  {removable?.(t.id, t.title)}</span>
              </li>
            );
          })}</ul>
        )}
      </Section>

      <p className="border-t border-line pt-3 text-[12px] text-ink-3">This update lists only milestones and deliverables your project team shares with you. Target dates can change.</p>
    </article>
  );
}
