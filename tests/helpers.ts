import { DateTime } from 'luxon';
import type { FastifyInstance } from 'fastify';
import { buildApp, SESSION_COOKIE } from '../server/src/app.js';
import { registerJobs } from '../server/src/jobs/index.js';
import { drainJobs } from '../server/src/lib/jobs.js';
import { pools, withOwner } from '../server/src/lib/db.js';
import { hashPassword, newToken } from '../server/src/lib/crypto.js';

export const PASSWORD = 'test-password-123';
let app: FastifyInstance | null = null;
let registered = false;
export async function getApp() {
  if (!registered) { registerJobs(); registered = true; }
  app ??= await buildApp();
  return app;
}
export { drainJobs };

export interface Org { tenantId: string; slug: string; users: Record<string, string>; tz: string }
let hash: string | null = null;

/** Create an isolated organization with typical roles. All names are synthetic test fixtures. */
export async function makeOrg(opts: { tz?: string; settings?: object } = {}): Promise<Org> {
  hash ??= await hashPassword(PASSWORD);
  const slug = `t${newToken(6).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
  const tz = opts.tz ?? 'Asia/Kolkata';
  return withOwner(async (db) => {
    const t = (await db.query(`insert into tenants (slug, name, timezone, settings) values ($1,$2,$3,$4) returning id`,
      [slug, `Test org ${slug}`, tz, { coverage_threshold: 0.5, founders_visible_to_routine_admin: true, ...(opts.settings ?? {}) }])).rows[0];
    const users: Record<string, string> = {};
    const mk = async (key: string, roles: string[], extra: Record<string, unknown> = {}) => {
      const r = await db.query(`insert into users (tenant_id, email, name, password_hash, roles, is_founder) values ($1,$2,$3,$4,$5,$6) returning id`,
        [t.id, `${key}@${slug}.test`, key[0].toUpperCase() + key.slice(1), hash, roles, !!extra.founder]);
      users[key] = r.rows[0].id;
    };
    await mk('admin', ['member', 'system_admin', 'routine_admin', 'leadership', 'cost_viewer']);
    await mk('manager', ['member', 'manager']);
    await mk('emp', ['member']);
    await mk('emp2', ['member']);
    await mk('outsider', ['member']);
    await mk('founder', ['member', 'leadership'], { founder: true });
    const team = (await db.query(`insert into teams (tenant_id, name, manager_id) values ($1,'Team',$2) returning id`, [t.id, users.manager])).rows[0];
    for (const k of ['emp', 'emp2']) await db.query(`insert into team_members (tenant_id, team_id, user_id) values ($1,$2,$3)`, [t.id, team.id, users[k]]);
    for (let wd = 1; wd <= 5; wd++) await db.query(`insert into work_schedules (tenant_id, weekday, start_minute, end_minute, break_minutes) values ($1,$2,540,1020,60)`, [t.id, wd]);
    return { tenantId: t.id, slug, users, tz };
  });
}

export async function login(org: Org, key: string) {
  const a = await getApp();
  const r = await a.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-requested-with': 'fetch', 'content-type': 'application/json' },
    payload: { organization: org.slug, email: `${key}@${org.slug}.test`, password: PASSWORD } });
  if (r.statusCode !== 200) throw new Error(`login failed ${r.statusCode} ${r.body}`);
  const c = r.cookies.find((x) => x.name === SESSION_COOKIE)!;
  return client(`${SESSION_COOKIE}=${c.value}`);
}

export function client(cookie: string) {
  const call = async (method: string, url: string, payload?: unknown) => {
    const a = await getApp();
    const r = await a.inject({ method: method as any, url, headers: { cookie, 'x-requested-with': 'fetch', ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) },
      payload: payload as any });
    let body: any = r.body;
    try { body = JSON.parse(r.body); } catch { /* binary */ }
    return { status: r.statusCode, body, raw: r.rawPayload, headers: r.headers };
  };
  return { get: (u: string) => call('GET', u), post: (u: string, b: unknown = {}) => call('POST', u, b), put: (u: string, b: unknown = {}) => call('PUT', u, b),
    patch: (u: string, b: unknown = {}) => call('PATCH', u, b), del: (u: string, b: unknown = {}) => call('DELETE', u, b) };
}

/** A recent weekday (local) strictly before today, `n` working days back. */
export function pastWorkday(tz: string, n = 1) {
  let d = DateTime.now().setZone(tz).startOf('day'); let k = 0;
  while (k < n) { d = d.minus({ days: 1 }); if (d.weekday <= 5) k++; }
  return d;
}
export const localIso = (tz: string, date: string, hhmm: string) => DateTime.fromISO(`${date}T${hhmm}`, { zone: tz }).toUTC().toISO()!;
export { pools, withOwner };
