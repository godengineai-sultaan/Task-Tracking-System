import { DateTime } from 'luxon';
import type { SeedCtx } from './types.js';

/** Fictional DEMO fixtures for the 'planning' feature area. */
export default async function seed({ ins, q, T, U, tasks, today, TZ }: SeedCtx) {
  // Reminder preferences: Kabir confirms recaps from client visits and turned that reminder off; Asha plans before work starts.
  await ins('planning_preferences', { user_id: U.kabir, plan_nudge: true, recap_nudge: false });
  await ins('planning_preferences', { user_id: U.asha, plan_nudge: false, recap_nudge: true });

  // Open work waiting on another open task, so "Suggest my day" shows a dependency exclusion with its reason.
  const open = (owner: string, title: string) => tasks.find((t) => t.spec.owner === owner && t.spec.title === title && !['done', 'cancelled'].includes(t.status));
  for (const [owner, task, dependsOn] of [
    ['vikram', 'Board update: Q3 commercial summary', 'Negotiate Initech master agreement'],
    ['sara', 'Notification preferences screen', 'Design tokens for portal theme'],
  ]) {
    const t = open(owner, task), dep = open(owner, dependsOn);
    if (t && dep) await q(`insert into task_dependencies (tenant_id, task_id, depends_on_task_id) values ($1,$2,$3) on conflict do nothing`, [T, t.id, dep.id]);
  }

  // Routine nudges already sent (in-app only), each with its once-per-day idempotency record.
  let last = today.minus({ days: 1 });
  while (last.weekday > 5 || last.toISODate() === '2026-10-02') last = last.minus({ days: 1 }); // never on a weekend or the seeded holiday
  const now = DateTime.now().setZone(TZ);
  const sent: { k: string; kind: 'plan' | 'recap'; day: DateTime; at: DateTime; read: boolean }[] = [
    { k: 'dev', kind: 'recap', day: last, at: last.set({ hour: 17, minute: 15 }), read: true },
    { k: 'priya', kind: 'recap', day: last, at: last.set({ hour: 17, minute: 15 }), read: true },
  ];
  // Sara (Mon-Thu, 10:00-18:00) has not planned today yet: after 10:15 on her working day she has the plan reminder.
  const saraStart = today.set({ hour: 10, minute: 15 });
  if (today.weekday <= 4 && today.toISODate() !== '2026-10-02' && now >= saraStart) sent.push({ k: 'sara', kind: 'plan', day: today, at: saraStart, read: false });
  for (const s of sent) {
    await ins('notifications', {
      user_id: U[s.k], kind: s.kind === 'plan' ? 'planning_plan_nudge' : 'planning_recap_nudge',
      title: s.kind === 'plan' ? 'Plan your day' : 'Confirm your recap',
      body: s.kind === 'plan' ? 'Choose up to three intended outcomes for today. "Suggest my day" on My Day can propose them, with reasons.'
        : 'Your scheduled day ends soon. Review the suggested summary and confirm your recap; it takes about a minute.',
      link: s.kind === 'plan' ? '/' : '/recap', created_at: s.at.toJSDate(), read_at: s.read ? s.at.plus({ minutes: 20 }).toJSDate() : null,
    });
    await ins('planning_nudges', { user_id: U[s.k], date: s.day.toISODate(), kind: s.kind, sent_at: s.at.toJSDate() });
  }
}
