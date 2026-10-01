import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, Clock, Flag, FolderKanban, Sparkles, User, Tag } from 'lucide-react';
import { api } from '../lib/api';
import { CATEGORY_LABEL, PRIORITY_LABEL, fmtDate, hm } from '../lib/format';
import { useMe } from '../lib/session';
import { Badge, Button, Callout, Checkbox, Kbd, Modal, Textarea, useToast } from './ui';

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
  useEffect(() => { if (open) { openedAt.current = Date.now(); setText(''); setAiDraft(null); setAddToMyDay(!!defaults?.addToMyDay); } }, [open]);
  useEffect(() => { const t = setTimeout(() => setDebounced(text), 150); return () => clearTimeout(t); }, [text]);
  const parse = useQuery({ queryKey: ['parse', debounced], queryFn: () => api.post('/api/tasks/parse', { text: debounced }), enabled: open && debounced.trim().length > 0 });
  const p = parse.data;
  const create = useMutation({
    mutationFn: () => api.post('/api/tasks', {
      title: aiDraft?.title ?? p?.title ?? text, dueDate: aiDraft?.due_date ?? p?.dueDate ?? null, estimateMinutes: aiDraft?.estimate_minutes ?? p?.estimateMinutes ?? null,
      priority: aiDraft?.priority ?? p?.priority ?? undefined, projectId: p?.project?.id ?? defaults?.projectId ?? null, ownerId: p?.owner?.id ?? undefined,
      category: p?.category ?? undefined, description: aiDraft?.description, checklist: aiDraft?.checklist, addToMyDay,
      sourceType: aiDraft ? 'ai_draft' : 'quick_capture', captureMs: Date.now() - openedAt.current,
    }),
    onSuccess: (t: any) => {
      if (aiDraft?.runId) api.post(`/api/ai/runs/${aiDraft.runId}/decision`, { decision: 'accepted' }).catch(() => {});
      qc.invalidateQueries(); toast({ tone: 'good', text: `Created "${t.title}"${t.planFull ? ' — today already has three outcomes, so it stays in your open work' : addToMyDay ? ' and added to today' : ''}` }); onClose();
    },
    onError: (e: any) => { qc.invalidateQueries(); toast({ tone: 'critical', text: e.message }); },
  });
  const ai = useMutation({
    mutationFn: () => api.post('/api/ai/task-draft', { note: aiNote }),
    onSuccess: (r: any) => setAiDraft({ ...r.draft, runId: r.runId, promptVersion: r.promptVersion, model: r.model }),
    onError: (e: any) => toast({ tone: 'critical', text: e.message }),
  });
  const title = aiDraft?.title ?? p?.title ?? '';
  const canCreate = (aiDraft ? !!aiDraft.title : !!text.trim() && !!title) && !create.isPending;
  return (
    <Modal open={open} onClose={onClose} title="Quick capture" width="max-w-xl"
      footer={<>
        <div className="mr-auto hidden items-center gap-1 text-[12px] text-ink-3 sm:flex"><Kbd>Enter</Kbd> create · <Kbd>Esc</Kbd> close</div>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!canCreate} loading={create.isPending} onClick={() => create.mutate()}>Create task</Button>
      </>}>
      <label htmlFor="qc" className="sr-only">Describe the task in one line</label>
      <input id="qc" data-autofocus autoComplete="off" value={text} onChange={(e) => { setText(e.target.value); setAiDraft(null); }}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && canCreate) { e.preventDefault(); create.mutate(); } }}
        placeholder="Prepare laptop PO draft today — 30 min #OPS !high"
        className="h-11 w-full rounded-lg bg-surface-2 px-3 text-[15px] ring-1 ring-inset ring-line focus:outline-none focus:ring-2 focus:ring-accent" />
      <p className="mt-1.5 text-[12px] text-ink-3">Shortcuts: <code>today</code>/<code>tomorrow</code>/<code>fri</code>/<code>2026-10-09</code>, <code>30m</code>/<code>2h</code>, <code>#KEY</code> project, <code>!high</code>, <code>@name</code> owner, <code>/finance</code> category.</p>
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
