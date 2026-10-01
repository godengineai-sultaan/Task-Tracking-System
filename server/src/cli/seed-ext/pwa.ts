import { DateTime } from 'luxon';
import type { SeedCtx } from './types.js';

/** Fictional DEMO fixtures for the 'pwa' feature area: captures made on a phone while offline, synced later. */
export default async function seed(ctx: SeedCtx) {
  const { ins, U, P, today } = ctx;
  const captures = [
    { owner: 'kabir', title: 'Photograph damaged pallet labels for the freight claim', project: 'OPS', est: 20, capturedDaysAgo: 1, hour: 18, minute: 40 },
    { owner: 'rahul', title: 'Ask courier for revised pickup slot', project: 'OPS', est: 15, capturedDaysAgo: 2, hour: 8, minute: 5 },
  ];
  for (const [i, c] of captures.entries()) {
    const capturedAt = today.minus({ days: c.capturedDaysAgo }).set({ hour: c.hour, minute: c.minute });
    const synced = capturedAt.plus({ hours: 13, minutes: 12 }); const now = DateTime.now().setZone(ctx.TZ);
    const syncedAt = synced > now ? now : synced; // never created in the future when the demo is seeded early in the morning
    const t = await ins('tasks', {
      project_id: P[c.project]?.id ?? null, title: c.title, owner_id: U[c.owner], created_by: U[c.owner], status: 'planned', priority: 'medium',
      category: 'operations', due_date: capturedAt.plus({ days: 1 }).toISODate(), estimate_minutes: c.est, tags: [], acceptance_criteria: '',
      source_type: 'quick_capture', source_ref: { channel: 'offline_outbox', capturedAt: capturedAt.toUTC().toISO() },
      client_request_id: `demo-offline-capture-${i + 1}`, created_at: syncedAt.toJSDate(), updated_at: syncedAt.toJSDate(), sort_order: syncedAt.toSeconds(),
    });
    await ins('task_state_history', { task_id: t.id, from_status: null, to_status: 'planned', actor_id: U[c.owner], reason: 'Created (quick_capture, synced from offline outbox) (DEMO fixture)', at: syncedAt.toJSDate() });
  }
}
