import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { DateTime } from 'luxon';
import { beforeAll, describe, expect, it } from 'vitest';
import { login, makeOrg, pastWorkday, withOwner, type Org } from './helpers.js';
import { ICON_DIR, ICONS, renderScanlines } from '../server/src/services/ext/pwa-icons.js';

let org: Org; let emp: any; let emp2: any;
beforeAll(async () => {
  org = await makeOrg();
  [emp, emp2] = await Promise.all([login(org, 'emp'), login(org, 'emp2')]);
});
const rid = (s: string) => `test-${s}-${Math.random().toString(36).slice(2, 10)}`;
const countByRequest = (id: string) => withOwner(async (db) => Number((await db.query(`select count(*) n from tasks where tenant_id = $1 and client_request_id = $2`, [org.tenantId, id])).rows[0].n));

describe('idempotent task creation (clientRequestId)', () => {
  it('returns the same task when the same creator retries the same id', async () => {
    const id = rid('same');
    const a = await emp.post('/api/tasks', { title: 'Offline capture retry', clientRequestId: id, sourceType: 'quick_capture' });
    expect(a.status).toBe(200);
    const b = await emp.post('/api/tasks', { title: 'Offline capture retry (edited on retry)', clientRequestId: id, sourceType: 'quick_capture' });
    expect(b.status).toBe(200);
    expect(b.body.id).toBe(a.body.id);
    expect(b.body.replayed).toBe(true);
    expect(b.body.title).toBe('Offline capture retry');
    expect(await countByRequest(id)).toBe(1);
  });

  it('isolates ids per creator: another person with the same id gets their own task', async () => {
    const id = rid('shared');
    const mine = await emp.post('/api/tasks', { title: 'Emp capture', clientRequestId: id });
    const theirs = await emp2.post('/api/tasks', { title: 'Emp2 capture', clientRequestId: id });
    expect(theirs.status).toBe(200);
    expect(theirs.body.id).not.toBe(mine.body.id);
    expect(theirs.body.title).toBe('Emp2 capture');
    expect(theirs.body.owner_id).toBe(org.users.emp2);
    expect(await countByRequest(id)).toBe(2);
  });

  it('creates exactly one task when the same id arrives concurrently', async () => {
    const id = rid('race');
    const rs = await Promise.all([1, 2, 3, 4].map(() => emp.post('/api/tasks', { title: 'Concurrent retry', clientRequestId: id })));
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(new Set(rs.map((r) => r.body.id)).size).toBe(1);
    expect(await countByRequest(id)).toBe(1);
  });

  it('records one audit event and still creates normally without an id', async () => {
    const id = rid('audit');
    const a = await emp.post('/api/tasks', { title: 'Audited capture', clientRequestId: id });
    await emp.post('/api/tasks', { title: 'Audited capture', clientRequestId: id });
    const n = await withOwner(async (db) => Number((await db.query(`select count(*) n from audit_events where tenant_id = $1 and action = 'task.create' and resource_id = $2`, [org.tenantId, a.body.id])).rows[0].n));
    expect(n).toBe(1);
    const x = await emp.post('/api/tasks', { title: 'No id' }); const y = await emp.post('/api/tasks', { title: 'No id' });
    expect(x.body.id).not.toBe(y.body.id);
  });

  it('rejects malformed ids', async () => {
    expect((await emp.post('/api/tasks', { title: 'Bad id', clientRequestId: 'short' })).status).toBe(400);
    expect((await emp.post('/api/tasks', { title: 'Bad id', clientRequestId: "x'; drop table tasks;--" })).status).toBe(400);
  });
});

describe('offline outbox sync (POST /api/pwa/captures)', () => {
  it('resolves relative dates against the capture day and replays without duplicating', async () => {
    const yesterday = pastWorkday(org.tz, 1);
    const body = { clientRequestId: rid('outbox'), text: 'Call courier about sample pack today 20m !high', capturedAt: yesterday.set({ hour: 18 }).toUTC().toISO() };
    const a = await emp.post('/api/pwa/captures', body);
    expect(a.status).toBe(200);
    expect(a.body.replayed).toBe(false);
    expect(a.body.task).toMatchObject({ title: 'Call courier about sample pack', due_date: yesterday.toISODate(), estimate_minutes: 20, priority: 'high', source_type: 'quick_capture' });
    expect(a.body.task.source_ref).toMatchObject({ channel: 'offline_outbox' });
    const b = await emp.post('/api/pwa/captures', body);
    expect(b.body.replayed).toBe(true);
    expect(b.body.task.id).toBe(a.body.task.id);
    expect(await countByRequest(body.clientRequestId)).toBe(1);
  });

  it('finds the task when the online request committed but its response was lost', async () => {
    const id = rid('lost');
    const online = await emp.post('/api/tasks', { title: 'Prepare stand-up notes', clientRequestId: id });
    const queued = await emp.post('/api/pwa/captures', { clientRequestId: id, text: 'Prepare stand-up notes', capturedAt: new Date().toISOString() });
    expect(queued.body).toMatchObject({ replayed: true, task: { id: online.body.id } });
  });

  it("adds to today's plan only when captured today, and reports unknown shortcuts", async () => {
    const today = await emp.post('/api/pwa/captures', { clientRequestId: rid('today'), text: 'Draft vendor reply #NOPE', capturedAt: new Date().toISOString(), addToMyDay: true });
    expect(today.body.addedToMyDay).toBe(true);
    expect(today.body.warnings).toContain('No project with key NOPE');
    const day = await emp.get('/api/my-day');
    expect(day.body.intendedOutcomes.map((x: any) => x.id)).toContain(today.body.task.id);
    const old = await emp.post('/api/pwa/captures', { clientRequestId: rid('old'), text: 'Old idea', capturedAt: DateTime.now().minus({ days: 3 }).toISO(), addToMyDay: true });
    expect(old.body.addedToMyDay).toBe(false);
  });

  it('clamps a future capture time to now and validates input', async () => {
    const future = await emp.post('/api/pwa/captures', { clientRequestId: rid('future'), text: 'Time traveller today', capturedAt: DateTime.now().plus({ days: 5 }).toISO() });
    expect(future.body.task.due_date).toBe(DateTime.now().setZone(org.tz).toISODate());
    expect((await emp.post('/api/pwa/captures', { clientRequestId: rid('bad'), text: '   ', capturedAt: new Date().toISOString() })).status).toBe(400);
    expect((await emp.post('/api/pwa/captures', { clientRequestId: rid('bad'), text: 'x', capturedAt: 'yesterday' })).status).toBe(400);
    expect((await emp.post('/api/pwa/captures', { clientRequestId: rid('bad'), text: '#OPS !high', capturedAt: new Date().toISOString() })).status).toBe(400);
  });

  it('requires a session', async () => {
    const { getApp } = await import('./helpers.js');
    const r = await (await getApp()).inject({ method: 'POST', url: '/api/pwa/captures', headers: { 'x-requested-with': 'fetch', 'content-type': 'application/json' },
      payload: { clientRequestId: rid('anon'), text: 'Anonymous', capturedAt: new Date().toISOString() } });
    expect(r.statusCode).toBe(401);
  });
});

describe('installable app assets', () => {
  const pub = resolve(import.meta.dirname, '../web/public');
  it('manifest lists committed icons that match the generator output', () => {
    const m = JSON.parse(readFileSync(resolve(pub, 'manifest.webmanifest'), 'utf8'));
    expect(m).toMatchObject({ short_name: 'Tasks', display: 'standalone', start_url: '/' });
    expect(m.icons.some((i: any) => i.purpose === 'maskable')).toBe(true);
    for (const icon of ICONS) {
      const png = readFileSync(resolve(ICON_DIR, icon.file));
      expect(png.subarray(1, 4).toString('ascii')).toBe('PNG');
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([icon.size, icon.size]);
      const idat: Buffer[] = []; let o = 8;
      while (o < png.length) { const len = png.readUInt32BE(o); if (png.toString('ascii', o + 4, o + 8) === 'IDAT') idat.push(png.subarray(o + 8, o + 8 + len)); o += 12 + len; }
      expect(inflateSync(Buffer.concat(idat)).equals(renderScanlines(icon.size, icon.maskable))).toBe(true);
      const listed = m.icons.find((i: any) => i.src === `/icons/${icon.file}`);
      if (listed) expect(listed.sizes).toBe(`${icon.size}x${icon.size}`);
    }
  });
  it('service worker never intercepts API traffic', () => {
    const sw = readFileSync(resolve(pub, 'sw.js'), 'utf8');
    expect(sw).toMatch(/url\.pathname\.startsWith\('\/api\/'\)\) return;/);
  });
});
