import { beforeAll, describe, expect, it } from 'vitest';
import { client, drainJobs, getApp, login, makeOrg, pastWorkday, pools, withOwner, type Org } from './helpers.js';
import { withTenant } from '../server/src/lib/db.js';
import { verifyAuditChain } from '../server/src/lib/audit.js';

let A: Org, B: Org; let aEmp: any, aAdmin: any, aMgr: any, aOut: any, bEmp: any, bAdmin: any; let secretTask: any;
beforeAll(async () => {
  A = await makeOrg(); B = await makeOrg({ settings: { founders_visible_to_routine_admin: false } });
  [aEmp, aAdmin, aMgr, aOut, bEmp, bAdmin] = await Promise.all([login(A, 'emp'), login(A, 'admin'), login(A, 'manager'), login(A, 'outsider'), login(B, 'emp'), login(B, 'admin')]);
  secretTask = (await aEmp.post('/api/tasks', { title: 'Tenant A confidential deliverable' })).body;
  await aEmp.post(`/api/tasks/${secretTask.id}/evidence`, { label: 'Signed contract', sourceModule: 'HR drive', sourceReference: 'HR-9', restricted: true });
  await aEmp.post('/api/recap/confirm', { date: pastWorkday(A.tz, 1).toISODate(), summary: 'A work' });
});

describe('tenant isolation', () => {
  it('another tenant cannot read, search, list, export or report on tasks', async () => {
    expect((await bAdmin.get(`/api/tasks/${secretTask.id}`)).status).toBe(404);
    expect((await bAdmin.get('/api/search?q=confidential')).body.tasks).toHaveLength(0);
    expect((await bAdmin.get('/api/tasks?includeDone=1')).body.map((t: any) => t.id)).not.toContain(secretTask.id);
    expect((await bAdmin.get(`/api/reports/individual?userId=${A.users.emp}&kind=week`)).status).toBe(403);
    expect((await bAdmin.post('/api/exports', { format: 'pdf', report: 'individual', params: { userId: A.users.emp, start: '2026-09-01', end: '2026-09-30' } })).status).toBe(403);
    expect((await bAdmin.get(`/api/admin/routine/${A.users.emp}`)).status).toBe(403);
    expect((await bAdmin.get('/api/admin/routine')).body.rows.map((r: any) => r.user.id)).not.toContain(A.users.emp);
  });
  it('row-level security blocks cross-tenant reads even if application code forgets a filter', async () => {
    const rows = await withTenant(B.tenantId, (db) => db.query(`select id from tasks where id = $1`, [secretTask.id]));
    expect(rows.rowCount).toBe(0);
    const unscoped = await pools().app.query(`select count(*)::int n from tasks`);
    expect(unscoped.rows[0].n).toBe(0); // no tenant context => nothing visible to the app role
    await expect(withTenant(B.tenantId, (db) => db.query(`insert into tasks (tenant_id, title, owner_id) values ($1,'x',$2)`, [A.tenantId, A.users.emp]))).rejects.toThrow(/row-level security/);
  });
});

describe('role scoping', () => {
  it('employees see only their own analytics; managers only their team; the main admin everyone', async () => {
    expect((await aOut.get(`/api/reports/individual?userId=${A.users.emp}`)).status).toBe(403);
    expect((await aOut.get('/api/admin/routine')).status).toBe(403);
    expect((await aMgr.get(`/api/reports/individual?userId=${A.users.emp}`)).status).toBe(200);
    expect((await aMgr.get(`/api/reports/individual?userId=${A.users.outsider}`)).status).toBe(403);
    const team = (await aMgr.get('/api/admin/routine')).body;
    expect(team.scope).toBe('team'); expect(team.rows.map((r: any) => r.user.id).sort()).toEqual([A.users.emp, A.users.emp2, A.users.manager].sort());
    const all = (await aAdmin.get('/api/admin/routine')).body;
    expect(all.scope).toBe('company'); expect(all.rows).toHaveLength(6);
    expect((await aOut.get(`/api/time-entries?from=2026-01-01T00:00:00Z&to=2030-01-01T00:00:00Z&userId=${A.users.emp}`)).status).toBe(403);
  });
  it('founder visibility follows the declared policy', async () => {
    expect((await aAdmin.get(`/api/reports/individual?userId=${A.users.founder}`)).status).toBe(200);
    expect((await bAdmin.get(`/api/reports/individual?userId=${B.users.founder}`)).status).toBe(403);
    expect((await bAdmin.get('/api/admin/routine')).body.rows.map((r: any) => r.user.id)).not.toContain(B.users.founder);
  });
  it('admin task visibility does not reveal restricted evidence', async () => {
    const asAdmin = (await aAdmin.get(`/api/tasks/${secretTask.id}`)).body;
    expect(asAdmin.evidence[0]).toMatchObject({ hidden: true, label: 'Confidential reference' });
    expect(asAdmin.evidence[0].source_reference).toBeUndefined();
    const asOwner = (await aEmp.get(`/api/tasks/${secretTask.id}`)).body;
    expect(asOwner.evidence[0].source_reference).toBe('HR-9');
  });
  it('managers cannot edit an employee recap or time entry', async () => {
    const e = (await aEmp.post('/api/time-entries', { category: 'admin', startedAt: new Date(Date.now() - 3600e3).toISOString(), endedAt: new Date(Date.now() - 1800e3).toISOString() })).body.entry;
    expect((await aMgr.patch(`/api/time-entries/${e.id}`, { note: 'x', version: e.version, reason: 'override' })).status).toBe(403);
    expect((await aMgr.del(`/api/time-entries/${e.id}`, { reason: 'x' })).status).toBe(403);
  });
  it('non-admins cannot change roles or organization policy', async () => {
    expect((await aEmp.patch(`/api/admin/users/${A.users.emp}`, { roles: ['member', 'routine_admin'] })).status).toBe(403);
    expect((await aMgr.patch('/api/admin/tenant', { settings: { ai_enabled: true } })).status).toBe(403);
    expect((await aEmp.get('/api/admin/audit')).status).toBe(403);
  });
});

describe('session and request protections', () => {
  it('rejects unauthenticated and cross-site style requests', async () => {
    const app = await getApp();
    expect((await app.inject({ method: 'GET', url: '/api/my-day' })).statusCode).toBe(401);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'content-type': 'application/json' }, payload: { organization: A.slug, email: `emp@${A.slug}.test`, password: 'x' } });
    expect(login.statusCode).toBe(403); // missing x-requested-with
    const bad = await client('').post('/api/auth/login', { organization: A.slug, email: `emp@${A.slug}.test`, password: 'wrong-password' });
    expect(bad.status).toBe(401);
  });
  it('deactivated users lose access immediately', async () => {
    const out = await login(A, 'emp2');
    expect((await out.get('/api/me')).status).toBe(200);
    await aAdmin.patch(`/api/admin/users/${A.users.emp2}`, { status: 'deactivated' });
    expect((await out.get('/api/me')).status).toBe(401);
    await aAdmin.patch(`/api/admin/users/${A.users.emp2}`, { status: 'active' });
  });
});

describe('audit', () => {
  it('audit log is append-only and tampering is detected by the hash chain', async () => {
    await drainJobs();
    expect((await aAdmin.get('/api/admin/audit/verify')).body.ok).toBe(true);
    await expect(withOwner((db) => db.query(`update audit_events set reason = 'x' where tenant_id = $1`, [A.tenantId]))).rejects.toThrow(/append-only/);
    // Simulate a privileged operator bypassing the trigger: the chain check must catch it.
    await withOwner(async (db) => {
      await db.query('alter table audit_events disable trigger audit_no_update');
      await db.query(`update audit_events set reason = 'tampered' where id = (select min(id) from audit_events where tenant_id = $1)`, [A.tenantId]);
      await db.query('alter table audit_events enable trigger audit_no_update');
    });
    const v = await withTenant(A.tenantId, (db) => verifyAuditChain(db, A.tenantId));
    expect(v.ok).toBe(false);
  });
});

describe('organization data export and MFA', () => {
  it('admin data export contains records but never secrets', async () => {
    const r = await aAdmin.get('/api/admin/export-data');
    expect(r.status).toBe(200);
    const text = JSON.stringify(r.body);
    expect(r.body.tasks.length).toBeGreaterThan(0);
    expect(text).not.toMatch(/password_hash|mfa_secret|secret_enc|token_hash|scrypt\$/);
    expect((await aEmp.get('/api/admin/export-data')).status).toBe(403);
  });
  it('two-step verification gates sign-in until a valid TOTP code is given', async () => {
    const { totp } = await import('../server/src/lib/crypto.js');
    const u = await login(A, 'outsider');
    const setup = (await u.post('/api/me/mfa/setup')).body;
    expect(setup.qr).toMatch(/^data:image\/png;base64,/);
    expect((await u.post('/api/me/mfa/enable', { code: '000000' })).status).toBe(400);
    expect((await u.post('/api/me/mfa/enable', { code: totp(setup.secret) })).status).toBe(200);
    const app = await getApp();
    const first = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-requested-with': 'fetch', 'content-type': 'application/json' },
      payload: { organization: A.slug, email: `outsider@${A.slug}.test`, password: 'test-password-123' } });
    expect(first.json()).toEqual({ mfaRequired: true });
    const pending = client(`tt_sid=${first.cookies.find((c) => c.name === 'tt_sid')!.value}`);
    expect((await pending.get('/api/me')).status).toBe(401);
    expect((await pending.post('/api/auth/mfa', { code: '123456' })).status).toBe(401);
    const ok = await app.inject({ method: 'POST', url: '/api/auth/mfa', headers: { cookie: `tt_sid=${first.cookies.find((c) => c.name === 'tt_sid')!.value}`, 'x-requested-with': 'fetch', 'content-type': 'application/json' },
      payload: { code: totp(setup.secret) } });
    expect(ok.statusCode).toBe(200);
    const full = client(`tt_sid=${ok.cookies.find((c) => c.name === 'tt_sid')!.value}`);
    expect((await full.get('/api/me')).body.user.mfa_enabled).toBe(true);
  });
});
