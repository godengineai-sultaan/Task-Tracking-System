import { registerJob } from '../../lib/jobs.js';
import { registerTenantTick } from '../index.js';
import { createWeeklyDrafts } from '../../services/ext/clientbrand.js';

/** Background jobs for the 'clientbrand' feature area. */
export default function register() {
  // Optional (tenant setting): prepare weekly client update drafts on Fridays. Never publishes; idempotent per project + week.
  registerJob('clientbrand.weekly', async (db, _p, job) => { await createWeeklyDrafts(db, job.tenantId!); });
  registerTenantTick('clientbrand.weekly');
}
