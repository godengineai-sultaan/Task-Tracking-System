import { DateTime } from 'luxon';
import { one, type Db } from '../../lib/db.js';
import { badRequest, conflict } from '../../lib/errors.js';
import { type Actor, has } from '../access.js';
import { localToday } from '../calendar.js';
import { setPlan } from '../myday.js';
import { createTask, parseQuickCapture, projectVisibleSql } from '../tasks.js';

/**
 * Idempotency for client-generated request ids (offline outbox, retried quick captures).
 * Scoped per (tenant, creator): the same id from another person never resolves to someone else's task.
 * The advisory lock serialises concurrent retries of one id so exactly one task is created.
 */
export async function findClientRequest(db: Db, a: Actor, clientRequestId: string) {
  await db.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [`task-client-request:${a.tenantId}:${a.id}:${clientRequestId}`]);
  return one(db, `select * from tasks where created_by = $1 and client_request_id = $2`, [a.id, clientRequestId]);
}

export async function stampClientRequest(db: Db, taskId: string, clientRequestId: string) {
  await db.query(`update tasks set client_request_id = $2 where id = $1`, [taskId, clientRequestId]);
}

export interface OfflineCapture { clientRequestId: string; userId?: string; text: string; capturedAt: string; projectId?: string | null; addToMyDay?: boolean }

/**
 * Create a task from a one-line capture that was queued on the device while offline.
 * Relative words ("today", "fri") are resolved against the day it was captured, not the day it synced.
 */
export async function syncOfflineCapture(db: Db, a: Actor, c: OfflineCapture, correlationId?: string) {
  // A capture queued under one account (e.g. in a tab left open after another person signed in on this device) is never created as someone else.
  if (c.userId && c.userId !== a.id) throw conflict('This capture was saved on this device by a different account, so it was not created');
  const prior = await findClientRequest(db, a, c.clientRequestId);
  if (prior) return { task: prior, replayed: true, warnings: [] as string[], addedToMyDay: false, planFull: false };
  const now = DateTime.now();
  let at = DateTime.fromISO(c.capturedAt);
  if (!at.isValid || at > now) at = now;
  const capturedOn = at.setZone(a.timezone).toISODate()!;
  const p = parseQuickCapture(c.text, capturedOn);
  if (!p.title) throw badRequest('The capture has no title left after removing shortcuts');
  const project = p.projectKey ? await one(db, `select id from projects pr where key = $1 and status <> 'archived' and ${projectVisibleSql('pr', 2)}`, [p.projectKey, a.id, has(a, 'routine_admin')]) : null;
  const owner = p.ownerHint ? await one(db, `select id from users where status = 'active' and not ('customer' = any(roles))
    and (lower(split_part(email, '@', 1)) = $1 or lower(split_part(name, ' ', 1)) = $1 or lower(replace(name, ' ', '.')) = $1) limit 1`, [p.ownerHint]) : null;
  const warnings = [
    ...(p.projectKey && !project ? [`No project with key ${p.projectKey}`] : []),
    ...(p.ownerHint && !owner ? [`No teammate matches @${p.ownerHint}; assigned to you`] : []),
  ];
  const r = await createTask(db, a, a.tenantId, {
    title: p.title, dueDate: p.dueDate, estimateMinutes: p.estimateMinutes, priority: p.priority ?? undefined, category: p.category ?? undefined,
    projectId: project?.id ?? c.projectId ?? null, ownerId: owner?.id ?? undefined,
    sourceType: 'quick_capture', sourceRef: { channel: 'offline_outbox', capturedAt: at.toUTC().toISO() },
  }, { correlationId });
  await stampClientRequest(db, r.task.id, c.clientRequestId);
  let addedToMyDay = false; let planFull = false;
  // Only plan it for today when it was captured today: yesterday's intention is not silently moved onto today's plan.
  const today = localToday(a.timezone);
  if (c.addToMyDay && capturedOn === today) {
    const plan = await one(db, `select (select array_agg(task_id order by position) from daily_plan_items where plan_id = dp.id and removed_at is null) ids
      from daily_plans dp where user_id = $1 and date = $2`, [a.id, today]);
    const ids: string[] = plan?.ids ?? [];
    if (ids.length >= 3) planFull = true;
    else { await setPlan(db, a, today, [...ids, r.task.id]); addedToMyDay = true; }
  }
  return { task: r.task, replayed: false, warnings, addedToMyDay, planFull };
}
