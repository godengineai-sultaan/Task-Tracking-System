import pg from 'pg';
import { config } from './config.js';

// DATE columns stay as 'YYYY-MM-DD' strings; never shift them through JS Date timezones.
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

export type Db = pg.PoolClient;

let appPool: pg.Pool | null = null;
let ownerPool: pg.Pool | null = null;

export function pools(urls?: { app: string; owner: string }) {
  if (urls) {
    appPool = new pg.Pool({ connectionString: urls.app, max: 10 });
    ownerPool = new pg.Pool({ connectionString: urls.owner, max: 4 });
  }
  appPool ??= new pg.Pool({ connectionString: config.databaseUrl, max: Number(process.env.PG_POOL_MAX || 20) });
  ownerPool ??= new pg.Pool({ connectionString: config.migrationDatabaseUrl, max: 4 });
  return { app: appPool, owner: ownerPool };
}

export async function closePools() {
  await appPool?.end(); await ownerPool?.end();
  appPool = ownerPool = null;
}

/** A transaction client runs one query at a time; queue concurrent callers (e.g. Promise.all) instead of overlapping them. */
function serialized(client: pg.PoolClient): pg.PoolClient {
  const c = client as any;
  if (c.__serialized) return client;
  const raw = client.query.bind(client);
  let chain: Promise<unknown> = Promise.resolve();
  c.query = (...args: any[]) => { const p = chain.then(() => raw(...(args as [any]))); chain = p.catch(() => {}); return p; };
  c.__serialized = true;
  return client;
}

/** Product partition settings for one transaction (see migrations/018_portfolio.sql). Omitted = every product (system work). */
export interface ProductScope { scope: string; focus?: string | null }

/** Run fn in a transaction with row-level security bound to one tenant (and, for a signed-in actor, their product scope). */
export async function withTenant<T>(tenantId: string, fn: (db: Db) => Promise<T>, product?: ProductScope): Promise<T> {
  const client = serialized(await pools().app.connect());
  try {
    await client.query('begin');
    if (product) await client.query("select set_config('app.tenant_id', $1, true), set_config('app.product_scope', $2, true), set_config('app.product_focus', $3, true)",
      [tenantId, product.scope, product.focus ?? '']);
    else await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Unscoped app-role transaction (only tenants/sessions/jobs are reachable: everything else is RLS-filtered to nothing). */
export async function withSystem<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const client = serialized(await pools().app.connect());
  try {
    await client.query('begin');
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Owner role (bypasses RLS). Only for migrations, seed, bootstrap and maintenance CLIs. */
export async function withOwner<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const client = serialized(await pools().owner.connect());
  try {
    await client.query('begin');
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function one<T = any>(db: Db, sql: string, params: unknown[] = []): Promise<T | null> {
  const r = await db.query(sql, params);
  return (r.rows[0] as T) ?? null;
}
export async function many<T = any>(db: Db, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query(sql, params)).rows as T[];
}
