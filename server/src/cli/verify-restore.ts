/** Restore drill verification: audit hash chains, RLS still enforced for the app role, stored-file checksums. */
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { config } from '../lib/config.js';
import { sha256 } from '../lib/crypto.js';
import { verifyAuditChain } from '../lib/audit.js';

const target = process.argv[2] ?? 'taskapp_restore_drill';
const storage = resolve(process.env.RESTORE_STORAGE_DIR ?? '.data/restore-drill-storage');
const owner = new pg.Client({ connectionString: config.migrationDatabaseUrl.replace(/\/taskapp$/, `/${target}`) });
const app = new pg.Client({ connectionString: config.databaseUrl.replace(/\/taskapp$/, `/${target}`) });
await owner.connect(); await app.connect();
let failures = 0;
for (const t of (await owner.query('select id, slug from tenants')).rows) {
  const r = await verifyAuditChain(owner as any, t.id);
  console.log(`audit chain ${t.slug}: ${r.ok ? 'OK' : `BROKEN at ${r.brokenAt}`} (${r.checked} events)`); if (!r.ok) failures++;
}
const leaked = (await app.query('select count(*)::int n from tasks')).rows[0].n;
console.log(`RLS without tenant context: ${leaked === 0 ? 'OK (0 rows visible)' : `FAIL (${leaked} rows)`}`); if (leaked) failures++;
let bad = 0, missing = 0;
for (const f of (await owner.query('select storage_key, sha256 from stored_files')).rows) {
  const p = join(storage, f.storage_key.split('/').slice(1).join('/'));
  const p2 = join(storage, f.storage_key);
  const path = existsSync(p2) ? p2 : p;
  if (!existsSync(path)) { missing++; continue; }
  if (sha256(readFileSync(path)) !== f.sha256) bad++;
}
console.log(`stored files: ${missing} missing, ${bad} checksum mismatches`); if (bad || missing) failures++;
await owner.end(); await app.end();
process.exit(failures ? 1 : 0);
