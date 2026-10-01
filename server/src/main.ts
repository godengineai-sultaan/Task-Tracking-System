import { config } from './lib/config.js';
import { buildApp } from './app.js';
import { registerJobs, scheduleTick } from './jobs/index.js';
import { startWorker, stopWorker } from './lib/jobs.js';
import { closePools, withSystem } from './lib/db.js';
import { log } from './lib/log.js';
import { migrate } from './cli/migrate.js';

const applied = await migrate();
if (applied.length) log.info({ applied }, 'migrations applied');
registerJobs();
const app = await buildApp();
await app.listen({ port: config.port, host: '127.0.0.1' });
log.info({ port: config.port }, 'API listening');
if (process.env.WORKER !== '0') {
  startWorker();
  const tick = () => withSystem((db) => scheduleTick(db)).catch((e) => log.error({ err: e.message }, 'tick failed'));
  await tick();
  setInterval(tick, 5 * 60 * 1000);
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { stopWorker(); await app.close(); await closePools(); process.exit(0); });
