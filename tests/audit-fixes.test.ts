import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { PASSWORD, client, drainJobs, getApp, login, makeOrg, withOwner, type Org } from './helpers.js';
import { withSystem, withTenant } from '../server/src/lib/db.js';
import { base32Encode, encrypt, hashPassword, hmacHex, newToken, sha256, totp } from '../server/src/lib/crypto.js';
import { SESSION_COOKIE } from '../server/src/app.js';
import { config } from '../server/src/lib/config.js';
import { generateRecurring } from '../server/src/services/tasks.js';
import { httpUrlOrNull } from '../server/src/services/integrations.js';
import { registerExportReport } from '../server/src/services/exports.js';
import { purgeFinishedJobs } from '../server/src/jobs/index.js';
import { localToday } from '../server/src/services/calendar.js';
import { randomBytes } from 'node:crypto';

// Many sign-ins in one file: lift the per-IP login limit (read when the app is built).
process.env.LOGIN_RATE_LIMIT = '1000';

let org: Org; let admin: any, manager: any, emp: any, emp2: any, outsider: any;
let cust: { id: string; customerId: string; c: any };
const H = { 'x-requested-with': 'fetch', 'content-type': 'application/json' };

async function addUser(o: Org, key: string, roles: string[], extra: { customerId?: string; founder?: boolean } = {}) {
  const hash = await hashPassword(PASSWORD);
  const id = await withOwner(async (db) => (await db.query(`insert into users (tenant_id, email, name, password_hash, roles, customer_id, is_founder) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [o.tenantId, `${key}@${o.slug}.test`, key[0].toUpperCase() + key.slice(1), hash, roles, extra.customerId ?? null, !!extra.founder])).rows[0].id as string);
  o.users[key] = id;
  return id;
}
async function privateProject(owner = admin, key = `P${newToken(3).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`) {
  const p = (await owner.post('/api/projects', { key: key.slice(0, 8), name: 'Leadership hiring (private)', visibility: 'private' })).body;
  expect(p.id).toBeTruthy();
  return p;
}
const yesterdayIso = () => DateTime.now().minus({ days: 1 }).set({ hour: 10, minute: 0, second: 0, millisecond: 0 });
const icsStamp = (d: DateTime) => d.toUTC().toFormat("yyyyMMdd'T'HHmmss'Z'");
const ics = (events: string[]) => `BEGIN:VCALENDAR\nVERSION:2.0\n${events.join('\n')}\nEND:VCALENDAR\n`;
const vevent = (uid: string, start: DateTime, mins: number, extra = '') =>
  `BEGIN:VEVENT\nUID:${uid}\nDTSTART:${icsStamp(start)}\nDTEND:${icsStamp(start.plus({ minutes: mins }))}\nSUMMARY:Meeting ${uid}\n${extra ? extra + '\n' : ''}END:VEVENT`;

// Organizations made here: their leftover queued jobs are removed at the end so other test files never drain them.
const made: string[] = [];
const mk = async (opts?: Parameters<typeof makeOrg>[0]) => { const o = await makeOrg(opts); made.push(o.tenantId); return o; };
beforeAll(async () => {
  org = await mk();
  [admin, manager, emp, emp2, outsider] = await Promise.all(['admin', 'manager', 'emp', 'emp2', 'outsider'].map((k) => login(org, k)));
  const customer = (await admin.post('/api/admin/customers', { name: 'Globex' })).body;
  const id = await addUser(org, 'lena', ['customer'], { customerId: customer.id });
  cust = { id, customerId: customer.id, c: await login(org, 'lena') };
});

afterAll(async () => {
  await withOwner((db) => db.query(`delete from jobs where status = 'queued' and tenant_id = any($1::uuid[])`, [made]));
});

describe('invitations never take over accounts (security-1)', () => {
  const join = async (link: string, password: string) => (await getApp()).inject({ method: 'POST', url: `/api/join/${org.slug}/${link.split('/').pop()}`, headers: H, payload: { password } });
  it('a second invitation retires the first, and a leftover link cannot reset an active account', async () => {
    const email = `bob@${org.slug}.test`;
    const inv1 = (await admin.post('/api/admin/invitations', { email, name: 'Bob', roles: ['member', 'manager'] })).body;
    const inv2 = (await admin.post('/api/admin/invitations', { email, name: 'Bob', roles: ['member'] })).body;
    expect((await join(inv2.link, PASSWORD)).statusCode).toBe(200);
    const bob = await login(org, 'bob');
    expect((await join(inv1.link, 'attacker-pass1')).statusCode).toBe(400);
    // A legacy second open invitation (issued before this fix) is refused for an active account too.
    const token = newToken(24);
    await withOwner((db) => db.query(`insert into invitations (tenant_id, email, name, roles, token_hash, expires_at) values ($1,$2,'Bob',array['member','system_admin'],$3, now() + interval '7 days')`,
      [org.tenantId, email, sha256(token)]));
    expect((await join(`x/${token}`, 'attacker-pass1')).statusCode).toBe(400);
    expect((await bob.get('/api/me')).status).toBe(200); // own password and session untouched
    expect((await bob.get('/api/me')).body.user.roles).toEqual(['member']);
  });
  it('a deactivated person cannot reactivate themselves with an invitation issued before the deactivation', async () => {
    const email = `carl@${org.slug}.test`;
    const first = (await admin.post('/api/admin/invitations', { email, name: 'Carl', roles: ['member'] })).body;
    expect((await join(first.link, PASSWORD)).statusCode).toBe(200);
    const carlId = (await withOwner((db) => db.query(`select id from users where lower(email) = lower($1)`, [email]))).rows[0].id;
    org.users.carl = carlId;
    expect((await admin.patch(`/api/admin/users/${carlId}`, { status: 'deactivated' })).status).toBe(200);
    // An invitation that was still open from before the deactivation (issued before this fix) cannot bring the account back.
    const oldToken = newToken(24);
    await withOwner((db) => db.query(`insert into invitations (tenant_id, email, name, roles, token_hash, expires_at, created_at) values ($1,$2,'Carl',array['member','routine_admin'],$3, now() + interval '7 days', now() - interval '1 hour')`,
      [org.tenantId, email, sha256(oldToken)]));
    expect((await join(`x/${oldToken}`, 'carl-again-pass')).statusCode).toBe(400);
    // A stale session row for the account is dropped when the account is re-established through a new invitation.
    const stale = newToken();
    await withOwner((db) => db.query(`insert into sessions (token_hash, tenant_id, user_id, expires_at) values ($1,$2,$3, now() + interval '1 day')`, [sha256(stale), org.tenantId, carlId]));
    const fresh = (await admin.post('/api/admin/invitations', { email, name: 'Carl', roles: ['member'] })).body;
    expect((await join(fresh.link, PASSWORD)).statusCode).toBe(200);
    expect((await client(`${SESSION_COOKIE}=${stale}`).get('/api/me')).status).toBe(401);
    expect((await login(org, 'carl').then((c) => c.get('/api/me'))).body.user.roles).toEqual(['member']);
  });
});

describe('integration suggestions respect task access (security-2, security-14)', () => {
  it('cannot log calendar time against, or link activity to, a task the person cannot see or change', async () => {
    const hidden = await privateProject();
    const secretTask = (await admin.post('/api/tasks', { title: 'Interview VP finalist', projectId: hidden.id })).body;
    const conn = (await emp.post('/api/integrations', { kind: 'ics_calendar', name: 'cal' })).body;
    expect((await emp.post(`/api/integrations/${conn.id}/ics`, { ics: ics([vevent('m1', yesterdayIso(), 30)]) })).status).toBe(200);
    await drainJobs();
    const sug = (await emp.get('/api/suggestions')).body.find((s: any) => s.kind === 'time_entry');
    expect(sug).toBeTruthy();
    expect((await emp.post(`/api/suggestions/${sug.id}/decide`, { decision: 'accept', taskId: secretTask.id })).status).toBe(404);
    const from = DateTime.now().minus({ days: 3 }).toUTC().toISO(), to = DateTime.now().toUTC().toISO();
    const mine = (await emp.get(`/api/time-entries?from=${encodeURIComponent(from!)}&to=${encodeURIComponent(to!)}`)).body;
    expect(mine.map((e: any) => e.task_title)).not.toContain('Interview VP finalist');

    // Link activity: a visible task the person does not contribute to.
    const company = (await admin.post('/api/projects', { key: 'OPSX', name: 'Ops' })).body;
    const other = (await emp2.post('/api/tasks', { title: 'Someone else\'s task', projectId: company.id, requiresEvidence: true })).body;
    const linkSug = await withOwner(async (db) => (await db.query(`insert into suggestions (tenant_id, user_id, kind, dedupe_key, event_ids, title, data, matched_task_id)
      values ($1,$2,'link_to_task','code:PR-1','{}','Link PR-1',$3,$4) returning id`, [org.tenantId, org.users.emp, { source: 'code', ref: 'PR-1', url: 'https://code.example/PR-1', event_count: 1 }, other.id])).rows[0].id);
    expect((await emp.post(`/api/suggestions/${linkSug}/decide`, { decision: 'accept' })).status).toBe(403);
    const ev = await withOwner((db) => db.query(`select count(*)::int n from evidence_links where task_id = $1`, [other.id]));
    expect(ev.rows[0].n).toBe(0);
  });
  it('automation run history does not hand out ids of tasks the viewer cannot see', async () => {
    const hidden = await privateProject();
    const t = (await admin.post('/api/tasks', { title: 'Offer letter', projectId: hidden.id })).body;
    await withOwner(async (db) => {
      const r = (await db.query(`insert into automation_rules (tenant_id, name, trigger, actions, scope, owner_id, enabled) values ($1,'r','{"type":"task.created"}','[]','company',$2,false) returning id`, [org.tenantId, org.users.admin])).rows[0];
      await db.query(`insert into automation_runs (tenant_id, rule_id, rule_version, task_id, trigger, status) values ($1,$2,1,$3,'task.created','success')`, [org.tenantId, r.id, t.id]);
    });
    const runs = (await emp.get('/api/automations/runs')).body.filter((r: any) => r.rule_name === 'r');
    expect(runs).toHaveLength(1);
    expect(runs[0].task_visible).toBe(false);
    expect(runs[0].task_id).toBeNull();
  });
  it('only http(s) links from connected tools become evidence', async () => {
    expect(httpUrlOrNull('https://issues.example/ISS-7')).toBe('https://issues.example/ISS-7');
    expect(httpUrlOrNull('data:text/html,<b>x</b>')).toBeNull();
    expect(httpUrlOrNull('ms-word:ofe|u|https://x')).toBeNull();
    expect(httpUrlOrNull('javascript:alert(1)')).toBeNull();
    const c = (await admin.post('/api/integrations', { kind: 'issues', name: 'Issues' })).body;
    const body = JSON.stringify({ schema_version: '1.0', tenant_id: org.tenantId, event_id: 'u-1', event_type: 'issue.assigned',
      payload: { title: 'Odd link', issue_ref: 'ISS-9', assignee_email: `emp@${org.slug}.test`, url: 'data:text/html,<script>x</script>' } });
    const ts = Math.floor(Date.now() / 1000);
    const r = await (await getApp()).inject({ method: 'POST', url: `/api/inbound/${org.slug}/${c.id}`, headers: { 'content-type': 'application/json', 'x-timestamp': String(ts),
      'x-signature': `sha256=${hmacHex(c.secret, `${ts}.${body}`)}` }, payload: body });
    expect(r.statusCode).toBe(202);
    await drainJobs();
    const s = (await emp.get('/api/suggestions')).body.find((x: any) => x.dedupe_key === 'issues:ISS-9');
    expect(s.data.url).toBeNull();
    const accepted = (await emp.post(`/api/suggestions/${s.id}/decide`, { decision: 'accept' })).body;
    const ev = await withOwner((db) => db.query(`select count(*)::int n from evidence_links where task_id = $1`, [accepted.result.id]));
    expect(ev.rows[0].n).toBe(0);
  });
});

describe('client accounts and reference data (security-3, security-4, security-11, ux-1)', () => {
  it('client and member accounts cannot list clients, staff structure, role profiles, holidays or schedules', async () => {
    for (const url of ['/api/admin/customers', '/api/admin/departments', '/api/admin/teams', '/api/admin/role-profiles', '/api/calendar/holidays',
      `/api/calendar/schedule?userId=${org.users.emp}`]) expect((await cust.c.get(url)).status, url).toBe(403);
    expect((await emp.get('/api/admin/customers')).status).toBe(403);
    expect((await manager.get('/api/admin/customers')).status).toBe(200);
    expect((await emp.get('/api/admin/departments')).status).toBe(200);
    expect((await emp.get(`/api/calendar/schedule?userId=${org.users.emp2}`)).status).toBe(403);
    expect((await emp.get('/api/calendar/schedule')).status).toBe(200);
    expect((await manager.get(`/api/calendar/schedule?userId=${org.users.emp}`)).status).toBe(200);
    expect((await admin.get(`/api/calendar/schedule?userId=${org.users.outsider}`)).status).toBe(200);
  });
  it('the client task list carries only the customer-safe fields', async () => {
    const p = (await admin.post('/api/projects', { key: 'WEBX', name: 'Web portal', customerId: cust.customerId })).body;
    const t = (await admin.post('/api/tasks', { title: 'Checkout page', projectId: p.id, customerVisible: true, estimateMinutes: 120, tags: ['internal'] })).body;
    expect((await admin.post(`/api/tasks/${t.id}/status`, { to: 'blocked', blocker: { reason: 'Waiting on Initech contract; Globex invoice overdue' } })).status).toBe(200);
    const rows = (await cust.c.get('/api/tasks')).body;
    const row = rows.find((r: any) => r.id === t.id);
    expect(row).toBeTruthy();
    for (const k of ['blocker_reason', 'owner_id', 'owner_name', 'estimate_minutes', 'tags', 'priority', 'checklist_total']) expect(row).not.toHaveProperty(k);
    expect(JSON.stringify(rows)).not.toContain('Initech');
  });
  it('clients cannot use the quick-capture parser to resolve projects or staff', async () => {
    expect((await cust.c.post('/api/tasks/parse', { text: 'x #WEBX @emp' })).status).toBe(403);
  });
});

describe('project rules on task edits, milestones and recurring work (security-5, security-6, security-9)', () => {
  it('moving a task into a private project follows the create-time rule; milestones and reviewers are checked', async () => {
    const hidden = await privateProject();
    const mine = (await outsider.post('/api/tasks', { title: 'Mine' })).body;
    expect((await outsider.patch(`/api/tasks/${mine.id}`, { version: mine.version, projectId: hidden.id })).status).toBe(400);
    expect((await outsider.get(`/api/tasks/${mine.id}`)).body.project).toBeNull();
    const a = (await admin.post('/api/projects', { key: 'AAA1', name: 'A' })).body, b = (await admin.post('/api/projects', { key: 'BBB1', name: 'B' })).body;
    const mb = (await admin.post(`/api/projects/${b.id}/milestones`, { name: 'B launch' })).body;
    const t = (await outsider.post('/api/tasks', { title: 'In A', projectId: a.id })).body;
    expect((await outsider.patch(`/api/tasks/${t.id}`, { version: t.version, milestoneId: mb.id })).status).toBe(400);
    expect((await outsider.patch(`/api/tasks/${t.id}`, { version: t.version, reviewerId: cust.id })).status).toBe(400);
    const moved = await outsider.patch(`/api/tasks/${t.id}`, { version: t.version, projectId: b.id, milestoneId: mb.id });
    expect(moved.status).toBe(200); expect(moved.body.milestone_id).toBe(mb.id);
    const back = await outsider.patch(`/api/tasks/${t.id}`, { version: moved.body.version, projectId: a.id });
    expect(back.status).toBe(200); expect(back.body.milestone_id).toBeNull(); // a milestone of the old project does not follow the task
  });
  it('the open-milestone list hides milestones of private projects from non-members', async () => {
    const hidden = await privateProject();
    const m = (await admin.post(`/api/projects/${hidden.id}/milestones`, { name: 'Shortlist signed off' })).body;
    expect((await outsider.get('/api/milestones')).body.map((x: any) => x.id)).not.toContain(m.id);
    expect((await admin.get('/api/milestones')).body.map((x: any) => x.id)).toContain(m.id);
  });
  it('recurring work cannot target a private project the creator cannot use, and the generator re-checks', async () => {
    const hidden = await privateProject();
    expect((await outsider.post('/api/recurring', { title: 'Sneaky', rule: 'daily', projectId: hidden.id })).status).toBe(400);
    const tpl = await withOwner(async (db) => (await db.query(`insert into recurring_templates (tenant_id, title, owner_id, created_by, project_id, rule, category, priority, checklist, last_generated_date)
      values ($1,'Legacy sneaky',$2,$2,$3,'daily','admin','medium','[]', current_date - 2) returning id`, [org.tenantId, org.users.outsider, hidden.id])).rows[0].id);
    await withTenant(org.tenantId, (db) => generateRecurring(db, org.tenantId, localToday(org.tz)));
    const n = await withOwner((db) => db.query(`select count(*)::int n from tasks where recurring_template_id = $1`, [tpl]));
    expect(n.rows[0].n).toBe(0);
  });
});

describe('person records stay with the people allowed to see them (security-7, security-8)', () => {
  it('task detail shows exact time entries only to those who may see that person\'s records', async () => {
    const p = (await admin.post('/api/projects', { key: 'CMP1', name: 'Company work' })).body;
    const t = (await emp.post('/api/tasks', { title: 'Shared work', projectId: p.id })).body;
    const s = DateTime.now().minus({ hours: 3 }), e = s.plus({ minutes: 45 });
    expect((await emp2.post('/api/time-entries', { taskId: t.id, startedAt: s.toUTC().toISO(), endedAt: e.toUTC().toISO() })).status).toBe(200);
    const asPeer = (await outsider.get(`/api/tasks/${t.id}`)).body;
    expect(asPeer.time.filter((x: any) => x.user_id === org.users.emp2)).toHaveLength(0);
    expect(asPeer.timeTotalMinutes).toBe(45);
    const asManager = (await manager.get(`/api/tasks/${t.id}`)).body;
    expect(asManager.time.filter((x: any) => x.user_id === org.users.emp2)).toHaveLength(1);
  });
  it('the leave calendar applies the founder-visibility policy to routine admins', async () => {
    const o = await mk({ settings: { founders_visible_to_routine_admin: false } });
    await addUser(o, 'ra', ['member', 'routine_admin']);
    const [founder, ra] = await Promise.all([login(o, 'founder'), login(o, 'ra')]);
    const d = DateTime.now().plus({ days: 10 }).toISODate();
    expect((await founder.post('/api/calendar/leave', { startDate: d, endDate: d, kind: 'sick', note: 'private note' })).status).toBe(200);
    expect((await ra.get(`/api/calendar/leave?userId=${o.users.founder}`)).status).toBe(403);
    expect((await ra.get('/api/calendar/leave')).body.map((l: any) => l.user_id)).not.toContain(o.users.founder);
  });
});

describe('calendar import bounds (security-10)', () => {
  it('second- and minute-level repeat rules are refused and instance counts are capped', async () => {
    const conn = (await outsider.post('/api/integrations', { kind: 'ics_calendar', name: 'spam' })).body;
    const start = DateTime.now().minus({ days: 30 });
    const r1 = (await outsider.post(`/api/integrations/${conn.id}/ics`, { ics: ics([vevent('s1', start, 1, 'RRULE:FREQ=SECONDLY'), vevent('s2', start, 1, 'RRULE:FREQ=MINUTELY'),
      vevent('s3', start, 1, `RRULE:FREQ=HOURLY;BYMINUTE=${Array.from({ length: 60 }, (_, i) => i).join(',')}`)]) })).body;
    expect(r1.received).toBe(0); expect(r1.unreadable).toBe(3);
    const r2 = (await outsider.post(`/api/integrations/${conn.id}/ics`, { ics: ics([vevent('h1', start, 5, 'RRULE:FREQ=HOURLY')]) })).body;
    expect(r2.received).toBe(500); expect(r2.capped).toBe(1);
    // The 500 suggestions are not this file's business: drop their queued processing jobs.
    await withOwner((db) => db.query(`delete from jobs where status = 'queued' and kind = 'integration.process'
      and (payload->>'eventId')::uuid in (select id from integration_events where connection_id = $1)`, [conn.id]));
  });
});

describe('sign-in hardening (security-12, security-13)', () => {
  const raw = async (url: string, payload: unknown, cookie: string, ip: string) =>
    (await getApp()).inject({ method: 'POST', url, headers: { ...H, cookie }, payload: payload as any, remoteAddress: ip });
  async function startMfa(o: Org, ip: string) {
    const r = await raw('/api/auth/login', { organization: o.slug, email: `emp2@${o.slug}.test`, password: PASSWORD }, '', ip);
    expect(r.json().mfaRequired).toBe(true);
    return `${SESSION_COOKIE}=${r.cookies.find((c) => c.name === SESSION_COOKIE)!.value}`;
  }
  it('a pending MFA sign-in is dropped after 5 wrong codes and the account locks after 10', async () => {
    const o = await mk();
    const secret = base32Encode(randomBytes(20));
    await withOwner((db) => db.query(`update users set mfa_secret_enc = $2, mfa_enabled = true where id = $1`, [o.users.emp2, encrypt(secret)]));
    let ip = 0; const nextIp = () => `10.9.0.${++ip}`;
    let cookie = await startMfa(o, nextIp());
    for (let i = 0; i < 5; i++) expect((await raw('/api/auth/mfa', { code: '000000' }, cookie, nextIp())).statusCode).toBe(401);
    expect((await raw('/api/auth/mfa', { code: totp(secret) }, cookie, nextIp())).json().message).toMatch(/Sign in again/);
    cookie = await startMfa(o, nextIp());
    for (let i = 0; i < 5; i++) await raw('/api/auth/mfa', { code: '000000' }, cookie, nextIp());
    cookie = await startMfa(o, nextIp());
    expect((await raw('/api/auth/mfa', { code: totp(secret) }, cookie, nextIp())).statusCode).toBe(429);
    await withOwner((db) => db.query(`update users set mfa_locked_until = now() - interval '1 second' where id = $1`, [o.users.emp2]));
    expect((await raw('/api/auth/mfa', { code: totp(secret) }, cookie, nextIp())).statusCode).toBe(200);
    const u = await withOwner((db) => db.query(`select mfa_failed_attempts from users where id = $1`, [o.users.emp2]));
    expect(u.rows[0].mfa_failed_attempts).toBe(0);
  });
  it('an unknown email costs a password hash, like a known one', async () => {
    const app = await getApp();
    const time = async (email: string) => { const t = Date.now(); await app.inject({ method: 'POST', url: '/api/auth/login', headers: H, payload: { organization: org.slug, email, password: 'wrong-password-1' } }); return Date.now() - t; };
    let known = 0, unknown = 0;
    for (let i = 0; i < 3; i++) { known += await time(`emp@${org.slug}.test`); unknown += await time(`nobody${i}@${org.slug}.test`); }
    expect(unknown).toBeGreaterThan(known * 0.4);
  });
});

describe('recurring work does not backfill (integrity-1)', () => {
  it('resuming a paused template, or a stale marker, never creates a pile of overdue tasks', async () => {
    const tpl = (await emp.post('/api/recurring', { title: 'Inbox zero', rule: 'daily' })).body;
    const today = localToday(org.tz);
    expect((await emp.patch(`/api/recurring/${tpl.id}`, { active: false })).body.active).toBe(false);
    expect((await emp.patch(`/api/recurring/${tpl.id}`, { title: 'Inbox zero (daily)' })).body.active).toBe(false); // an edit does not resume it
    await withOwner((db) => db.query(`update recurring_templates set last_generated_date = $2::date - 20 where id = $1`, [tpl.id, today]));
    expect((await emp.patch(`/api/recurring/${tpl.id}`, { active: true })).status).toBe(200);
    await withTenant(org.tenantId, (db) => generateRecurring(db, org.tenantId, DateTime.fromISO(today).plus({ days: 1 }).toISODate()!));
    const past = await withOwner((db) => db.query(`select count(*)::int n from tasks where recurring_template_id = $1 and occurrence_date < $2`, [tpl.id, today]));
    expect(past.rows[0].n).toBe(0);
    // A marker left far behind (e.g. downtime) catches up at most a week.
    await withOwner((db) => db.query(`update recurring_templates set last_generated_date = $2::date - 40 where id = $1`, [tpl.id, today]));
    await withTenant(org.tenantId, (db) => generateRecurring(db, org.tenantId, DateTime.fromISO(today).plus({ days: 1 }).toISODate()!));
    const old = await withOwner((db) => db.query(`select count(*)::int n from tasks where recurring_template_id = $1 and occurrence_date < $2::date - 7`, [tpl.id, today]));
    expect(old.rows[0].n).toBe(0);
  });
});

describe('blocker reminders use the owner\'s local day (integrity-2)', () => {
  it('a reminder sent after local midnight counts as today\'s, whatever the database timezone', async () => {
    const o = await mk({ tz: 'Pacific/Kiritimati' });
    const e = await login(o, 'emp');
    const t = (await e.post('/api/tasks', { title: 'Waiting on legal' })).body, u = (await e.post('/api/tasks', { title: 'Waiting on finance' })).body;
    for (const x of [t, u]) await e.post(`/api/tasks/${x.id}/status`, { to: 'blocked', blocker: { reason: 'Review' } });
    await withOwner((db) => db.query(`update blockers set raised_at = now() - interval '2 days' where task_id = any($1::uuid[])`, [[t.id, u.id]]));
    const midnight = DateTime.now().setZone(o.tz).startOf('day').plus({ minutes: 1 }).toUTC().toISO();
    await withOwner((db) => db.query(`insert into notifications (tenant_id, user_id, kind, title, link, created_at) values ($1,$2,'blocker_reminder','Follow up',$3,$4)`,
      [o.tenantId, o.users.emp, `/tasks/${t.id}`, midnight]));
    const job = await withOwner(async (db) => (await db.query(`insert into jobs (tenant_id, kind, payload, run_at) values ($1,'blockers.remind','{}', now() - interval '1 day') returning id`, [o.tenantId])).rows[0].id);
    await drainJobs(1);
    expect((await withOwner((db) => db.query(`select status from jobs where id = $1`, [job]))).rows[0].status).toBe('succeeded');
    const n = await withOwner((db) => db.query(`select link, count(*)::int n from notifications where user_id = $1 and kind = 'blocker_reminder' group by link order by link`, [o.users.emp]));
    expect(Object.fromEntries(n.rows.map((r) => [r.link, r.n]))).toEqual({ [`/tasks/${t.id}`]: 1, [`/tasks/${u.id}`]: 1 });
  });
});

describe('AI runs (integrity-3, performance-9)', () => {
  const saved = { key: config.anthropicApiKey, base: process.env.ANTHROPIC_BASE_URL };
  afterAll(() => { config.anthropicApiKey = saved.key; if (saved.base === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = saved.base; });
  it('a failed model call is recorded as a failed run', async () => {
    const o = await mk({ settings: { ai_enabled: true } });
    const e = await login(o, 'emp');
    config.anthropicApiKey = 'sk-test-not-a-real-key';
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9';
    const r = await e.post('/api/ai/task-draft', { note: 'Follow up with the vendor about laptops' });
    expect(r.status).toBe(502); expect(r.body.error).toBe('ai_failed');
    const runs = await withOwner((db) => db.query(`select status, count(*)::int n from ai_runs where tenant_id = $1 group by status`, [o.tenantId]));
    expect(runs.rows).toEqual([{ status: 'failed', n: 1 }]);
  }, 60_000);
});

describe('concurrent review and reopen apply once (integrity-5)', () => {
  // Both requests read the task before either writes: hold the row lock until both are waiting on it.
  async function race(taskId: string, send: () => Promise<any>) {
    let pending: Promise<any>[] = [];
    await withOwner(async (db) => {
      await db.query(`select id from tasks where id = $1 for update`, [taskId]);
      pending = [send(), send()];
      await new Promise((r) => setTimeout(r, 600));
    });
    return (await Promise.all(pending)).map((r) => r.status).sort();
  }
  it('two simultaneous accepts record one review and one transition', async () => {
    const t = (await emp.post('/api/tasks', { title: 'Submit me', requiresReview: true, reviewerId: org.users.manager })).body;
    await emp.post(`/api/tasks/${t.id}/status`, { to: 'in_review' });
    expect(await race(t.id, () => manager.post(`/api/tasks/${t.id}/review`, { decision: 'accepted' }))).toEqual([200, 409]);
    const n = await withOwner((db) => db.query(`select (select count(*)::int from task_reviews where task_id = $1) reviews,
      (select count(*)::int from task_state_history where task_id = $1 and to_status = 'done') done`, [t.id]));
    expect(n.rows[0]).toEqual({ reviews: 1, done: 1 });
    expect(await race(t.id, () => emp.post(`/api/tasks/${t.id}/reopen`, { reason: 'Bug found' }))).toEqual([200, 409]);
    expect((await emp.get(`/api/tasks/${t.id}`)).body.task.reopen_count).toBe(1);
  });
});

describe('exports, retention and the job queue (integrity-6, integrity-7)', () => {
  it('an export whose generation keeps failing ends as failed with a reason', async () => {
    registerExportReport('always_fails', { authorize: async () => {}, build: async () => { throw new Error('renderer exploded'); }, csv: () => '' });
    const ex = (await emp.post('/api/exports', { format: 'csv', report: 'always_fails', params: {} })).body;
    for (let i = 0; i < 3; i++) {
      await withOwner((db) => db.query(`update jobs set run_at = now() where idempotency_key = $1 and status = 'queued'`, [`export:${ex.id}`]));
      await drainJobs();
    }
    const row = (await emp.get(`/api/exports/${ex.id}`)).body;
    expect(row.status).toBe('failed'); expect(row.error).toMatch(/renderer exploded/);
  });
  it('the scheduler queues daily retention, old finished jobs are purged and old export files removed', async () => {
    const old = await withOwner(async (db) => (await db.query(`insert into jobs (tenant_id, kind, status, finished_at, created_at) values ($1,'noop','succeeded', now() - interval '20 days', now() - interval '20 days') returning id`, [org.tenantId])).rows[0].id);
    const recent = await withOwner(async (db) => (await db.query(`insert into jobs (tenant_id, kind, status, finished_at) values ($1,'noop','succeeded', now() - interval '1 day') returning id`, [org.tenantId])).rows[0].id);
    await withSystem((db) => purgeFinishedJobs(db));
    const left = await withOwner((db) => db.query(`select id from jobs where id = any($1::uuid[])`, [[old, recent]]));
    expect(left.rows.map((r) => r.id)).toEqual([recent]);
    const before = new Date();
    await withOwner((db) => db.query(`insert into jobs (tenant_id, kind, payload) values (null,'scheduler.tick','{}')`));
    // Run only the tick (other tenants' queued work is not this test's business), then check what it queued for this organization.
    await withOwner((db) => db.query(`update jobs set run_at = run_at + interval '1 hour' where status = 'queued' and kind <> 'scheduler.tick' and created_at < $1`, [before]));
    await drainJobs(1);
    const day = new Date().toISOString().slice(0, 10);
    const q = await withOwner((db) => db.query(`select count(*)::int n from jobs where idempotency_key = $1`, [`retention:${org.tenantId}:${day}`]));
    expect(q.rows[0].n).toBe(1);
    await withOwner((db) => db.query(`delete from jobs where status = 'queued' and created_at >= $1 and tenant_id <> $2`, [before, org.tenantId]));
    await withOwner((db) => db.query(`update jobs set run_at = run_at - interval '1 hour' where status = 'queued' and created_at < $1`, [before]));
    // Retention removes month-old exports and their stored files.
    const ex = (await emp.post('/api/exports', { format: 'csv', report: 'individual', params: { userId: org.users.emp, start: localToday(org.tz), end: localToday(org.tz) } })).body;
    await withOwner((db) => db.query(`update jobs set run_at = now() where idempotency_key = $1`, [`export:${ex.id}`]));
    await drainJobs();
    expect((await emp.get(`/api/exports/${ex.id}`)).body.status).toBe('ready');
    await withOwner((db) => db.query(`update exports set created_at = now() - interval '40 days' where id = $1`, [ex.id]));
    await withOwner((db) => db.query(`insert into jobs (tenant_id, kind, payload) values ($1,'retention.purge','{}')`, [org.tenantId]));
    await drainJobs();
    expect((await emp.get(`/api/exports/${ex.id}`)).status).toBe(404);
    const files = await withOwner((db) => db.query(`select count(*)::int n from stored_files where tenant_id = $1 and purpose = 'export'`, [org.tenantId]));
    expect(files.rows[0].n).toBe(0);
  });
});

describe('indexes for hot lookups (integrity-8, integrity-9, performance-1..4, 10, 11)', () => {
  it('per-person and per-task lookups are indexed', async () => {
    const r = await withOwner((db) => db.query(`select indexname from pg_indexes where schemaname = 'public'`));
    const names = new Set(r.rows.map((x) => x.indexname));
    for (const n of ['notifications_user_created', 'notifications_unread', 'time_entries_task', 'task_reviews_task', 'comments_task', 'checklist_items_task',
      'evidence_links_task', 'daily_plan_items_task', 'blockers_task', 'jobs_running_locked', 'jobs_tenant_created']) expect(names.has(n), n).toBe(true);
  });
});

describe('reassignment uses the previous owner\'s local date (integrity-10)', () => {
  it('only today and later plans lose the item, in the owner\'s own timezone', async () => {
    const dbDate = (await withOwner((db) => db.query(`select current_date::text d`))).rows[0].d as string;
    const tz = ['Pacific/Kiritimati', 'Etc/GMT+12'].find((z) => localToday(z) !== dbDate)!;
    const o = await mk();
    await withOwner((db) => db.query(`update users set timezone = $2 where id = $1`, [o.users.emp, tz]));
    const [e, m] = await Promise.all([login(o, 'emp'), login(o, 'manager')]);
    const t = (await e.post('/api/tasks', { title: 'Plan me' })).body;
    const today = localToday(tz), yesterday = DateTime.fromISO(today).minus({ days: 1 }).toISODate();
    await withOwner(async (db) => {
      for (const d of [yesterday, today]) {
        const p = (await db.query(`insert into daily_plans (tenant_id, user_id, date) values ($1,$2,$3) returning id`, [o.tenantId, o.users.emp, d])).rows[0];
        await db.query(`insert into daily_plan_items (tenant_id, plan_id, task_id, position) values ($1,$2,$3,1)`, [o.tenantId, p.id, t.id]);
      }
    });
    expect((await m.post(`/api/tasks/${t.id}/reassign`, { ownerId: o.users.emp2, reason: 'Rebalance' })).status).toBe(200);
    const rows = await withOwner((db) => db.query(`select dp.date::text d, dpi.removed_at is not null removed from daily_plan_items dpi join daily_plans dp on dp.id = dpi.plan_id
      where dpi.task_id = $1 order by dp.date`, [t.id]));
    expect(rows.rows).toEqual([{ d: yesterday, removed: false }, { d: today, removed: true }]);
  });
});

describe('objectives and milestones (integrity-12, seams-4, seams-13)', () => {
  it('the legacy objective write routes are gone; milestone links to objectives are leadership-only and audited', async () => {
    expect((await admin.post('/api/objectives', { title: 'Legacy' })).status).toBe(404);
    const o = (await admin.post('/api/objectives/create', { title: 'Close Q3 books' })).body;
    expect((await admin.patch(`/api/objectives/${o.id}`, { status: 'dropped' })).status).toBe(404);
    const p = (await manager.post('/api/projects', { key: 'MGR1', name: 'Manager project' })).body;
    expect((await manager.post(`/api/projects/${p.id}/milestones`, { name: 'M1', objectiveId: o.id })).status).toBe(403);
    const m = (await manager.post(`/api/projects/${p.id}/milestones`, { name: 'M1' })).body;
    expect((await manager.patch(`/api/milestones/${m.id}`, { objectiveId: o.id })).status).toBe(403);
    expect((await admin.patch(`/api/milestones/${m.id}`, { objectiveId: o.id })).status).toBe(200);
    expect((await manager.patch(`/api/milestones/${m.id}`, { objectiveId: null })).status).toBe(403);
    expect((await manager.patch(`/api/milestones/${m.id}`, { status: 'done' })).status).toBe(200);
    const a = await withOwner((db) => db.query(`select action from audit_events where tenant_id = $1 and (resource_id = $2 or details->>'milestoneId' = $2) order by id`, [org.tenantId, m.id]));
    expect(a.rows.map((r) => r.action)).toEqual(['milestone.create', 'objective.milestone_linked', 'milestone.update', 'milestone.update']);
  });
});

describe('blocked work and status events (seams-2, seams-3)', () => {
  it('the person a blocker waits on can open the task', async () => {
    const t = (await emp.post('/api/tasks', { title: 'Needs outsider input' })).body;
    expect((await outsider.get(`/api/tasks/${t.id}`)).status).toBe(404);
    await emp.post(`/api/tasks/${t.id}/status`, { to: 'blocked', blocker: { reason: 'Need numbers', waitingOnUserId: org.users.outsider } });
    const r = await outsider.get(`/api/tasks/${t.id}`);
    expect(r.status).toBe(200); expect(r.body.canEdit).toBe(false);
  });
  it('starting a timer and planning a backlog item fire status-change rules', async () => {
    const o = await mk();
    const [a, e] = await Promise.all([login(o, 'admin'), login(o, 'emp')]);
    for (const to of ['in_progress', 'planned']) expect((await a.post('/api/automations', { name: `to ${to}`, scope: 'company', trigger: { type: 'task.status_changed', to },
      actions: [{ type: 'add_comment', text: `moved to ${to}` }] })).status).toBe(200);
    const t = (await e.post('/api/tasks', { title: 'Timer task', status: 'planned' })).body;
    expect((await e.post('/api/timer/start', { taskId: t.id })).status).toBe(200);
    const b = (await e.post('/api/tasks', { title: 'Backlog task', status: 'backlog' })).body;
    expect((await e.put('/api/my-day/plan', { taskIds: [b.id] })).status).toBe(200);
    const runs = await withOwner((db) => db.query(`select r.name, x.task_id from automation_runs x join automation_rules r on r.id = x.rule_id where x.tenant_id = $1 and x.status = 'success' order by r.name`, [o.tenantId]));
    expect(runs.rows).toEqual([{ name: 'to in_progress', task_id: t.id }, { name: 'to planned', task_id: b.id }]);
    const h = await withOwner((db) => db.query(`select from_status, to_status from task_state_history where task_id = $1 order by at, id`, [b.id]));
    expect(h.rows.at(-1)).toEqual({ from_status: 'backlog', to_status: 'planned' });
  });
});

describe('leadership delivery: no ranking, small groups, founder policy, overlaps once (analytics-1, analytics-2, analytics-9)', () => {
  it('leadership-only viewers get department aggregates with small groups withheld; the main admin gets an alphabetical list', async () => {
    const o = await mk({ settings: { founders_visible_to_routine_admin: false } });
    await addUser(o, 'lead', ['member', 'leadership']);
    await addUser(o, 'ra', ['member', 'routine_admin']);
    const P = (await (await login(o, 'admin')).post('/api/projects', { key: 'DLV1', name: 'Delivery' })).body;
    await withOwner(async (db) => {
      const dep = async (name: string, keys: string[]) => {
        const d = (await db.query(`insert into departments (tenant_id, name) values ($1,$2) returning id`, [o.tenantId, name])).rows[0].id;
        await db.query(`update users set department_id = $2 where id = any($1::uuid[])`, [keys.map((k) => o.users[k]), d]);
      };
      await dep('Eng', ['emp', 'emp2', 'manager']); await dep('Sales', ['outsider']); await dep('Leadership', ['founder']);
      const t0 = DateTime.now().minus({ days: 3 }).set({ hour: 10, minute: 0, second: 0, millisecond: 0 });
      const te = (k: string, startMin: number, mins: number, source = 'manual', ended = true) => db.query(`insert into time_entries (tenant_id, user_id, task_id, category, started_at, ended_at, source)
        values ($1,$2,$3,'task',$4,$5,$6)`, [o.tenantId, o.users[k], null, t0.plus({ minutes: startMin }).toUTC().toISO(), ended ? t0.plus({ minutes: startMin + mins }).toUTC().toISO() : null, source]);
      await te('emp', 0, 60); await te('emp', 0, 30, 'timer'); // overlap: counted once
      await te('emp2', 0, 60); await te('manager', 0, 60); await te('outsider', 0, 120); await te('founder', 0, 90);
      await db.query(`insert into time_entries (tenant_id, user_id, category, started_at, source) values ($1,$2,'task', now() - interval '20 minutes', 'timer')`, [o.tenantId, o.users.emp2]); // running: not confirmed
      for (const [k, n] of [['emp', 1], ['emp2', 4], ['outsider', 2], ['founder', 3]] as const)
        for (let i = 0; i < n; i++) await db.query(`insert into tasks (tenant_id, title, owner_id, created_by, status, project_id, estimate_minutes) values ($1,$2,$3,$3,'planned',$4,30)`, [o.tenantId, `${k} ${i}`, o.users[k], P.id]);
    });
    const [lead, ra, admin] = await Promise.all([login(o, 'lead'), login(o, 'ra'), login(o, 'admin')]);
    const L = (await lead.get('/api/leadership/delivery')).body;
    expect(L.workloadConcentration).toEqual([]);
    expect(L.workloadByDepartment.map((w: any) => w.department)).not.toContain('Sales');
    expect(L.workloadByDepartment.map((w: any) => w.department)).not.toContain('Leadership');
    expect(L.allocationByDepartment.map((w: any) => w.department)).not.toContain('Sales');
    expect(L.allocationByDepartment.map((w: any) => w.department)).not.toContain('Leadership');
    expect(L.allocation.every((r: any) => r.department === null)).toBe(true);
    expect(L.smallGroupsWithheld).toBe(true);
    const total = (d: any) => d.allocationByDepartment.reduce((s: number, r: any) => s + r.minutes, 0);
    expect(total(L)).toBe(60 + 60 + 60 + 120 + 90); // overlaps once, running timer excluded
    const R = (await ra.get('/api/leadership/delivery')).body;
    const names = R.workloadConcentration.map((w: any) => w.name);
    expect(names).toEqual([...names].sort((x: string, y: string) => x.localeCompare(y)));
    expect(names).not.toContain('Founder');
    expect(total(R)).toBe(60 + 60 + 60 + 120); // founder's time withheld from a non-founder routine admin
    const A = (await admin.get('/api/leadership/delivery')).body;
    expect(A.workloadConcentration.map((w: any) => w.name)).toContain('Founder');
    expect(A.allocationByDepartment.map((w: any) => w.department)).toEqual(expect.arrayContaining(['Sales', 'Leadership', 'Eng']));
  });
});

describe('period reports (analytics-4, analytics-5, analytics-7, analytics-8)', () => {
  it('blocked time on a fully blocked day is 100% of available time, not more', async () => {
    const o = await mk();
    await withOwner((db) => db.query(`update users set created_at = now() - interval '1 year' where tenant_id = $1`, [o.tenantId]));
    const e = await login(o, 'emp');
    const t = (await e.post('/api/tasks', { title: 'Stuck' })).body;
    await e.post(`/api/tasks/${t.id}/status`, { to: 'blocked', blocker: { reason: 'Waiting' } });
    await withOwner((db) => db.query(`update blockers set raised_at = now() - interval '10 days' where task_id = $1`, [t.id]));
    const d = DateTime.now().setZone(o.tz).minus({ days: 1 }); let day = d; while (day.weekday > 5) day = day.minus({ days: 1 });
    const r = (await e.get(`/api/reports/individual?kind=day&date=${day.toISODate()}`)).body;
    expect(r.days[0].blockedMinutes).toBe(r.days[0].capacity.availableMinutes);
    expect(r.days[0].blockerShare).toBe(1);
  });
  it('a period report leaves out today (still in progress) but the day view keeps it', async () => {
    const o = await mk();
    await withOwner(async (db) => {
      await db.query(`update users set created_at = now() - interval '1 year' where tenant_id = $1`, [o.tenantId]);
      for (let wd = 6; wd <= 7; wd++) await db.query(`insert into work_schedules (tenant_id, weekday, start_minute, end_minute, break_minutes) values ($1,$2,540,1020,60)`, [o.tenantId, wd]);
    });
    const e = await login(o, 'emp');
    const t = (await e.post('/api/tasks', { title: 'Today outcome' })).body;
    expect((await e.put('/api/my-day/plan', { taskIds: [t.id] })).status).toBe(200);
    const today = localToday(o.tz);
    const w = (await e.get(`/api/reports/individual?kind=custom&start=${DateTime.fromISO(today).minus({ days: 2 }).toISODate()}&end=${today}`)).body;
    expect(w.summary.carryovers).toBe(0);
    expect(w.summary.intendedOutcomes).toBe(0);
    expect(w.summary.workingDays).toBe(2);
    const d = (await e.get(`/api/reports/individual?kind=day&date=${today}`)).body;
    expect(d.days[0].intendedOutcomes).toHaveLength(1); expect(d.reportState).toBe('provisional');
  });
  it('capacity pressure from today does not change the assessment of a finished period', async () => {
    const o = await mk();
    await withOwner(async (db) => {
      await db.query(`update users set created_at = now() - interval '1 year' where tenant_id = $1`, [o.tenantId]);
      const mon = DateTime.now().setZone(o.tz).minus({ weeks: 1 }).startOf('week');
      for (let i = 0; i < 5; i++) {
        const d = mon.plus({ days: i }).toISODate()!;
        await db.query(`insert into time_entries (tenant_id, user_id, category, started_at, ended_at, source) values ($1,$2,'admin',$3,$4,'manual')`,
          [o.tenantId, o.users.emp, DateTime.fromISO(`${d}T09:00`, { zone: o.tz }).toUTC().toISO(), DateTime.fromISO(`${d}T17:00`, { zone: o.tz }).toUTC().toISO()]);
        await db.query(`insert into daily_reviews (tenant_id, user_id, date, status, summary, version, confirmed_at) values ($1,$2,$3,'confirmed','Done',1,now())`, [o.tenantId, o.users.emp, d]);
      }
      await db.query(`insert into tasks (tenant_id, title, owner_id, created_by, status, estimate_minutes) values ($1,'Huge',$2,$2,'planned',100000)`, [o.tenantId, o.users.emp]);
    });
    const e = await login(o, 'emp');
    const last = DateTime.now().setZone(o.tz).minus({ weeks: 1 }).toISODate();
    const r = (await e.get(`/api/reports/individual?kind=week&date=${last}`)).body;
    expect(r.summary.capacityPressure.ratio).toBeGreaterThan(1.25);
    expect(r.assessment.reasons.join(' ')).not.toMatch(/Upcoming estimated work/);
    expect(r.assessment.label).toBe('on_track');
  });
  it('days before a person\'s records begin are not working days, and an empty previous period gives no delta', async () => {
    const o = await mk();
    const e = await login(o, 'emp');
    const today = DateTime.fromISO(localToday(o.tz));
    let first = today.minus({ days: 3 }); while (first.weekday > 5) first = first.minus({ days: 1 });
    await withOwner((db) => db.query(`insert into time_entries (tenant_id, user_id, category, started_at, ended_at, source) values ($1,$2,'admin',$3,$4,'manual')`,
      [o.tenantId, o.users.emp, DateTime.fromISO(`${first.toISODate()}T10:00`, { zone: o.tz }).toUTC().toISO(), DateTime.fromISO(`${first.toISODate()}T11:00`, { zone: o.tz }).toUTC().toISO()]));
    const start = today.minus({ days: 13 }).toISODate(), end = today.minus({ days: 1 }).toISODate();
    const r = (await e.get(`/api/reports/individual?kind=custom&start=${start}&end=${end}`)).body;
    expect(r.days.filter((d: any) => d.date < first.toISODate()!).every((d: any) => d.beforeRecords)).toBe(true);
    expect(r.summary.workingDays).toBeLessThanOrEqual(3);
    expect(r.trend.status).toBe('not_applicable'); expect(r.trend.loggingCoverage.delta).toBeNull();
    const m = await login(o, 'manager');
    const ins = (await m.get('/api/insights?weeks=4')).body;
    expect(ins.totals.previous.recapAdoption.status).toBe('not_applicable');
    expect(ins.totals.previous.loggingCoverage.status).toBe('not_applicable');
  });
});

describe('team-wide reports use a fixed number of queries (performance-5)', () => {
  it('buildReports does not issue a round of queries per person', async () => {
    const { buildReports } = await import('../server/src/services/analytics.js');
    const o = await mk();
    const week = DateTime.now().setZone(o.tz).minus({ weeks: 1 }).startOf('week');
    const count = async (ids: string[]) => withTenant(o.tenantId, async (db) => {
      let n = 0;
      const counting = new Proxy(db, { get: (t, k) => (k === 'query' ? (...args: any[]) => { n++; return (t as any).query(...args); } : (t as any)[k]) });
      await buildReports(counting as any, ids, 'week', week.toISODate()!, week.plus({ days: 6 }).toISODate()!, { trend: false });
      return n;
    });
    const two = await count([o.users.emp, o.users.emp2]);
    const six = await count(Object.values(o.users));
    expect(six).toBe(two);
  });
});

describe('seams between feature areas (seams-5, seams-6, seams-7, seams-8, seams-10, analytics-5 trends, analytics-6)', () => {
  it('the organization export includes feature-area records but no subscription addresses or feed tokens', async () => {
    const r = await admin.get('/api/admin/export-data');
    expect(r.status).toBe(200);
    for (const k of ['task_templates', 'automation_rules', 'automation_runs', 'weekly_reviews', 'objective_key_results', 'objective_checkins', 'project_budgets',
      'client_updates', 'tenant_branding', 'calendar_subscriptions', 'calendar_feed_tokens', 'holiday_imports', 'planning_preferences', 'whatif_scenarios'])
      expect(r.body, k).toHaveProperty(k);
    expect(r.body.automation_runs.length).toBeGreaterThan(0);
    expect(JSON.stringify(r.body)).not.toMatch(/url_enc|token_hash/);
  });
  it('a reviewer is not notified twice when work is submitted for review', async () => {
    const o = await mk();
    const [a, e, m] = await Promise.all([login(o, 'admin'), login(o, 'emp'), login(o, 'manager')]);
    expect((await a.post('/api/automations', { name: 'Tell the reviewer', scope: 'company', trigger: { type: 'task.status_changed', to: 'in_review' },
      actions: [{ type: 'notify', target: 'reviewer', message: 'Ready for your review: {task.title}' }] })).status).toBe(200);
    const t = (await e.post('/api/tasks', { title: 'Review me', requiresReview: true, reviewerId: o.users.manager })).body;
    expect((await e.post(`/api/tasks/${t.id}/status`, { to: 'in_review' })).status).toBe(200);
    const kinds = (await m.get('/api/notifications')).body.filter((n: any) => n.link === `/tasks/${t.id}`).map((n: any) => n.kind);
    expect(kinds).toEqual(['review_requested']);
  });
  it('team review and profitability PDFs carry the organization brand header', async () => {
    const { inflateSync } = await import('node:zlib');
    const text = (buf: Buffer) => {
      let out = ''; let i = 0;
      while ((i = buf.indexOf('stream', i)) !== -1) {
        const s = buf.indexOf('\n', i) + 1, e = buf.indexOf('endstream', s);
        try { out += inflateSync(buf.subarray(s, e)).toString('latin1'); } catch { /* not deflated */ }
        i = e + 9;
      }
      return out.toLowerCase();
    };
    const brand = { name: 'Zyxwv Branded Org', accent: '#1d4ed8', logo: null };
    const hex = Buffer.from('Zyxwv').toString('hex');
    const { teamWeekPdf } = await import('../server/src/services/ext/teamreview.js');
    const { profitabilityPdf } = await import('../server/src/services/ext/profitability.js');
    const tw = await withTenant(org.tenantId, async (db) => {
      const { loadActor } = await import('../server/src/services/access.js');
      const { teamWeek } = await import('../server/src/services/ext/teamreview.js');
      const act = (await loadActor(db, org.tenantId, org.users.manager))!;
      return teamWeekPdf(await teamWeek(db, act, {}), act, brand);
    });
    expect(text(tw)).toContain(hex);
    const pf = await withTenant(org.tenantId, async (db) => {
      const { loadActor } = await import('../server/src/services/access.js');
      const { portfolio } = await import('../server/src/services/ext/profitability.js');
      const act = (await loadActor(db, org.tenantId, org.users.admin))!;
      return profitabilityPdf(await portfolio(db, act, {}), act, brand);
    });
    expect(text(pf)).toContain(hex);
  });
  it('applying a template sends one summary notice per person, not one per step', async () => {
    const tpl = (await manager.post('/api/templates', { name: 'Onboarding', category: 'team', visibility: 'company',
      items: [{ title: 'Step one', dueOffsetDays: 0 }, { title: 'Step two', dueOffsetDays: 1 }, { title: 'Step three', dueOffsetDays: 2 }] })).body;
    const before = (await emp.get('/api/notifications')).body.filter((n: any) => n.kind === 'task_assigned').length;
    expect((await manager.post(`/api/templates/${tpl.id}/apply`, { startDate: '2030-01-07', defaultOwnerId: org.users.emp, applyKey: `k-${newToken(8)}` })).status).toBe(200);
    const after = (await emp.get('/api/notifications')).body.filter((n: any) => n.kind === 'task_assigned');
    expect(after.length - before).toBe(1);
    expect(after[0].title).toBe('3 new tasks from template: Onboarding');
  });
  it('an offline "@name" capture is assigned only when exactly one person matches', async () => {
    const o = await mk();
    await addUser(o, 'priya', ['member']);
    await withOwner((db) => db.query(`insert into users (tenant_id, email, name, roles) values ($1,$2,'Priya Shah',array['member'])`, [o.tenantId, `pshah@${o.slug}.test`]));
    await withOwner((db) => db.query(`update users set name = 'Priya Nair' where id = $1`, [o.users.priya]));
    const e = await login(o, 'emp');
    const r = (await e.post('/api/pwa/captures', { clientRequestId: `test-amb-${newToken(6).replace(/[^A-Za-z0-9]/g, 'x')}`, text: 'Draft SOW @priya', capturedAt: new Date().toISOString() })).body;
    expect(r.task.owner_id).toBe(o.users.emp);
    expect(r.warnings.join(' ')).toMatch(/more than one person/);
  });
  it('personal trends never report more blocked time than available time', async () => {
    const o = await mk();
    await withOwner((db) => db.query(`update users set created_at = now() - interval '1 year' where tenant_id = $1`, [o.tenantId]));
    const e = await login(o, 'emp');
    const t = (await e.post('/api/tasks', { title: 'Long block' })).body;
    await e.post(`/api/tasks/${t.id}/status`, { to: 'blocked', blocker: { reason: 'Waiting' } });
    await withOwner((db) => db.query(`update blockers set raised_at = now() - interval '30 days' where task_id = $1`, [t.id]));
    const r = (await e.get('/api/trends/personal?weeks=4')).body;
    const full = r.weeks.filter((w: any) => w.status === 'applicable');
    expect(full.length).toBeGreaterThan(0);
    for (const w of full) expect(w.blockedMinutes).toBeLessThanOrEqual(w.availableMinutes);
  });
  it('Insights names its focus measure differently from personal Trends', async () => {
    const r = (await manager.get('/api/insights?weeks=4')).body;
    expect(r.definitions.focusShare.label).toBe('Uninterrupted task time');
  });
});
