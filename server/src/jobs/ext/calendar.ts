import { enqueue, registerJob } from '../../lib/jobs.js';
import { registerTenantTick } from '../index.js';
import { dueSubscriptions, syncSubscription } from '../../services/ext/calendar.js';

/** Background jobs, tenant ticks and task-event listeners for the 'calendar' feature area. */
export default function register() {
  // Hourly per tenant: one sync job per due ICS subscription (idempotent per subscription per hour).
  registerTenantTick('calendar.subscriptions.tick');
  registerJob('calendar.subscriptions.tick', async (db, _p, job) => {
    const hour = new Date().toISOString().slice(0, 13);
    for (const s of await dueSubscriptions(db))
      await enqueue(db, { tenantId: job.tenantId, kind: 'calendar.subscription.sync', payload: { subscriptionId: s.id }, idempotencyKey: `calsub:${s.id}:${hour}`, maxAttempts: 1 });
    // Unconfirmed holiday previews are only needed between preview and confirm (confirm expires after 24 hours).
    await db.query(`delete from holiday_imports where status = 'preview' and created_at < now() - interval '7 days'`);
  });
  registerJob('calendar.subscription.sync', async (db, p) => { await syncSubscription(db, p.subscriptionId, 'schedule'); });
}
