import { beforeAll, describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { SESSION_COOKIE } from '../server/src/app.js';
import { hashPassword } from '../server/src/lib/crypto.js';
import { withTenant } from '../server/src/lib/db.js';
import { contrastWithWhite, nearestAccessibleShade, validateLogo } from '../server/src/services/ext/clientbrand-brand.js';
import { createWeeklyDrafts } from '../server/src/services/ext/clientbrand.js';
import { PASSWORD, client, drainJobs, getApp, login, makeOrg, withOwner, type Org } from './helpers.js';

// 1x1 transparent PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const SAFE_SVG = '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><linearGradient id="g"><stop offset="0" stop-color="#0f766e"/></linearGradient></defs><rect width="10" height="10" fill="url(#g)"/><use href="#g"/></svg>';

async function cookieFor(org: Org, key: string) {
  const app = await getApp();
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-requested-with': 'fetch', 'content-type': 'application/json' },
    payload: { organization: org.slug, email: `${key}@${org.slug}.test`, password: PASSWORD } });
  return `${SESSION_COOKIE}=${r.cookies.find((x) => x.name === SESSION_COOKIE)!.value}`;
}
async function upload(cookie: string, data: Buffer | string, filename = 'logo.bin', mime = 'application/octet-stream') {
  const app = await getApp();
  const boundary = `----cb${Math.random().toString(16).slice(2)}`;
  const payload = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`),
    Buffer.isBuffer(data) ? data : Buffer.from(data), Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const r = await app.inject({ method: 'POST', url: '/api/branding/logo', headers: { cookie, 'x-requested-with': 'fetch', 'content-type': `multipart/form-data; boundary=${boundary}` }, payload });
  return { status: r.statusCode, body: JSON.parse(r.body) };
}

let org: Org; let other: Org;
let admin: any, mgr: any, emp: any, founder: any, clientA: any, clientB: any, otherAdmin: any;
let adminCookie: string;
const ids: Record<string, string> = {};

beforeAll(async () => {
  org = await makeOrg(); other = await makeOrg();
  const hash = await hashPassword(PASSWORD);
  const now = DateTime.now();
  await withOwner(async (db) => {
    const T = org.tenantId;
    const q1 = async (sql: string, p: unknown[]) => (await db.query(sql, p)).rows[0];
    ids.custA = (await q1(`insert into customers (tenant_id, name) values ($1,'Acme (test client)') returning id`, [T])).id;
    ids.custB = (await q1(`insert into customers (tenant_id, name) values ($1,'Beta (test client)') returning id`, [T])).id;
    for (const [key, cust] of [['clienta', ids.custA], ['clientb', ids.custB]])
      await db.query(`insert into users (tenant_id, email, name, password_hash, roles, customer_id) values ($1,$2,$3,$4,array['customer'],$5)`, [T, `${key}@${org.slug}.test`, key, hash, cust]);
    ids.projA = (await q1(`insert into projects (tenant_id, key, name, customer_id, owner_id, business_outcome) values ($1,'ACME','Acme portal',$2,$3,'Self-service orders') returning id`, [T, ids.custA, org.users.manager])).id;
    ids.projB = (await q1(`insert into projects (tenant_id, key, name, customer_id, owner_id) values ($1,'BETA','Beta rollout',$2,$3) returning id`, [T, ids.custB, org.users.manager])).id;
    ids.internalProj = (await q1(`insert into projects (tenant_id, key, name, owner_id) values ($1,'INT','Internal ops',$2) returning id`, [T, org.users.manager])).id;
    ids.msShared = (await q1(`insert into milestones (tenant_id, project_id, name, due_date) values ($1,$2,'Beta launch',$3) returning id`, [T, ids.projA, now.plus({ days: 10 }).toISODate()])).id;
    ids.msInternal = (await q1(`insert into milestones (tenant_id, project_id, name) values ($1,$2,'Internal hardening INTERNALMS') returning id`, [T, ids.projA])).id;
    const task = async (title: string, o: { visible: boolean; status: string; doneAgoDays?: number; dueIn?: number; ms?: string; project?: string }) => (await q1(
      `insert into tasks (tenant_id, project_id, milestone_id, title, owner_id, created_by, status, customer_visible, done_at, accepted_at, due_date, estimate_minutes, description)
       values ($1,$2,$3,$4,$5,$5,$6,$7,$8,$8,$9,240,'internal description SECRETDESC') returning id`,
      [T, o.project ?? ids.projA, o.ms ?? null, title, org.users.emp, o.status, o.visible, o.doneAgoDays !== undefined ? now.minus({ days: o.doneAgoDays }).toJSDate() : null,
       o.dueIn !== undefined ? now.plus({ days: o.dueIn }).toISODate() : null])).id;
    ids.doneShared = await task('Order status API', { visible: true, status: 'done', doneAgoDays: 0, ms: ids.msShared });
    ids.doneOld = await task('Old shared deliverable OLDDONE', { visible: true, status: 'done', doneAgoDays: 30, ms: ids.msShared });
    ids.openShared = await task('Tracking page UI', { visible: true, status: 'in_progress', dueIn: 5, ms: ids.msShared });
    ids.farShared = await task('Far future FARFUTURE', { visible: true, status: 'planned', dueIn: 90 });
    ids.doneInternal = await task('Salary benchmark SECRETDONE', { visible: false, status: 'done', doneAgoDays: 0, ms: ids.msInternal });
    ids.openInternal = await task('Refactor auth SECRETOPEN', { visible: false, status: 'planned', dueIn: 3, ms: ids.msShared });
    await task('Beta shared item', { visible: true, status: 'done', doneAgoDays: 0, project: ids.projB });
    await db.query(`insert into comments (tenant_id, task_id, author_id, body) values ($1,$2,$3,'internal note SECRETNOTE')`, [T, ids.doneShared, org.users.manager]);
    await db.query(`insert into time_entries (tenant_id, user_id, task_id, category, started_at, ended_at, source, note) values ($1,$2,$3,'task',now() - interval '2 hours', now() - interval '1 hour', 'manual', 'SECRETTIME')`,
      [T, org.users.emp, ids.doneShared]);
  });
  [admin, mgr, emp, founder, clientA, clientB, otherAdmin] = await Promise.all([login(org, 'admin'), login(org, 'manager'), login(org, 'emp'), login(org, 'founder'),
    login(org, 'clienta'), login(org, 'clientb'), login(other, 'admin')]);
  adminCookie = await cookieFor(org, 'admin');
});

describe('branding: accent contrast enforcement', () => {
  it('computes WCAG contrast and the nearest darker accessible shade', () => {
    expect(contrastWithWhite('#256abf')).toBeGreaterThan(5.3);
    for (const c of ['#7fb2ff', '#ffcc00', '#22c55e', '#ff6b6b', '#ffffff', '#00ffff']) {
      const s = nearestAccessibleShade(c);
      expect(contrastWithWhite(s)).toBeGreaterThanOrEqual(4.5);
      expect(contrastWithWhite(s)).toBeLessThan(5.2); // nearest, not just "black"
    }
    expect(nearestAccessibleShade('#256abf')).toBe('#256abf');
  });
  it('rejects an inaccessible accent with a suggestion, accepts the suggestion, and enforces version + role', async () => {
    const b0 = (await admin.get('/api/branding')).body;
    expect(b0).toMatchObject({ accent: null, logo: null, canEdit: true, version: 0 });
    const bad = await admin.put('/api/branding', { displayName: 'Acme Holdings', accent: '#7FB2FF', version: b0.version });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('contrast');
    expect(contrastWithWhite(bad.body.details.suggestion)).toBeGreaterThanOrEqual(4.5);
    expect((await admin.get('/api/branding')).body.accent).toBeNull();
    const ok = await admin.put('/api/branding', { displayName: 'Acme Holdings', accent: bad.body.details.suggestion, version: b0.version });
    expect(ok.status).toBe(200);
    const b1 = (await emp.get('/api/branding')).body;
    expect(b1).toMatchObject({ displayName: 'Acme Holdings', accent: bad.body.details.suggestion, canEdit: false });
    expect((await emp.get('/api/me')).body.tenant.name).toBe('Acme Holdings');
    expect((await admin.put('/api/branding', { displayName: 'Stale', accent: null, version: b0.version })).status).toBe(409);
    expect((await admin.put('/api/branding', { displayName: 'Acme Holdings', accent: 'red', version: b1.version })).status).toBe(400);
    expect((await mgr.put('/api/branding', { displayName: 'Hijack', accent: '#000000', version: b1.version })).status).toBe(403);
    expect((await clientA.put('/api/branding', { displayName: 'Hijack', accent: '#000000', version: b1.version })).status).toBe(403);
    const audit = await withOwner(async (db) => (await db.query(`select details from audit_events where tenant_id = $1 and action = 'branding.update'`, [org.tenantId])).rows);
    expect(audit).toHaveLength(1);
  });
});

describe('branding: logo validation and authorization', () => {
  it('validates logos by content and rejects scripts, links and oversize files', () => {
    expect(validateLogo(PNG)).toEqual({ mime: 'image/png' });
    expect(validateLogo(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]))).toEqual({ mime: 'image/jpeg' });
    expect(validateLogo(Buffer.from(SAFE_SVG))).toEqual({ mime: 'image/svg+xml' });
    const bad = [
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><rect x="1>" onclick="alert(1)"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><SCRIPT>alert(1)</SCRIPT></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><svg:script>alert(1)</svg:script></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><iframe src="https://x.example"/></foreignObject></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><use href="https://x.example/a.svg#i"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><use xlink:href="&#106;avascript:alert(1)"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,AAAA"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><style>@import url(https://x.example/a.css);</style></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:url(https://x.example/p)"/></svg>',
      '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x "y">]><svg xmlns="http://www.w3.org/2000/svg"/>',
      '<?xml version="1.0"?><?xml-stylesheet href="https://x.example/a.css"?><svg xmlns="http://www.w3.org/2000/svg"/>',
    ];
    for (const s of bad) expect(validateLogo(Buffer.from(s)), s).toHaveProperty('error');
    expect(validateLogo(Buffer.from('hello world'))).toHaveProperty('error');
    expect(validateLogo(Buffer.concat([PNG, Buffer.alloc(201 * 1024)]))).toEqual({ error: 'Logo must be 200 KB or smaller.' });
  });

  it('only a system admin uploads; signed-in users of the tenant (incl. clients) can fetch it; other tenants cannot', async () => {
    const mgrCookie = await cookieFor(org, 'manager');
    expect((await upload(mgrCookie, PNG, 'logo.png', 'image/png')).status).toBe(403);
    const scripted = await upload(adminCookie, '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>', 'logo.svg', 'image/svg+xml');
    expect(scripted.status).toBe(400);
    expect(scripted.body.message).toMatch(/event handler/);
    const big = await upload(adminCookie, Buffer.concat([PNG, Buffer.alloc(220 * 1024)]), 'big.png', 'image/png');
    expect(big.status).toBe(400);
    expect(big.body.message).toMatch(/200 KB/);
    // Declared as PNG but actually HTML: content wins and it is rejected.
    expect((await upload(adminCookie, '<html><script>alert(1)</script></html>', 'x.png', 'image/png')).status).toBe(400);

    const ok = await upload(adminCookie, SAFE_SVG, 'logo.svg', 'image/svg+xml');
    expect(ok.status).toBe(200);
    expect(ok.body.logo.mime).toBe('image/svg+xml');
    const f = await emp.get(ok.body.logo.url);
    expect(f.status).toBe(200);
    expect(f.headers['content-type']).toBe('image/svg+xml');
    expect(String(f.headers['content-security-policy'])).toContain('sandbox');
    expect((await clientA.get('/api/branding/logo')).status).toBe(200);
    expect((await otherAdmin.get('/api/branding/logo')).status).toBe(404);
    expect((await client('tt_sid=nope').get('/api/branding/logo')).status).toBe(401);
    const stored = await withOwner(async (db) => (await db.query(`select purpose, tenant_id from stored_files where id = (select logo_file_id from tenant_branding where tenant_id = $1)`, [org.tenantId])).rows[0]);
    expect(stored).toMatchObject({ purpose: 'branding', tenant_id: org.tenantId });

    expect((await upload(adminCookie, PNG, 'logo.png', 'image/png')).status).toBe(200);
    expect((await emp.get('/api/branding/logo')).headers['content-type']).toBe('image/png');
    expect((await mgr.del('/api/branding/logo')).status).toBe(403);
    expect((await admin.del('/api/branding/logo')).status).toBe(200);
    expect((await emp.get('/api/branding')).body.logo).toBeNull();
    expect((await admin.del('/api/branding/logo')).status).toBe(200);
    expect((await upload(adminCookie, PNG, 'logo.png', 'image/png')).status).toBe(200);
  });

  it('existing PDF exports still render with the branded header', async () => {
    const r = await admin.post('/api/exports', { format: 'pdf', report: 'delivery', params: {} });
    expect(r.status).toBe(200);
    await drainJobs();
    const e = (await admin.get(`/api/exports/${r.body.id}`)).body;
    expect(e.status).toBe('ready');
    const f = await admin.get(`/api/exports/${r.body.id}/file`);
    expect(f.raw.subarray(0, 4).toString()).toBe('%PDF');
  });
});

describe('client updates: draft content', () => {
  let draft: any;
  it('includes only client-visible tasks and milestones, never internal time, notes or people data', async () => {
    const r = await mgr.post('/api/client-updates', { projectId: ids.projA });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'draft', created: true, canEdit: true, projectName: 'Acme portal', customerName: 'Acme (test client)' });
    draft = r.body;
    const h = draft.highlights;
    expect(h.completed.map((t: any) => t.id)).toEqual([ids.doneShared]);
    expect(h.upcoming.map((t: any) => t.id)).toEqual([ids.openShared]);
    expect(h.milestones.map((m: any) => m.id)).toEqual([ids.msShared]);
    expect(h.milestones[0]).toMatchObject({ done: 2, total: 3 });
    const json = JSON.stringify(draft.highlights);
    for (const secret of ['SECRET', 'INTERNALMS', 'OLDDONE', 'FARFUTURE', 'Emp', org.users.emp, 'minutes', 'estimate', 'owner'])
      expect(json, secret).not.toContain(secret);
    // Idempotent per project + period
    const again = await mgr.post('/api/client-updates', { projectId: ids.projA });
    expect(again.body).toMatchObject({ id: draft.id, created: false });
  });
  it('drops items that stop being shared before publishing', async () => {
    await withOwner((db) => db.query(`update tasks set customer_visible = false where id = $1`, [ids.openShared]));
    const v = (await mgr.get(`/api/client-updates/${draft.id}`)).body;
    expect(v.highlights.upcoming).toEqual([]);
    await withOwner((db) => db.query(`update tasks set customer_visible = true where id = $1`, [ids.openShared]));
  });
  it('lets the owner edit the summary and remove items, with optimistic versioning', async () => {
    const e = await mgr.patch(`/api/client-updates/${draft.id}`, { version: draft.version, summary: 'API shipped; tracking UI next.', removeItemIds: [ids.openShared] });
    expect(e.status).toBe(200);
    expect(e.body.summary).toBe('API shipped; tracking UI next.');
    expect(e.body.highlights.upcoming).toEqual([]);
    expect((await mgr.patch(`/api/client-updates/${draft.id}`, { version: draft.version, summary: 'stale' })).status).toBe(409);
    const re = await mgr.post(`/api/client-updates/${draft.id}/refresh`, { version: e.body.version });
    expect(re.body.highlights.upcoming.map((t: any) => t.id)).toEqual([ids.openShared]);
    expect(re.body.summary).toBe('API shipped; tracking UI next.');
    draft = re.body;
  });
  it('only accepts client projects', async () => {
    expect((await mgr.post('/api/client-updates', { projectId: ids.internalProj })).status).toBe(404);
    expect((await mgr.post('/api/client-updates', { projectId: ids.projA, periodStart: '2026-05-10', periodEnd: '2026-05-01' })).status).toBe(400);
  });

  describe('publish permissions', () => {
    it('employees who do not own the project cannot prepare, see or publish updates', async () => {
      expect((await emp.post('/api/client-updates', { projectId: ids.projA })).status).toBe(403);
      expect((await emp.get(`/api/client-updates/${draft.id}`)).status).toBe(404);
      expect((await emp.post(`/api/client-updates/${draft.id}/publish`, { version: draft.version })).status).toBe(404);
      expect((await emp.get('/api/client-updates')).body).toEqual([]);
      expect((await emp.get('/api/client-updates/projects')).body).toEqual([]);
      expect((await clientA.post(`/api/client-updates/${draft.id}/publish`, { version: draft.version })).status).toBe(404);
      expect((await clientA.post('/api/client-updates', { projectId: ids.projA })).status).toBe(403);
      expect((await clientA.get('/api/client-updates/projects')).status).toBe(403);
    });
    it('requires a summary, then the owner publishes explicitly; published updates are immutable until unpublished', async () => {
      const blank = (await founder.post('/api/client-updates', { projectId: ids.projB })).body;
      expect(blank.canEdit).toBe(true);
      expect((await founder.post(`/api/client-updates/${blank.id}/publish`, { version: blank.version })).status).toBe(400);
      expect((await mgr.post(`/api/client-updates/${draft.id}/publish`, { version: draft.version - 1 })).status).toBe(409);
      const p = await mgr.post(`/api/client-updates/${draft.id}/publish`, { version: draft.version });
      expect(p.status).toBe(200);
      expect(p.body).toMatchObject({ status: 'published', publishedByName: 'Manager' });
      expect((await mgr.patch(`/api/client-updates/${draft.id}`, { version: p.body.version, summary: 'x' })).status).toBe(409);
      expect((await mgr.del(`/api/client-updates/${draft.id}`, { version: p.body.version })).status).toBe(409);
      const n = await withOwner(async (db) => (await db.query(`select n.title from notifications n join users u on u.id = n.user_id where u.email = $1 and n.kind = 'client_update'`, [`clienta@${org.slug}.test`])).rows);
      expect(n).toHaveLength(1);
      const a = await withOwner(async (db) => (await db.query(`select actor_id from audit_events where tenant_id = $1 and action = 'client_update.publish' and resource_id = $2`, [org.tenantId, draft.id])).rows);
      expect(a).toEqual([{ actor_id: org.users.manager }]);
      // Unpublish needs a reason, returns to draft; system admin can re-publish.
      expect((await mgr.post(`/api/client-updates/${draft.id}/unpublish`, { version: p.body.version })).status).toBe(400);
      const u = await mgr.post(`/api/client-updates/${draft.id}/unpublish`, { version: p.body.version, reason: 'Typo in summary' });
      expect(u.body.status).toBe('draft');
      expect((await clientA.get(`/api/client-updates/${draft.id}`)).status).toBe(404);
      const again = await admin.post(`/api/client-updates/${draft.id}/publish`, { version: u.body.version });
      expect(again.body.status).toBe('published');
      draft = again.body;
      // Discard works for drafts only
      expect((await founder.del(`/api/client-updates/${blank.id}`, { version: blank.version })).status).toBe(200);
    });
  });

  describe('customer isolation', () => {
    it('the client sees only published updates of its own projects, with exactly the client view', async () => {
      const pending = (await mgr.post('/api/client-updates', { projectId: ids.projA, periodStart: '2026-01-05', periodEnd: '2026-01-11' })).body;
      expect(pending.status).toBe('draft');
      const list = (await clientA.get('/api/client-updates')).body;
      expect(list.map((x: any) => x.id)).toEqual([draft.id]);
      expect(list[0]).not.toHaveProperty('status');
      expect(list[0]).not.toHaveProperty('createdByName');
      const d = await clientA.get(`/api/client-updates/${draft.id}`);
      expect(d.status).toBe(200);
      expect(d.body.summary).toBe('API shipped; tracking UI next.');
      expect((await clientA.get(`/api/client-updates/${pending.id}`)).status).toBe(404);
      expect((await clientA.get(`/api/client-updates/${pending.id}/pdf`)).status).toBe(404);
      const pdf = await clientA.get(`/api/client-updates/${draft.id}/pdf`);
      expect(pdf.status).toBe(200);
      expect(pdf.headers['content-type']).toBe('application/pdf');
      expect(pdf.raw.subarray(0, 4).toString()).toBe('%PDF');
      // Staff can download a draft PDF (marked DRAFT) for review.
      const draftPdf = await mgr.get(`/api/client-updates/${pending.id}/pdf`);
      expect(draftPdf.status).toBe(200);
      expect(String(draftPdf.headers['content-disposition'])).toContain('DRAFT');
    });
    it('another client of the same organization and other organizations see nothing', async () => {
      expect((await clientB.get('/api/client-updates')).body).toEqual([]);
      expect((await clientB.get(`/api/client-updates/${draft.id}`)).status).toBe(404);
      expect((await clientB.get(`/api/client-updates/${draft.id}/pdf`)).status).toBe(404);
      expect((await clientB.get(`/api/client-updates?projectId=${ids.projA}`)).body).toEqual([]);
      expect((await otherAdmin.get(`/api/client-updates/${draft.id}`)).status).toBe(404);
      expect((await otherAdmin.get('/api/client-updates')).body).toEqual([]);
    });
    it('archived projects disappear from the portal', async () => {
      await withOwner((db) => db.query(`update projects set status = 'archived' where id = $1`, [ids.projA]));
      expect((await clientA.get('/api/client-updates')).body).toEqual([]);
      expect((await clientA.get(`/api/client-updates/${draft.id}`)).status).toBe(404);
      await withOwner((db) => db.query(`update projects set status = 'active' where id = $1`, [ids.projA]));
    });
  });
});

describe('weekly drafts tick', () => {
  it('is off by default, then prepares (never publishes) one draft per client project per week', async () => {
    const friday = DateTime.fromISO('2026-09-25T13:00', { zone: org.tz });
    expect(await withTenant(org.tenantId, (db) => createWeeklyDrafts(db, org.tenantId, friday))).toBe(0);
    expect((await mgr.put('/api/client-updates/settings', { weeklyDrafts: true })).status).toBe(403);
    expect((await admin.put('/api/client-updates/settings', { weeklyDrafts: true })).status).toBe(200);
    expect(await withTenant(org.tenantId, (db) => createWeeklyDrafts(db, org.tenantId, friday.minus({ days: 1 })))).toBe(0);
    expect(await withTenant(org.tenantId, (db) => createWeeklyDrafts(db, org.tenantId, friday))).toBe(2);
    expect(await withTenant(org.tenantId, (db) => createWeeklyDrafts(db, org.tenantId, friday.plus({ hours: 2 })))).toBe(0);
    const rows = await withOwner(async (db) => (await db.query(`select status, source, period_start::text, period_end::text from client_updates where tenant_id = $1 and source = 'scheduled'`, [org.tenantId])).rows);
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r).toMatchObject({ status: 'draft', period_start: '2026-09-21', period_end: '2026-09-27' });
    const note = (await mgr.get('/api/client-updates?status=draft')).body.filter((x: any) => x.source === 'scheduled');
    expect(note).toHaveLength(2);
    expect((await clientA.get('/api/client-updates')).body.every((x: any) => x.periodStart !== '2026-09-21')).toBe(true);
  });
  it('runs as a registered tenant job', async () => {
    await withOwner((db) => db.query(`insert into jobs (tenant_id, kind, payload) values ($1, 'clientbrand.weekly', '{}')`, [org.tenantId]));
    await drainJobs();
    const j = await withOwner(async (db) => (await db.query(`select status from jobs where tenant_id = $1 and kind = 'clientbrand.weekly'`, [org.tenantId])).rows);
    expect(j.every((x: any) => x.status === 'succeeded')).toBe(true);
  });
});
