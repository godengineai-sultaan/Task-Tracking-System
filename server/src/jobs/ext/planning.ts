import { registerJob } from '../../lib/jobs.js';
import { registerTenantTick } from '../index.js';
import { nudgeUser, runNudges } from '../../services/ext/planning.js';

/** Background jobs, tenant ticks and task-event listeners for the 'planning' feature area. */
export default function register() {
  // Hourly per tenant: send open nudges and schedule the ones whose window opens before the next tick.
  registerTenantTick('planning.nudges');
  registerJob('planning.nudges', async (db, _p, job) => { await runNudges(db, job.tenantId!); });
  registerJob('planning.nudge', async (db, p, job) => { await nudgeUser(db, job.tenantId!, p.userId, p.kind, p.date); });
}
