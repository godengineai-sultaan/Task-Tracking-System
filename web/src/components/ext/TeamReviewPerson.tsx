import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CalendarRange, CircleCheck, ExternalLink, Flag, ListChecks, MessagesSquare } from 'lucide-react';
import { api } from '../../lib/api';
import { addDays, fmtDate, fmtDateTime, hm, pct } from '../../lib/format';
import { AssessmentBadge, Avatar, Badge, Button, Checkbox, Field, Input, Modal, StatusBadge, Textarea, cx, useToast } from '../ui';

export type ReviewAction = 'acknowledge' | 'discussed' | 'needs_follow_up';
export const REVIEW_STATUS: Record<string, { label: string; tone: 'good' | 'info' | 'warning' }> = {
  acknowledged: { label: 'Acknowledged', tone: 'good' }, discussed: { label: 'Discussed', tone: 'info' }, needs_follow_up: { label: 'Needs follow-up', tone: 'warning' },
};
const ACTION_STATUS: Record<ReviewAction, string> = { acknowledge: 'acknowledged', discussed: 'discussed', needs_follow_up: 'needs_follow_up' };
const STATUS_ACTION: Record<string, ReviewAction> = { acknowledged: 'acknowledge', discussed: 'discussed', needs_follow_up: 'needs_follow_up' };

/** Monday of the ISO week containing a YYYY-MM-DD date. */
export function mondayOf(d: string) { const x = new Date(`${d}T12:00:00Z`); return addDays(d, -((x.getUTCDay() + 6) % 7)); }
export const weekRange = (start: string) => `${fmtDate(start)} – ${fmtDate(addDays(start, 6), { day: 'numeric', month: 'short', year: 'numeric' })}`;
const firstName = (n: string) => n.split(' ')[0];

export function ReviewStatusBadge({ status }: { status: string | null | undefined }) {
  if (!status) return <Badge>Not reviewed</Badge>;
  const s = REVIEW_STATUS[status];
  return <Badge tone={s?.tone}>{s?.label ?? status}</Badge>;
}

/** Confirmed vs unknown time for the week. Unknown is hatched and never shown as idle. */
export function CoverageBar({ confirmed, unknown, available }: { confirmed: number; unknown: number; available: number }) {
  if (!available) return <p className="text-[12px] text-ink-3">No scheduled capacity this week, so coverage is Not Applicable.</p>;
  const w = (Math.min(confirmed, available) / available) * 100;
  return (
    <div>
      <div className="flex h-2 w-full gap-[2px] overflow-hidden rounded" role="img" aria-label={`Confirmed ${hm(confirmed)} and unknown ${hm(unknown)} of ${hm(available)} available`}>
        {confirmed > 0 && <div title={`Confirmed: ${hm(confirmed)}`} className="rounded-l" style={{ width: `${w}%`, minWidth: 3, background: 'var(--c-task)' }} />}
        {unknown > 0 && <div title={`Unknown, not idle: ${hm(unknown)}`} className="hatch flex-1 rounded-r" />}
      </div>
      <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[12px] text-ink-2">
        <li className="flex items-center gap-1.5"><span aria-hidden className="inline-block size-2.5 rounded-sm" style={{ background: 'var(--c-task)' }} />Confirmed <span className="tabular font-medium text-ink">{hm(confirmed)}</span></li>
        <li className="flex items-center gap-1.5"><span aria-hidden className="hatch inline-block size-2.5 rounded-sm ring-1 ring-line-strong" />Unknown, not idle <span className="tabular font-medium text-ink">{hm(unknown)}</span></li>
      </ul>
    </div>
  );
}

function Metric({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: 'critical' | 'warning' }) {
  return (
    <div className="min-w-0">
      <dt className="text-[12px] text-ink-3">{label}</dt>
      <dd className={cx('tabular text-[15px] font-semibold leading-snug', tone === 'critical' && 'text-critical-ink', tone === 'warning' && 'text-warning-ink')}>
        {value}{sub !== undefined && sub !== '' && <span className="ml-1 text-[12px] font-normal text-ink-3">{sub}</span>}
      </dd>
    </div>
  );
}

export function ReviewNote({ review, subjectName, mine }: { review: any; subjectName: string; mine?: boolean }) {
  return (
    <div className="rounded-lg bg-surface-2 p-3 text-[13px]">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <ReviewStatusBadge status={review.status} />
        <span className="text-[12px] text-ink-3">{mine ? 'Your review' : `By ${review.reviewer.name}`} · {fmtDateTime(review.updatedAt)}</span>
      </div>
      {review.note && <p className="mt-1.5 whitespace-pre-wrap break-words text-ink">{review.note}</p>}
      {review.followUpTask && (
        <Link to={`/tasks/${review.followUpTask.id}`} className="mt-1.5 inline-flex max-w-full items-center gap-1.5 text-accent-ink hover:underline">
          <ListChecks className="size-3.5 shrink-0" aria-hidden /><span className="truncate">Follow-up: {review.followUpTask.title}</span>
          {review.followUpTask.status && <StatusBadge status={review.followUpTask.status} />}
        </Link>
      )}
      {review.employeeResponse && (
        <div className="mt-2 border-l-2 border-accent pl-2.5">
          <div className="text-[12px] text-ink-3">Response from {firstName(subjectName)} · {fmtDateTime(review.employeeRespondedAt)}</div>
          <p className="whitespace-pre-wrap break-words text-ink">{review.employeeResponse}</p>
        </div>
      )}
    </div>
  );
}

function ListBlock({ title, items }: { title: string; items: React.ReactNode[] }) {
  if (!items.length) return null;
  return (
    <div>
      <h3 className="mb-1 text-[12px] font-medium text-ink-3">{title}</h3>
      <ul className="space-y-0.5 text-[13px] text-ink-2">{items.map((x, i) => <li key={i} className="break-words">{x}</li>)}</ul>
    </div>
  );
}

/** One person's week: explainable assessment, recorded facts, drill links and inline review actions. */
export function PersonCard({ p, week, onReview }: { p: any; week: string; onReview: (p: any, action: ReviewAction) => void }) {
  const id = `person-${p.user.id}`;
  const o = p.outcomes, t = p.time, d = p.deadlines;
  const reportLink = p.isSelf ? `/analytics?kind=week&date=${week}` : `/analytics/${p.user.id}?kind=week&date=${week}`;
  return (
    <article aria-labelledby={id} className="flex flex-col rounded-xl bg-surface shadow-card ring-1 ring-line">
      <header className="flex flex-wrap items-start gap-3 border-b border-line p-4">
        <Avatar name={p.user.name} size={32} />
        <div className="min-w-0 flex-1">
          <h2 id={id} className="text-[15px] font-semibold leading-tight"><Link to={reportLink} className="hover:underline">{p.user.name}</Link>{p.isSelf && <span className="ml-1.5 text-[12px] font-normal text-ink-3">(you)</span>}</h2>
          <p className="mt-0.5 truncate text-[12px] text-ink-3">{[p.user.title, p.user.department, `profile “${p.roleProfile}”`].filter(Boolean).join(' · ')}</p>
        </div>
        <div className="flex w-full flex-wrap items-center gap-1.5 sm:w-auto">
          <AssessmentBadge label={p.assessment.label} />
          {!p.isSelf && <ReviewStatusBadge status={p.review?.status} />}
        </div>
      </header>
      <div className="flex-1 space-y-4 p-4">
        <ul className="space-y-1 text-[13px] text-ink">{p.assessment.reasons.map((r: string, i: number) => <li key={i}>{r}</li>)}</ul>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
          <Metric label="Intended outcomes accepted" value={`${o.acceptedPlanned}/${o.intended}`} sub={o.intended ? pct(o.plannedCompletion) : ''} />
          <Metric label="Accepted outcomes" value={o.accepted} />
          <Metric label="Carryovers" value={o.carryovers} />
          <Metric label="Deadlines met" value={d.met} sub={`${d.late} late · ${d.overdue} overdue`} tone={d.overdue ? 'critical' : undefined} />
          <Metric label="Blocked time" value={hm(t.blockedMinutes)} sub={`${p.blockers.open} open`} tone={p.blockers.open ? 'warning' : undefined} />
          <Metric label="Recaps confirmed" value={`${p.recaps.confirmed}/${p.recaps.required}`} sub={p.recaps.missing ? `${p.recaps.missing} missing` : ''} tone={p.recaps.missing ? 'warning' : undefined} />
        </dl>
        <div>
          <div className="mb-1.5 flex items-baseline justify-between gap-2 text-[12px] text-ink-3"><span>Logging coverage (not productivity)</span><span className="tabular font-medium text-ink">{t.availableMinutes ? pct(t.loggingCoverage) : 'N/A'}</span></div>
          <CoverageBar confirmed={t.confirmedMinutes} unknown={t.unknownMinutes} available={t.availableMinutes} />
        </div>
        <ListBlock title="Open blockers" items={p.blockers.items.map((b: any) => <><Link className="font-medium text-ink hover:underline" to={`/tasks/${b.taskId}`}>{b.task}</Link>: {b.reason}{b.waitingOn ? ` · waiting on ${b.waitingOn}` : ''}</>)} />
        <ListBlock title="Overdue" items={d.overdueItems.map((x: any) => <><Link className="font-medium text-ink hover:underline" to={`/tasks/${x.taskId}`}>{x.title}</Link> · due {fmtDate(x.dueDate)}</>)} />
        <ListBlock title="Carried over" items={o.carriedOverTitles} />
        <ListBlock title="Suggested next steps" items={p.recommendations.map((r: any) => r.text)} />
        <details className="group text-[13px]">
          <summary className="cursor-pointer rounded text-ink-2 hover:text-ink">Facts and assumptions behind this assessment</summary>
          <div className="mt-2 space-y-2 text-ink-2">
            <ul className="list-disc space-y-0.5 pl-5">{p.assessment.facts.map((f: string, i: number) => <li key={i}>{f}</li>)}</ul>
            <p className="text-[12px] text-ink-3">Assumptions: {p.assessment.assumptions.join('; ')}</p>
          </div>
        </details>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
          <Link to={reportLink} className="inline-flex items-center gap-1 text-accent-ink hover:underline"><CalendarRange className="size-3.5" aria-hidden />Week report</Link>
          <Link to={`/admin/routine/${p.user.id}?date=${p.lastWorkingDate ?? week}`} className="inline-flex items-center gap-1 text-accent-ink hover:underline"><ExternalLink className="size-3.5" aria-hidden />Daily routine</Link>
        </div>
      </div>
      <footer className="space-y-3 border-t border-line p-4">
        {p.isSelf ? <p className="text-[13px] text-ink-3">This is your own week. Reviews of it come from your manager or the main administrator.</p> : <>
          {p.review ? <ReviewNote review={p.review} subjectName={p.user.name} mine /> : <p className="text-[13px] text-ink-3">You have not reviewed this week yet.</p>}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant={p.review ? 'secondary' : 'primary'} icon={<CircleCheck className="size-4" aria-hidden />} aria-label={`Acknowledge ${p.user.name}'s week`} onClick={() => onReview(p, 'acknowledge')}>Acknowledge</Button>
            <Button size="sm" icon={<MessagesSquare className="size-4" aria-hidden />} aria-label={`Mark ${p.user.name}'s week discussed`} onClick={() => onReview(p, 'discussed')}>Mark discussed</Button>
            <Button size="sm" icon={<Flag className="size-4" aria-hidden />} aria-label={`Request follow-up for ${p.user.name}`} onClick={() => onReview(p, 'needs_follow_up')}>Request follow-up</Button>
          </div>
        </>}
        {p.otherReviews.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-[12px] font-medium text-ink-3">Other reviewers</h3>
            {p.otherReviews.map((r: any) => <ReviewNote key={r.id} review={r} subjectName={p.user.name} />)}
          </div>
        )}
      </footer>
    </article>
  );
}

/** Table view of the same facts (alphabetical, no ranking). Scrolls inside its own container on small screens. */
export function TeamTable({ people, week, range, onReview }: { people: any[]; week: string; range: string; onReview: (p: any, action: ReviewAction) => void }) {
  return (
    <div className="overflow-x-auto rounded-xl bg-surface ring-1 ring-line">
      <table className="w-full min-w-[1120px] text-[13px]">
        <caption className="sr-only">Team week summary for {range}, in alphabetical order. Not a ranking.</caption>
        <thead className="border-b border-line text-left text-[12px] text-ink-3"><tr>
          {['Person', 'Assessment', 'Intended accepted', 'Accepted', 'Carryovers', 'Logging coverage', 'Unknown (not idle)', 'Blocked', 'Deadlines met / late / overdue', 'Recaps', 'Your review'].map((h) =>
            <th key={h} scope="col" className="px-3 py-2 font-medium">{h}</th>)}
        </tr></thead>
        <tbody className="divide-y divide-line">{people.map((p) => (
          <tr key={p.user.id} className="align-top hover:bg-surface-2/60">
            <th scope="row" className="whitespace-nowrap px-3 py-2.5 text-left font-medium">
              <Link to={p.isSelf ? `/analytics?kind=week&date=${week}` : `/analytics/${p.user.id}?kind=week&date=${week}`} className="flex items-center gap-2 hover:underline">
                <Avatar name={p.user.name} size={24} /><span>{p.user.name}{p.isSelf && ' (you)'}<span className="block text-[12px] font-normal text-ink-3">{p.user.department ?? '—'}</span></span></Link></th>
            <td className="px-3 py-2.5"><AssessmentBadge label={p.assessment.label} /></td>
            <td className="tabular whitespace-nowrap px-3 py-2.5">{p.outcomes.acceptedPlanned}/{p.outcomes.intended} <span className="text-ink-3">{p.outcomes.intended ? pct(p.outcomes.plannedCompletion) : ''}</span></td>
            <td className="tabular whitespace-nowrap px-3 py-2.5">{p.outcomes.accepted}</td>
            <td className="tabular whitespace-nowrap px-3 py-2.5">{p.outcomes.carryovers}</td>
            <td className="tabular whitespace-nowrap px-3 py-2.5">{p.time.availableMinutes ? <>{pct(p.time.loggingCoverage)} <span className="text-ink-3">· {hm(p.time.confirmedMinutes)}</span></> : 'N/A'}</td>
            <td className="tabular whitespace-nowrap px-3 py-2.5">{p.time.availableMinutes ? hm(p.time.unknownMinutes) : 'N/A'}</td>
            <td className="tabular whitespace-nowrap px-3 py-2.5">{hm(p.time.blockedMinutes)} <span className="text-ink-3">· {p.blockers.open} open</span></td>
            <td className="tabular whitespace-nowrap px-3 py-2.5">{p.deadlines.met} / {p.deadlines.late} / <span className={p.deadlines.overdue ? 'text-critical-ink' : ''}>{p.deadlines.overdue}</span></td>
            <td className="tabular whitespace-nowrap px-3 py-2.5">{p.recaps.confirmed}/{p.recaps.required}{p.recaps.missing > 0 && <span className="block text-[12px] text-warning-ink">{p.recaps.missing} missing</span>}</td>
            <td className="px-3 py-2.5">{p.isSelf ? <span className="text-ink-3">—</span> : <div className="flex flex-wrap items-center gap-2">
              <ReviewStatusBadge status={p.review?.status} />
              <Button size="sm" variant="ghost" aria-label={`Review ${p.user.name}'s week`} onClick={() => onReview(p, p.review ? STATUS_ACTION[p.review.status] : 'acknowledge')}>Review</Button></div>}</td>
          </tr>))}</tbody>
      </table>
    </div>
  );
}

const OUTCOMES: { value: ReviewAction; label: string; hint: string }[] = [
  { value: 'acknowledge', label: 'Acknowledged', hint: 'You have seen the week; nothing to change.' },
  { value: 'discussed', label: 'Discussed', hint: 'You talked it through together.' },
  { value: 'needs_follow_up', label: 'Needs follow-up', hint: 'Something needs action; optionally create a task.' },
];

/** Record or update the reviewer's review of one person's week. Saving notifies the employee; it never edits their recaps or time. */
export function ReviewModal({ person, week, initial, today, onClose }: { person: any | null; week: string; initial: ReviewAction; today: string; onClose: () => void }) {
  const qc = useQueryClient(); const toast = useToast();
  const [action, setAction] = useState<ReviewAction>(initial);
  const [note, setNote] = useState(''); const [withTask, setWithTask] = useState(false);
  const [title, setTitle] = useState(''); const [due, setDue] = useState('');
  useEffect(() => {
    if (!person) return;
    setAction(initial); setNote(person.review?.note ?? ''); setWithTask(false); setTitle(''); setDue('');
  }, [person?.user.id, person?.review?.version, initial]); // eslint-disable-line react-hooks/exhaustive-deps
  const name = person ? firstName(person.user.name) : '';
  const m = useMutation({
    mutationFn: () => api.post('/api/team-review/reviews', {
      subjectUserId: person.user.id, week, action, note, version: person.review?.version,
      followUp: action === 'needs_follow_up' && withTask ? { title: title.trim(), dueDate: due || null } : undefined,
    }),
    onSuccess: () => {
      toast({ tone: 'good', text: `Review saved as ${REVIEW_STATUS[ACTION_STATUS[action]].label.toLowerCase()}. ${name} has been notified.` });
      qc.invalidateQueries({ queryKey: ['team-review'] }); onClose();
    },
    onError: (e: any) => {
      if (e.status === 409) { toast({ tone: 'critical', text: 'This review changed elsewhere. The latest version has been loaded; check it and save again.' }); qc.invalidateQueries({ queryKey: ['team-review'] }); onClose(); }
      else toast({ tone: 'critical', text: e.message });
    },
  });
  const invalid = (action === 'needs_follow_up' && !note.trim() && !(withTask && title.trim())) || (withTask && action === 'needs_follow_up' && !title.trim());
  return (
    <Modal open={!!person} onClose={onClose} title={person ? `Review ${person.user.name}'s week` : 'Review'}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} disabled={invalid} onClick={() => m.mutate()}>Save review</Button></>}>
      {person && <div className="space-y-4">
        <p className="text-[13px] text-ink-2">{weekRange(week)} · <AssessmentBadge label={person.assessment.label} /></p>
        <fieldset>
          <legend className="mb-1.5 text-[13px] font-medium text-ink-2">Review outcome</legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {OUTCOMES.map((x) => (
              <label key={x.value} className={cx('flex cursor-pointer gap-2 rounded-lg p-2.5 ring-1 ring-inset focus-within:ring-2 focus-within:ring-accent',
                action === x.value ? 'bg-accent-soft ring-accent' : 'bg-surface ring-line-strong hover:bg-surface-2')}>
                <input type="radio" name="review-outcome" value={x.value} checked={action === x.value} onChange={() => setAction(x.value)} className="mt-0.5 accent-[var(--accent)]" />
                <span><span className="block text-[13px] font-medium text-ink">{x.label}</span><span className="block text-[12px] text-ink-3">{x.hint}</span></span>
              </label>
            ))}
          </div>
        </fieldset>
        <Field label={`Note for ${name}`} hint={`${name} sees this note and can respond. It never changes their recaps or time entries.`}>
          {(id) => <Textarea id={id} data-autofocus rows={4} maxLength={3000} value={note} onChange={(e) => setNote(e.target.value)}
            placeholder={action === 'needs_follow_up' ? 'What needs follow-up, and why?' : 'Optional: what went well, context, next steps'} />}
        </Field>
        {action === 'needs_follow_up' && (
          <div className="space-y-3 rounded-lg bg-surface-2 p-3">
            <Checkbox checked={withTask} onChange={setWithTask} label={`Also create a follow-up task for ${name}`} />
            {withTask && <div className="grid gap-3 sm:grid-cols-[1fr_11rem]">
              <Field label="Task title">{(id) => <Input id={id} maxLength={300} value={title} onChange={(e) => setTitle(e.target.value)} />}</Field>
              <Field label="Due date (optional)">{(id) => <Input id={id} type="date" min={today} value={due} onChange={(e) => setDue(e.target.value)} />}</Field>
            </div>}
          </div>
        )}
        {person.review && <p className="text-[12px] text-ink-3">Updating your existing review (version {person.review.version}).</p>}
      </div>}
    </Modal>
  );
}
