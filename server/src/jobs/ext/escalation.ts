import { registerJob } from '../../lib/jobs.js';
import { registerTenantTick } from '../index.js';
import { runEscalation } from '../../services/ext/escalation.js';

/** Background jobs, tenant ticks and task-event listeners for the 'escalation' feature area. */
export default function register() {
  // Hourly per tenant; does nothing unless the tenant enabled the policy. Each level fires once per blocker.
  registerJob('escalation.evaluate', async (db, _p, job) => { await runEscalation(db, job.tenantId!); });
  registerTenantTick('escalation.evaluate');
}
