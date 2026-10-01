import { DateTime } from 'luxon';
import type { SeedCtx } from './types.js';

/** Fictional DEMO fixtures for the 'automation' feature area: a few rules and a short, consistent run history. */
export default async function seed(ctx: SeedCtx) {
  const { ins, q1, U, P, today } = ctx;
  const rule = (r: Record<string, unknown>) => ins('automation_rules', {
    ...r, trigger: JSON.stringify(r.trigger), conditions: JSON.stringify(r.conditions ?? {}), actions: JSON.stringify(r.actions),
    created_by: r.owner_id, updated_by: r.owner_id, created_at: today.minus({ days: 12 }).set({ hour: 10 }).toJSDate(),
  });
  await rule({ name: 'Escalate blocked finance tasks', description: 'Close-period work cannot wait on a blocker.', scope: 'company', owner_id: U.asha,
    preset: 'escalate_blocked_finance', trigger: { type: 'task.status_changed', from: null, to: 'blocked' }, conditions: { categories: ['finance'] },
    actions: [{ type: 'notify', target: 'manager', message: 'Blocked finance task needs attention: {task.title}' },
      { type: 'add_comment', text: 'Escalated to the owner\'s manager automatically because finance work is blocked.' }] });
  const dueSoon = await rule({ name: 'Portal tasks: due-tomorrow reminder', scope: 'team', owner_id: U.priya, preset: 'due_tomorrow',
    trigger: { type: 'task.due_soon', days: 1 }, conditions: { projectIds: [P.WEB.id] }, actions: [{ type: 'notify', target: 'owner', message: 'Due {task.due}: {task.title}' }] });
  // Kept as an example but off: the core already tells the reviewer when work is submitted (automation skips them for that change too).
  await rule({ name: 'Tell the reviewer when work is submitted', scope: 'company', owner_id: U.asha, preset: 'notify_reviewer_submitted', enabled: false,
    trigger: { type: 'task.status_changed', from: null, to: 'in_review' }, conditions: {}, actions: [{ type: 'notify', target: 'reviewer', message: 'Ready for your review: {task.title}' }] });
  await rule({ name: 'Follow up when changes are requested', scope: 'company', owner_id: U.asha, preset: 'follow_up_changes_requested', enabled: false,
    trigger: { type: 'task.reviewed', decision: 'changes_requested' }, conditions: {},
    actions: [{ type: 'create_follow_up', title: 'Address review feedback: {task.title}', owner: 'owner', dueInDays: 2 }] });

  // Due-tomorrow reminders already sent the day before each recent WEB due date (dedupe keys stop the hourly tick from repeating them).
  for (const owner of ['rahul', 'sara'] as const) {
    const t = await q1(`select id, number, title, due_date::text due from tasks where tenant_id = $1 and owner_id = $2 and project_id = $3
      and due_date between $4::date - 5 and $4::date + 1 order by due_date desc limit 1`, [ctx.T, U[owner], P.WEB.id, today.toISODate()]);
    if (!t) continue;
    const name = (await q1(`select name from users where id = $1`, [U[owner]])).name;
    let sent = DateTime.fromISO(t.due, { zone: ctx.TZ }).minus({ days: 1 }).set({ hour: 9, minute: 5 });
    if (sent > DateTime.now()) sent = DateTime.now().minus({ hours: 1 });
    const title = `Due ${DateTime.fromISO(t.due).toFormat('d LLL')}: ${t.title}`;
    await ins('notifications', { user_id: U[owner], kind: 'automation', title, created_at: sent.toJSDate(),
      body: `Automation rule "Portal tasks: due-tomorrow reminder" on #${t.number} ${t.title}`, link: `/tasks/${t.id}` });
    await ins('automation_runs', { rule_id: dueSoon.id, rule_version: 1, task_id: t.id, trigger: 'task.due_soon', status: 'success', created_at: sent.toJSDate(),
      message: `Notified ${name}`, results: JSON.stringify([{ type: 'notify', status: 'done', detail: `Notified ${name}` }]), dedupe_key: `task.due_soon:${dueSoon.id}:${t.id}:${t.due}` });
  }
}

/**
 * Run history for the finance escalation rule. Runs after the escalation fixtures so it can name a finance task that really is
 * blocked, dated when its blocker was raised (the rule fires on the change to Blocked); the notification and comment really exist.
 */
export async function seedAutomationHistory(ctx: SeedCtx) {
  const { ins, q1, U } = ctx;
  const rule = await q1(`select id from automation_rules where tenant_id = $1 and preset = 'escalate_blocked_finance'`, [ctx.T]);
  const fin = rule && await q1(`select t.id, t.number, t.title, b.raised_at from tasks t join blockers b on b.task_id = t.id and b.resolved_at is null
    where t.tenant_id = $1 and t.category = 'finance' and t.status = 'blocked' order by (t.owner_id = $2) desc, b.raised_at limit 1`, [ctx.T, U.meera]);
  if (!fin) return;
  const when = new Date(new Date(fin.raised_at).getTime() + 1000);
  await ins('comments', { task_id: fin.id, author_id: null, kind: 'system', created_at: when,
    body: 'Automation · Escalate blocked finance tasks: Escalated to the owner\'s manager automatically because finance work is blocked.' });
  await ins('notifications', { user_id: U.asha, kind: 'automation', title: `Blocked finance task needs attention: ${fin.title}`, read_at: new Date(when.getTime() + 3600_000), created_at: when,
    body: `Automation rule "Escalate blocked finance tasks" on #${fin.number} ${fin.title}`, link: `/tasks/${fin.id}` });
  await ins('automation_runs', { rule_id: rule.id, rule_version: 1, task_id: fin.id, trigger: 'task.status_changed', status: 'success', created_at: when,
    message: 'Notified Asha Rao; Posted a comment', results: JSON.stringify([{ type: 'notify', status: 'done', detail: 'Notified Asha Rao' }, { type: 'add_comment', status: 'done', detail: 'Posted a comment' }]) });
}
