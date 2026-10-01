import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, Clock, Flag, FolderKanban, Mic, Sparkles, Square, User, Tag, WifiOff } from 'lucide-react';
import { api } from '../lib/api';
import { newClientRequestId, queueCapture, usePwa } from '../pwa';
import { CATEGORY_LABEL, PRIORITY_LABEL, fmtDate, hm } from '../lib/format';
import { useMe } from '../lib/session';
import { Badge, Button, Callout, Checkbox, IconButton, Kbd, Modal, Textarea, cx, useToast } from './ui';

/**
 * One-line capture: "Prepare laptop PO draft today — 30 minutes #OPS !high @dev".
 * Fields are parsed deterministically and shown for confirmation before the task is created.
 */
export function QuickCapture({ open, onClose, defaults }: { open: boolean; onClose: () => void; defaults?: { projectId?: string; addToMyDay?: boolean } }) {
  const me = useMe(); const qc = useQueryClient(); const toast = useToast();
  const [text, setText] = useState(''); const [addToMyDay, setAddToMyDay] = useState(!!defaults?.addToMyDay);
  const [debounced, setDebounced] = useState('');
  const [aiNote, setAiNote] = useState(''); const [aiDraft, setAiDraft] = useState<any>(null);
  const openedAt = useRef(Date.now());
  // One id per capture: a retry (or the offline outbox) re-sends it and the server returns the same task.
  const requestId = useRef('');
  const offline = !usePwa().online;
  useEffect(() => { if (open) { openedAt.current = Date.now(); requestId.current = newClientRequestId(); setText(''); setAiDraft(null); setAddToMyDay(!!defaults?.addToMyDay); } }, [open]);
  useEffect(() => { const t = setTimeout(() => setDebounced(text), 150); return () => clearTimeout(t); }, [text]);
  const parse = useQuery({ queryKey: ['parse', debounced], queryFn: () => api.post('/api/tasks/parse', { text: debounced }), enabled: open && !offline && debounced.trim().length > 0 });
  const p = offline ? undefined : parse.data;
  const saveOffline = async () => {
    try {
      await queueCapture({ clientRequestId: requestId.current, text: text.trim(), projectId: defaults?.projectId ?? null, addToMyDay, capturedAt: new Date().toISOString() });
      toast({ tone: 'good', text: 'Saved on this device. It will be created when you are back online.' }); onClose();
    } catch { toast({ tone: 'critical', text: 'This browser could not store the capture offline. Copy it and try again when you are online.' }); }
  };
  const create = useMutation({
    mutationFn: () => api.post('/api/tasks', { clientRequestId: requestId.current,
      title: aiDraft?.title ?? p?.title ?? text, dueDate: aiDraft?.due_date ?? p?.dueDate ?? null, estimateMinutes: aiDraft?.estimate_minutes ?? p?.estimateMinutes ?? null,
      priority: aiDraft?.priority ?? p?.priority ?? undefined, projectId: p?.project?.id ?? defaults?.projectId ?? null, ownerId: p?.owner?.id ?? undefined,
      category: p?.category ?? undefined, description: aiDraft?.description, checklist: aiDraft?.checklist, addToMyDay,
      sourceType: aiDraft ? 'ai_draft' : 'quick_capture', captureMs: Date.now() - openedAt.current,
    }),
    onSuccess: (t: any) => {
      if (aiDraft?.runId) api.post(`/api/ai/runs/${aiDraft.runId}/decision`, { decision: 'accepted' }).catch(() => {});
      qc.invalidateQueries(); toast({ tone: 'good', text: `Created "${t.title}"${t.planFull ? ' — today already has three outcomes, so it stays in your open work' : addToMyDay ? ' and added to today' : ''}` }); onClose();
    },
    onError: (e: any) => {
      // Lost connection mid-request: keep the capture in the offline outbox (same request id, so it can never be created twice).
      if (e?.status === 0 && !aiDraft) { void saveOffline(); return; }
      qc.invalidateQueries(); toast({ tone: 'critical', text: e.message });
    },
  });
  const ai = useMutation({
    mutationFn: () => api.post('/api/ai/task-draft', { note: aiNote }),
    onSuccess: (r: any) => setAiDraft({ ...r.draft, runId: r.runId, promptVersion: r.promptVersion, model: r.model }),
    onError: (e: any) => toast({ tone: 'critical', text: e.message }),
  });
  const title = aiDraft?.title ?? p?.title ?? '';
  const canCreate = offline ? !!text.trim() && !aiDraft : (aiDraft ? !!aiDraft.title : !!text.trim() && !!title) && !create.isPending;
  const submit = () => { if (offline) void saveOffline(); else create.mutate(); };
  const voice = useVoice(open && !!me.tenant.settings?.voice_capture_enabled, (t) => { setText(t); setAiDraft(null); });
  return (
    <Modal open={open} onClose={onClose} title="Quick capture" width="max-w-xl"
      footer={<>
        <div className="mr-auto hidden items-center gap-1 text-[12px] text-ink-3 sm:flex"><Kbd>Enter</Kbd> create · <Kbd>Esc</Kbd> close</div>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!canCreate} loading={create.isPending} onClick={submit}>{offline ? 'Save offline' : 'Create task'}</Button>
      </>}>
      <label htmlFor="qc" className="sr-only">Describe the task in one line</label>
      <div className="relative">
        <input id="qc" data-autofocus autoComplete="off" value={text} onChange={(e) => { setText(e.target.value); setAiDraft(null); }}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && canCreate) { e.preventDefault(); submit(); } }}
          placeholder="Prepare laptop PO draft today — 30 min #OPS !high"
          className={cx('h-11 w-full rounded-lg bg-surface-2 px-3 text-[15px] ring-1 ring-inset ring-line focus:outline-none focus:ring-2 focus:ring-accent', voice.available && 'pr-12')} />
        {voice.available && <IconButton label={offline ? 'Voice capture needs a connection' : voice.listening ? 'Stop dictation' : 'Dictate with voice'} aria-pressed={voice.listening}
          disabled={offline} onClick={voice.listening ? voice.stop : voice.start}
          className={cx('absolute right-1.5 top-1.5 disabled:opacity-50', voice.listening && 'bg-critical-soft text-critical-ink')}>
          {voice.listening ? <Square className="size-4" /> : <Mic className="size-4" />}</IconButton>}
      </div>
      {voice.available && <p className="mt-1.5 flex gap-1.5 text-[12px] text-ink-3"><Mic className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <span>Voice is opt-in. Your browser's speech service turns speech into text (it may send the audio to the browser maker to transcribe). Only the transcript is used and you confirm it below; this app never receives or stores audio.</span></p>}
      {(voice.listening || voice.error) && <p role="status" aria-live="polite" className={cx('mt-1 text-[12px] font-medium', voice.error ? 'text-critical-ink' : 'text-accent-ink')}>
        {voice.error || 'Listening… speak your task, then review it.'}</p>}
      <p className="mt-1.5 text-[12px] text-ink-3">Shortcuts: <code>today</code>/<code>tomorrow</code>/<code>fri</code>/<code>2026-10-09</code>, <code>30m</code>/<code>2h</code>, <code>#KEY</code> project, <code>!high</code>, <code>@name</code> owner, <code>/finance</code> category.</p>
      {offline && text.trim() && (
        <div className="mt-3"><Callout tone="neutral" icon={<WifiOff className="size-4" />}>You're offline. This capture is kept on this device and created when you reconnect.
          Shortcuts like <code>today</code>, <code>30m</code> and <code>#KEY</code> are applied then, using the day you captured it.</Callout></div>
      )}
      {(p || aiDraft) && (
        <div className="mt-3 rounded-lg bg-surface-2 p-3" aria-live="polite">
          <p className="text-[12px] font-medium text-ink-3">Will create {aiDraft && <Badge tone="info" icon={<Sparkles className="size-3" />}>AI draft · {aiDraft.promptVersion}</Badge>}</p>
          <p className="mt-1 font-medium">{title || <span className="text-ink-3">Add a title</span>}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Badge icon={<User className="size-3" />}>{p?.owner?.name ?? 'You'}</Badge>
            {(aiDraft?.due_date ?? p?.dueDate) && <Badge tone="warning" icon={<CalendarDays className="size-3" />}>Due {fmtDate(aiDraft?.due_date ?? p.dueDate, { weekday: 'short', day: 'numeric', month: 'short' })}</Badge>}
            {(aiDraft?.estimate_minutes ?? p?.estimateMinutes) && <Badge icon={<Clock className="size-3" />}>{hm(aiDraft?.estimate_minutes ?? p.estimateMinutes)} estimate</Badge>}
            {(aiDraft?.priority ?? p?.priority) && <Badge icon={<Flag className="size-3" />}>{PRIORITY_LABEL[aiDraft?.priority ?? p.priority]}</Badge>}
            {p?.project && <Badge tone="info" icon={<FolderKanban className="size-3" />}>{p.project.key} · {p.project.name}</Badge>}
            {p?.category && <Badge icon={<Tag className="size-3" />}>{CATEGORY_LABEL[p.category]}</Badge>}
          </div>
          {aiDraft?.checklist?.length > 0 && <ul className="mt-2 list-disc pl-5 text-[13px] text-ink-2">{aiDraft.checklist.map((c: string, i: number) => <li key={i}>{c}</li>)}</ul>}
          {p?.warnings?.length > 0 && <div className="mt-2 space-y-1">{p.warnings.map((w: string) => <p key={w} className="text-[12px] text-warning-ink">⚠ {w}</p>)}</div>}
        </div>
      )}
      <div className="mt-3"><Checkbox checked={addToMyDay} onChange={setAddToMyDay} label="Add to today's intended outcomes" /></div>
      <details className="mt-4 rounded-lg ring-1 ring-line">
        <summary className="cursor-pointer select-none px-3 py-2 text-[13px] font-medium text-ink-2"><Sparkles className="mr-1 inline size-3.5" aria-hidden />Draft from a longer note (optional AI)</summary>
        <div className="space-y-2 px-3 pb-3">
          {!me.ai.available ? <Callout tone="neutral">{me.ai.note}</Callout> : <>
            <Textarea rows={3} value={aiNote} onChange={(e) => setAiNote(e.target.value)} placeholder="Paste a short note or message. The draft is a proposal — you review it before anything is saved." />
            <Button size="sm" loading={ai.isPending} disabled={!aiNote.trim()} onClick={() => ai.mutate()} icon={<Sparkles className="size-3.5" />}>Draft task</Button>
          </>}
        </div>
      </details>
    </Modal>
  );
}

type SpeechCtor = new () => any;
const speechCtor = (): SpeechCtor | null => typeof window === 'undefined' ? null : ((window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition ?? null);

/** Browser speech-to-text (Web Speech API). Transcript only; nothing is recorded or uploaded by this app. */
function useVoice(enabled: boolean, onText: (t: string) => void) {
  const [listening, setListening] = useState(false); const [error, setError] = useState('');
  const rec = useRef<any>(null);
  const available = enabled && !!speechCtor();
  const stop = () => { try { rec.current?.stop(); } catch { /* already stopped */ } };
  useEffect(() => () => { try { rec.current?.abort(); } catch { /* not started */ } rec.current = null; }, [enabled]);
  useEffect(() => { if (!enabled) { setListening(false); setError(''); } }, [enabled]);
  const start = () => {
    const Ctor = speechCtor(); if (!Ctor) return;
    setError('');
    const r = new Ctor(); rec.current = r;
    r.lang = navigator.language || 'en-US'; r.interimResults = true; r.continuous = false; r.maxAlternatives = 1;
    r.onresult = (e: any) => { let t = ''; for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript; onText(t.trim()); };
    r.onerror = (e: any) => setError(e.error === 'not-allowed' || e.error === 'service-not-allowed' ? 'Microphone access was not allowed. You can type the task instead.'
      : e.error === 'no-speech' ? 'No speech was heard. Try again or type the task.' : 'Voice capture stopped. You can type the task instead.');
    r.onend = () => setListening(false);
    try { r.start(); setListening(true); } catch { setError('Voice capture could not start in this browser.'); }
  };
  return { available, listening, error, start, stop };
}
