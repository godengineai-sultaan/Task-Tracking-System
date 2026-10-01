import type { SeedCtx } from './types.js';
import { evaluateWeeklyStatuses } from '../../services/ext/objectives.js';

/** Fictional DEMO fixtures for the 'objectives' feature area. */
export default async function seed(ctx: SeedCtx) {
  const { c, ins, T, U, P, M, today } = ctx;
  const d = (n: number) => today.plus({ days: n });
  const at = (n: number, h = 17) => d(n).set({ hour: h, minute: 30 }).toJSDate();
  const portal = M.web1.objective_id as string;
  const books = M.fin1.objective_id as string;

  // Key results on the core objectives
  await ins('objective_key_results', { objective_id: portal, title: 'Order tracking beta and client UAT signed off', kind: 'milestone_completion', milestone_ids: [M.web1.id, M.web2.id], position: 0, created_by: U.asha, updated_by: U.asha });
  await ins('objective_key_results', { objective_id: portal, title: 'Globex pilot users onboarded to portal v2', kind: 'manual', target_value: 25, current_value: 9, unit: 'users', position: 1, created_by: U.asha, updated_by: U.asha, updated_at: at(-3) });
  await ins('objective_key_results', { objective_id: books, title: 'Balance-sheet accounts reconciled and signed off', kind: 'manual', target_value: 6, current_value: 2, unit: 'accounts', position: 0, created_by: U.vikram, updated_by: U.meera, updated_at: at(-1) });
  await ins('objective_key_results', { objective_id: books, title: 'Close tasks accepted', kind: 'task_completion', milestone_ids: [M.fin1.id], position: 1, created_by: U.vikram, updated_by: U.vikram });

  // An objective with relative dates so the early warning stays meaningful whenever the demo is seeded
  const joiners = await ins('objectives', { title: 'Every October joiner productive on day one', description: 'Laptops, accounts and seating ready before each start date. (DEMO fixture)',
    owner_id: U.dev, period_start: d(-35).toISODate(), period_end: d(20).toISODate(), created_at: at(-36) });
  await c.query(`update milestones set objective_id = $1 where id = $2`, [joiners.id, M.ops1.id]);
  for (const [title, est, due] of [['Image laptops for October joiners', 90, 6], ['Seat plan and desk setup for joiners', 60, 8]] as [string, number, number][]) {
    const t = await ins('tasks', { project_id: P.OPS.id, milestone_id: M.ops1.id, title, owner_id: U.dev, created_by: U.dev, status: 'planned', priority: 'medium', category: 'operations',
      due_date: d(due).toISODate(), estimate_minutes: est, created_at: at(-5, 10), updated_at: at(-5, 10) });
    await ins('task_state_history', { task_id: t.id, from_status: null, to_status: 'planned', actor_id: U.dev, reason: 'Created (DEMO fixture)', at: at(-5, 10) });
  }
  await ins('objective_key_results', { objective_id: joiners.id, title: 'Joiners with a working laptop on day one', kind: 'manual', target_value: 6, current_value: 2, unit: 'joiners', position: 0, created_by: U.asha, updated_by: U.dev });
  await ins('objective_key_results', { objective_id: joiners.id, title: 'Procurement tasks accepted', kind: 'task_completion', project_ids: [P.OPS.id], position: 1, created_by: U.asha, updated_by: U.asha });

  // No end date yet: shows "insufficient data" with the reason instead of a guess
  const pipeline = await ins('objectives', { title: 'Two enterprise contracts signed this year', description: 'Initech and one more enterprise logo. (DEMO fixture)', owner_id: U.vikram,
    period_start: d(-20).toISODate(), created_at: at(-21) });
  await ins('objective_key_results', { objective_id: pipeline.id, title: 'Enterprise contracts signed', kind: 'manual', target_value: 2, current_value: 0, unit: 'contracts', position: 0, created_by: U.vikram, updated_by: U.vikram });

  // A closed objective for the "Closed" filter
  await ins('objectives', { title: 'Move expense claims to the new tool', description: 'Retire spreadsheet claims. (DEMO fixture)', owner_id: U.meera, status: 'achieved',
    period_start: d(-120).toISODate(), period_end: d(-40).toISODate(), created_at: at(-121) });

  // Check-ins (owner confidence over time)
  for (const [obj, who, days, conf, note] of [
    [portal, 'asha', -27, 4, 'Scope agreed with Globex; API work started.'],
    [portal, 'asha', -20, 4, 'Order status endpoint in review.'],
    [portal, 'asha', -13, 3, 'Timezone bug in delivery estimates is slowing the beta.'],
    [portal, 'asha', -6, 3, 'Beta date holds if the tracking page lands this week.'],
    [books, 'vikram', -1, 2, 'Bank statements for two accounts are still missing.'],
    [joiners.id, 'dev', -14, 4, 'Vendor confirmed laptop stock.'],
    [joiners.id, 'dev', -4, 3, 'Two joiners moved their start date earlier.'],
    [pipeline.id, 'vikram', -2, 3, 'Initech legal review in progress.'],
  ] as [string, string, number, number, string][]) {
    await ins('objective_checkins', { objective_id: obj, author_id: U[who], confidence: conf, note, created_at: at(days, 11) });
  }

  // Real current-week snapshot from the same logic the weekly tick uses (notifies owners of at-risk/off-track objectives).
  await evaluateWeeklyStatuses(c as any, T);
}
