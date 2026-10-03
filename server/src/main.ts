import { writeFileSync } from 'node:fs';
import { config } from './lib/config.js';
import { buildApp } from './app.js';
import { registerJobs, scheduleTick } from './jobs/index.js';
import { startWorker, stopWorker } from './lib/jobs.js';
import { closePools, withSystem } from './lib/db.js';
import { isSchedulerLeader, releaseLeader } from './lib/leader.js';
import { log } from './lib/log.js';
import { migrate } from './cli/migrate.js';

// APP_ROLE: api (HTTP only), worker (job worker + scheduler, no HTTP) or all (both; the default for local runs).
// The legacy WORKER=0 switch still means api-only.
const role = process.env.APP_ROLE || (process.env.WORKER === '0' ? 'api' : 'all');
if (!['api', 'worker', 'all'].includes(role)) throw new Error(`APP_ROLE must be api, worker or all (got "${role}")`);

const applied = await migrate();
if (applied.length) log.info({ applied }, 'migrations applied');
registerJobs();
const app = role === 'worker' ? null : await buildApp();
if (app) {
  await app.listen({ port: config.port, host: config.host });
  log.info({ port: config.port, role }, 'API listening');
}
const timers: NodeJS.Timeout[] = [];
if (role !== 'api') {
  startWorker();
  // Every worker replica ticks, but only the advisory-lock leader enqueues (the tick job is also idempotent per hour).
  const tick = () => isSchedulerLeader().then(async (lead) => { if (lead) await withSystem((db) => scheduleTick(db)); })
    .catch((e) => log.error({ err: e.message }, 'tick failed'));
  await tick();
  timers.push(setInterval(tick, 5 * 60 * 1000));
  // Container healthcheck for the HTTP-less worker: a heartbeat file refreshed while the database is reachable.
  const hb = process.env.WORKER_HEARTBEAT_FILE;
  if (hb) {
    const beat = () => withSystem((db) => db.query('select 1')).then(() => writeFileSync(hb, String(Date.now())))
      .catch((e) => log.warn({ err: e.message }, 'worker heartbeat failed'));
    await beat();
    timers.push(setInterval(beat, 15 * 1000));
  }
  log.info({ role }, 'worker started');
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => {
  log.info({ sig }, 'shutting down');
  timers.forEach(clearInterval);
  await app?.close();
  await stopWorker();
  await releaseLeader();
  await closePools();
  process.exit(0);
});
