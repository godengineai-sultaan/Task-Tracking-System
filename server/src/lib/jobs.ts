import { hostname } from 'node:os';
import type { Db } from './db.js';
import { withSystem, withTenant } from './db.js';
import { log } from './log.js';

export interface EnqueueInput { tenantId: string | null; kind: string; payload?: object; idempotencyKey?: string; runAt?: Date; maxAttempts?: number }

/** Outbox insert: call inside the same transaction as the business change. Idempotency key prevents duplicates. */
export async function enqueue(db: Db, j: EnqueueInput) {
  const r = await db.query(
    `insert into jobs (tenant_id, kind, payload, idempotency_key, run_at, max_attempts)
     values ($1,$2,$3,$4,coalesce($5, now()),$6) on conflict (idempotency_key) do nothing returning id`,
    [j.tenantId, j.kind, j.payload ?? {}, j.idempotencyKey ?? null, j.runAt ?? null, j.maxAttempts ?? 5]);
  return r.rows[0]?.id as string | undefined;
}

export type JobHandler = (db: Db, payload: any, job: { id: string; tenantId: string | null; attempts: number }) => Promise<void>;
/** Runs with no transaction open; the handler opens its own short transactions (for network I/O between database steps). */
export type OpenJobHandler = (tenantId: string | null, payload: any, job: { id: string; tenantId: string | null; attempts: number }) => Promise<void>;
/** Called in its own tenant transaction when a job is dead-lettered (e.g. to mark the record the job was producing as failed). */
export type DeadJobHandler = (db: Db, payload: any, error: string) => Promise<void>;
const handlers = new Map<string, JobHandler>();
const openHandlers = new Map<string, OpenJobHandler>();
const deadHandlers = new Map<string, DeadJobHandler>();
export function registerJob(kind: string, h: JobHandler, opts: { onDead?: DeadJobHandler } = {}) {
  handlers.set(kind, h);
  if (opts.onDead) deadHandlers.set(kind, opts.onDead);
}
export function registerOpenJob(kind: string, h: OpenJobHandler) { openHandlers.set(kind, h); }

const workerId = `${hostname()}:${process.pid}`;

/** Claim and run one job. Returns false when the queue is empty. */
export async function runOneJob(): Promise<boolean> {
  const job = await withSystem(async (db) => {
    await db.query(`update jobs set status='queued', locked_at=null, locked_by=null
                    where status='running' and locked_at < now() - interval '10 minutes'`);
    return (await db.query(
      `update jobs set status='running', locked_at=now(), locked_by=$1, attempts=attempts+1
       where id = (select id from jobs where status='queued' and run_at <= now() order by run_at limit 1 for update skip locked)
       returning *`, [workerId])).rows[0];
  });
  if (!job) return false;
  const h = handlers.get(job.kind), open = openHandlers.get(job.kind);
  try {
    const ctx = { id: job.id, tenantId: job.tenant_id, attempts: job.attempts };
    if (open) await open(job.tenant_id, job.payload, ctx);
    else if (!h) throw new Error(`No handler for job kind ${job.kind}`);
    else if (job.tenant_id) await withTenant(job.tenant_id, (db) => h(db, job.payload, ctx));
    else await withSystem((db) => h(db, job.payload, ctx));
    await withSystem((db) => db.query(`update jobs set status='succeeded', finished_at=now(), locked_at=null, last_error=null where id=$1`, [job.id]));
  } catch (e: any) {
    const dead = job.attempts >= job.max_attempts;
    const delaySec = Math.min(3600, 5 * 2 ** job.attempts);
    log.warn({ job: job.id, kind: job.kind, attempt: job.attempts, dead, err: e?.message }, 'job failed');
    await withSystem((db) => db.query(
      `update jobs set status=$2, last_error=$3, locked_at=null, run_at = now() + ($4 || ' seconds')::interval,
         finished_at = case when $2 = 'dead' then now() else null end where id=$1`,
      [job.id, dead ? 'dead' : 'queued', String(e?.message ?? e).slice(0, 2000), String(delaySec)]));
    const onDead = deadHandlers.get(job.kind);
    if (dead && onDead && job.tenant_id) await withTenant(job.tenant_id, (db) => onDead(db, job.payload, String(e?.message ?? e)))
      .catch((err: any) => log.error({ job: job.id, kind: job.kind, err: err?.message }, 'dead-letter handler failed'));
  }
  return true;
}

let timer: NodeJS.Timeout | null = null;
let busy = false;
export function startWorker(intervalMs = 1000) {
  timer = setInterval(async () => {
    if (busy || !timer) return; busy = true;
    try { while (timer && await runOneJob()) { /* drain */ } } catch (e: any) { log.error({ err: e?.message }, 'worker loop error'); }
    finally { busy = false; }
  }, intervalMs);
}
/** Stop claiming jobs and wait (bounded) for the job in flight, so a deploy restart does not strand it for the 10-minute lock timeout. */
export async function stopWorker(maxWaitMs = 20000) {
  if (timer) clearInterval(timer);
  timer = null;
  for (const until = Date.now() + maxWaitMs; busy && Date.now() < until;) await new Promise((r) => setTimeout(r, 100));
}
export async function drainJobs(max = 100) { let n = 0; while (n < max && (await runOneJob())) n++; return n; }
