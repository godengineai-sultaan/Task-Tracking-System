import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarRange, Inbox, ListChecks, Send } from 'lucide-react';
import { api } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { Button, Card, Empty, ErrorState, Field, Skeleton, StatusBadge, Textarea, cx, useToast } from '../ui';
import { ReviewStatusBadge, weekRange } from './TeamReviewPerson';

function MyReviewCard({ review, highlight }: { review: any; highlight: boolean }) {
  const qc = useQueryClient(); const toast = useToast();
  const ref = useRef<HTMLElement>(null);
  const [editing, setEditing] = useState(!review.employeeResponse);
  const [text, setText] = useState(review.employeeResponse ?? '');
  useEffect(() => { setText(review.employeeResponse ?? ''); setEditing(!review.employeeResponse); }, [review.version, review.employeeResponse]);
  useEffect(() => { if (highlight) ref.current?.scrollIntoView({ block: 'center' }); }, [highlight]);
  // Switching between the response and the form removes the focused control; move focus to its counterpart.
  const textRef = useRef<HTMLTextAreaElement>(null); const editRef = useRef<HTMLButtonElement>(null); const focusNext = useRef<'text' | 'edit' | null>(null);
  useEffect(() => { if (focusNext.current) (focusNext.current === 'text' ? textRef : editRef).current?.focus(); focusNext.current = null; }, [editing]);
  const reviewer = review.reviewer.name.split(' ')[0];
  const m = useMutation({
    mutationFn: () => api.post(`/api/team-review/reviews/${review.id}/respond`, { response: text, version: review.version }),
    onSuccess: () => { focusNext.current = 'edit'; toast({ tone: 'good', text: `Response sent to ${reviewer}` }); qc.invalidateQueries({ queryKey: ['team-review-mine'] }); },
    onError: (e: any) => {
      toast({ tone: 'critical', text: e.status === 409 ? 'This review changed since you opened it. The latest version has been loaded.' : e.message });
      if (e.status === 409) qc.invalidateQueries({ queryKey: ['team-review-mine'] });
    },
  });
  const hid = `my-review-${review.id}`;
  return (
    <article ref={ref} aria-labelledby={hid} className={cx('rounded-xl bg-surface shadow-card', highlight ? 'ring-2 ring-accent' : 'ring-1 ring-line')}>
      <header className="flex flex-wrap items-start justify-between gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <h2 id={hid} className="text-[15px] font-semibold">Week of {weekRange(review.weekStart)}</h2>
          <p className="text-[12px] text-ink-3">Reviewed by {review.reviewer.name} · {fmtDateTime(review.updatedAt)}</p>
        </div>
        <ReviewStatusBadge status={review.status} />
      </header>
      <div className="space-y-3 p-4 text-[13.5px]">
        {review.note ? <p className="whitespace-pre-wrap break-words text-ink">{review.note}</p> : <p className="text-ink-3">No note was added.</p>}
        {review.followUpTask && (
          <Link to={`/tasks/${review.followUpTask.id}`} className="inline-flex max-w-full items-center gap-1.5 text-accent-ink hover:underline">
            <ListChecks className="size-4 shrink-0" aria-hidden /><span className="truncate">Follow-up task: {review.followUpTask.title}</span>
            {review.followUpTask.status && <StatusBadge status={review.followUpTask.status} />}
          </Link>
        )}
        {!editing ? (
          <div className="rounded-lg bg-surface-2 p-3">
            <div className="text-[12px] text-ink-3">Your response · {fmtDateTime(review.employeeRespondedAt)}</div>
            <p className="mt-0.5 whitespace-pre-wrap break-words text-ink">{review.employeeResponse}</p>
            <Button ref={editRef} size="sm" variant="ghost" className="mt-1 -ml-2" onClick={() => { focusNext.current = 'text'; setEditing(true); }}>Edit response</Button>
          </div>
        ) : (
          <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); if (text.trim()) m.mutate(); }}>
            <Field label="Your response" hint={`Optional. ${reviewer} is notified. Add context, agree next steps or correct a misunderstanding.`}>
              {(id) => <Textarea ref={textRef} id={id} rows={3} maxLength={3000} value={text} onChange={(e) => setText(e.target.value)} />}
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" size="sm" variant="primary" icon={<Send className="size-4" aria-hidden />} loading={m.isPending} disabled={!text.trim()}>Send response</Button>
              {review.employeeResponse && <Button type="button" size="sm" variant="ghost" onClick={() => { focusNext.current = 'edit'; setText(review.employeeResponse); setEditing(false); }}>Cancel</Button>}
            </div>
          </form>
        )}
        <Link to={`/analytics?kind=week&date=${review.weekStart}`} className="inline-flex items-center gap-1 text-[13px] text-accent-ink hover:underline">
          <CalendarRange className="size-3.5" aria-hidden />Open my week report</Link>
      </div>
    </article>
  );
}

/** The signed-in person's own weekly reviews (from any reviewer), newest week first. */
export function MyWeeklyReviews({ highlightWeek }: { highlightWeek: string | null }) {
  const q = useQuery({ queryKey: ['team-review-mine'], queryFn: () => api.get<any[]>('/api/team-review/mine') });
  if (q.isLoading) return <div className="space-y-4"><Skeleton className="h-40" /><Skeleton className="h-40" /></div>;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data?.length) return (
    <Card><Empty icon={<Inbox className="size-6" />} title="No weekly reviews yet">
      When your manager or the main administrator reviews one of your weeks, their note appears here and you can respond.
    </Empty></Card>
  );
  return <ul className="space-y-4">{q.data.map((r) => <li key={r.id}><MyReviewCard review={r} highlight={r.weekStart === highlightWeek} /></li>)}</ul>;
}
