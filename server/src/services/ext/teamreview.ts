import { DateTime } from 'luxon';
import PDFDocument from 'pdfkit';
import { drawPdfBrandHeader, type PdfBrand } from './clientbrand-brand.js';
import type { Db } from '../../lib/db.js';
import { many, one } from '../../lib/db.js';
import { audit } from '../../lib/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { type Actor, has, isStaff, reviewableUserIds } from '../access.js';
import { buildReport, buildReports, METRIC_DEFINITIONS } from '../analytics.js';
import { localToday } from '../calendar.js';
import { notify } from '../notify.js';
import { createTask } from '../tasks.js';
import { csvCell, registerExportReport } from '../exports.js';

/**
 * Weekly team review. Reviewers (team managers, main admin) see a compact, explainable week summary per person
 * in alphabetical order (never ranked) and record a visible review. Reviews never modify recaps or time entries.
 */
export type ReviewStatus = 'acknowledged' | 'discussed' | 'needs_follow_up';
export type ReviewAction = 'acknowledge' | 'discussed' | 'needs_follow_up';
const STATUS_FOR: Record<ReviewAction, ReviewStatus> = { acknowledge: 'acknowledged', discussed: 'discussed', needs_follow_up: 'needs_follow_up' };
const VERB: Record<ReviewStatus, string> = { acknowledged: 'acknowledged your week', discussed: 'marked your week as discussed', needs_follow_up: 'asked for a follow-up on your week' };

export const TEAM_REVIEW_NOTE = 'Alphabetical order, not a ranking. Logging coverage is recorded allocation, not productivity; unknown time is not idle time. Reviews never change recaps or time entries.';

/** ISO week (Monday to Sunday) containing any date. */
export function weekOf(anyDate: string) {
  const d = DateTime.fromISO(anyDate);
  if (!d.isValid) throw badRequest('Invalid week date');
  return { start: d.startOf('week').toISODate()!, end: d.endOf('week').toISODate()! };
}
export const weekLabel = (start: string) => `week of ${DateTime.fromISO(start).toFormat('d LLL yyyy')}`;

export function isWeeklyReviewer(a: Actor) { return isStaff(a) && (has(a, 'routine_admin') || a.managedUserIds.length > 0); }

async function reviewScope(db: Db, a: Actor) {
  if (!isWeeklyReviewer(a)) throw forbidden('Weekly team review is for team managers and the main administrator. Your own weekly reviews are under "My weekly reviews".');
  // Team membership alone never makes a client (customer) account reviewable as staff.
  const rows = await many(db, `select id from users where id = any($1::uuid[]) and not ('customer' = any(roles))`, [await reviewableUserIds(db, a)]);
  return rows.map((r) => r.id as string);
}
const authorityFor = (a: Actor, subjectId: string) => (a.managedUserIds.includes(subjectId) ? 'team_manager' : 'routine_admin');

export async function assertCanReviewSubject(db: Db, a: Actor, subjectId: string) {
  if (subjectId === a.id) throw forbidden('You cannot review your own week');
  const ids = await reviewScope(db, a);
  if (!ids.includes(subjectId)) throw forbidden('This person is not in your review scope');
}

function formatReview(r: any) {
  return {
    id: r.id, weekStart: r.week_start, status: r.status as ReviewStatus, note: r.note, version: r.version,
    reviewer: { id: r.reviewer_id, name: r.reviewer_name ?? null }, subjectUserId: r.subject_user_id,
    employeeResponse: r.employee_response, employeeRespondedAt: r.employee_responded_at,
    followUpTask: r.follow_up_task_id ? { id: r.follow_up_task_id, title: r.follow_up_title ?? null, status: r.follow_up_status ?? null } : null,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
const REVIEW_SELECT = `select wr.*, ru.name reviewer_name, ft.title follow_up_title, ft.status follow_up_status
  from weekly_reviews wr join users ru on ru.id = wr.reviewer_id left join tasks ft on ft.id = wr.follow_up_task_id`;

/** Compact week summary for one person, derived only from the explainable individual report. */
function summarizePerson(u: any, r: any, reviews: any[], a: Actor) {
  const s = r.summary;
  const required = r.days.filter((d: any) => d.capacity.availableMinutes > 0 && !d.isFuture && !d.isToday);
  const confirmed = required.filter((d: any) => d.reportState !== 'provisional').length;
  const missing = required.filter((d: any) => !d.recap).length;
  const openBlockers = r.blockers.filter((b: any) => !b.resolvedAt);
  const carried = [...new Set(r.days.flatMap((d: any) => (d.carryovers ?? []).map((c: any) => c.title)))] as string[];
  const worked = r.days.filter((d: any) => d.capacity.availableMinutes > 0 && !d.isFuture);
  const mine = reviews.find((x) => x.reviewer_id === a.id);
  const isSelf = u.id === a.id;
  return {
    user: { id: u.id, name: u.name, title: u.title, department: u.department, isFounder: u.is_founder }, isSelf,
    roleProfile: r.roleProfile.name, reportState: r.reportState,
    assessment: r.assessment as { label: string; reasons: string[]; facts: string[]; assumptions: string[] },
    outcomes: { intended: s.intendedOutcomes, acceptedPlanned: s.acceptedPlannedOutcomes, plannedCompletion: s.plannedCommitmentCompletion,
      accepted: s.acceptedOutcomes, carryovers: s.carryovers, carriedOverTitles: carried.slice(0, 5) },
    time: { availableMinutes: s.availableMinutes, confirmedMinutes: s.explainedMinutes, unknownMinutes: s.unknownMinutes, loggingCoverage: s.loggingCoverage,
      blockedMinutes: s.blockedMinutes },
    blockers: { open: openBlockers.length, items: openBlockers.slice(0, 5).map((b: any) => ({ id: b.id, taskId: b.taskId, task: b.task, reason: b.reason, cause: b.cause, waitingOn: b.waitingOn, raisedAt: b.raisedAt })) },
    deadlines: { ...s.deadlines, overdueItems: r.deadlines.filter((d: any) => d.state === 'overdue').slice(0, 5).map((d: any) => ({ taskId: d.taskId, title: d.title, dueDate: d.dueDate })) },
    recaps: { required: required.length, confirmed, missing, completion: required.length ? confirmed / required.length : null },
    recommendations: r.recommendations.slice(0, 3),
    lastWorkingDate: worked.length ? worked[worked.length - 1].date : null,
    review: mine ? formatReview(mine) : null,
    otherReviews: reviews.filter((x) => x.reviewer_id !== a.id).map(formatReview),
    flags: {
      needsAttention: r.assessment.label === 'needs_attention', missingRecaps: missing > 0,
      blocked: openBlockers.length > 0 || s.blockedMinutes > 0, unreviewed: !isSelf && !mine,
    },
  };
}
export type PersonWeek = ReturnType<typeof summarizePerson>;

function totalsOf(people: PersonWeek[]) {
  const sum = (f: (p: PersonWeek) => number) => people.reduce((t, p) => t + f(p), 0);
  const available = sum((p) => p.time.availableMinutes), confirmed = sum((p) => p.time.confirmedMinutes);
  const intended = sum((p) => p.outcomes.intended), acceptedPlanned = sum((p) => p.outcomes.acceptedPlanned);
  const required = sum((p) => p.recaps.required), recapsConfirmed = sum((p) => p.recaps.confirmed);
  return {
    people: people.length,
    outcomes: { intended, acceptedPlanned, plannedCompletion: intended ? acceptedPlanned / intended : null, accepted: sum((p) => p.outcomes.accepted), carryovers: sum((p) => p.outcomes.carryovers) },
    time: { availableMinutes: available, confirmedMinutes: confirmed, unknownMinutes: sum((p) => p.time.unknownMinutes), loggingCoverage: available > 0 ? confirmed / available : null,
      blockedMinutes: sum((p) => p.time.blockedMinutes) },
    openBlockers: sum((p) => p.blockers.open),
    deadlines: { met: sum((p) => p.deadlines.met), late: sum((p) => p.deadlines.late), overdue: sum((p) => p.deadlines.overdue), open: sum((p) => p.deadlines.open) },
    recaps: { required, confirmed: recapsConfirmed, missing: sum((p) => p.recaps.missing), completion: required ? recapsConfirmed / required : null },
    attention: { needsAttention: people.filter((p) => p.flags.needsAttention).length, missingRecaps: people.filter((p) => p.flags.missingRecaps).length,
      blocked: people.filter((p) => p.flags.blocked).length, unreviewed: people.filter((p) => p.flags.unreviewed).length },
    reviewedByYou: people.filter((p) => p.review).length,
  };
}

/** GET /api/team-review: every person the actor may review (self only on request), alphabetical. */
export async function teamWeek(db: Db, a: Actor, opts: { week?: string; includeMe?: boolean }) {
  const ids = await reviewScope(db, a);
  const today = localToday(a.timezone);
  const { start, end } = weekOf(opts.week ?? DateTime.fromISO(today).minus({ days: 7 }).toISODate()!);
  if (start > today) throw badRequest('That week has not started yet, so there is nothing recorded to review.');
  const users = await many(db, `select u.id, u.name, u.title, u.is_founder, d.name department from users u left join departments d on d.id = u.department_id
    where u.id = any($1::uuid[]) and u.status = 'active' and ($2::boolean or u.id <> $3) order by lower(u.name), u.name, u.id`, [ids, !!opts.includeMe, a.id]);
  const reviews = await many(db, `${REVIEW_SELECT} where wr.subject_user_id = any($1::uuid[]) and wr.week_start = $2 order by wr.created_at`, [users.map((u) => u.id), start]);
  const people: PersonWeek[] = [];
  // One set of queries for the whole team (not a full report round trip per person).
  const reports = await buildReports(db, users.map((u) => u.id), 'week', start, end, { trend: false });
  for (const u of users) people.push(summarizePerson(u, reports.get(u.id)!, reviews.filter((x) => x.subject_user_id === u.id), a));
  return {
    week: { start, end, isCurrent: start <= today && today <= end }, today,
    scope: has(a, 'routine_admin') ? 'company' as const : 'team' as const, includeMe: !!opts.includeMe,
    generatedAt: new Date().toISOString(), order: 'alphabetical' as const, people, totals: totalsOf(people), note: TEAM_REVIEW_NOTE,
    definitions: { version: METRIC_DEFINITIONS.version, logging_coverage: METRIC_DEFINITIONS.logging_coverage, unknown_time: METRIC_DEFINITIONS.unknown_time,
      planned_commitment_completion: METRIC_DEFINITIONS.planned_commitment_completion, accepted_outcome: METRIC_DEFINITIONS.accepted_outcome,
      blocker_share: METRIC_DEFINITIONS.blocker_share, assessment: METRIC_DEFINITIONS.assessment },
  };
}

export interface WeeklyReviewInput {
  subjectUserId: string; week: string; action: ReviewAction; note?: string; version?: number;
  followUp?: { title: string; dueDate?: string | null };
}

/** Acknowledge / discussed / needs follow-up. Optimistic versioning: updating an existing review requires its current version. */
export async function recordWeeklyReview(db: Db, a: Actor, i: WeeklyReviewInput) {
  await assertCanReviewSubject(db, a, i.subjectUserId);
  const subject = await one(db, `select id, name, status from users where id = $1`, [i.subjectUserId]);
  if (!subject || subject.status !== 'active') throw notFound('Person not found');
  const { start } = weekOf(i.week);
  if (start > localToday(a.timezone)) throw badRequest('That week has not started yet');
  const status = STATUS_FOR[i.action];
  const existing = await one(db, `select * from weekly_reviews where reviewer_id = $1 and subject_user_id = $2 and week_start = $3`, [a.id, i.subjectUserId, start]);
  const note = i.note === undefined ? (existing?.note ?? '') : i.note.trim();
  if (i.followUp && status !== 'needs_follow_up') throw badRequest('A follow-up task can only be created with a follow-up request');
  if (status === 'needs_follow_up' && !note && !i.followUp) throw badRequest('Say what needs follow-up: add a note or a follow-up task');
  if (i.followUp && existing?.follow_up_task_id) {
    // One linked follow-up at a time: a second task would silently unlink the first, which stays assigned to the employee.
    const prev = await one(db, `select status from tasks where id = $1`, [existing.follow_up_task_id]);
    if (prev && prev.status !== 'done' && prev.status !== 'cancelled') throw conflict('This review already has an open follow-up task. Update or close that task instead of creating another.');
  }
  let row: any;
  if (!existing) {
    row = await one(db, `insert into weekly_reviews (tenant_id, reviewer_id, subject_user_id, week_start, status, note) values ($1,$2,$3,$4,$5,$6)
      on conflict (tenant_id, reviewer_id, subject_user_id, week_start) do nothing returning *`, [a.tenantId, a.id, i.subjectUserId, start, status, note]);
    if (!row) throw conflict('This review was just saved elsewhere. Reload to see the latest version.');
  } else {
    if (i.version !== existing.version) throw conflict('This review changed since you loaded it. Reload to see the latest version.', { currentVersion: existing.version });
    row = await one(db, `update weekly_reviews set status = $2, note = $3, version = version + 1, updated_at = now()
      where id = $1 and version = $4 returning *`, [existing.id, status, note, i.version]);
    if (!row) throw conflict('This review changed since you loaded it. Reload to see the latest version.');
  }
  if (i.followUp) {
    const t = await createTask(db, a, a.tenantId, { title: i.followUp.title, ownerId: i.subjectUserId, dueDate: i.followUp.dueDate ?? null, sourceType: 'follow_up',
      sourceRef: { weekly_review_id: row.id, week_start: start, reviewer_id: a.id }, description: note, externalKey: `weekly_review:${row.id}:v${row.version}` },
      { authority: authorityFor(a, i.subjectUserId) });
    row = await one(db, `update weekly_reviews set follow_up_task_id = $2 where id = $1 returning *`, [row.id, t.task.id]);
  }
  await notify(db, a.tenantId, i.subjectUserId, 'weekly_review', `${a.name} ${VERB[status]} (${weekLabel(start)})`, note, `/team-review?tab=mine&week=${start}`);
  await audit(db, { tenantId: a.tenantId, actorId: a.id, action: `weekly_review.${status}`, resourceType: 'weekly_review', resourceId: row.id, resourceVersion: row.version,
    authority: authorityFor(a, i.subjectUserId), details: { subject: i.subjectUserId, weekStart: start, from: existing?.status ?? null, to: status,
      noteChanged: !existing || existing.note !== note, followUpTaskId: i.followUp ? row.follow_up_task_id : null } });
  return formatReview(await one(db, `${REVIEW_SELECT} where wr.id = $1`, [row.id]));
}

/** The employee's own response to a review of their week. Only the reviewed person may respond. */
export async function respondToWeeklyReview(db: Db, a: Actor, id: string, b: { response: string; version: number }) {
  const row = await one(db, `select * from weekly_reviews where id = $1`, [id]);
  if (!row || row.subject_user_id !== a.id) throw notFound('Review not found');
  const text = b.response.trim();
  if (!text) throw badRequest('Write a response');
  const upd = await one(db, `update weekly_reviews set employee_response = $2, employee_responded_at = now(), version = version + 1
    where id = $1 and version = $3 returning *`, [id, text, b.version]);
  if (!upd) throw conflict('This review changed since you loaded it. Reload to see the latest version.');
  await notify(db, a.tenantId, row.reviewer_id, 'weekly_review_response', `${a.name} responded to your weekly review (${weekLabel(row.week_start)})`, text, `/team-review?week=${row.week_start}`);
  await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'weekly_review.respond', resourceType: 'weekly_review', resourceId: id, resourceVersion: upd.version,
    authority: 'subject', details: { weekStart: row.week_start, reviewer: row.reviewer_id, firstResponse: !row.employee_responded_at } });
  return formatReview(await one(db, `${REVIEW_SELECT} where wr.id = $1`, [id]));
}

/** Reviews of the signed-in person's own weeks (any reviewer), newest week first. */
export async function myWeeklyReviews(db: Db, a: Actor, limit = 26) {
  const rows = await many(db, `${REVIEW_SELECT} where wr.subject_user_id = $1 order by wr.week_start desc, wr.updated_at desc limit $2`, [a.id, limit]);
  return rows.map(formatReview);
}

/** Monday reminder to team managers with people not yet reviewed for last week. Idempotent per manager per week. */
export async function remindWeeklyReviewers(db: Db, tenantId: string, at: DateTime<boolean> = DateTime.now()) {
  const t = await one(db, `select timezone from tenants where id = $1`, [tenantId]);
  const now = at.setZone(t?.timezone ?? 'UTC');
  if (now.weekday !== 1 || now.hour < 9) return 0;
  const weekStart = now.minus({ days: 7 }).startOf('week').toISODate()!;
  const link = `/team-review?week=${weekStart}`;
  const rows = await many(db, `select tm_mgr.manager_id, count(distinct tm.user_id)::int pending
    from teams tm_mgr join team_members tm on tm.team_id = tm_mgr.id join users u on u.id = tm.user_id join users m on m.id = tm_mgr.manager_id
    where u.status = 'active' and m.status = 'active' and tm.user_id <> tm_mgr.manager_id and not ('customer' = any(u.roles))
      and not exists (select 1 from weekly_reviews wr where wr.reviewer_id = tm_mgr.manager_id and wr.subject_user_id = tm.user_id and wr.week_start = $1)
      and not exists (select 1 from notifications n where n.user_id = tm_mgr.manager_id and n.kind = 'weekly_review_ready' and n.link = $2)
    group by tm_mgr.manager_id`, [weekStart, link]);
  for (const r of rows) {
    await notify(db, tenantId, r.manager_id, 'weekly_review_ready', `Weekly team review: ${weekLabel(weekStart)}`,
      `${r.pending} team member(s) not yet reviewed. People are listed alphabetically; nothing is ranked.`, link);
  }
  return rows.length;
}

// ---------- Export: team_weekly (same scope as the page) ----------
const pctv = (v: number | null | undefined) => (v === null || v === undefined ? 'N/A' : `${Math.round(v * 100)}%`);
const hmv = (m: number) => `${Math.floor(m / 60)}h ${Math.round(m % 60)}m`;
const LABEL: Record<string, string> = { on_track: 'On Track', needs_attention: 'Needs Attention', insufficient_data: 'Insufficient Data', not_applicable: 'Not Applicable' };
const STATUS_LABEL: Record<string, string> = { acknowledged: 'Acknowledged', discussed: 'Discussed', needs_follow_up: 'Needs follow-up' };

export function teamWeekCsv(d: Awaited<ReturnType<typeof teamWeek>>) {
  const rows: unknown[][] = [
    ['Team weekly review', `${d.week.start} to ${d.week.end}`], ['Scope', d.scope], ['Order', 'Alphabetical (not a ranking)'], ['Note', d.note],
    ['Definitions', d.definitions.version], ['Generated', d.generatedAt], [],
    ['employee', 'department', 'assessment', 'assessment_reasons', 'assessment_facts', 'assessment_assumptions', 'intended_outcomes', 'accepted_planned', 'planned_completion', 'accepted_outcomes', 'carryovers',
      'available_min', 'confirmed_min', 'unknown_min', 'logging_coverage', 'blocked_min', 'open_blockers', 'deadlines_met', 'deadlines_late', 'deadlines_overdue',
      'recaps_confirmed', 'recaps_required', 'recaps_missing', 'your_review', 'your_note', 'employee_response', 'top_recommendations'],
  ];
  for (const p of d.people) {
    rows.push([p.user.name, p.user.department ?? '', LABEL[p.assessment.label] ?? p.assessment.label, p.assessment.reasons.join(' | '), p.assessment.facts.join(' | '),
      p.assessment.assumptions.join(' | '), p.outcomes.intended, p.outcomes.acceptedPlanned,
      pctv(p.outcomes.plannedCompletion), p.outcomes.accepted, p.outcomes.carryovers, p.time.availableMinutes, p.time.confirmedMinutes, p.time.unknownMinutes,
      p.time.availableMinutes ? pctv(p.time.loggingCoverage) : 'N/A', p.time.blockedMinutes, p.blockers.open, p.deadlines.met, p.deadlines.late, p.deadlines.overdue,
      p.recaps.confirmed, p.recaps.required, p.recaps.missing, p.review ? STATUS_LABEL[p.review.status] : '', p.review?.note ?? '', p.review?.employeeResponse ?? '',
      p.recommendations.map((r: any) => r.text).join(' | ')]);
  }
  const t = d.totals;
  rows.push([], ['Team totals', '', '', '', '', '', t.outcomes.intended, t.outcomes.acceptedPlanned, pctv(t.outcomes.plannedCompletion), t.outcomes.accepted, t.outcomes.carryovers,
    t.time.availableMinutes, t.time.confirmedMinutes, t.time.unknownMinutes, pctv(t.time.loggingCoverage), t.time.blockedMinutes, t.openBlockers, t.deadlines.met, t.deadlines.late,
    t.deadlines.overdue, t.recaps.confirmed, t.recaps.required, t.recaps.missing, `${t.reviewedByYou} reviewed`, '', '', '']);
  return rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
}

export function teamWeekPdf(d: Awaited<ReturnType<typeof teamWeek>>, a: Actor, brand?: PdfBrand): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: 'Weekly team review', Author: 'Task Tracking and Productivity' } });
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    // Organization name, accent and logo, like every other exported report.
    if (brand) drawPdfBrandHeader(doc, brand);
    const h1 = (t: string) => doc.font('Helvetica-Bold').fontSize(18).fillColor('#111827').text(t).moveDown(0.3);
    const h2 = (t: string) => { doc.moveDown(0.6).font('Helvetica-Bold').fontSize(12).fillColor('#111827').text(t).moveDown(0.2); };
    const p = (t: string, color = '#374151') => doc.font('Helvetica').fontSize(9.5).fillColor(color).text(t, { lineGap: 2 });
    const t = d.totals;
    h1(`Weekly team review - ${d.week.start} to ${d.week.end}`);
    p(`Scope: ${d.scope === 'company' ? 'company-wide' : 'your teams'} - ${t.people} people, listed alphabetically. ${d.note}`, '#6b7280');
    h2('Team totals');
    p(`Intended outcomes accepted ${t.outcomes.acceptedPlanned}/${t.outcomes.intended} (${pctv(t.outcomes.plannedCompletion)}); accepted outcomes ${t.outcomes.accepted}; carryovers ${t.outcomes.carryovers}.`);
    p(`Confirmed ${hmv(t.time.confirmedMinutes)} of ${hmv(t.time.availableMinutes)} available (${pctv(t.time.loggingCoverage)} logging coverage); ${hmv(t.time.unknownMinutes)} unknown (not idle).`);
    p(`Blocked ${hmv(t.time.blockedMinutes)}; ${t.openBlockers} open blocker(s). Deadlines: ${t.deadlines.met} met, ${t.deadlines.late} late, ${t.deadlines.overdue} overdue.`);
    p(`Recaps: ${t.recaps.confirmed}/${t.recaps.required} confirmed (${pctv(t.recaps.completion)}), ${t.recaps.missing} missing. Reviewed by you: ${t.reviewedByYou}/${t.people}.`);
    for (const x of d.people) {
      h2(`${x.user.name}${x.user.department ? ` - ${x.user.department}` : ''}${x.isSelf ? ' (you)' : ''}`);
      p(`Assessment: ${LABEL[x.assessment.label] ?? x.assessment.label}. ${x.assessment.reasons.join(' ')}`);
      p(`Facts: ${x.assessment.facts.join('; ') || 'none recorded'}`, '#4b5563');
      p(`Assumptions: ${x.assessment.assumptions.join('; ')}`, '#6b7280');
      p(`Outcomes: ${x.outcomes.acceptedPlanned}/${x.outcomes.intended} intended accepted (${pctv(x.outcomes.plannedCompletion)}), ${x.outcomes.accepted} accepted in total, ${x.outcomes.carryovers} carryover(s).`);
      p(`Time: ${x.time.availableMinutes ? `${hmv(x.time.confirmedMinutes)} confirmed of ${hmv(x.time.availableMinutes)} (${pctv(x.time.loggingCoverage)} logging coverage), ${hmv(x.time.unknownMinutes)} unknown` : 'no scheduled capacity (Not Applicable)'}; blocked ${hmv(x.time.blockedMinutes)}, ${x.blockers.open} open blocker(s).`);
      p(`Deadlines: ${x.deadlines.met} met, ${x.deadlines.late} late, ${x.deadlines.overdue} overdue. Recaps: ${x.recaps.confirmed}/${x.recaps.required} confirmed, ${x.recaps.missing} missing.`);
      for (const r of x.recommendations) p(`> ${r.text}`);
      if (x.review) p(`Your review: ${STATUS_LABEL[x.review.status]}${x.review.note ? ` - ${x.review.note}` : ''}${x.review.employeeResponse ? ` | Response: ${x.review.employeeResponse}` : ''}`, '#1f2937');
      for (const o of x.otherReviews) p(`${o.reviewer.name}: ${STATUS_LABEL[o.status]}${o.note ? ` - ${o.note}` : ''}`, '#4b5563');
    }
    doc.moveDown(1).font('Helvetica').fontSize(7.5).fillColor('#9ca3af')
      .text(`Generated ${new Date().toISOString()} for ${a.name}. Authorized records only. No ranking or single productivity score.`);
    doc.end();
  });
}

export function registerTeamWeeklyExport() {
  registerExportReport('team_weekly', {
    async authorize(db, a, p) {
      if (!p.date && !p.start) throw badRequest('date is required (any date in the week)');
      await reviewScope(db, a);
      // Same week rules as the page, checked here so an impossible or future week is refused instead of failing in the worker forever.
      if (weekOf(p.date ?? p.start).start > localToday(a.timezone)) throw badRequest('That week has not started yet, so there is nothing recorded to review.');
    },
    async build(db, a, p) {
      const data = await teamWeek(db, a, { week: p.date ?? p.start, includeMe: p.includeMe === true || p.includeMe === 'true' });
      return { data, name: `team-week-${data.week.start}` };
    },
    csv: teamWeekCsv,
    pdf: teamWeekPdf,
  });
}
