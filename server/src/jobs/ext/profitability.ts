import { registerJob } from '../../lib/jobs.js';
import { registerTenantTick } from '../index.js';
import { ALERT_JOB, checkBudgetAlerts } from '../../services/ext/profitability.js';

/** Background jobs, tenant ticks and task-event listeners for the 'profitability' feature area. */
export default function register() {
  // Hourly per tenant (and right after a budget is saved): threshold and forecast alerts, idempotent per threshold.
  registerJob(ALERT_JOB, async (db, p, job) => { await checkBudgetAlerts(db, job.tenantId!, p?.projectId); });
  registerTenantTick(ALERT_JOB);
}
