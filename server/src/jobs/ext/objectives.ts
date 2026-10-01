import { registerJob } from '../../lib/jobs.js';
import { registerTenantTick } from '../index.js';
import { evaluateWeeklyStatuses } from '../../services/ext/objectives.js';

/** Background jobs, tenant ticks and task-event listeners for the 'objectives' feature area. */
export default function register() {
  // Enqueued hourly per tenant by the scheduler; the per-ISO-week unique snapshot makes it a weekly evaluation.
  registerTenantTick('objectives.weekly_status');
  registerJob('objectives.weekly_status', async (db, payload, job) => {
    const key = typeof payload?.periodKey === 'string' && /^[\w-]{1,40}$/.test(payload.periodKey) ? payload.periodKey : undefined;
    await evaluateWeeklyStatuses(db, job.tenantId!, key);
  });
}
