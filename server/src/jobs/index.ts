import { DateTime } from 'luxon';
import { many, one } from '../lib/db.js';
import { enqueue, registerJob } from '../lib/jobs.js';
import { generateExport, markExportFailed } from '../services/exports.js';
import { processEvent } from '../services/integrations.js';
import { snapshotReport } from '../services/myday.js';
import { generateRecurring } from '../services/tasks.js';
import { notify } from '../services/notify.js';
import { readPolicy } from '../services/ext/escalation.js';
import { audit } from '../lib/audit.js';
import { removeStored } from '../lib/storage.js';
import { registerExtJobs } from './ext/index.js';

/** Extension point: per-tenant job kinds enqueued once per hour by the scheduler (idempotent per hour). */
const tenantTicks: string[] = [];
export function registerTenantTick(kind: string) { if (!tenantTicks.includes(kind)) tenantTicks.push(kind); }

export function registerJobs() {
  registerExtJobs();
  registerJob('report.snapshot', async (db, p, job) => { await snapshotReport(db, job.tenantId!, p.userId, p.date, p.reason); });
  // A dead-lettered export is marked failed (with the reason) so the requester is not left with "queued" forever.
  registerJob('export.generate', async (db, p) => { await generateExport(db, p.exportId); },
    { onDead: (db, p, err) => markExportFailed(db, p.exportId, err) });
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
    // "Today" is each owner's local date, and "already reminded today" counts from that local midnight — never the database
    // session's date, which differs from the owner's around midnight.
    const due = await many(db, `with o as (select b.reason, b.raised_at, b.next_follow_up, tk.id task_id, tk.title, tk.owner_id, z.tz,
          (now() at time zone z.tz)::date today
        from blockers b join tasks tk on tk.id = b.task_id join users u on u.id = tk.owner_id
        cross join lateral (select coalesce(u.timezone, $1) tz) z where b.resolved_at is null)
      select distinct on (o.task_id) o.* from o
      where (o.next_follow_up is null and o.raised_at < now() - interval '1 day' or o.next_follow_up <= o.today)
        and not exists (select 1 from notifications n where n.user_id = o.owner_id and n.kind = 'blocker_reminder' and n.link = '/tasks/' || o.task_id
          and n.created_at >= (o.today::timestamp at time zone o.tz))
      order by o.task_id, o.raised_at desc`, [t.timezone]);
    for (const b of due) await notify(db, job.tenantId!, b.owner_id, 'blocker_reminder', `Follow up on blocker: ${b.title}`, b.reason, `/tasks/${b.task_id}`);
  });
  // Retention: remove expired sessions-independent data per tenant policy. Audit rows are purged only through the guarded path.
  registerJob('retention.purge', async (db, _p, job) => {
    const t = await one(db, `select settings from tenants where id = $1`, [job.tenantId]);
    const days = Number(t.settings?.retention_days ?? 730);
    const r1 = await db.query(`delete from ux_timings where created_at < now() - ($1 || ' days')::interval`, [String(days)]);
    const r2 = await db.query(`delete from notifications where created_at < now() - ($1 || ' days')::interval`, [String(Math.min(days, 180))]);
    const r3 = await db.query(`delete from integration_events where received_at < now() - ($1 || ' days')::interval and status in ('ignored','duplicate','rejected')`, [String(days)]);
    const r4 = await db.query(`delete from automation_runs where created_at < now() - ($1 || ' days')::interval`, [String(Math.min(days, 365))]);
    // Generated report files are kept for 30 days (they can be regenerated from the records); the stored files go with them.
    const oldExports = await many(db, `delete from exports where created_at < now() - interval '30 days' returning file_id`);
    const fileIds = oldExports.map((e) => e.file_id).filter(Boolean);
    const files = fileIds.length ? await many(db, `delete from stored_files where id = any($1::uuid[]) and purpose = 'export' returning storage_key`, [fileIds]) : [];
    for (const f of files) await removeStored(f.storage_key);
    const r5 = await db.query(`delete from planning_nudges where sent_at < now() - ($1 || ' days')::interval`, [String(Math.min(days, 180))]);
    const r6 = await db.query(`delete from ai_runs where created_at < now() - ($1 || ' days')::interval`, [String(days)]);
    const r7 = await db.query(`delete from holiday_imports where created_at < now() - ($1 || ' days')::interval`, [String(days)]);
    await audit(db, { tenantId: job.tenantId!, actorId: null, action: 'retention.purge', resourceType: 'tenant', resourceId: job.tenantId!,
      details: { retentionDays: days, uxTimings: r1.rowCount, notifications: r2.rowCount, integrationEvents: r3.rowCount, automationRuns: r4.rowCount,
        exports: oldExports.length, exportFiles: files.length, planningNudges: r5.rowCount, aiRuns: r6.rowCount, holidayImports: r7.rowCount } });
  });
  // Scheduler tick (system job): enqueue per-tenant periodic work once per hour, idempotent by hour key.
  registerJob('scheduler.tick', async (db) => {
    const hour = new Date().toISOString().slice(0, 13), day = hour.slice(0, 10);
    const tenants = await many(db, `select id from tenants where status = 'active'`);
    for (const t of tenants) {
      await enqueue(db, { tenantId: t.id, kind: 'recurring.generate', payload: {}, idempotencyKey: `recurring:${t.id}:${hour}` });
      await enqueue(db, { tenantId: t.id, kind: 'blockers.remind', payload: {}, idempotencyKey: `remind:${t.id}:${hour}` });
      // Retention runs on its own once a day per organization (admins can still run it on demand).
      await enqueue(db, { tenantId: t.id, kind: 'retention.purge', payload: {}, idempotencyKey: `retention:${t.id}:${day}` });
      for (const kind of tenantTicks) await enqueue(db, { tenantId: t.id, kind, payload: {}, idempotencyKey: `${kind}:${t.id}:${hour}` });
    }
    await db.query(`delete from sessions where expires_at < now()`);
    await purgeFinishedJobs(db);
  });
}

/** Finished jobs are operational records only: keep two weeks of successes and a month of dead letters for diagnosis. */
export async function purgeFinishedJobs(db: any) {
  await db.query(`delete from jobs where status in ('succeeded','cancelled') and finished_at < now() - interval '14 days'`);
  await db.query(`delete from jobs where status = 'dead' and finished_at < now() - interval '30 days'`);
}

export async function scheduleTick(db: any) {
  const hour = new Date().toISOString().slice(0, 13);
  await enqueue(db, { tenantId: null, kind: 'scheduler.tick', payload: {}, idempotencyKey: `tick:${hour}` });
}
