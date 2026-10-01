import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import '../lib/config.js';

export async function migrate(ownerUrl = process.env.MIGRATION_DATABASE_URL!) {
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    await client.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
    const done = new Set((await client.query('select name from schema_migrations')).rows.map((r) => r.name));
    const dir = resolve(import.meta.dirname, '../../migrations');
    const applied: string[] = [];
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(f)) continue;
      await client.query('begin');
      try {
        await client.query(readFileSync(resolve(dir, f), 'utf8'));
        await client.query('insert into schema_migrations(name) values ($1)', [f]);
        await client.query('commit');
        applied.push(f);
      } catch (e) { await client.query('rollback'); throw new Error(`Migration ${f} failed: ${(e as Error).message}`); }
    }
    return applied;
  } finally { await client.end(); }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrate().then((a) => { console.log(a.length ? `Applied: ${a.join(', ')}` : 'Database is up to date'); })
    .catch((e) => { console.error(e.message); process.exit(1); });
}
