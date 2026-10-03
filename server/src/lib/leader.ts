import pg from 'pg';
import { config } from './config.js';
import { log } from './log.js';

// Session-level advisory lock held on a dedicated connection: at most one process per database is the scheduler leader.
// Postgres releases the lock when that process or its connection dies, so another replica takes over on its next tick.
const SCHEDULER_LOCK = 7415001;
let leader: pg.Client | null = null;

export async function isSchedulerLeader(): Promise<boolean> {
  if (leader) {
    try { await leader.query('select 1'); return true; } catch { await releaseLeader(); }
  }
  const c = new pg.Client({ connectionString: config.databaseUrl });
  c.on('error', (e) => { if (leader === c) { log.warn({ err: e.message }, 'scheduler leader connection lost'); leader = null; } });
  await c.connect();
  const won = (await c.query('select pg_try_advisory_lock($1) as ok', [SCHEDULER_LOCK]).catch(() => ({ rows: [{ ok: false }] }))).rows[0].ok;
  if (!won) { await c.end().catch(() => {}); return false; }
  leader = c;
  log.info({}, 'scheduler leader elected');
  return true;
}

export async function releaseLeader() {
  const c = leader; leader = null;
  await c?.end().catch(() => {});
}
