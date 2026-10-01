import { DateTime } from 'luxon';
import { many, one } from '../lib/db.js';
import { enqueue, registerJob } from '../lib/jobs.js';
import { generateExport } from '../services/exports.js';
import { processEvent } from '../services/integrations.js';
import { snapshotReport } from '../services/myday.js';
import { generateRecurring } from '../services/tasks.js';
import { notify } from '../services/notify.js';
import { readPolicy } from '../services/ext/escalation.js';
import { audit } from '../lib/audit.js';
import { registerExtJobs } from './ext/index.js';

/** Extension point: per-tenant job kinds enqueued once per hour by the scheduler (idempotent per hour). */
const tenantTicks: string[] = [];
export function registerTenantTick(kind: string) { if (!tenantTicks.includes(kind)) tenantTicks.push(kind); }

export function registerJobs() {
  registerExtJobs();
  registerJob('report.snapshot', async (db, p, job) => { await snapshotReport(db, job.tenantId!, p.userId, p.date, p.reason); });
  registerJob('export.generate', async (db, p) => { await generateExport(db, p.exportId); });
  registerJob('integration.process', async (db, p) => { await processEvent(db, p.eventId); });
  registerJob('recurring.generate', async (db, _p, job) => {
    const t = await one(db, `select timezone from tenants where id = $1`, [job.tenantId]);
    const through = DateTime.now().setZone(t.timezone).plus({ days: 1 }).toISODate()!;
    await generateRecurring(db, job.tenantId!, through);
  });
  // Blocker reminders: open blockers whose follow-up date has arrived. Idempotent per blocker per day.
  registerJob('blockers.remind', async (db, _p, job) => {
    const t = await one(db, `select timezone, settings from tenants where id = $1`, [job.tenantId]);
    // Smart escalation (jobs/ext/escalation.ts) owns owner follow-up reminders when enabled: do not remind twice.
    if (readPolicy(t.settings).enabled) return;
    const today = DateTime.now().setZone(t.timezone).toISODate()!;
    const due = await many(db, `select b.id, b.reason, t.id task_id, t.title, t.owner_id from blockers b join tasks t on t.id = b.task_id
      where b.resolved_at is null and (b.next_follow_up is null and b.raised_at < now() - interval '1 day' or b.next_follow_up <= $1)
      and not exists (select 1 from notifications n where n.user_id = t.owner_id and n.kind = 'blocker_reminder' and n.link = '/tasks/' || t.id and n.created_at::date = $1::date)`, [today]);
    for (const b of due) await notify(db, job.tenantId!, b.owner_id, 'blocker_reminder', `Follow up on blocker: ${b.title}`, b.reason, `/tasks/${b.task_id}`);
  });
  // Retention: remove expired sessions-independent data per tenant policy. Audit rows are purged only through the guarded path.
  registerJob('retention.purge', async (db, _p, job) => {
    const t = await one(db, `select settings from tenants where id = $1`, [job.tenantId]);
    const days = Number(t.settings?.retention_days ?? 730);
    const r1 = await db.query(`delete from ux_timings where created_at < now() - ($1 || ' days')::interval`, [String(days)]);
    const r2 = await db.query(`delete from notifications where created_at < now() - ($1 || ' days')::interval`, [String(Math.min(days, 180))]);
    const r3 = await db.query(`delete from integration_events where received_at < now() - ($1 || ' days')::interval and status in ('ignored','duplicate','rejected')`, [String(days)]);
    await audit(db, { tenantId: job.tenantId!, actorId: null, action: 'retention.purge', resourceType: 'tenant', resourceId: job.tenantId!,
      details: { retentionDays: days, uxTimings: r1.rowCount, notifications: r2.rowCount, integrationEvents: r3.rowCount } });
  });
  // Scheduler tick (system job): enqueue per-tenant periodic work once per hour, idempotent by hour key.
  registerJob('scheduler.tick', async (db) => {
    const hour = new Date().toISOString().slice(0, 13);
    const tenants = await many(db, `select id from tenants where status = 'active'`);
    for (const t of tenants) {
      await enqueue(db, { tenantId: t.id, kind: 'recurring.generate', payload: {}, idempotencyKey: `recurring:${t.id}:${hour}` });
      await enqueue(db, { tenantId: t.id, kind: 'blockers.remind', payload: {}, idempotencyKey: `remind:${t.id}:${hour}` });
      for (const kind of tenantTicks) await enqueue(db, { tenantId: t.id, kind, payload: {}, idempotencyKey: `${kind}:${t.id}:${hour}` });
    }
    await db.query(`delete from sessions where expires_at < now()`);
  });
}

export async function scheduleTick(db: any) {
  const hour = new Date().toISOString().slice(0, 13);
  await enqueue(db, { tenantId: null, kind: 'scheduler.tick', payload: {}, idempotencyKey: `tick:${hour}` });
}
