import { DateTime } from 'luxon';
import type { SeedCtx } from './types.js';
import type { CalendarData } from '../../services/calendar.js';
import { dateAfterWorkingDays, workingDaysBetween } from '../../services/ext/escalation.js';

/** Fictional DEMO fixtures for the 'escalation' feature area: an enabled policy and blockers at different rungs of the ladder. */
export default async function seed(ctx: SeedCtx) {
  const { q, ins, T, U, P, today, TZ } = ctx;
  const todayIso = today.toISODate()!;
  const now = DateTime.now().setZone(TZ);
  await q(`update tenants set settings = jsonb_set(settings, '{escalation}', $2::jsonb, true) where id = $1`, [T, JSON.stringify({
    enabled: true, remindOwner: true, waitingOnAfterDays: 2, managerAfterDays: 4, adminAfterDays: 7, quietWhenOwnerOnLeave: true,
    version: 1, updatedAt: today.minus({ days: 12 }).set({ hour: 11 }).toISO(), updatedBy: U.asha,
  })]);

  // Owner role bypasses RLS: every query filters by tenant explicitly.
  const calendar = async (userId: string): Promise<CalendarData> => {
    const own = await q(`select * from work_schedules where tenant_id = $1 and user_id = $2`, [T, userId]);
    const rows = own.length ? own : await q(`select * from work_schedules where tenant_id = $1 and user_id is null`, [T]);
    const holidays = await q(`select to_char(date, 'YYYY-MM-DD') date, name from holidays where tenant_id = $1`, [T]);
    const leave = await q(`select to_char(start_date, 'YYYY-MM-DD') start_date, to_char(end_date, 'YYYY-MM-DD') end_date, portion, kind
      from leave_entries where tenant_id = $1 and user_id = $2`, [T, userId]);
    return { timezone: TZ, schedule: new Map(rows.map((r) => [r.weekday, r])), holidays: new Map(holidays.map((h) => [h.date, h.name])), leave };
  };
  const at = (date: string, hhmm: string) => {
    const t = DateTime.fromISO(`${date}T${hhmm}`, { zone: TZ });
    return (t > now ? now.minus({ minutes: 20 }) : t).toJSDate();
  };

  type Spec = { owner: string; project: string; title: string; cat: string; age: number; cause: string; reason: string; waitingOn?: string; waitingText?: string;
    followUp?: string | null; fired: { level: string; day: number; skipped?: string }[]; nudge?: { day: number; note: string } };
  const nextWorkday = (() => { let d = today.plus({ days: 1 }); while (d.weekday > 5) d = d.plus({ days: 1 }); return d.toISODate()!; })();
  const specs: Spec[] = [
    { owner: 'rahul', project: 'WEB', title: 'Verify courier webhook signatures', cat: 'delivery', age: 5, cause: 'access', waitingOn: 'dev',
      reason: 'Need the courier sandbox signing secret from Operations', fired: [{ level: 'owner', day: 1 }, { level: 'waiting_on', day: 2 }, { level: 'manager', day: 4 }],
      nudge: { day: 3, note: 'Could you share the sandbox secret before stand-up?' } },
    { owner: 'sara', project: 'WEB', title: 'Refund policy copy for tracking page', cat: 'delivery', age: 3, cause: 'client', waitingText: 'Globex legal team',
      reason: 'Waiting for Globex legal to approve the refund wording', followUp: nextWorkday,
      fired: [{ level: 'owner', day: 1 }, { level: 'waiting_on', day: 2, skipped: 'Waiting on someone outside the team (Globex legal team); no one to notify in the app' }] },
    { owner: 'meera', project: 'FIN', title: 'Chase missing vendor statement for September close', cat: 'finance', age: 8, cause: 'dependency', waitingOn: 'dev',
      reason: 'Courier vendor statement not received; Operations owns the vendor contact',
      fired: [{ level: 'owner', day: 1 }, { level: 'waiting_on', day: 2 }, { level: 'manager', day: 4 }, { level: 'admin', day: 7 }] },
    { owner: 'kabir', project: 'SALES', title: 'Renewal pricing sheet for Globex', cat: 'sales', age: 1, cause: 'requirement', waitingOn: 'vikram',
      reason: 'Need discount guardrails confirmed before sharing pricing', followUp: nextWorkday, fired: [] },
  ];
  const names = Object.fromEntries((await q(`select id, name from users where tenant_id = $1`, [T])).map((u) => [u.id, u.name]));
  const managerOf = async (userId: string) => (await q(`select distinct t.manager_id from teams t join team_members tm on tm.team_id = t.id
    where t.tenant_id = $1 and tm.user_id = $2 and t.manager_id <> $2`, [T, userId])).map((r) => r.manager_id as string);
  const admins = (await q(`select id from users where tenant_id = $1 and 'routine_admin' = any(roles) and status = 'active'`, [T])).map((r) => r.id as string);

  for (const s of specs) {
    const cal = await calendar(U[s.owner]);
    let raised = today;
    for (let i = 0; i < 60 && workingDaysBetween(cal, raised.toISODate()!, todayIso, true) < s.age; i++) raised = raised.minus({ days: 1 });
    const raisedOn = raised.toISODate()!;
    const created = DateTime.fromISO(`${raisedOn}T09:40`, { zone: TZ }).minus({ days: 2 }).toJSDate();
    const raisedAt = at(raisedOn, '11:15');
    const t = await ins('tasks', { project_id: P[s.project].id, title: s.title, owner_id: U[s.owner], created_by: U[s.owner], status: 'blocked', priority: 'high',
      category: s.cat, due_date: today.plus({ days: 4 }).toISODate(), estimate_minutes: 120, started_at: created, created_at: created, updated_at: raisedAt,
      sort_order: DateTime.fromJSDate(created).toSeconds() });
    await ins('task_state_history', { task_id: t.id, from_status: null, to_status: 'planned', actor_id: U[s.owner], reason: 'Created (DEMO fixture)', at: created });
    await ins('task_state_history', { task_id: t.id, from_status: 'planned', to_status: 'in_progress', actor_id: U[s.owner], reason: null, at: created });
    await ins('task_state_history', { task_id: t.id, from_status: 'in_progress', to_status: 'blocked', actor_id: U[s.owner], reason: s.reason, at: raisedAt });
    const b = await ins('blockers', { task_id: t.id, reason: s.reason, cause: s.cause, waiting_on_user_id: s.waitingOn ? U[s.waitingOn] : null,
      waiting_on_text: s.waitingText ?? '', next_follow_up: s.followUp ?? null, raised_by: U[s.owner], raised_at: raisedAt });
    const link = `/tasks/${t.id}`;
    for (const f of s.fired) {
      const day = dateAfterWorkingDays(cal, raisedOn, f.day, true)!;
      const when = at(day, '10:05');
      const recipients = f.skipped ? [] : f.level === 'owner' ? [U[s.owner]] : f.level === 'waiting_on' ? [U[s.waitingOn!]] : f.level === 'manager' ? await managerOf(U[s.owner]) : admins.filter((id) => id !== U[s.owner]);
      await ins('blocker_escalations', { blocker_id: b.id, level: f.level, working_days: f.day, outcome: f.skipped ? 'skipped' : 'notified', note: f.skipped ?? '',
        notified_user_id: recipients[0] ?? null, recipient_ids: recipients, created_at: when });
      const owner = names[U[s.owner]];
      const facts = `Blocked for ${f.day} working day${f.day === 1 ? '' : 's'} (weekends, holidays and leave not counted). Reason: ${s.reason}`;
      for (const r of recipients) {
        const [kind, title] = f.level === 'owner' ? ['blocker_reminder', `Follow up on blocker: ${s.title}`] : f.level === 'waiting_on' ? ['blocker_escalation', `${owner} is still waiting on you`]
          : f.level === 'manager' ? ['blocker_escalation', `Blocker may need your help: ${s.title}`] : ['blocker_escalation', `Long-running blocker: ${s.title}`];
        await ins('notifications', { user_id: r, kind, title, body: f.level === 'owner' || f.level === 'waiting_on' ? `"${s.title}": ${facts}` : `${owner}'s task. ${facts}`, link, created_at: when });
      }
    }
    if (s.nudge && s.waitingOn) {
      const day = dateAfterWorkingDays(cal, raisedOn, s.nudge.day, true)!;
      await ins('blocker_nudges', { blocker_id: b.id, actor_id: U[s.owner], notified_user_id: U[s.waitingOn], nudged_on: day, note: s.nudge.note, created_at: at(day, '15:30') });
      await ins('notifications', { user_id: U[s.waitingOn], kind: 'blocker_nudge', title: `${names[U[s.owner]]} nudged you about a blocker`,
        body: `"${s.title}" is waiting on you. ${s.reason} Note: ${s.nudge.note}`, link, created_at: at(day, '15:30') });
    }
  }
}
