import { beforeAll, describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { drainJobs, getApp, login, makeOrg, withOwner, type Org } from './helpers.js';
import { hmacHex } from '../server/src/lib/crypto.js';

let org: Org; let admin: any; let emp: any;
beforeAll(async () => { org = await makeOrg(); [admin, emp] = await Promise.all([login(org, 'admin'), login(org, 'emp')]); });

async function deliver(connId: string, secret: string, env: any, opts: { badSig?: boolean; ts?: number } = {}) {
  const app = await getApp();
  const body = JSON.stringify(env); const ts = opts.ts ?? Math.floor(Date.now() / 1000);
  return app.inject({ method: 'POST', url: `/api/inbound/${org.slug}/${connId}`, headers: { 'content-type': 'application/json', 'x-timestamp': String(ts),
    'x-signature': `sha256=${opts.badSig ? 'ab'.repeat(32) : hmacHex(secret, `${ts}.${body}`)}` }, payload: body });
}
const envelope = (o: any) => ({ schema_version: '1.0', tenant_id: org.tenantId, occurred_at: new Date().toISOString(), correlation_id: 'corr-1', ...o });

describe('approval → execution task contract', () => {
  it('authenticates, de-duplicates deliveries and never creates duplicate tasks', async () => {
    const c = (await admin.post('/api/integrations', { kind: 'module_approvals', name: 'Approvals' })).body;
    expect(c.secret).toBeTruthy();
    const ev = envelope({ event_id: 'evt-1', event_type: 'approval.approved', resource_id: 'REQ-7', resource_version: '1',
      payload: { title: 'Execute purchase: 2 monitors', owner_email: `emp@${org.slug}.test`, request_ref: 'REQ-7', approved_scope_ref: 'S-7', kind: 'purchase', completion_conditions: ['PO issued', 'Delivery confirmed'] } });
    expect((await deliver(c.id, c.secret, ev, { badSig: true })).statusCode).toBe(403);
    expect((await deliver(c.id, c.secret, ev, { ts: Math.floor(Date.now() / 1000) - 3600 })).statusCode).toBe(403);
    expect((await deliver(c.id, c.secret, { ...ev, tenant_id: '00000000-0000-0000-0000-000000000000' })).statusCode).toBe(403);
    expect((await deliver(c.id, c.secret, ev)).statusCode).toBe(202);
    expect((await deliver(c.id, c.secret, ev)).json().status).toBe('duplicate');
    expect((await deliver(c.id, c.secret, { ...ev, event_id: 'evt-2' })).statusCode).toBe(202); // redelivery with a new event id
    await drainJobs();
    const tasks = await withOwner((db) => db.query(`select * from tasks where tenant_id = $1 and source_type = 'approval'`, [org.tenantId]));
    expect(tasks.rowCount).toBe(1);
    expect(tasks.rows[0]).toMatchObject({ owner_id: org.users.emp, requires_evidence: true });
    expect(tasks.rows[0].source_ref).toMatchObject({ request_ref: 'REQ-7', approved_scope_ref: 'S-7' });
    const evs = (await admin.get(`/api/integrations/${c.id}/events`)).body;
    expect(evs.map((e: any) => e.status).sort()).toEqual(['applied', 'applied']);
  });
});

describe('vault / offboarding contract is metadata-only', () => {
  it('rejects payloads with secrets without storing them, and creates metadata-only tasks otherwise', async () => {
    const c = (await admin.post('/api/integrations', { kind: 'module_vault', name: 'Vault' })).body;
    const leak = await deliver(c.id, c.secret, envelope({ event_id: 'v-1', event_type: 'credential.rotation_due', payload: { system_name: 'AWS', password: 'hunter2', owner_email: `emp@${org.slug}.test` } }));
    expect(leak.statusCode).toBe(422);
    const stored = await withOwner((db) => db.query(`select payload, status from integration_events where event_id = 'v-1'`));
    expect(stored.rows[0].status).toBe('rejected'); expect(JSON.stringify(stored.rows[0].payload)).not.toContain('hunter2');
    const ok = await deliver(c.id, c.secret, envelope({ event_id: 'v-2', event_type: 'credential.rotation_due', payload: { system_name: 'AWS', credential_ref: 'CRED-1', owner_email: `emp@${org.slug}.test`, due_date: '2030-01-01' } }));
    expect(ok.statusCode).toBe(202);
    await drainJobs();
    const t = await withOwner((db) => db.query(`select title, description, source_ref from tasks where tenant_id = $1 and source_type = 'offboarding'`, [org.tenantId]));
    expect(t.rows[0].title).toBe('Rotate credential for AWS');
    expect(JSON.stringify(t.rows[0])).not.toContain("hunter2"); expect(Object.keys(t.rows[0].source_ref)).not.toContain("password");
  });
});

describe('issues and calendar suggestions require confirmation and de-duplicate', () => {
  it('groups related issue events into one suggestion; accepting creates one task', async () => {
    const c = (await admin.post('/api/integrations', { kind: 'issues', name: 'Issues' })).body;
    for (const id of ['i-1', 'i-2']) await deliver(c.id, c.secret, envelope({ event_id: id, event_type: 'issue.updated', resource_id: 'ISS-3',
      payload: { title: 'Checkout bug', issue_ref: 'ISS-3', assignee_email: `emp@${org.slug}.test`, url: 'https://issues.example/ISS-3' } }));
    await drainJobs();
    const s = (await emp.get('/api/suggestions')).body.filter((x: any) => x.kind === 'task');
    expect(s).toHaveLength(1); expect(s[0].event_ids).toHaveLength(2);
    const r = await emp.post(`/api/suggestions/${s[0].id}/decide`, { decision: 'accept' });
    expect(r.body.status).toBe('accepted');
    expect((await emp.post(`/api/suggestions/${s[0].id}/decide`, { decision: 'accept' })).body.status).toBe('accepted');
    const n = await withOwner((db) => db.query(`select count(*)::int n from tasks where tenant_id = $1 and external_key = 'issues:ISS-3'`, [org.tenantId]));
    expect(n.rows[0].n).toBe(1);
  });
  it('ICS import keeps only title/time, re-import is de-duplicated and confirmed meetings are not double counted', async () => {
    const c = (await emp.post('/api/integrations', { kind: 'ics_calendar', name: 'Cal' })).body;
    const start = DateTime.now().setZone(org.tz).minus({ days: 1 }).set({ hour: 11, minute: 0, second: 0, millisecond: 0 }).toUTC();
    const fmt = (d: DateTime) => d.toFormat("yyyyMMdd'T'HHmmss'Z'");
    const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:standup-1', `DTSTART:${fmt(start)}`, `DTEND:${fmt(start.plus({ minutes: 30 }))}`,
      'SUMMARY:Stand-up', 'DESCRIPTION:Secret agenda details', 'LOCATION:Room 4', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:priv-1', 'CLASS:PRIVATE', `DTSTART:${fmt(start.plus({ hours: 2 }))}`, `DTEND:${fmt(start.plus({ hours: 3 }))}`, 'SUMMARY:Doctor', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    const r1 = (await emp.post(`/api/integrations/${c.id}/ics`, { ics })).body;
    expect(r1.received).toBe(2);
    expect((await emp.post(`/api/integrations/${c.id}/ics`, { ics })).body).toMatchObject({ received: 0, duplicates: 2 });
    await drainJobs();
    const stored = await withOwner((db) => db.query(`select payload from integration_events where connection_id = $1`, [c.id]));
    expect(JSON.stringify(stored.rows)).not.toMatch(/Secret agenda|Room 4|Doctor/);
    const sug = (await emp.get('/api/suggestions')).body.filter((x: any) => x.kind === 'time_entry');
    expect(sug.map((s: any) => s.title).sort()).toEqual(['Private event', 'Stand-up']);
    const stand = sug.find((s: any) => s.title === 'Stand-up');
    await emp.post(`/api/suggestions/${stand.id}/decide`, { decision: 'accept' });
    const entries = await withOwner((db) => db.query(`select count(*)::int n from time_entries where user_id = $1 and source = 'calendar'`, [org.users.emp]));
    expect(entries.rows[0].n).toBe(1);
    // A timer that overlapped the meeting is counted once in the day report.
    await emp.post('/api/time-entries', { category: 'admin', startedAt: start.minus({ minutes: 15 }).toISO(), endedAt: start.plus({ minutes: 15 }).toISO() });
    const date = start.setZone(org.tz).toISODate();
    const day = (await emp.get(`/api/reports/individual?kind=day&date=${date}`)).body.days[0];
    expect(day.time.explainedMinutes).toBe(45);
    expect(day.time.conflicts[0].minutes).toBe(15);
  });
});

describe('exports', () => {
  it('generates a real PDF for authorized users only', async () => {
    const start = DateTime.now().setZone(org.tz).minus({ days: 7 }).toISODate(), end = DateTime.now().setZone(org.tz).toISODate();
    const ex = await emp.post('/api/exports', { format: 'pdf', report: 'individual', params: { userId: org.users.emp, kind: 'week', start, end } });
    expect(ex.status).toBe(200);
    await drainJobs();
    const st = (await emp.get(`/api/exports/${ex.body.id}`)).body;
    expect(st.status).toBe('ready');
    const f = await emp.get(`/api/exports/${ex.body.id}/file`);
    expect(f.headers['content-type']).toBe('application/pdf');
    expect(Buffer.from(f.raw).subarray(0, 5).toString()).toBe('%PDF-');
    expect((await admin.get(`/api/exports/${ex.body.id}/file`)).status).toBe(404); // files belong to the requester
    expect((await emp.post('/api/exports', { format: 'csv', report: 'team_daily', params: { date: end } })).status).toBe(403);
    const team = await admin.post('/api/exports', { format: 'csv', report: 'team_daily', params: { date: end } });
    await drainJobs();
    expect((await admin.get(`/api/exports/${team.body.id}`)).body.status).toBe('ready');
  });
});

describe('documents and KYC contracts', () => {
  it('a finalized PO is attached to the approval task as a restricted reference; KYC gaps create one follow-up', async () => {
    const appr = (await admin.post('/api/integrations', { kind: 'module_approvals', name: 'Approvals 2' })).body;
    await deliver(appr.id, appr.secret, envelope({ event_id: 'a-9', event_type: 'approval.approved', resource_id: 'REQ-9',
      payload: { title: 'Execute purchase: chairs', owner_email: `emp@${org.slug}.test`, request_ref: 'REQ-9', kind: 'purchase' } }));
    const docs = (await admin.post('/api/integrations', { kind: 'module_documents', name: 'Docs' })).body;
    await drainJobs();
    await deliver(docs.id, docs.secret, envelope({ event_id: 'd-1', event_type: 'document.finalized', resource_id: 'DOC-PO-9',
      payload: { document_ref: 'DOC-PO-9', kind: 'Purchase order', related_request_ref: 'REQ-9' } }));
    const kyc = (await admin.post('/api/integrations', { kind: 'module_kyc', name: 'KYC' })).body;
    for (const id of ['k-1', 'k-2']) await deliver(kyc.id, kyc.secret, envelope({ event_id: id, event_type: 'kyc.document_missing', resource_id: 'SUBJ-4',
      payload: { subject_ref: 'SUBJ-4', required_item: 'Address proof', status: 'missing', owner_email: `emp@${org.slug}.test` } }));
    await drainJobs();
    const ev = await withOwner((db) => db.query(`select e.restricted, e.source_reference, e.allowed_user_ids, t.owner_id from evidence_links e join tasks t on t.id = e.task_id
      where t.tenant_id = $1 and e.source_module = 'documents'`, [org.tenantId]));
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0]).toMatchObject({ restricted: true, source_reference: 'DOC-PO-9' });
    expect(ev.rows[0].allowed_user_ids).toEqual([ev.rows[0].owner_id]);
    const asAdmin = (await admin.get('/api/tasks?q=chairs')).body[0];
    const detail = (await admin.get(`/api/tasks/${asAdmin.id}`)).body;
    expect(detail.evidence.find((e: any) => e.source_module === 'documents').hidden).toBe(true);
    const k = await withOwner((db) => db.query(`select title, source_ref from tasks where tenant_id = $1 and source_type = 'kyc'`, [org.tenantId]));
    expect(k.rows).toHaveLength(1);
    expect(k.rows[0].title).toBe('Follow up: Address proof for SUBJ-4');
  });
});

describe('retention', () => {
  it('purges expired telemetry per policy and records the purge in the audit log', async () => {
    await withOwner((db) => db.query(`insert into ux_timings (tenant_id, user_id, flow, duration_ms, date, created_at) values ($1,$2,'recap',1000,'2020-01-01','2020-01-01')`, [org.tenantId, org.users.emp]));
    expect((await admin.post('/api/admin/retention/run')).status).toBe(200);
    await drainJobs();
    const left = await withOwner((db) => db.query(`select count(*)::int n from ux_timings where tenant_id = $1 and created_at < '2021-01-01'`, [org.tenantId]));
    expect(left.rows[0].n).toBe(0);
    const a = await withOwner((db) => db.query(`select details from audit_events where tenant_id = $1 and action = 'retention.purge'`, [org.tenantId]));
    expect(a.rows[0].details.uxTimings).toBe(1);
  });
});
