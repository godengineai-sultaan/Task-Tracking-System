/**
 * Create a real organization and its first administrator without the public signup page.
 * Usage: npm run bootstrap -- --org "Acme Pvt Ltd" --slug acme --tz Asia/Kolkata --name "Jane Admin" --email jane@acme.com
 * The password is read from BOOTSTRAP_PASSWORD or prompted; it is never printed.
 */
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { withOwner, closePools } from '../lib/db.js';
import { hashPassword } from '../lib/crypto.js';
import { audit } from '../lib/audit.js';
import { migrate } from './migrate.js';

const { values: v } = parseArgs({ options: { org: { type: 'string' }, slug: { type: 'string' }, tz: { type: 'string', default: 'UTC' }, name: { type: 'string' }, email: { type: 'string' },
  plan: { type: 'string', default: 'organization' }, seats: { type: 'string', default: '250' } } });
for (const k of ['org', 'slug', 'name', 'email'] as const) if (!v[k]) { console.error(`Missing --${k}`); process.exit(1); }
let password = process.env.BOOTSTRAP_PASSWORD ?? '';
if (!password) { const rl = createInterface({ input: process.stdin, output: process.stdout }); password = await rl.question('Administrator password (min 10 chars): '); rl.close(); }
if (password.length < 10) { console.error('Password must be at least 10 characters'); process.exit(1); }
await migrate();
await withOwner(async (db) => {
  const t = (await db.query(`insert into tenants (slug, name, timezone, plan, seat_limit, settings) values ($1,$2,$3,$4,$5,$6) returning id`,
    [v.slug, v.org, v.tz, v.plan, Number(v.seats), { founders_visible_to_routine_admin: true, include_meetings_in_work_policy: true, coverage_threshold: 0.5, retention_days: 730,
      ai_enabled: false, voice_capture_enabled: false, evidence_required_categories: [], review_required_categories: [] }])).rows[0];
  const u = (await db.query(`insert into users (tenant_id, email, name, password_hash, roles) values ($1,$2,$3,$4,$5) returning id`,
    [t.id, v.email, v.name, await hashPassword(password), ['member', 'system_admin', 'routine_admin', 'leadership', 'manager']])).rows[0];
  for (let wd = 1; wd <= 5; wd++) await db.query(`insert into work_schedules (tenant_id, weekday, start_minute, end_minute, break_minutes) values ($1,$2,540,1050,60)`, [t.id, wd]);
  await db.query(`insert into role_profiles (tenant_id, name, description) values ($1,'General','Default profile')`, [t.id]);
  await audit(db, { tenantId: t.id, actorId: u.id, action: 'tenant.bootstrap', resourceType: 'tenant', resourceId: t.id });
});
console.log(`Organization "${v.org}" created. Sign in with organization "${v.slug}" and ${v.email}.`);
await closePools();
