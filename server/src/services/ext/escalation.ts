import { DateTime } from 'luxon';
import { z } from 'zod';
import type { Db } from '../../lib/db.js';
import { many, one } from '../../lib/db.js';
import { audit } from '../../lib/audit.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { notify } from '../notify.js';
import { type Actor, assertContribute, canContribute, has, isStaff, loadVisibleTask } from '../access.js';
import { type CalendarData, dayCapacity, loadCalendar, localDayBounds, localToday } from '../calendar.js';

/**
 * Smart blocker escalation. Ages are counted in the blocker owner's working days (their schedule,
 * company holidays and, optionally, their full-day leave), never in calendar days.
 * Each ladder level fires once per blocker; resolving the blocker stops the ladder.
 */
export const LEVELS = ['waiting_on', 'manager', 'admin'] as const;
export type Level = typeof LEVELS[number];
export const LEVEL_LABEL: Record<Level | 'owner', string> = {
  owner: 'Owner reminded', waiting_on: 'Person waited on notified', manager: 'Team manager notified', admin: 'Main admins notified',
};
export const CAUSE_LABEL: Record<string, string> = {
  dependency: 'Dependency', client: 'Client', requirement: 'Unclear requirement', access: 'Access', technical: 'Technical', capacity: 'Capacity', other: 'Other',
};

const days = z.number().int().min(1).max(60).nullable();
export const policySchema = z.object({
  enabled: z.boolean(),
  remindOwner: z.boolean(),
  waitingOnAfterDays: days,
  managerAfterDays: days,
  adminAfterDays: days,
  quietWhenOwnerOnLeave: z.boolean(),
}).superRefine((p, ctx) => {
  let prev = 0;
  for (const k of ['waitingOnAfterDays', 'managerAfterDays', 'adminAfterDays'] as const) {
    const v = p[k];
    if (v === null) continue;
    if (v < prev) ctx.addIssue({ code: 'custom', path: [k], message: 'Each step must come on or after the step before it' });
    prev = v;
  }
});
export type PolicyFields = z.infer<typeof policySchema>;
export type EscalationPolicy = PolicyFields & { version: number; updatedAt: string | null; updatedBy: string | null };

export const DEFAULT_POLICY: EscalationPolicy = {
  enabled: false, remindOwner: true, waitingOnAfterDays: 2, managerAfterDays: 4, adminAfterDays: 7, quietWhenOwnerOnLeave: true,
  version: 0, updatedAt: null, updatedBy: null,
};

export function readPolicy(settings: any): EscalationPolicy {
  const raw = settings?.escalation;
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_POLICY };
  const merged = { ...DEFAULT_POLICY, ...raw };
  const parsed = policySchema.safeParse(merged);
  if (!parsed.success) return { ...DEFAULT_POLICY, version: Number(raw.version) || 0 };
  return { ...parsed.data, version: Number(raw.version) || 0, updatedAt: raw.updatedAt ?? null, updatedBy: raw.updatedBy ?? null };
}

export async function loadPolicy(db: Db, tenantId: string) {
  const t = await one(db, `select settings from tenants where id = $1`, [tenantId]);
  return readPolicy(t?.settings);
}

export function ladder(p: PolicyFields): { level: Level; afterDays: number }[] {
  const steps: { level: Level; afterDays: number | null }[] = [
    { level: 'waiting_on', afterDays: p.waitingOnAfterDays }, { level: 'manager', afterDays: p.managerAfterDays }, { level: 'admin', afterDays: p.adminAfterDays },
  ];
  return steps.filter((s): s is { level: Level; afterDays: number } => s.afterDays !== null);
}

export async function savePolicy(db: Db, a: Actor, input: PolicyFields, version: number, correlationId?: string) {
  const t = await one(db, `select settings from tenants where id = $1 for update`, [a.tenantId]);
  const before = readPolicy(t?.settings);
  if (before.version !== version) throw conflict('The escalation policy was changed by someone else. Reload to see the latest version.', { currentVersion: before.version });
  const next: EscalationPolicy = { ...input, version: before.version + 1, updatedAt: new Date().toISOString(), updatedBy: a.id };
  await db.query(`update tenants set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{escalation}', $2::jsonb, true) where id = $1`, [a.tenantId, JSON.stringify(next)]);
  const { version: _v1, updatedAt: _u1, updatedBy: _b1, ...from } = before;
  await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'escalation.policy.update', resourceType: 'tenant', resourceId: a.tenantId,
    resourceVersion: next.version, correlationId, details: { from, to: input } });
  return next;
}

// ---------- Working-day arithmetic (pure) ----------

/** Does this local date count toward a blocker's age? Owner's scheduled, non-holiday days; full-day leave pauses the clock when quiet. */
export function countsAsWorkingDay(cal: CalendarData, date: string, quietOnLeave: boolean) {
  const s = dayCapacity(cal, date).status;
  return s === 'working' || s === 'partial_leave' || (s === 'leave' && !quietOnLeave);
}

/** Working days strictly after `from` up to and including `to`. */
export function workingDaysBetween(cal: CalendarData, from: string, to: string, quietOnLeave: boolean) {
  let n = 0;
  let d = DateTime.fromISO(from).plus({ days: 1 });
  const end = DateTime.fromISO(to);
  for (let guard = 0; d <= end && guard < 3700; guard++, d = d.plus({ days: 1 })) if (countsAsWorkingDay(cal, d.toISODate()!, quietOnLeave)) n++;
  return n;
}

/** The local date on which `n` working days will have passed since `from`; null when not reached within ~a year. */
export function dateAfterWorkingDays(cal: CalendarData, from: string, n: number, quietOnLeave: boolean) {
  let k = 0;
  let d = DateTime.fromISO(from);
  for (let i = 0; i < 370; i++) {
    d = d.plus({ days: 1 });
    if (countsAsWorkingDay(cal, d.toISODate()!, quietOnLeave)) k++;
    if (k >= n) return d.toISODate()!;
  }
  return null;
}

export const localDateOf = (ts: Date | string, tz: string) => DateTime.fromJSDate(ts instanceof Date ? ts : new Date(ts)).setZone(tz).toISODate()!;

export interface Fired { level: string; follow_up_date: string | null; outcome: string; created_at?: Date }
export interface Assessment {
  raisedOn: string;
  today: string;
  ageWorkingDays: number;
  /** Today's status for the owner; escalation only acts on days that count. */
  actsToday: boolean;
  todayStatus: string;
  currentLevel: Level | null;
  next: { level: Level; afterDays: number; date: string | null } | null;
  due: { level: Level; afterDays: number }[];
  ownerReminderDue: { followUpDate: string | null } | null;
}

/** Explainable assessment of one open blocker under a policy. Pure: everything it needs is passed in. */
export function assessBlocker(cal: CalendarData, p: EscalationPolicy, b: { raised_at: Date | string; next_follow_up: string | null }, today: string, fired: Fired[]): Assessment {
  const raisedOn = localDateOf(b.raised_at, cal.timezone);
  const quiet = p.quietWhenOwnerOnLeave;
  const status = dayCapacity(cal, today).status;
  const actsToday = countsAsWorkingDay(cal, today, quiet);
  const age = raisedOn >= today ? 0 : workingDaysBetween(cal, raisedOn, today, quiet);
  const done = new Set(fired.filter((f) => f.level !== 'owner').map((f) => f.level));
  const steps = ladder(p);
  // The badge reflects who has actually been told; skipped steps (e.g. external waiting-on) do not count as escalation.
  const currentLevel = [...LEVELS].reverse().find((l) => fired.some((f) => f.level === l && f.outcome === 'notified')) ?? null;
  const pending = steps.filter((s) => !done.has(s.level));
  const due = pending.filter((s) => age >= s.afterDays);
  const upcoming = pending.find((s) => age < s.afterDays) ?? null;
  // A step that is already due comes first; it fires today only on a day that counts, otherwise on the next one.
  const next = due[0] ? { ...due[0], date: actsToday ? today : dateAfterWorkingDays(cal, today, 1, quiet) }
    : upcoming ? { ...upcoming, date: dateAfterWorkingDays(cal, raisedOn, upcoming.afterDays, quiet) } : null;
  let ownerReminderDue: Assessment['ownerReminderDue'] = null;
  if (p.remindOwner) {
    const key = b.next_follow_up ?? null;
    const reached = key ? key <= today : age >= 1;
    if (reached && !fired.some((f) => f.level === 'owner' && (f.follow_up_date ?? null) === key)) ownerReminderDue = { followUpDate: key };
  }
  return { raisedOn, today, ageWorkingDays: age, actsToday, todayStatus: status, currentLevel, next, due, ownerReminderDue };
}

// ---------- Loading and assessing many blockers ----------

const OPEN_BLOCKER_SQL = `select b.*, t.title task_title, t.number task_number, t.owner_id, t.status task_status, o.name owner_name, o.is_founder owner_is_founder,
    w.name waiting_on_name, w.status waiting_on_status, w.roles waiting_on_roles
  from blockers b join tasks t on t.id = b.task_id join users o on o.id = t.owner_id left join users w on w.id = b.waiting_on_user_id`;

/** The blocker waits on an active staff user who can be told in the app (not a client, not deactivated). */
const waitsOnInternal = (b: any) => !!b.waiting_on_user_id && b.waiting_on_status === 'active' && !(b.waiting_on_roles ?? []).includes('customer');

async function calendarsFor(db: Db, rows: any[], today?: string) {
  const cals = new Map<string, CalendarData>();
  const from = DateTime.fromJSDate(rows.reduce((m, r) => (r.raised_at < m ? r.raised_at : m), new Date())).minus({ days: 2 }).toISODate()!;
  const to = DateTime.fromISO(today ?? DateTime.utc().toISODate()!).plus({ days: 200 }).toISODate()!;
  for (const ownerId of new Set(rows.map((r) => r.owner_id))) cals.set(ownerId, await loadCalendar(db, ownerId, from, to));
  return cals;
}

async function firedFor(db: Db, ids: string[]) {
  const rows = ids.length ? await many(db, `select * from blocker_escalations where blocker_id = any($1::uuid[]) order by created_at`, [ids]) : [];
  const by = new Map<string, any[]>();
  for (const r of rows) { if (!by.has(r.blocker_id)) by.set(r.blocker_id, []); by.get(r.blocker_id)!.push(r); }
  return by;
}

export async function assessRows(db: Db, rows: any[], p: EscalationPolicy, opts: { today?: string } = {}) {
  if (!rows.length) return [];
  const cals = await calendarsFor(db, rows, opts.today);
  const fired = await firedFor(db, rows.map((r) => r.id));
  return rows.map((r) => {
    const cal = cals.get(r.owner_id)!;
    const today = opts.today ?? localToday(cal.timezone);
    return { row: r, cal, fired: fired.get(r.id) ?? [], a: assessBlocker(cal, p, r, today, fired.get(r.id) ?? []) };
  });
}

// ---------- Tick ----------

const plural = (n: number, w: string) => `${n} working ${w}${n === 1 ? '' : 's'}`;

async function managersOf(db: Db, userId: string): Promise<string[]> {
  return (await many(db, `select distinct t.manager_id from teams t join team_members tm on tm.team_id = t.id join users u on u.id = t.manager_id
    where tm.user_id = $1 and t.manager_id <> $1 and u.status = 'active'`, [userId])).map((r) => r.manager_id);
}
async function adminsFor(db: Db, owner: { id: string; is_founder: boolean }, settings: any): Promise<string[]> {
  const foundersOnly = owner.is_founder && settings?.founders_visible_to_routine_admin === false;
  return (await many(db, `select id from users where status = 'active' and 'routine_admin' = any(roles) and not ('customer' = any(roles))
    and id <> $1 and ($2::boolean = false or is_founder) order by name`, [owner.id, foundersOnly])).map((r) => r.id);
}

async function record(db: Db, tenantId: string, blockerId: string, level: string, followUpDate: string | null, workingDays: number,
  outcome: 'notified' | 'skipped', note: string, recipients: string[]) {
  const r = await one(db, `insert into blocker_escalations (tenant_id, blocker_id, level, follow_up_date, working_days, outcome, note, notified_user_id, recipient_ids)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict do nothing returning id`,
    [tenantId, blockerId, level, followUpDate, workingDays, outcome, note, recipients[0] ?? null, recipients]);
  return !!r;
}

/**
 * Evaluate every open blocker for one tenant and fire due steps once. Safe to run repeatedly (unique per level).
 * `today` overrides each owner's local date (tests, backfills).
 */
export async function runEscalation(db: Db, tenantId: string, opts: { today?: string } = {}) {
  const t = await one(db, `select settings from tenants where id = $1`, [tenantId]);
  const p = readPolicy(t?.settings);
  const out = { evaluated: 0, notified: 0, skipped: 0, quiet: 0 };
  if (!p.enabled) return out;
  const rows = await many(db, `${OPEN_BLOCKER_SQL} where b.resolved_at is null and t.status not in ('done','cancelled') order by b.raised_at`);
  for (const { row: b, a, cal } of await assessRows(db, rows, p, opts)) {
    out.evaluated++;
    if (!a.actsToday) { if (a.todayStatus === 'leave') out.quiet++; continue; }
    const link = `/tasks/${b.task_id}`;
    const waitingOn = b.waiting_on_name || b.waiting_on_text || 'not specified';
    const facts = `Blocked for ${plural(a.ageWorkingDays, 'day')} (weekends, holidays${p.quietWhenOwnerOnLeave ? ' and leave' : ''} not counted). Cause: ${CAUSE_LABEL[b.cause] ?? b.cause}. Waiting on: ${waitingOn}. Reason: ${b.reason}`;
    const sentNow = new Set<string>();
    if (a.ownerReminderDue) {
      const key = a.ownerReminderDue.followUpDate;
      // "Today" is the owner's local calendar day (a rolling window would swallow the next day's follow-up reminder).
      const dayStart = localDayBounds(cal.timezone, localToday(cal.timezone)).start;
      const already = await one(db, `select 1 from notifications where user_id = $1 and kind = 'blocker_reminder' and link = $2 and created_at >= $3`, [b.owner_id, link, dayStart]);
      const inserted = await record(db, tenantId, b.id, 'owner', key, a.ageWorkingDays, already ? 'skipped' : 'notified', already ? 'Owner was already reminded today' : '', [b.owner_id]);
      if (inserted && !already) {
        await notify(db, tenantId, b.owner_id, 'blocker_reminder', `Follow up on blocker: ${b.task_title}`,
          key ? `Your follow-up date (${key}) has arrived. Resolve the blocker or set a new follow-up date. ${b.reason}` : `${facts}. Set a follow-up date or resolve it.`, link);
        sentNow.add(b.owner_id); out.notified++;
      }
    }
    for (const step of a.due) {
      let recipients: string[] = []; let note = '';
      if (step.level === 'waiting_on') {
        if (!waitsOnInternal(b)) note = b.waiting_on_user_id ? `${b.waiting_on_name ?? 'The person waited on'} is a client or no longer active; no one to notify in the app`
          : b.waiting_on_text ? `Waiting on someone outside the team (${b.waiting_on_text}); no one to notify in the app` : 'No internal person is named as waited on';
        else if (b.waiting_on_user_id === b.owner_id) note = 'The owner is also the person waited on';
        else recipients = [b.waiting_on_user_id];
      } else if (step.level === 'manager') {
        recipients = await managersOf(db, b.owner_id);
        if (!recipients.length) note = 'The owner is not in a team with a manager';
      } else {
        recipients = await adminsFor(db, { id: b.owner_id, is_founder: b.owner_is_founder }, t?.settings);
        if (!recipients.length) note = b.owner_is_founder && t?.settings?.founders_visible_to_routine_admin === false
          ? "Founders' records are not visible to main admins, and no other founder is a main admin" : 'No main admin other than the owner';
      }
      const outcome = recipients.length ? 'notified' : 'skipped';
      if (!(await record(db, tenantId, b.id, step.level, null, a.ageWorkingDays, outcome, note, recipients))) continue;
      if (outcome === 'skipped') out.skipped++;
      for (const uid of recipients) {
        if (sentNow.has(uid)) continue;
        sentNow.add(uid); out.notified++;
        if (step.level === 'waiting_on') await notify(db, tenantId, uid, 'blocker_escalation', `${b.owner_name} is still waiting on you`, `"${b.task_title}": ${facts}`, link);
        else if (step.level === 'manager') await notify(db, tenantId, uid, 'blocker_escalation', `Blocker may need your help: ${b.task_title}`, `${b.owner_name}'s task. ${facts}`, link);
        else await notify(db, tenantId, uid, 'blocker_escalation', `Long-running blocker: ${b.task_title}`, `${b.owner_name}'s task. ${facts}`, link);
      }
      await audit(db, { tenantId, actorId: null, action: 'blocker.escalated', resourceType: 'blocker', resourceId: b.id, authority: 'escalation_policy',
        reason: note || null, details: { level: step.level, afterDays: step.afterDays, workingDays: a.ageWorkingDays, outcome, recipients, policyVersion: p.version } });
    }
  }
  return out;
}

// ---------- Nudge ----------

export async function nudgeBlocker(db: Db, a: Actor, blockerId: string, note: string, correlationId?: string) {
  const bl = await one(db, `select b.*, w.name waiting_on_name, w.status waiting_on_status, w.roles waiting_on_roles from blockers b
    left join users w on w.id = b.waiting_on_user_id where b.id = $1`, [blockerId]);
  if (!bl) throw notFound('Blocker not found');
  const t = await loadVisibleTask(db, a, bl.task_id);
  await assertContribute(db, a, t);
  if (bl.resolved_at) throw conflict('This blocker is already resolved');
  const why = nudgeUnavailable(bl, a);
  if (why) throw badRequest(why);
  const today = localToday(a.timezone);
  const row = await one(db, `insert into blocker_nudges (tenant_id, blocker_id, actor_id, notified_user_id, nudged_on, note) values ($1,$2,$3,$4,$5,$6)
    on conflict (blocker_id, actor_id, nudged_on) do nothing returning *`, [a.tenantId, bl.id, a.id, bl.waiting_on_user_id, today, note]);
  if (!row) throw new AppError(429, 'rate_limited', 'You already nudged about this blocker today. You can nudge again tomorrow.');
  await notify(db, a.tenantId, bl.waiting_on_user_id, 'blocker_nudge', `${a.name} nudged you about a blocker`,
    `"${t.title}" is waiting on you. ${bl.reason}${note ? ` Note: ${note}` : ''}`, `/tasks/${t.id}`);
  await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'blocker.nudge', resourceType: 'blocker', resourceId: bl.id, correlationId,
    details: { taskId: t.id, notifiedUserId: bl.waiting_on_user_id, hasNote: !!note } });
  return { nudge: row, nextAllowedOn: DateTime.fromISO(today).plus({ days: 1 }).toISODate() };
}

function nudgeUnavailable(bl: any, a: Actor): string | null {
  if (!waitsOnInternal(bl))
    return 'This blocker is not waiting on a person in the app. Contact them directly, or set who it is waiting on.';
  if (bl.waiting_on_user_id === a.id) return 'This blocker is waiting on you.';
  return null;
}

// ---------- Read models ----------

/** Escalation state and history for one blocker (TaskDetail BlockerCard). */
export async function blockerEscalation(db: Db, a: Actor, blockerId: string) {
  const bl = await one(db, `${OPEN_BLOCKER_SQL} where b.id = $1`, [blockerId]);
  if (!bl) throw notFound('Blocker not found');
  const task = await loadVisibleTask(db, a, bl.task_id);
  const p = await loadPolicy(db, a.tenantId);
  const assessed = bl.resolved_at ? null : (await assessRows(db, [bl], p))[0];
  const [esc, nudges] = await Promise.all([
    many(db, `select e.*, (select coalesce(array_agg(u.name order by u.name), '{}') from users u where u.id = any(e.recipient_ids)) recipient_names
      from blocker_escalations e where e.blocker_id = $1`, [bl.id]),
    many(db, `select n.*, u.name actor_name, w.name notified_name from blocker_nudges n join users u on u.id = n.actor_id left join users w on w.id = n.notified_user_id
      where n.blocker_id = $1`, [bl.id]),
  ]);
  const history = [
    ...esc.map((e) => ({ id: e.id, type: 'escalation' as const, level: e.level, outcome: e.outcome, note: e.note, workingDays: e.working_days,
      followUpDate: e.follow_up_date, recipients: e.recipient_names, at: e.created_at })),
    ...nudges.map((n) => ({ id: n.id, type: 'nudge' as const, actor: n.actor_name, recipients: n.notified_name ? [n.notified_name] : [], note: n.note, at: n.created_at })),
  ].sort((x, y) => +new Date(y.at) - +new Date(x.at));
  const contributor = isStaff(a) && !bl.resolved_at && (await canContribute(db, a, task));
  const nudgedToday = nudges.some((n) => n.actor_id === a.id && n.nudged_on === localToday(a.timezone));
  const unavailable = contributor ? nudgeUnavailable(bl, a) : 'Only people working on this task can nudge';
  return {
    blockerId: bl.id, resolved: !!bl.resolved_at,
    policy: { enabled: p.enabled, steps: ladder(p), remindOwner: p.remindOwner, quietWhenOwnerOnLeave: p.quietWhenOwnerOnLeave },
    ageWorkingDays: assessed?.a.ageWorkingDays ?? null, raisedOn: assessed?.a.raisedOn ?? null,
    currentLevel: [...LEVELS].reverse().find((l) => esc.some((e) => e.level === l && e.outcome === 'notified')) ?? null,
    next: p.enabled ? assessed?.a.next ?? null : null,
    waitingOn: bl.waiting_on_name || bl.waiting_on_text || null,
    nudge: { allowed: !bl.resolved_at && !unavailable && !nudgedToday, nudgedToday, reason: bl.resolved_at ? 'Resolved' : unavailable },
    history,
  };
}

/** Blocker-aging list scoped by role: team managers see their team (and themselves); routine/system admins see the company. */
export async function blockerAging(db: Db, a: Actor) {
  const company = has(a, 'routine_admin') || has(a, 'system_admin');
  if (!isStaff(a) || (!company && !a.managedUserIds.length)) throw forbidden('The blocker-aging view is for team managers and admins');
  const hideFounders = a.tenantSettings.founders_visible_to_routine_admin === false && !a.isFounder;
  // Founder hiding narrows the company scope only; a manager always sees their own team (as in canViewPersonRecords).
  const rows = await many(db, `${OPEN_BLOCKER_SQL} where b.resolved_at is null and t.status not in ('done','cancelled')
    and ($1::boolean or t.owner_id = any($2::uuid[])) and ($3::boolean = false or o.is_founder = false or t.owner_id = any($2::uuid[]))
    order by b.raised_at`, [company, [a.id, ...a.managedUserIds], hideFounders]);
  const p = await loadPolicy(db, a.tenantId);
  const nudges = rows.length ? await many(db, `select blocker_id, count(*)::int n, max(created_at) last_at from blocker_nudges where blocker_id = any($1::uuid[]) group by blocker_id`,
    [rows.map((r) => r.id)]) : [];
  const nmap = new Map(nudges.map((n) => [n.blocker_id, n]));
  const items = (await assessRows(db, rows, p)).map(({ row: r, a: s }) => ({
    blockerId: r.id, taskId: r.task_id, taskNumber: r.task_number, taskTitle: r.task_title, ownerId: r.owner_id, ownerName: r.owner_name,
    cause: r.cause, reason: r.reason, waitingOn: r.waiting_on_name || r.waiting_on_text || null, waitingOnInternal: waitsOnInternal(r),
    raisedAt: r.raised_at, raisedOn: s.raisedOn, ageWorkingDays: s.ageWorkingDays, level: s.currentLevel, nextFollowUp: r.next_follow_up,
    nextEscalation: p.enabled ? s.next : null, nudges: nmap.get(r.id)?.n ?? 0, lastNudgeAt: nmap.get(r.id)?.last_at ?? null,
  }));
  const ages = items.map((i) => i.ageWorkingDays).sort((x, y) => x - y);
  const median = ages.length ? (ages.length % 2 ? ages[(ages.length - 1) / 2] : (ages[ages.length / 2 - 1] + ages[ages.length / 2]) / 2) : null;
  return {
    scope: company ? 'company' : 'team', policy: { enabled: p.enabled, steps: ladder(p) },
    summary: {
      open: items.length, medianAgeWorkingDays: median,
      escalated: items.filter((i) => i.level === 'manager' || i.level === 'admin').length,
      external: items.filter((i) => !i.waitingOnInternal && i.waitingOn).length,
    },
    items,
  };
}
