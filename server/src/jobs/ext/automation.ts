import { registerJob } from '../../lib/jobs.js';
import { log } from '../../lib/log.js';
import { onTaskEvent } from '../../services/events.js';
import { handleTaskEvent, runTimeTriggers } from '../../services/ext/automation.js';
import { registerTenantTick } from '../index.js';

/** Background jobs, tenant ticks and task-event listeners for the 'automation' feature area. */
export default function register() {
  // Event-triggered rules run inside the change's transaction; each rule is savepoint-isolated, so a rule error never fails the change.
  onTaskEvent(async (db, ev) => {
    try { await handleTaskEvent(db, ev); } catch (e: any) { log.error({ type: ev.type, err: e?.message }, 'automation listener failed'); }
  });
  // Time-based rules (due soon / overdue): hourly per tenant, at most once per rule, task and due date.
  registerTenantTick('automation.time_rules');
  registerJob('automation.time_rules', async (db, _p, job) => { await runTimeTriggers(db, job.tenantId!); });
}
