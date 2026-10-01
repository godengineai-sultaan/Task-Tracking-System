import { DateTime } from 'luxon';
import type { Db } from '../../lib/db.js';
import { many, one } from '../../lib/db.js';
import { audit } from '../../lib/audit.js';
import { notify } from '../notify.js';

/**
 * Objectives & key results: progress roll-up and an explainable early warning.
 * Every number here comes from recorded work (milestones, tasks, estimates, acceptance timestamps) or
 * owner-reported key-result values. When the data needed for a signal is missing, the signal is not used
 * and the reason is stated; nothing is imputed.
 */
export type ForecastStatus = 'on_track' | 'at_risk' | 'off_track' | 'insufficient_data';

export const OKR_RULES = {
  /** Share of tasks that must carry an estimate before estimates are used for weighting and for the velocity forecast. */
  estimateCoverage: 0.8,
  /** Velocity look-back window in weeks. */
  velocityWeeks: 4,
  /** Minimum weeks of history before a velocity forecast is used. */
  minHistoryWeeks: 2,
  /** Elapsed-time signal: progress this far (fraction) behind expectation is at risk / off track. */
  gapAtRisk: 0.1,
  gapOffTrack: 0.25,
  /** Velocity signal: weeks needed / weeks left above these ratios is at risk / off track. */
  paceAtRisk: 1,
  paceOffTrack: 1.25,
};
const RANK: Record<ForecastStatus, number> = { insufficient_data: -1, on_track: 0, at_risk: 1, off_track: 2 };
export const FORECAST_LABEL: Record<ForecastStatus, string> = { on_track: 'On track', at_risk: 'At risk', off_track: 'Off track', insufficient_data: 'Insufficient data' };

export const pctText = (v: number) => `${Math.round(v * 100)}%`;
export function minutesText(m: number) {
  const r = Math.round(m), h = Math.floor(r / 60), mm = r % 60;
  return h ? (mm ? `${h}h ${mm}m` : `${h}h`) : `${mm}m`;
}
const round = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const utc = (s: string) => DateTime.fromISO(s, { zone: 'utc' });
/** Whole calendar days from a to b (b - a). */
const daysBetween = (a: string, b: string) => Math.round(utc(b).diff(utc(a), 'days').days);
const addDays = (s: string, n: number) => utc(s).plus({ days: n }).toISODate()!;

// ---------------------------------------------------------------- roll-up

export interface TaskRow { id: string; milestone_id: string | null; project_id: string | null; status: string; estimate_minutes: number | null; accepted_at: Date | string | null }
export interface WorkStats { tasks: number; done: number; estimated: number; estTotal: number; estDone: number; open: number; openEstimated: number; openMinutes: number }
export interface Progress { value: number | null; basis: 'estimate' | 'count' | 'milestones' | 'manual' | 'none'; coverage: number | null; explanation: string }

/** Stats over non-cancelled tasks. */
export function taskStats(rows: TaskRow[]): WorkStats {
  const s: WorkStats = { tasks: 0, done: 0, estimated: 0, estTotal: 0, estDone: 0, open: 0, openEstimated: 0, openMinutes: 0 };
  for (const t of rows) {
    if (t.status === 'cancelled') continue;
    const est = t.estimate_minutes ?? null;
    s.tasks++;
    if (est !== null) { s.estimated++; s.estTotal += est; }
    if (t.status === 'done') { s.done++; if (est !== null) s.estDone += est; }
    else { s.open++; if (est !== null) { s.openEstimated++; s.openMinutes += est; } }
  }
  return s;
}

/** Estimate-weighted when estimate coverage is good, otherwise count-weighted; the explanation says which and why. */
export function weightedProgress(s: WorkStats): Progress {
  if (s.tasks === 0) return { value: null, basis: 'none', coverage: null, explanation: 'No tasks linked yet.' };
  const coverage = s.estimated / s.tasks;
  if (coverage >= OKR_RULES.estimateCoverage && s.estTotal > 0) {
    const unest = s.tasks - s.estimated;
    return { value: s.estDone / s.estTotal, basis: 'estimate', coverage,
      explanation: `Weighted by estimates: ${minutesText(s.estDone)} of ${minutesText(s.estTotal)} estimated work accepted (${s.estimated} of ${plural(s.tasks, 'task')} ${s.tasks === 1 ? 'has' : 'have'} an estimate${unest ? `; ${unest} without one ${unest === 1 ? 'is' : 'are'} left out of the weighting` : ''}).` };
  }
  return { value: s.done / s.tasks, basis: 'count', coverage,
    explanation: `Weighted by task count: ${s.done} of ${plural(s.tasks, 'task')} accepted. Estimates were not used because only ${s.estimated} of ${s.tasks} (${pctText(coverage)}) have one; ${pctText(OKR_RULES.estimateCoverage)} is needed.` };
}

export interface MilestoneRow { id: string; objective_id: string | null; name: string; due_date: string | null; status: string; project_id: string; project_key: string; project_name: string; project_visibility: string; project_owner_id: string | null }
export interface KeyResultResult {
  id: string; title: string; kind: string; unit: string; version: number; position: number;
  milestone_ids: string[]; project_ids: string[];
  target_value: number | null; current_value: number | null;
  /** Values the progress is computed from (reported for manual, derived for linked kinds). */
  current: number | null; target: number | null; measure: string;
  progress: number | null; basis: Progress['basis']; explanation: string; updated_at: string | Date;
}

export function keyResultProgress(kr: any, milestones: Map<string, MilestoneRow>, tasks: TaskRow[]): KeyResultResult {
  const base = { id: kr.id, title: kr.title, kind: kr.kind, unit: kr.unit, version: kr.version, position: kr.position, milestone_ids: kr.milestone_ids ?? [], project_ids: kr.project_ids ?? [],
    target_value: kr.target_value, current_value: kr.current_value, updated_at: kr.updated_at };
  if (kr.kind === 'manual') {
    if (kr.current_value === null || kr.current_value === undefined) {
      return { ...base, current: null, target: kr.target_value, measure: kr.unit, progress: null, basis: 'none', explanation: 'No value reported yet.' };
    }
    const p = Math.min(1, Math.max(0, kr.current_value / kr.target_value));
    return { ...base, current: kr.current_value, target: kr.target_value, measure: kr.unit, progress: p, basis: 'manual',
      explanation: `Reported ${kr.current_value}${kr.unit ? ` ${kr.unit}` : ''} of ${kr.target_value}${kr.unit ? ` ${kr.unit}` : ''}.` };
  }
  const ms = base.milestone_ids.map((id: string) => milestones.get(id)).filter((m: MilestoneRow | undefined): m is MilestoneRow => !!m && m.status !== 'cancelled');
  if (kr.kind === 'milestone_completion') {
    if (!ms.length) return { ...base, current: null, target: null, measure: 'milestones', progress: null, basis: 'none', explanation: 'No open or completed milestones linked.' };
    const done = ms.filter((m) => m.status === 'done').length;
    return { ...base, current: done, target: ms.length, measure: 'milestones', progress: done / ms.length, basis: 'count', explanation: `${done} of ${plural(ms.length, 'milestone')} done.` };
  }
  // task_completion: tasks in the linked milestones and/or projects (each task counted once)
  const msIds = new Set(ms.map((m) => m.id)); const pIds = new Set(base.project_ids);
  const rows = tasks.filter((t) => (t.milestone_id && msIds.has(t.milestone_id)) || (t.project_id && pIds.has(t.project_id)));
  const pr = weightedProgress(taskStats(rows)); const st = taskStats(rows);
  if (pr.value === null) return { ...base, current: null, target: null, measure: 'tasks', progress: null, basis: 'none', explanation: 'No tasks in the linked milestones or projects yet.' };
  return pr.basis === 'estimate'
    ? { ...base, current: st.estDone, target: st.estTotal, measure: 'estimate minutes', progress: pr.value, basis: pr.basis, explanation: pr.explanation }
    : { ...base, current: st.done, target: st.tasks, measure: 'tasks', progress: pr.value, basis: pr.basis, explanation: pr.explanation };
}

export interface RollUp { value: number | null; parts: { label: string; value: number }[]; explanation: string }
/** Overall progress: linked work counts as one part and each key result with data as one part, equally weighted. */
export function rollUp(work: Progress, krs: KeyResultResult[]): RollUp {
  const parts: { label: string; value: number }[] = [];
  if (work.value !== null) parts.push({ label: 'Linked work', value: work.value });
  for (const k of krs) if (k.progress !== null) parts.push({ label: k.title, value: k.progress });
  const missing = krs.filter((k) => k.progress === null).length;
  const missingNote = missing ? ` ${plural(missing, 'key result')} without data ${missing === 1 ? 'is' : 'are'} left out.` : '';
  if (!parts.length) return { value: null, parts, explanation: `Nothing to measure yet: link milestones with tasks or add key results.${missingNote}` };
  const value = parts.reduce((s, p) => s + p.value, 0) / parts.length;
  const krCount = parts.length - (work.value !== null ? 1 : 0);
  const explanation = parts.length === 1
    ? `Based on ${work.value !== null ? 'linked work' : 'one key result'} only.${missingNote}`
    : `Equal-weight average of ${work.value !== null ? 'linked work and ' : ''}${plural(krCount, 'key result')}.${missingNote}`;
  return { value, parts, explanation };
}

// ---------------------------------------------------------------- forecast

export interface AssessInput {
  today: string; periodStart: string | null; periodEnd: string | null; createdDate: string;
  progress: number | null; progressExplanation: string;
  open: { tasks: number; estimated: number; minutes: number };
  /** Accepted linked tasks inside the velocity window. */
  accepted: { minutes: number; tasks: number; unestimated: number };
  latestCheckin?: LatestCheckin | null;
  /** Tenant timezone, for showing the check-in date as a local date. */
  tz?: string;
}
export interface LatestCheckin { confidence: number; created_at: string | Date; author_name?: string | null; by_owner?: boolean }
export interface Signal { key: 'elapsed' | 'velocity'; used: boolean; status: ForecastStatus | null; summary: string }
export interface Forecast {
  status: ForecastStatus; reasons: string[]; facts: string[]; assumptions: string[]; signals: Signal[];
  progress: number | null; expected: number | null; elapsedDays: number | null; totalDays: number | null; daysLeft: number | null;
  historyWeeks: number | null; velocityPerWeek: number | null; remainingMinutes: number | null; projectedWeeks: number | null; weeksLeft: number | null;
  openEstimateCoverage: number | null; rules: typeof OKR_RULES;
}

export function assess(i: AssessInput): Forecast {
  const facts: string[] = [], assumptions: string[] = [], reasons: string[] = [], signals: Signal[] = [];
  const f: Forecast = { status: 'insufficient_data', reasons, facts, assumptions, signals, progress: i.progress, expected: null, elapsedDays: null, totalDays: null, daysLeft: null,
    historyWeeks: null, velocityPerWeek: null, remainingMinutes: null, projectedWeeks: null, weeksLeft: null, openEstimateCoverage: null, rules: OKR_RULES };
  const finish = (status: ForecastStatus) => {
    f.status = status;
    const c = i.latestCheckin;
    if (c) facts.push(`Latest check-in confidence: ${c.confidence}/5 (${DateTime.fromJSDate(new Date(c.created_at), { zone: i.tz ?? 'utc' }).toISODate()}${c.author_name ? `, by ${c.author_name}${c.by_owner ? ', the owner' : ''}` : ''}). Shown for context; it does not change the computed status.`);
    return f;
  };
  const start = i.periodStart ?? i.createdDate;
  if (!i.periodStart) assumptions.push(`No period start is set, so the objective's creation date (${start}) is used as the start.`);
  if (i.progress === null) {
    reasons.push('Progress cannot be measured yet: there are no linked milestones with tasks and no key results with data.');
    return finish('insufficient_data');
  }
  facts.push(`Progress ${pctText(i.progress)}. ${i.progressExplanation}`);
  if (!i.periodEnd) { reasons.push('No period end date is set, so expected progress and time left cannot be worked out.'); return finish('insufficient_data'); }
  const total = daysBetween(start, i.periodEnd) + 1;
  if (total <= 0) { reasons.push(`The period end (${i.periodEnd}) is before its start (${start}).`); return finish('insufficient_data'); }
  f.totalDays = total;
  if (i.progress >= 1) { reasons.push('All measured work and key results are complete.'); return finish('on_track'); }
  if (i.today < start) { reasons.push(`The period starts on ${start}; nothing is expected yet.`); return finish('insufficient_data'); }
  if (i.today > i.periodEnd) {
    f.expected = 1; f.elapsedDays = total; f.daysLeft = 0; f.weeksLeft = 0;
    reasons.push(`The period ended on ${i.periodEnd} with ${pctText(i.progress)} progress.`);
    return finish('off_track');
  }

  // Signal 1: progress vs. elapsed time
  const elapsed = daysBetween(start, i.today), expected = elapsed / total, daysLeft = daysBetween(i.today, i.periodEnd) + 1, weeksLeft = daysLeft / 7;
  Object.assign(f, { expected, elapsedDays: elapsed, daysLeft, weeksLeft: round(weeksLeft) });
  facts.push(`Expected by elapsed time: ${pctText(expected)} (${elapsed} of ${total} days elapsed; ${plural(daysLeft, 'day')} left including today).`);
  assumptions.push('Expected progress assumes work is spread evenly across the period.');
  // One decimal so a value just over a threshold never reads as equal to it (e.g. 10.3 points vs. "more than 10").
  const gap = expected - i.progress, pts = round(Math.abs(gap) * 100);
  const es: ForecastStatus = gap > OKR_RULES.gapOffTrack ? 'off_track' : gap > OKR_RULES.gapAtRisk ? 'at_risk' : 'on_track';
  signals.push({ key: 'elapsed', used: true, status: es, summary: gap > 0 ? `${pts} points behind the ${pctText(expected)} expected by elapsed time` : `At or ahead of the ${pctText(expected)} expected by elapsed time` });
  if (es !== 'on_track') reasons.push(`Progress (${pctText(i.progress)}) is ${pts} points behind the ${pctText(expected)} expected by elapsed time; more than ${Math.round((es === 'off_track' ? OKR_RULES.gapOffTrack : OKR_RULES.gapAtRisk) * 100)} points behind is ${FORECAST_LABEL[es].toLowerCase()}.`);

  // Signal 2: velocity of accepted estimate on linked work vs. remaining estimate
  const windowStart = [addDays(i.today, -7 * OKR_RULES.velocityWeeks), start].sort()[1];
  const historyWeeks = round(daysBetween(windowStart, i.today) / 7);
  f.historyWeeks = historyWeeks;
  const cov = i.open.tasks ? i.open.estimated / i.open.tasks : null;
  f.openEstimateCoverage = cov;
  let vs: ForecastStatus | null = null;
  const skip = (why: string) => { signals.push({ key: 'velocity', used: false, status: null, summary: why }); assumptions.push(`Velocity forecast not used: ${why}`); };
  if (i.open.tasks === 0) skip('there are no open linked tasks, so there is no remaining estimate to forecast.');
  else if (historyWeeks < OKR_RULES.minHistoryWeeks) skip(`only ${historyWeeks} week${historyWeeks === 1 ? '' : 's'} of history since the period started; at least ${OKR_RULES.minHistoryWeeks} are needed.`);
  else if (cov! < OKR_RULES.estimateCoverage) skip(`only ${i.open.estimated} of ${plural(i.open.tasks, 'open task')} (${pctText(cov!)}) have an estimate; ${pctText(OKR_RULES.estimateCoverage)} is needed to size the remaining work.`);
  // Accepted work without estimates has an unknown size: do not read it as zero pace.
  else if (i.accepted.tasks && (i.accepted.tasks - i.accepted.unestimated) / i.accepted.tasks < OKR_RULES.estimateCoverage)
    skip(`only ${i.accepted.tasks - i.accepted.unestimated} of ${plural(i.accepted.tasks, 'task')} accepted in the last ${historyWeeks} weeks have an estimate; ${pctText(OKR_RULES.estimateCoverage)} is needed to measure the recent pace.`);
  else {
    const velocity = i.accepted.minutes / historyWeeks;
    Object.assign(f, { velocityPerWeek: Math.round(velocity), remainingMinutes: i.open.minutes });
    facts.push(`Accepted on linked work over the last ${historyWeeks} weeks: ${minutesText(i.accepted.minutes)} of estimates across ${plural(i.accepted.tasks, 'task')}, about ${minutesText(velocity)} per week.`);
    facts.push(`Remaining estimate: ${minutesText(i.open.minutes)} across ${plural(i.open.tasks, 'open task')}.`);
    if (i.open.estimated < i.open.tasks) assumptions.push(`${plural(i.open.tasks - i.open.estimated, 'open task')} without an estimate ${i.open.tasks - i.open.estimated === 1 ? 'is' : 'are'} not in the remaining estimate.`);
    if (i.accepted.unestimated) assumptions.push(`${plural(i.accepted.unestimated, 'accepted task')} without an estimate ${i.accepted.unestimated === 1 ? 'is' : 'are'} not counted in velocity.`);
    assumptions.push(`The velocity forecast assumes the pace of the last ${historyWeeks} weeks continues and that estimates are accurate.`);
    if (velocity === 0) {
      vs = 'off_track';
      reasons.push(`No estimated linked work was accepted in the last ${historyWeeks} weeks, so the ${minutesText(i.open.minutes)} remaining has no recent pace to finish by ${i.periodEnd}.`);
      signals.push({ key: 'velocity', used: true, status: vs, summary: 'No accepted estimate in the look-back window' });
    } else {
      const projected = round(i.open.minutes / velocity), ratio = (i.open.minutes / velocity) / weeksLeft;
      f.projectedWeeks = projected;
      facts.push(`At that pace the remaining estimate needs about ${projected} weeks; ${round(weeksLeft)} weeks remain.`);
      vs = ratio > OKR_RULES.paceOffTrack ? 'off_track' : ratio > OKR_RULES.paceAtRisk ? 'at_risk' : 'on_track';
      signals.push({ key: 'velocity', used: true, status: vs, summary: `Needs about ${projected} weeks at the recent pace; ${round(weeksLeft)} weeks remain` });
      if (vs !== 'on_track') reasons.push(`At the recent pace the remaining estimate needs about ${projected} weeks, but only ${round(weeksLeft)} weeks remain.`);
    }
  }
  const status = vs && RANK[vs] > RANK[es] ? vs : es;
  if (status === 'on_track') reasons.push(vs ? 'Progress is in line with elapsed time and the recent pace covers the remaining estimate.' : 'Progress is in line with elapsed time.');
  return finish(status);
}

// ---------------------------------------------------------------- loading

export async function tenantToday(db: Db, tenantId: string) {
  const t = await one(db, `select timezone from tenants where id = $1`, [tenantId]);
  const tz: string = t?.timezone ?? 'UTC';
  return { tz, today: DateTime.now().setZone(tz).toISODate()! };
}

export interface ObjectiveComputed {
  objective: any; work: Progress & { stats: WorkStats; milestones: number; milestonesDone: number };
  keyResults: KeyResultResult[]; progress: RollUp; forecast: Forecast | null;
  milestones: (MilestoneRow & { stats: WorkStats })[]; latestCheckin: LatestCheckin | null;
}

/** Load and compute objectives (batched queries; no per-person or per-day loops). */
export async function computeObjectives(db: Db, tenantId: string, opts: { ids?: string[]; activeOnly?: boolean } = {}) {
  const { tz, today } = await tenantToday(db, tenantId);
  const objs = await many(db, `select o.*, u.name owner_name, to_char(o.created_at at time zone $1, 'YYYY-MM-DD') created_date
      from objectives o left join users u on u.id = o.owner_id
      where o.tenant_id = $4 and ($2::uuid[] is null or o.id = any($2::uuid[])) and (not $3 or o.status = 'active')
      order by o.status = 'active' desc, o.period_end nulls last, o.title`, [tz, opts.ids ?? null, !!opts.activeOnly, tenantId]);
  if (!objs.length) return { today, tz, items: [] as ObjectiveComputed[] };
  const oids = objs.map((o) => o.id);
  const [krs, checkins] = await Promise.all([
    many(db, `select * from objective_key_results where objective_id = any($1::uuid[]) order by position, created_at`, [oids]),
    many(db, `select distinct on (c.objective_id) c.objective_id, c.confidence, c.created_at, c.author_id, u.name author_name
      from objective_checkins c left join users u on u.id = c.author_id where c.objective_id = any($1::uuid[]) order by c.objective_id, c.created_at desc`, [oids]),
  ]);
  const krMs = [...new Set(krs.flatMap((k) => k.milestone_ids ?? []))], krPs = [...new Set(krs.flatMap((k) => k.project_ids ?? []))];
  const milestones = await many<MilestoneRow>(db, `select m.id, m.objective_id, m.name, m.due_date, m.status, m.project_id, p.key project_key, p.name project_name,
      p.visibility project_visibility, p.owner_id project_owner_id
    from milestones m join projects p on p.id = m.project_id where m.tenant_id = $3 and (m.objective_id = any($1::uuid[]) or m.id = any($2::uuid[]))
    order by m.due_date nulls last, m.name`, [oids, krMs, tenantId]);
  const tasks = await many<TaskRow>(db, `select id, milestone_id, project_id, status, estimate_minutes, accepted_at from tasks
    where tenant_id = $3 and status <> 'cancelled' and (milestone_id = any($1::uuid[]) or project_id = any($2::uuid[]))`, [milestones.map((m) => m.id), krPs, tenantId]);
  const msById = new Map(milestones.map((m) => [m.id, m]));
  const tasksByMs = new Map<string, TaskRow[]>();
  for (const t of tasks) if (t.milestone_id) { if (!tasksByMs.has(t.milestone_id)) tasksByMs.set(t.milestone_id, []); tasksByMs.get(t.milestone_id)!.push(t); }

  const items: ObjectiveComputed[] = objs.map((o) => {
    const linked = milestones.filter((m) => m.objective_id === o.id).map((m) => ({ ...m, stats: taskStats(tasksByMs.get(m.id) ?? []) }));
    const activeMs = linked.filter((m) => m.status !== 'cancelled');
    const oTasks = activeMs.flatMap((m) => tasksByMs.get(m.id) ?? []);
    const stats = taskStats(oTasks);
    let work: Progress = weightedProgress(stats);
    const msDone = activeMs.filter((m) => m.status === 'done').length;
    if (stats.tasks === 0) {
      work = activeMs.length
        ? { value: msDone / activeMs.length, basis: 'milestones', coverage: null, explanation: `${msDone} of ${plural(activeMs.length, 'linked milestone')} done (no tasks in them yet, so milestones are counted instead).` }
        : { value: null, basis: 'none', coverage: null, explanation: 'No milestones linked yet.' };
    }
    const keyResults = krs.filter((k) => k.objective_id === o.id).map((k) => keyResultProgress(k, msById, tasks));
    const progress = rollUp(work, keyResults);
    const lc = checkins.find((c) => c.objective_id === o.id);
    const latest: LatestCheckin | null = lc ? { confidence: lc.confidence, created_at: lc.created_at, author_name: lc.author_name ?? null, by_owner: !!o.owner_id && lc.author_id === o.owner_id } : null;
    let forecast: Forecast | null = null;
    if (o.status === 'active') {
      const start = o.period_start ?? o.created_date;
      const windowStart = [addDays(today, -7 * OKR_RULES.velocityWeeks), start].sort()[1];
      const from = DateTime.fromISO(windowStart, { zone: tz }).toMillis();
      const acc = oTasks.filter((t) => t.status === 'done' && t.accepted_at && new Date(t.accepted_at).getTime() >= from);
      forecast = assess({ today, periodStart: o.period_start, periodEnd: o.period_end, createdDate: o.created_date,
        progress: progress.value, progressExplanation: [work.value !== null ? `Linked work: ${work.explanation}` : '', progress.explanation].filter(Boolean).join(' '),
        open: { tasks: stats.open, estimated: stats.openEstimated, minutes: stats.openMinutes },
        accepted: { minutes: acc.reduce((s, t) => s + (t.estimate_minutes ?? 0), 0), tasks: acc.length, unestimated: acc.filter((t) => t.estimate_minutes === null).length },
        latestCheckin: latest, tz });
    }
    return { objective: o, work: { ...work, stats, milestones: activeMs.length, milestonesDone: msDone }, keyResults, progress, forecast, milestones: linked,
      latestCheckin: latest };
  });
  return { today, tz, items };
}

// ---------------------------------------------------------------- weekly early warning

export function isoWeekKey(date: string) { const d = utc(date); return `${d.weekYear}-W${String(d.weekNumber).padStart(2, '0')}`; }

/**
 * Weekly status snapshot per active objective. One row per objective per period key (unique), so re-running the
 * hourly tick within a week does nothing. Owners are notified only when the status changes to at_risk/off_track.
 */
export async function evaluateWeeklyStatuses(db: Db, tenantId: string, periodKeyOverride?: string) {
  const periodKey = periodKeyOverride ?? isoWeekKey((await tenantToday(db, tenantId)).today);
  let recorded = 0, notified = 0;
  // The tick runs hourly: only objectives without this week's snapshot are computed, so most runs do no work.
  const pending = (await many(db, `select o.id from objectives o where o.tenant_id = $1 and o.status = 'active'
      and not exists (select 1 from objective_status_history h where h.objective_id = o.id and h.period_key = $2)`, [tenantId, periodKey])).map((r) => r.id as string);
  if (!pending.length) return { periodKey, recorded, notified };
  const { items } = await computeObjectives(db, tenantId, { ids: pending, activeOnly: true });
  const prevs = new Map((await many(db, `select distinct on (objective_id) objective_id, status from objective_status_history
      where objective_id = any($1::uuid[]) and period_key <> $2 order by objective_id, evaluated_at desc`, [pending, periodKey])).map((r) => [r.objective_id as string, r]));
  for (const it of items) {
    const f = it.forecast!; const o = it.objective;
    const prev = prevs.get(o.id);
    const row = await one(db, `insert into objective_status_history (tenant_id, objective_id, period_key, status, previous_status, progress, expected, reasons)
        values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (objective_id, period_key) do nothing returning id`,
      [tenantId, o.id, periodKey, f.status, prev?.status ?? null, it.progress.value, f.expected, JSON.stringify(f.reasons)]);
    if (!row) continue;
    recorded++;
    if (prev?.status === f.status) continue;
    if ((f.status === 'at_risk' || f.status === 'off_track') && o.owner_id) {
      await notify(db, tenantId, o.owner_id, 'objective_status', `Objective ${FORECAST_LABEL[f.status].toLowerCase()}: ${o.title}`, f.reasons.join(' '), `/objectives/${o.id}`);
      await db.query(`update objective_status_history set notified = true where id = $1`, [row.id]);
      notified++;
    }
    await audit(db, { tenantId, actorId: null, action: 'objective.status_changed', resourceType: 'objective', resourceId: o.id, authority: 'weekly_objective_tick',
      details: { periodKey, from: prev?.status ?? null, to: f.status, progress: it.progress.value, expected: f.expected, reasons: f.reasons, ownerNotified: (f.status === 'at_risk' || f.status === 'off_track') && !!o.owner_id } });
  }
  return { periodKey, recorded, notified };
}
