import { DateTime } from 'luxon';
import type { SeedCtx } from './types.js';

/** Fictional DEMO fixtures for the 'teamreview' feature area: a few weekly reviews, one with a follow-up task, some with responses. */
export default async function seed(ctx: SeedCtx) {
  const { ins, c, U, P, today } = ctx;
  const now = DateTime.now().setZone(ctx.TZ);
  const at = (d: DateTime) => (d < now ? d : now).toJSDate();
  const lastWeek = today.minus({ days: 7 }).startOf('week');
  const twoWeeks = today.minus({ days: 14 }).startOf('week');
  const reviewedAt = lastWeek.plus({ days: 7, hours: 10 }); // Monday morning after the week
  const link = (w: DateTime) => `/team-review?tab=mine&week=${w.toISODate()}`;

  const review = async (reviewer: string, subject: string, week: DateTime, status: string, note: string, response?: string, version = 1) => {
    const created = week.plus({ days: 7, hours: 10, minutes: Math.floor(note.length % 50) });
    return ins('weekly_reviews', { reviewer_id: U[reviewer], subject_user_id: U[subject], week_start: week.toISODate(), status, note,
      employee_response: response ?? '', employee_responded_at: response ? at(created.plus({ hours: 2 })) : null,
      version: response ? version + 1 : version, created_at: at(created), updated_at: at(created) });
  };

  // Two weeks ago: reviewed and closed out.
  await review('priya', 'rahul', twoWeeks, 'acknowledged', 'Solid progress on the order status API. Thanks for writing up the retry edge cases.',
    'Thanks. The load test is next on my list.');
  await review('asha', 'priya', twoWeeks, 'discussed', 'Talked through hiring pipeline and the checkout incident review. No changes needed.');
  await review('asha', 'kabir', twoWeeks, 'acknowledged', 'Good client follow-ups this week; the Globex proposal is on track.');

  // Last week: some reviewed, Rahul / Priya / Kabir still waiting so the workspace has work to do.
  await review('priya', 'sara', lastWeek, 'discussed',
    'We talked through the tracking page empty states and the API dependency. I will chase the backend estimate so you are not blocked again.',
    'Thanks. I will pair with Rahul on Monday to settle the status endpoint contract.', 2);
  await review('asha', 'dev', lastWeek, 'acknowledged', 'Courier comparison closed with the quotes attached as evidence. Nice work.');
  const meera = await review('asha', 'meera', lastWeek, 'needs_follow_up',
    'Two finance deliverables slipped past their due dates while waiting on vendor invoices. Let us agree a cut-off with Operations.');
  const created = reviewedAt.plus({ minutes: 5 });
  const task = await ins('tasks', { title: 'Agree vendor invoice cut-off with Operations', owner_id: U.meera, created_by: U.asha, status: 'planned', priority: 'high',
    category: 'finance', project_id: P.FIN?.id ?? null, due_date: today.plus({ days: 3 }).toISODate(), estimate_minutes: 45, source_type: 'follow_up',
    source_ref: { weekly_review_id: meera.id, week_start: lastWeek.toISODate(), reviewer_id: U.asha }, external_key: `weekly_review:${meera.id}:v1`,
    description: meera.note, created_at: at(created), updated_at: at(created), sort_order: created.toSeconds() });
  await ins('task_state_history', { task_id: task.id, from_status: null, to_status: 'planned', actor_id: U.asha, reason: 'Created (follow_up)', at: at(created) });
  await c.query(`update weekly_reviews set follow_up_task_id = $2 where id = $1`, [meera.id, task.id]);

  await ins('notifications', { user_id: U.sara, kind: 'weekly_review', title: `Priya Nair marked your week as discussed (week of ${lastWeek.toFormat('d LLL yyyy')})`,
    body: 'We talked through the tracking page empty states and the API dependency.', link: link(lastWeek), created_at: at(reviewedAt), read_at: at(reviewedAt.plus({ hours: 1 })) });
  await ins('notifications', { user_id: U.meera, kind: 'weekly_review', title: `Asha Rao asked for a follow-up on your week (week of ${lastWeek.toFormat('d LLL yyyy')})`,
    body: meera.note, link: link(lastWeek), created_at: at(created) });
  await ins('notifications', { user_id: U.priya, kind: 'weekly_review_ready', title: `Weekly team review: week of ${lastWeek.toFormat('d LLL yyyy')}`,
    body: '1 team member(s) not yet reviewed. People are listed alphabetically; nothing is ranked.', link: `/team-review?week=${lastWeek.toISODate()}`, created_at: at(reviewedAt.minus({ hours: 1 })) });
}
