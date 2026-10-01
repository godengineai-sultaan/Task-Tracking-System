import type { SeedCtx } from './types.js';

/** Fictional DEMO fixtures for the 'whatif' feature area: saved what-if scenarios (hypothetical changes only). */
export default async function seed(ctx: SeedCtx) {
  const { ins, q1, U, today } = ctx;
  const d = (x: typeof today) => x.toISODate()!;
  // Rahul's next open task that is not yet overdue: the one a two-week absence would push past its due date.
  const rahulTask = await q1(`select id from tasks where tenant_id = $1 and owner_id = $2 and status not in ('done','cancelled','backlog','in_review')
    and due_date >= $3 order by due_date, number limit 1`, [ctx.T, U.rahul, d(today)]);
  const leave = { type: 'leave', userId: U.rahul, start: d(today), end: d(today.plus({ days: 13 })) };
  const scenarios: { by: string; name: string; horizon: number; people: string[]; changes: object[] }[] = [
    { by: 'priya', name: 'Rahul away for two weeks (DEMO)', horizon: 14, people: [U.priya, U.rahul, U.sara], changes: [leave] },
    { by: 'priya', name: 'Rahul away, Sara covers his next task (DEMO)', horizon: 14, people: [U.priya, U.rahul, U.sara],
      changes: [leave, ...(rahulTask ? [{ type: 'reassign', taskId: rahulTask.id, toUserId: U.sara }] : [])] },
    { by: 'asha', name: 'Kabir focuses on the Globex renewal (DEMO)', horizon: 28, people: [U.kabir, U.vikram], changes: [
      { type: 'allocation', userId: U.kabir, percent: 60 },
      { type: 'add_task', ownerId: U.kabir, title: 'Globex renewal: pricing annex', estimateMinutes: 360, dueDate: d(today.plus({ days: 9 })), priority: 'high' }] },
  ];
  for (const s of scenarios)
    await ins('whatif_scenarios', { name: s.name, horizon_days: s.horizon, people: s.people, changes: JSON.stringify(s.changes), unestimated_minutes: 60, created_by: U[s.by] });
}
