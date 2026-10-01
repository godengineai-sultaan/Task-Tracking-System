import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ChevronLeft, ChevronRight, History, MessageSquareReply, Sparkles } from 'lucide-react';
import { api, qs } from '../lib/api';
import { STATUS_LABEL, addDays, fmtDate, fmtDateTime, fmtTime, hm } from '../lib/format';
import { useMe } from '../lib/session';
import { AssessmentBadge, Badge, Button, Callout, Card, ErrorState, Field, IconButton, Input, PageHeader, Segmented, Skeleton, StatusDot, Textarea, useToast } from '../components/ui';
import { AllocationBar, EntryModal, EntryRow } from '../components/time';
import { localDayBoundsIso } from './util';

export default function Recap() {
  const me = useMe(); const qc = useQueryClient(); const toast = useToast();
  const [sp, setSp] = useSearchParams();
  const date = sp.get('date') ?? me.today;
  const tz = me.user.effectiveTimezone;
  const q = useQuery({ queryKey: ['recap', date], queryFn: () => api.get(`/api/recap${qs({ date })}`) });
  const bounds = localDayBoundsIso(date, tz);
  const entries = useQuery({ queryKey: ['time-entries', date], queryFn: () => api.get(`/api/time-entries${qs({ from: bounds.start, to: bounds.end })}`) });
  const tasks = useQuery({ queryKey: ['tasks', { mine: '1' }], queryFn: () => api.get('/api/tasks?mine=1') });
  const openedAt = useRef(Date.now());
  const [f, setF] = useState({ summary: '', blockersNote: '', nextSteps: '', contextNote: '', dayType: 'work', changeReason: '' });
  const [entryModal, setEntryModal] = useState<{ entry?: any } | null>(null);
  const [aiRun, setAiRun] = useState<any>(null);
  useEffect(() => { openedAt.current = Date.now(); setAiRun(null); }, [date]);
  useEffect(() => {
    if (!q.data) return;
    const r = q.data.review; const day = q.data.report.days[0];
    if (r) setF({ summary: r.summary, blockersNote: r.blockers_note, nextSteps: r.next_steps, contextNote: r.context_note, dayType: r.day_type, changeReason: '' });
    else {
      const done = q.data.suggestedCompleted.map((c: any) => `${c.title}${c.to_status === 'in_review' ? ' (submitted for review)' : ''}`);
      const progressed = day.intendedOutcomes.filter((o: any) => !o.accepted && o.statusAtEndOfDay !== 'blocked').map((o: any) => o.title);
      const blocked = day.intendedOutcomes.filter((o: any) => o.statusAtEndOfDay === 'blocked').map((o: any) => o.title);
      setF({ summary: [done.length ? `Completed: ${done.join('; ')}.` : '', progressed.length ? `Progressed: ${progressed.join('; ')}.` : ''].filter(Boolean).join(' '),
        blockersNote: blocked.length ? `Blocked: ${blocked.join('; ')}` : '', nextSteps: day.carryovers.length ? `Continue ${day.carryovers.map((c: any) => c.title).join('; ')}` : '', contextNote: '', dayType: 'work', changeReason: '' });
    }
  }, [q.data]);
  const save = useMutation({
    mutationFn: (confirm: boolean) => (confirm ? api.post('/api/recap/confirm', { date, ...f, overheadMs: Date.now() - openedAt.current }) : api.put('/api/recap', { date, ...f })),
    onSuccess: (_r, confirm) => {
      if (aiRun) api.post(`/api/ai/runs/${aiRun.runId}/decision`, { decision: f.summary === aiRun.draft.summary ? 'accepted' : 'edited' }).catch(() => {});
      qc.invalidateQueries(); toast({ tone: 'good', text: confirm ? (q.data.review && q.data.review.status !== 'draft' ? 'Correction saved — earlier version kept' : 'Recap confirmed. Have a good evening!') : 'Draft saved' });
    },
    onError: (e: any) => toast({ tone: 'critical', text: e.message }),
  });
  const ai = useMutation({ mutationFn: () => api.post('/api/ai/recap-draft', { date }), onSuccess: (r: any) => { setAiRun(r); setF((x) => ({ ...x, summary: r.draft.summary, blockersNote: r.draft.blockers_note || x.blockersNote, nextSteps: r.draft.next_steps || x.nextSteps })); },
    onError: (e: any) => toast({ tone: 'critical', text: e.message }) });
  const respond = useMutation({ mutationFn: (b: any) => api.post('/api/manager-reviews', b), onSuccess: () => { qc.invalidateQueries(); toast({ tone: 'good', text: 'Response sent' }); }, onError: (e: any) => toast({ tone: 'critical', text: e.message }) });
  const nav = (n: number) => { const d = addDays(date, n); if (d <= me.today) setSp({ date: d }); };
  if (q.isLoading) return <Skeleton className="h-96" />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data; const day = d.report.days[0]; const t = day.time; const review = d.review;
  const submitted = review && review.status !== 'draft';
  return (
    <div>
      <PageHeader eyebrow="End-of-day recap" title={fmtDate(date, { weekday: 'long', day: 'numeric', month: 'long' })}
        subtitle="Review what was recorded, add anything missing, then confirm. About a minute."
        actions={<div className="flex items-center gap-1">
          <IconButton label="Previous day" onClick={() => nav(-1)}><ChevronLeft className="size-4" /></IconButton>
          <Input aria-label="Date" type="date" className="h-8 w-40" max={me.today} value={date} onChange={(e) => e.target.value && setSp({ date: e.target.value })} />
          <IconButton label="Next day" disabled={date >= me.today} onClick={() => nav(1)}><ChevronRight className="size-4" /></IconButton>
        </div>} />
      <div className="grid gap-4 lg:grid-cols-5">
        <div className="space-y-4 lg:col-span-3">
          <Card title="Outcomes" subtitle={`${day.acceptedPlanned} of ${day.intendedOutcomes.length} intended outcomes accepted`} actions={<AssessmentBadge label={day.assessment.label} />}>
            {day.intendedOutcomes.length === 0 ? <p className="text-[13px] text-ink-3">No intended outcomes were planned for this day.</p> : (
              <ul className="space-y-1.5">{day.intendedOutcomes.map((o: any) => (
                <li key={o.taskId} className="flex items-center gap-2 text-[13px]"><StatusDot status={o.statusAtEndOfDay} /><span className="flex-1">{o.title}</span><span className="text-[12px] text-ink-3">{STATUS_LABEL[o.statusAtEndOfDay]}</span></li>))}</ul>
            )}
            {day.scopeChanges.length > 0 && <p className="mt-2 text-[12px] text-ink-3">Replanned: {day.scopeChanges.map((s: any) => `${s.title} (${s.reason})`).join('; ')}</p>}
            {d.suggestedCompleted.length > 0 && <div className="mt-3 border-t border-line pt-3"><p className="mb-1 text-[12px] font-medium text-ink-3">Completed or submitted today</p>
              <ul className="space-y-1">{d.suggestedCompleted.map((c: any) => <li key={c.id} className="flex items-center gap-2 text-[13px]"><CheckCircle2 className="size-3.5 text-good-ink" aria-hidden />{c.title}{c.to_status === 'in_review' && <Badge tone="warning">in review</Badge>}</li>)}</ul></div>}
            {d.blockersRaised.length > 0 && <div className="mt-3 border-t border-line pt-3"><p className="mb-1 text-[12px] font-medium text-ink-3">Blockers raised</p>
              <ul className="space-y-1">{d.blockersRaised.map((b: any) => <li key={b.id} className="text-[13px]"><b>{b.title}</b>: {b.reason} <span className="text-ink-3">({b.cause})</span></li>)}</ul></div>}
          </Card>
          <Card title="Time" subtitle={day.capacity.availableMinutes ? `${hm(t.explainedMinutes)} confirmed of ${hm(day.capacity.availableMinutes)} available · ${hm(t.unknownMinutes)} unknown` : 'Zero scheduled capacity — Not Applicable'}
            actions={<Button size="sm" variant="ghost" onClick={() => setEntryModal({})}>Add missing time</Button>}>
            <AllocationBar byCategory={t.byCategory} unknown={t.unknownMinutes} available={day.capacity.availableMinutes} />
            {t.conflicts.length > 0 && <div className="mt-3"><Callout tone="warning">{t.conflicts.length} overlap{t.conflicts.length > 1 ? 's' : ''} ({hm(t.conflicts.reduce((s: number, c: any) => s + c.minutes, 0))}) counted once — e.g. a timer left running during a meeting. Correct the entry if it's wrong.</Callout></div>}
            {t.outsideScheduleMinutes > 0 && <p className="mt-2 text-[12px] text-ink-3">{hm(t.outsideScheduleMinutes)} recorded outside scheduled hours (shown, not counted in coverage).</p>}
            <ul className="mt-3 divide-y divide-line border-t border-line">{(entries.data ?? []).map((e: any) => <EntryRow key={e.id} e={e} tz={tz} onEdit={() => setEntryModal({ entry: e })} />)}
              {(entries.data ?? []).length === 0 && <li className="py-2 text-[13px] text-ink-3">No time recorded. That's fine — add it only if it helps your report.</li>}</ul>
          </Card>
          {d.managerReviews.length > 0 && <Card title="Review thread">
            <ul className="space-y-3">{d.managerReviews.map((m: any) => (
              <li key={m.id} className="text-[13px]">
                <div className="text-[12px] text-ink-3"><b className="text-ink">{m.reviewer_name}</b> · {m.action.replace(/_/g, ' ')} · {fmtDateTime(m.created_at)}{m.resolved_at && ' · answered'}</div>
                {m.note && <p className="mt-0.5">{m.note}</p>}
                {m.action === 'clarification_request' && !m.resolved_at && <RespondBox onSend={(note) => respond.mutate({ subjectUserId: me.user.id, date, action: 'clarification_response', note, parentId: m.id })} />}
              </li>))}</ul>
          </Card>}
        </div>
        <div className="space-y-4 lg:col-span-2">
          <Card title={submitted ? 'Your confirmed recap' : 'Your recap'} actions={submitted && <Badge tone="good" icon={<CheckCircle2 className="size-3" />}>{review.status === 'manager_reviewed' ? 'Manager reviewed' : 'Confirmed'} · v{review.version}</Badge>}>
            <div className="space-y-3">
              <Segmented label="Day type" value={f.dayType} onChange={(v) => setF({ ...f, dayType: v })} options={[{ value: 'work', label: 'Worked' }, { value: 'no_work', label: 'No work' }, { value: 'non_working', label: 'Non-working day' }]} />
              {f.dayType !== 'work' && <p className="text-[12px] text-ink-3">{f.dayType === 'no_work' ? 'Confirms you did no work on a scheduled day — different from a missing recap. Record leave so capacity is correct.' : 'Marks this as a non-working day. Ask an admin to add the leave/holiday so reports show Not Applicable.'}</p>}
              <Field label="What got done">{(id) => <Textarea id={id} rows={4} value={f.summary} onChange={(e) => setF({ ...f, summary: e.target.value })} />}</Field>
              <Field label="Blockers / what you need">{(id) => <Textarea id={id} rows={2} value={f.blockersNote} onChange={(e) => setF({ ...f, blockersNote: e.target.value })} />}</Field>
              <Field label="Next steps">{(id) => <Textarea id={id} rows={2} value={f.nextSteps} onChange={(e) => setF({ ...f, nextSteps: e.target.value })} />}</Field>
              <Field label="Context (optional)" hint="Explain anything the numbers don't show — research, an incident, a long negotiation.">{(id) => <Textarea id={id} rows={2} value={f.contextNote} onChange={(e) => setF({ ...f, contextNote: e.target.value })} />}</Field>
              {submitted && <Field label="What are you correcting?" hint="Required. The earlier version stays in history and the report is re-versioned.">{(id) => <Input id={id} value={f.changeReason} onChange={(e) => setF({ ...f, changeReason: e.target.value })} />}</Field>}
              {aiRun && <Callout tone="info" icon={<Sparkles className="mt-0.5 size-4 shrink-0" />}>AI draft ({aiRun.promptVersion}) from {aiRun.sources.length} of your records. Edit freely — it's only saved when you confirm.</Callout>}
              <div className="flex flex-wrap gap-2 pt-1">
                <Button variant="primary" loading={save.isPending && save.variables === true} disabled={!!(submitted && !f.changeReason.trim())} onClick={() => save.mutate(true)} icon={<CheckCircle2 className="size-4" />}>
                  {submitted ? 'Save correction' : 'Confirm recap'}</Button>
                {!submitted && <Button loading={save.isPending && save.variables === false} onClick={() => save.mutate(false)}>Save draft</Button>}
                {me.ai.available && <Button variant="ghost" loading={ai.isPending} onClick={() => ai.mutate()} icon={<Sparkles className="size-4" />}>Draft with AI</Button>}
              </div>
            </div>
          </Card>
          {d.versions.length > 0 && <Card title={<span className="flex items-center gap-2"><History className="size-4" aria-hidden />Versions</span>}>
            <ul className="space-y-1.5 text-[13px]">{d.versions.map((v: any) => <li key={v.version}><b>v{v.version}</b> · {v.change_reason} <span className="text-ink-3">· {v.created_by_name} · {fmtDateTime(v.created_at)}</span></li>)}</ul>
          </Card>}
          <Card title="Why this matters"><p className="text-[13px] leading-relaxed text-ink-2">Your recap turns today into an explainable report: outcomes, time you chose to record, blockers and context. Unknown time stays unknown — nobody fills it in for you, and it's never counted as idle.</p>
            <p className="mt-2 text-[12px] text-ink-3">Times shown in {tz}. Day assessment: {day.assessment.reasons[0]}</p></Card>
        </div>
      </div>
      <EntryModal open={!!entryModal} onClose={() => setEntryModal(null)} entry={entryModal?.entry} tasks={tasks.data ?? []} date={date} tz={tz} />
      <span className="hidden">{fmtTime(null)}</span>
    </div>
  );
}

function RespondBox({ onSend }: { onSend: (n: string) => void }) {
  const [v, setV] = useState('');
  return <div className="mt-2 flex gap-2"><Input aria-label="Your response" className="h-8" value={v} onChange={(e) => setV(e.target.value)} placeholder="Reply to your reviewer…" />
    <Button size="sm" variant="primary" icon={<MessageSquareReply className="size-3.5" />} disabled={!v.trim()} onClick={() => { onSend(v.trim()); setV(''); }}>Send</Button></div>;
}
