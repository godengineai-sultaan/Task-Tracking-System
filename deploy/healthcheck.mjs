// Container healthcheck in plain Node (no tsx start-up cost every 30 s).
// api/all: GET /api/health/ready (database reachable). worker: heartbeat file refreshed every 15 s while the DB answers.
import { statSync } from 'node:fs';

if (process.env.APP_ROLE === 'worker') {
  let age = Infinity;
  try { age = Date.now() - statSync(process.env.WORKER_HEARTBEAT_FILE || '/tmp/worker.heartbeat').mtimeMs; } catch { /* missing */ }
  process.exit(age < 90_000 ? 0 : 1);
}
fetch(`http://127.0.0.1:${process.env.PORT || 4300}/api/health/ready`, { signal: AbortSignal.timeout(4000) })
  .then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1));
