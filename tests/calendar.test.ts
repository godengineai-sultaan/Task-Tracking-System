import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { DateTime } from 'luxon';
import { drainJobs, getApp, login, makeOrg, withOwner, type Org } from './helpers.js';
import { decrypt, sha256 } from '../server/src/lib/crypto.js';
import { enqueue } from '../server/src/lib/jobs.js';
import { type FetchDeps, FetchGuardError, guardedFetch, isPublicAddress } from '../server/src/services/ext/calendar-fetch.js';
import { parseHolidayIcs, setCalendarFetchDeps } from '../server/src/services/ext/calendar.js';

// ---------------------------------------------------------------- local fake network
// A real HTTP server on 127.0.0.1, reached only through the injectable request function; the fake resolver maps names to addresses.
// The guard itself would refuse 127.0.0.1, which is exactly why tests inject the transport instead of using the network.
type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;
const routes = new Map<string, Handler>();
const hits: Record<string, number> = {};
const requested: { host: string; address: string; headers: Record<string, string> }[] = [];
const sockets = new Set<Socket>();
let server: http.Server; let port = 0;
const DNS: Record<string, string[]> = {
  'cal.example.com': ['93.184.216.34'], 'holidays.example.com': ['2606:2800:220:1:248:1893:25c8:1946'],
  'internal.example.com': ['10.1.2.3'], 'mixed.example.com': ['93.184.216.34', '127.0.0.1'], 'meta.example.com': ['169.254.169.254'],
  'cgnat.example.com': ['100.64.0.9'], 'loop6.example.com': ['::1'], 'mapped.example.com': ['::ffff:192.168.0.10'], 'mcast.example.com': ['239.1.1.1'],
};
const fake: FetchDeps = {
  resolve: async (h) => { if (!DNS[h]) throw new Error('ENOTFOUND'); return DNS[h]; },
  request: (url, o) => new Promise((resolve, reject) => {
    requested.push({ host: url.hostname, address: o.address, headers: o.headers });
    const req = http.request({ host: '127.0.0.1', port, path: url.pathname + url.search, headers: { ...o.headers, 'x-test-host': url.hostname }, signal: o.signal });
    req.on('response', (res) => resolve({ status: res.statusCode!, header: (n) => { const v = res.headers[n]; return Array.isArray(v) ? v[0] : v; }, body: res, cancel: () => res.destroy() }));
    req.on('error', reject);
    req.end();
  }),
};
const route = (hostPath: string, h: Handler) => routes.set(hostPath, h);
const fetchErr = async (url: string, opts: Parameters<typeof guardedFetch>[1] = {}) => {
  try { await guardedFetch(url, { deps: fake, ...opts }); } catch (e) { expect(e).toBeInstanceOf(FetchGuardError); return (e as FetchGuardError).code; }
  throw new Error(`expected ${url} to be refused`);
};

const utc = (d: DateTime) => d.toUTC().toFormat("yyyyMMdd'T'HHmmss'Z'");
const vevent = (uid: string, start: DateTime, end: DateTime, summary: string, extra: string[] = []) =>
  ['BEGIN:VEVENT', `UID:${uid}`, `DTSTART:${utc(start)}`, `DTEND:${utc(end)}`, `SUMMARY:${summary}`, ...extra, 'END:VEVENT'];
const cal = (...events: string[][]) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', ...events.flat(), 'END:VCALENDAR'].join('\r\n');
const allDay = (uid: string, start: string, endExcl: string, summary: string, extra: string[] = []) =>
  ['BEGIN:VEVENT', `UID:${uid}`, `DTSTART;VALUE=DATE:${start.replace(/-/g, '')}`, `DTEND;VALUE=DATE:${endExcl.replace(/-/g, '')}`, `SUMMARY:${summary}`, ...extra, 'END:VEVENT'];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const key = `${req.headers['x-test-host']}${req.url}`;
    hits[key] = (hits[key] ?? 0) + 1;
    const h = routes.get(key);
    if (!h) { res.statusCode = 404; res.end('nope'); return; }
    h(req, res);
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as AddressInfo).port;
  setCalendarFetchDeps(fake);
});
afterAll(async () => {
  setCalendarFetchDeps(null);
  for (const s of sockets) s.destroy();
  await new Promise((r) => server.close(r));
});

describe('SSRF guard for calendar addresses', () => {
  it('classifies public and non-public addresses', () => {
    for (const ip of ['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111']) expect(isPublicAddress(ip), ip).toBe(true);
    for (const ip of ['127.0.0.1', '10.0.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '100.127.255.254', '0.0.0.0', '224.0.0.251',
      '255.255.255.255', '198.18.0.1', '168.63.129.16', '::', '::1', 'fe80::1', 'fd00:ec2::254', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::a00:1',
      '2001:db8::1', '2002:7f00:1::1', '2001:0:4136:e378::1', 'not-an-ip']) expect(isPublicAddress(ip), ip).toBe(false);
  });

  it('refuses non-https schemes, credentials and non-standard ports without connecting', async () => {
    const before = requested.length;
    expect(await fetchErr('http://cal.example.com/a.ics')).toBe('not_https');
    expect(await fetchErr('ftp://cal.example.com/a.ics')).toBe('not_https');
    expect(await fetchErr('file:///etc/passwd')).toBe('not_https');
    expect(await fetchErr('https://user:pw@cal.example.com/a.ics')).toBe('credentials');
    expect(await fetchErr('https://cal.example.com:8443/a.ics')).toBe('port');
    expect(await fetchErr('not a url')).toBe('bad_url');
    expect(requested.length).toBe(before);
  });

  it('refuses private, loopback, link-local, CGNAT, multicast and metadata targets, by literal or by DNS', async () => {
    const before = requested.length;
    for (const u of ['https://127.0.0.1/a.ics', 'https://10.0.0.8/', 'https://172.20.1.1/', 'https://192.168.1.1/', 'https://169.254.169.254/latest/meta-data/',
      'https://100.64.0.1/', 'https://224.0.0.1/', 'https://0.0.0.0/', 'https://[::1]/', 'https://[fe80::1]/', 'https://[fd00:ec2::254]/', 'https://[::ffff:127.0.0.1]/',
      'https://2130706433/', 'https://0x7f.0.0.1/', 'https://localhost/', 'https://app.localhost/', 'https://metadata.google.internal/', 'https://intranet/',
      'https://internal.example.com/a.ics', 'https://mixed.example.com/a.ics', 'https://meta.example.com/', 'https://cgnat.example.com/', 'https://loop6.example.com/',
      'https://mapped.example.com/', 'https://mcast.example.com/'])
      expect(await fetchErr(u), u).toBe('private_address');
    expect(await fetchErr('https://unknown.example.com/a.ics')).toBe('dns');
    expect(requested.length).toBe(before);
  });

  it('re-checks every redirect hop: private targets, http downgrades and more than 3 redirects are refused', async () => {
    route('cal.example.com/to-private', (_q, s) => { s.writeHead(302, { location: 'https://internal.example.com/x.ics' }); s.end(); });
    route('cal.example.com/to-meta', (_q, s) => { s.writeHead(307, { location: 'https://169.254.169.254/latest/meta-data/' }); s.end(); });
    route('cal.example.com/to-http', (_q, s) => { s.writeHead(301, { location: 'http://cal.example.com/ok.ics' }); s.end(); });
    route('cal.example.com/loop', (_q, s) => { s.writeHead(302, { location: '/loop' }); s.end(); });
    route('cal.example.com/r1', (_q, s) => { s.writeHead(302, { location: '/r2' }); s.end(); });
    route('cal.example.com/r2', (_q, s) => { s.writeHead(302, { location: 'https://holidays.example.com/r3' }); s.end(); });
    route('holidays.example.com/r3', (_q, s) => { s.writeHead(302, { location: 'https://cal.example.com/ok.ics' }); s.end(); });
    route('cal.example.com/ok.ics', (_q, s) => { s.writeHead(200, { 'content-type': 'text/calendar' }); s.end(cal()); });

    let n = requested.length;
    expect(await fetchErr('https://cal.example.com/to-private')).toBe('private_address');
    expect(requested.slice(n).map((r) => r.host)).toEqual(['cal.example.com']); // the private hop was never contacted
    n = requested.length;
    expect(await fetchErr('https://cal.example.com/to-meta')).toBe('private_address');
    expect(requested.length - n).toBe(1);
    expect(await fetchErr('https://cal.example.com/to-http')).toBe('not_https');
    n = requested.length;
    expect(await fetchErr('https://cal.example.com/loop')).toBe('too_many_redirects');
    expect(requested.length - n).toBe(4); // original + 3 allowed redirects
    const ok = await guardedFetch('https://cal.example.com/r1', { deps: fake });
    expect(ok.status).toBe('ok');
    // Every connection was pinned to the validated address of its own hop.
    expect(requested.slice(-4).map((r) => r.address)).toEqual(['93.184.216.34', '93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946', '93.184.216.34']);
  });

  it('enforces the size cap (declared and streamed), the timeout, and conditional requests', async () => {
    route('cal.example.com/declared-big', (_q, s) => { s.writeHead(200, { 'content-length': String(5 * 1024 * 1024 + 1) }); s.write('BEGIN:VCALENDAR'); });
    route('cal.example.com/streamed-big', (_q, s) => {
      s.writeHead(200, { 'content-type': 'text/calendar' });
      const chunk = Buffer.alloc(64 * 1024, 'a'); let sent = 0;
      const pump = () => { while (sent <= 5 * 1024 * 1024 + chunk.length) { sent += chunk.length; if (!s.write(chunk)) { s.once('drain', pump); return; } } s.end(); };
      s.on('error', () => {}); pump();
    });
    route('cal.example.com/slow', () => { /* never answers */ });
    route('cal.example.com/etag.ics', (q, s) => {
      if (q.headers['if-none-match'] === '"v1"') { s.writeHead(304); s.end(); return; }
      s.writeHead(200, { etag: '"v1"', 'last-modified': 'Tue, 01 Sep 2026 10:00:00 GMT' }); s.end(cal());
    });
    expect(await fetchErr('https://cal.example.com/declared-big')).toBe('too_large');
    expect(await fetchErr('https://cal.example.com/streamed-big')).toBe('too_large');
    expect(await fetchErr('https://cal.example.com/slow', { limits: { timeoutMs: 300 } })).toBe('timeout');
    const first = await guardedFetch('https://cal.example.com/etag.ics', { deps: fake });
    expect(first).toMatchObject({ status: 'ok', etag: '"v1"', lastModified: 'Tue, 01 Sep 2026 10:00:00 GMT' });
    const second = await guardedFetch('https://cal.example.com/etag.ics', { deps: fake, headers: { 'if-none-match': '"v1"' } });
    expect(second.status).toBe('not_modified');
  });
});

describe('ICS URL subscription', () => {
  let org: Org; let emp: any; let emp2: any;
  beforeAll(async () => { org = await makeOrg(); [emp, emp2] = await Promise.all([login(org, 'emp'), login(org, 'emp2')]); });

  it('stores the address encrypted, imports only ended events as confirm-first suggestions, and de-duplicates re-syncs', async () => {
    const now = DateTime.now();
    route('cal.example.com/emp-secret-abc123/basic.ics', (_q, s) => {
      s.writeHead(200, { 'content-type': 'text/calendar' });
      s.end(cal(
        vevent('mtg-1', now.minus({ hours: 2 }), now.minus({ minutes: 90 }), 'Design review', ['DESCRIPTION:Confidential agenda', 'LOCATION:Room 9']),
        vevent('priv-1', now.minus({ hours: 26 }), now.minus({ hours: 25 }), 'Therapy', ['CLASS:PRIVATE']),
        vevent('ongoing-1', now.minus({ minutes: 10 }), now.plus({ minutes: 20 }), 'Ongoing sync'),
        vevent('future-1', now.plus({ days: 1 }), now.plus({ days: 1, hours: 1 }), 'Tomorrow planning'),
        vevent('old-1', now.minus({ days: 10 }), now.minus({ days: 10 }).plus({ hours: 1 }), 'Old meeting'),
      ));
    });
    const secretUrl = 'https://cal.example.com/emp-secret-abc123/basic.ics';
    expect((await emp.put('/api/calendar/subscription', { url: 'http://cal.example.com/emp-secret-abc123/basic.ics' })).status).toBe(400);
    const priv = await emp.put('/api/calendar/subscription', { url: 'https://internal.example.com/cal.ics' });
    expect(priv.status).toBe(400); expect(priv.body.message).toMatch(/private/);

    const r = await emp.put('/api/calendar/subscription', { url: secretUrl });
    expect(r.status).toBe(200);
    expect(r.body.subscription).toMatchObject({ host: 'cal.example.com', status: 'active', lastStatus: 'ok', lastResult: { received: 2, duplicates: 0 } });
    expect(JSON.stringify(r.body)).not.toContain('abc123');
    expect(JSON.stringify((await emp.get('/api/integrations')).body)).not.toContain('abc123');

    const row = (await withOwner((db) => db.query(`select url_enc from calendar_subscriptions where user_id = $1`, [org.users.emp]))).rows[0];
    expect(row.url_enc).not.toContain('abc123');
    expect(decrypt(row.url_enc)).toBe(secretUrl);
    const auditRows = await withOwner((db) => db.query(`select details from audit_events where tenant_id = $1 and action like 'calendar.subscription%'`, [org.tenantId]));
    expect(auditRows.rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(auditRows.rows)).not.toContain('abc123');

    await drainJobs();
    const sug = (await emp.get('/api/suggestions')).body.filter((x: any) => x.kind === 'time_entry');
    expect(sug.map((s: any) => s.title).sort()).toEqual(['Design review', 'Private event']);
    const stored = await withOwner((db) => db.query(`select payload from integration_events e join calendar_subscriptions s on s.connection_id = e.connection_id where s.user_id = $1`, [org.users.emp]));
    expect(JSON.stringify(stored.rows)).not.toMatch(/Confidential agenda|Room 9|Therapy|Ongoing sync|Tomorrow planning|Old meeting/);

    const again = await emp.post('/api/calendar/subscription/sync');
    expect(again.body.subscription.lastResult).toMatchObject({ received: 0, duplicates: 2 });
    await drainJobs();
    expect((await emp.get('/api/suggestions')).body.filter((x: any) => x.kind === 'time_entry')).toHaveLength(2);

    // Other people never see or change this subscription.
    expect((await emp2.get('/api/calendar/subscription')).body.subscription).toBeNull();
    expect((await emp2.post('/api/calendar/subscription/sync')).status).toBe(404);
  });

  it('records fetch errors visibly, pauses, resumes via the hourly tick, and removes the stored address', async () => {
    route('cal.example.com/emp-secret-abc123/basic.ics', (_q, s) => { s.writeHead(500); s.end(); });
    const failed = await emp.post('/api/calendar/subscription/sync');
    expect(failed.body.subscription).toMatchObject({ lastStatus: 'error', failures: 1 });
    expect(failed.body.subscription.lastError).toMatch(/HTTP 500/);

    expect((await emp.patch('/api/calendar/subscription', { status: 'paused' })).body.subscription.status).toBe('paused');
    expect((await emp.post('/api/calendar/subscription/sync')).status).toBe(400);
    const tick = () => withOwner((db) => enqueue(db, { tenantId: org.tenantId, kind: 'calendar.subscriptions.tick', idempotencyKey: `t-${Math.random()}` }));
    const key = 'cal.example.com/emp-secret-abc123/basic.ics';
    const before = hits[key] ?? 0;
    await withOwner((db) => db.query(`update calendar_subscriptions set last_fetch_at = now() - interval '2 hours' where user_id = $1`, [org.users.emp]));
    await tick(); await drainJobs();
    expect(hits[key] ?? 0).toBe(before); // paused: not fetched

    route(key, (_q, s) => { s.writeHead(200); s.end(cal()); });
    await emp.patch('/api/calendar/subscription', { status: 'active' });
    await tick(); await drainJobs();
    expect(hits[key]).toBe(before + 1);
    const st = (await emp.get('/api/calendar/subscription')).body.subscription;
    expect(st).toMatchObject({ lastStatus: 'ok', failures: 0, lastError: null });
    await tick(); await drainJobs();
    expect(hits[key]).toBe(before + 1); // fetched recently: not due again within the hour

    const removed = await emp.del('/api/calendar/subscription');
    expect(removed.body.subscription).toBeNull();
    const left = await withOwner((db) => db.query(`select count(*)::int n from calendar_subscriptions where user_id = $1`, [org.users.emp]));
    expect(left.rows[0].n).toBe(0);
    expect((await emp.get('/api/suggestions')).body.filter((x: any) => x.kind === 'time_entry')).toHaveLength(2); // decisions/data kept
  });
});

describe('personal calendar feed', () => {
  let org: Org; let other: Org; let emp: any; let emp2: any;
  const today = () => DateTime.now().setZone(org.tz).toISODate()!;
  beforeAll(async () => {
    [org, other] = await Promise.all([makeOrg(), makeOrg()]);
    [emp, emp2] = await Promise.all([login(org, 'emp'), login(org, 'emp2')]);
    const d = DateTime.now().setZone(org.tz);
    await withOwner(async (db) => {
      const ins = async (owner: string, title: string, due: string | null, status = 'planned') => (await db.query(
        `insert into tasks (tenant_id, title, description, owner_id, status, due_date) values ($1,$2,'Secret description text',$3,$4,$5) returning id`,
        [org.tenantId, title, org.users[owner], status, due])).rows[0].id;
      await ins('emp', 'Ship invoice export, phase 2', d.plus({ days: 3 }).toISODate());
      await ins('emp', 'Already finished thing', d.plus({ days: 2 }).toISODate(), 'done');
      const planned = await ins('emp', 'Draft onboarding checklist', null);
      await ins('emp2', 'Emp2 confidential renewal', d.plus({ days: 3 }).toISODate());
      const plan = (await db.query(`insert into daily_plans (tenant_id, user_id, date) values ($1,$2,$3) returning id`, [org.tenantId, org.users.emp, today()])).rows[0];
      await db.query(`insert into daily_plan_items (tenant_id, plan_id, task_id, position) values ($1,$2,$3,1)`, [org.tenantId, plan.id, planned]);
      await db.query(`insert into leave_entries (tenant_id, user_id, start_date, end_date, kind, note) values ($1,$2,$3,$4,'sick','Flu recovery')`,
        [org.tenantId, org.users.emp, d.plus({ days: 7 }).toISODate(), d.plus({ days: 8 }).toISODate()]);
      await db.query(`insert into leave_entries (tenant_id, user_id, start_date, end_date, kind) values ($1,$2,$3,$3,'training')`, [org.tenantId, org.users.emp2, d.plus({ days: 4 }).toISODate()]);
    });
  });
  const fetchFeed = async (path: string) => (await getApp()).inject({ method: 'GET', url: path }); // no session cookie
  const unfold = (s: string) => s.replace(/\r\n /g, '');

  it('serves only the owner\'s due dates (title + link), today\'s outcomes and leave, without a session', async () => {
    expect((await emp.get('/api/calendar/feed')).body.active).toBe(false);
    const created = await emp.post('/api/calendar/feed/rotate');
    expect(created.status).toBe(200);
    const path = new URL(created.body.url).pathname;
    expect(path).toMatch(new RegExp(`^/calendar-feed/${org.tenantId}\\.[A-Za-z0-9_-]{43}\\.ics$`));
    const secret = path.split('.')[1];
    const tok = await withOwner((db) => db.query(`select token_hash from calendar_feed_tokens where user_id = $1`, [org.users.emp]));
    expect(tok.rows[0].token_hash).toBe(sha256(secret)); // stored hashed only

    const res = await fetchFeed(path);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/calendar/);
    expect(res.headers['cache-control']).toMatch(/^private/);
    const body = unfold(res.body);
    expect(body).toMatch(/^BEGIN:VCALENDAR\r\n/);
    expect(body).toContain('SUMMARY:Due: Ship invoice export\\, phase 2');
    expect(body).toContain("SUMMARY:Today's outcome 1: Draft onboarding checklist");
    expect(body).toMatch(/URL:http[^\r\n]+\/tasks\/[0-9a-f-]{36}/);
    expect(body).toContain('SUMMARY:Leave');
    expect(body).not.toMatch(/Emp2|Secret description|Flu recovery|Already finished|Sick|Training/i);
    for (const line of res.body.split('\r\n')) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
    expect((await emp.get('/api/calendar/feed')).body).toMatchObject({ active: true });
    expect((await emp.get('/api/calendar/feed')).body.lastUsedAt).toBeTruthy();

    // emp2's own feed contains emp2's data only.
    const p2 = new URL((await emp2.post('/api/calendar/feed/rotate')).body.url).pathname;
    const b2 = unfold((await fetchFeed(p2)).body);
    expect(b2).toContain('Emp2 confidential renewal'); expect(b2).toContain('SUMMARY:Training');
    expect(b2).not.toMatch(/Ship invoice|onboarding/);
  });

  it('rotation and revocation invalidate old addresses immediately; malformed or cross-tenant tokens get 404', async () => {
    const p1 = new URL((await emp.post('/api/calendar/feed/rotate')).body.url).pathname;
    expect((await fetchFeed(p1)).statusCode).toBe(200);
    const p2 = new URL((await emp.post('/api/calendar/feed/rotate')).body.url).pathname;
    expect(p2).not.toBe(p1);
    expect((await fetchFeed(p1)).statusCode).toBe(404);
    expect((await fetchFeed(p2)).statusCode).toBe(200);
    const secret = p2.split('.')[1];
    expect((await fetchFeed(`/calendar-feed/${other.tenantId}.${secret}.ics`)).statusCode).toBe(404);
    expect((await fetchFeed('/calendar-feed/not-a-token.ics')).statusCode).toBe(404);
    expect((await fetchFeed(`/calendar-feed/${org.tenantId}.${secret}`)).statusCode).toBe(404);
    expect((await emp.del('/api/calendar/feed')).body.active).toBe(false);
    expect((await fetchFeed(p2)).statusCode).toBe(404);
    const audits = await withOwner((db) => db.query(`select action from audit_events where tenant_id = $1 and action like 'calendar.feed.%' and actor_id = $2`, [org.tenantId, org.users.emp]));
    expect(audits.rows.map((r) => r.action)).toEqual(expect.arrayContaining(['calendar.feed.create', 'calendar.feed.rotate', 'calendar.feed.revoke']));
    const active = await withOwner((db) => db.query(`select count(*)::int n from calendar_feed_tokens where user_id = $1 and revoked_at is null`, [org.users.emp]));
    expect(active.rows[0].n).toBe(0);
  });
});

describe('holiday import', () => {
  let org: Org; let admin: any; let emp: any;
  const Y = new Date().getFullYear() + 1;
  beforeAll(async () => { org = await makeOrg(); [admin, emp] = await Promise.all([login(org, 'admin'), login(org, 'emp')]); });
  const file = () => cal(
    allDay('h1', `${Y}-03-10`, `${Y}-03-11`, 'Founders Day'),
    allDay('h1b', `${Y}-03-10`, `${Y}-03-11`, 'Company Offsite'),
    allDay('h2', `${Y}-04-06`, `${Y}-04-08`, 'Spring Break'),
    allDay('h3', `${Y}-05-01`, `${Y}-05-02`, 'May Day'),
    allDay('h4', `${Y}-06-01`, `${Y}-06-02`, 'Cancelled Day', ['STATUS:CANCELLED']),
    vevent('t1', DateTime.fromISO(`${Y}-07-01T10:00`), DateTime.fromISO(`${Y}-07-01T11:00`), 'Timed party'),
  );

  it('previews dates read only from the file, imports on confirm, and is idempotent', async () => {
    await withOwner((db) => db.query(`insert into holidays (tenant_id, date, name) values ($1,$2,'Labour Day')`, [org.tenantId, `${Y}-05-01`]));
    expect((await emp.post('/api/calendar/holidays/import/preview', { source: 'file', ics: file() })).status).toBe(403);
    const p = await admin.post('/api/calendar/holidays/import/preview', { source: 'file', ics: file(), fileName: 'company-holidays.ics' });
    expect(p.status).toBe(200);
    expect(p.body.items.map((i: any) => [i.date, i.name, i.status])).toEqual([
      [`${Y}-03-10`, 'Founders Day / Company Offsite', 'new'], [`${Y}-04-06`, 'Spring Break', 'new'], [`${Y}-04-07`, 'Spring Break', 'new'], [`${Y}-05-01`, 'May Day', 'exists']]);
    expect(p.body.items[3].existingName).toBe('Labour Day');
    expect(p.body.warnings.join(' ')).toMatch(/timed event/);
    expect(p.body.warnings.join(' ')).toMatch(/cancelled/);
    expect(p.body.counts).toEqual({ total: 4, new: 3, existing: 1 });

    expect((await emp.post(`/api/calendar/holidays/import/${p.body.id}/confirm`, {})).status).toBe(403);
    expect((await admin.post(`/api/calendar/holidays/import/${p.body.id}/confirm`, { dates: [`${Y}-12-25`] })).status).toBe(400); // not in the file

    const c1 = await admin.post(`/api/calendar/holidays/import/${p.body.id}/confirm`, {});
    expect(c1.body).toEqual({ imported: 3, skipped: 0, alreadyConfirmed: false });
    const c2 = await admin.post(`/api/calendar/holidays/import/${p.body.id}/confirm`, {});
    expect(c2.body).toEqual({ imported: 3, skipped: 0, alreadyConfirmed: true });
    const hol = (await admin.get('/api/calendar/holidays')).body.filter((h: any) => h.date.startsWith(String(Y)));
    expect(hol.map((h: any) => [h.date, h.name])).toEqual([[`${Y}-03-10`, 'Founders Day / Company Offsite'], [`${Y}-04-06`, 'Spring Break'], [`${Y}-04-07`, 'Spring Break'], [`${Y}-05-01`, 'Labour Day']]);

    // Previewing the same file again: everything already exists, confirming changes nothing.
    const p2 = await admin.post('/api/calendar/holidays/import/preview', { source: 'file', ics: file() });
    expect(p2.body.counts).toEqual({ total: 4, new: 0, existing: 4 });
    expect((await admin.post(`/api/calendar/holidays/import/${p2.body.id}/confirm`, { dates: [`${Y}-03-10`] })).body).toEqual({ imported: 0, skipped: 1, alreadyConfirmed: false });
    expect((await admin.get('/api/calendar/holidays')).body.filter((h: any) => h.date.startsWith(String(Y)))).toHaveLength(4);

    const recent = (await admin.get('/api/calendar/holidays/imports')).body;
    expect(recent[recent.length - 1]).toMatchObject({ source_label: 'company-holidays.ics', imported_count: 3 });
    const a = await withOwner((db) => db.query(`select count(*)::int n from audit_events where tenant_id = $1 and action = 'holiday.import'`, [org.tenantId]));
    expect(a.rows[0].n).toBe(2);
  });

  it('imports a selected subset, and fetches https URLs through the same SSRF guard', async () => {
    route('holidays.example.com/public/holidays.ics', (_q, s) => { s.writeHead(200, { 'content-type': 'text/calendar' }); s.end(cal(allDay('u1', `${Y + 1}-01-26`, `${Y + 1}-01-27`, 'Republic Day'), allDay('u2', `${Y + 1}-08-15`, `${Y + 1}-08-16`, 'Independence Day'))); });
    const p = await admin.post('/api/calendar/holidays/import/preview', { source: 'url', url: 'https://holidays.example.com/public/holidays.ics' });
    expect(p.status).toBe(200);
    expect(p.body.sourceLabel).toBe('holidays.example.com');
    expect(p.body.items.map((i: any) => i.name)).toEqual(['Republic Day', 'Independence Day']);
    expect((await admin.post(`/api/calendar/holidays/import/${p.body.id}/confirm`, { dates: [`${Y + 1}-08-15`] })).body.imported).toBe(1);
    const hol = (await admin.get('/api/calendar/holidays')).body.map((h: any) => h.date);
    expect(hol).toContain(`${Y + 1}-08-15`); expect(hol).not.toContain(`${Y + 1}-01-26`);

    for (const url of ['https://internal.example.com/h.ics', 'http://holidays.example.com/public/holidays.ics', 'https://169.254.169.254/h.ics'])
      expect((await admin.post('/api/calendar/holidays/import/preview', { source: 'url', url })).status, url).toBe(400);
    expect((await admin.post('/api/calendar/holidays/import/preview', { source: 'file', ics: 'this is not a calendar file' })).body.items ?? []).toEqual([]);
  });

  it('expands repeating all-day rules only within the import window and never invents names', () => {
    const now = new Date();
    const { items } = parseHolidayIcs(cal(['BEGIN:VEVENT', 'UID:ny', 'DTSTART;VALUE=DATE:20200101', 'RRULE:FREQ=YEARLY', 'SUMMARY:New Year', 'END:VEVENT'], allDay('blank', `${Y}-09-09`, `${Y}-09-10`, '')), now);
    const ny = items.filter((i) => i.name === 'New Year').map((i) => i.date);
    expect(ny).toEqual([0, 1, 2, 3, 4].map((k) => `${now.getFullYear() - 1 + k}-01-01`));
    expect(items.find((i) => i.date === `${Y}-09-09`)?.name).toBe('Holiday');
  });
});
