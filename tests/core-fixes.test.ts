import { beforeAll, describe, expect, it } from 'vitest';
import { login, makeOrg, withOwner, type Org } from './helpers.js';
import { asAutomation, currentAutomationDepth } from '../server/src/services/events.js';

let org: Org; let admin: any; let emp: any; let outsider: any;
beforeAll(async () => { org = await makeOrg(); [admin, emp, outsider] = await Promise.all([login(org, 'admin'), login(org, 'emp'), login(org, 'outsider')]); });

describe('integration fixes', () => {
  it('a plan keeps an outcome after it is done and can still be changed', async () => {
    const a = (await emp.post('/api/tasks', { title: 'Finish me' })).body;
    const b = (await emp.post('/api/tasks', { title: 'Next one' })).body;
    expect((await emp.put('/api/my-day/plan', { taskIds: [a.id] })).status).toBe(200);
    expect((await emp.post(`/api/tasks/${a.id}/status`, { to: 'done' })).status).toBe(200);
    const r = await emp.put('/api/my-day/plan', { taskIds: [a.id, b.id] });
    expect(r.status).toBe(200);
    expect(r.body.intendedOutcomes.map((t: any) => t.id)).toEqual([a.id, b.id]);
    const c = (await emp.post('/api/tasks', { title: 'Already done elsewhere' })).body;
    await emp.post(`/api/tasks/${c.id}/status`, { to: 'done' });
    expect((await emp.put('/api/my-day/plan', { taskIds: [a.id, b.id, c.id] })).status).toBe(400); // newly added done task is still refused
  });

  it('private projects are hidden from the one-line parser and refuse tasks from non-members', async () => {
    const p = (await admin.post('/api/projects', { key: 'SECRET', name: 'Private hiring', visibility: 'private' })).body;
    expect((await outsider.post('/api/tasks/parse', { text: 'Draft offer #SECRET' })).body.project).toBeNull();
    expect((await admin.post('/api/tasks/parse', { text: 'Draft offer #SECRET' })).body.project.id).toBe(p.id);
    expect((await outsider.post('/api/tasks', { title: 'Sneaky', projectId: p.id })).status).toBe(400);
    expect((await admin.post('/api/tasks', { title: 'Allowed', projectId: p.id })).status).toBe(200);
  });

  it('client accounts cannot be added to staff teams', async () => {
    const cust = await withOwner(async (db) => (await db.query(`insert into users (tenant_id, email, name, roles) values ($1,'client@x.test','Client',array['customer']) returning id`, [org.tenantId])).rows[0].id);
    const team = await withOwner(async (db) => (await db.query(`select id from teams where tenant_id = $1 limit 1`, [org.tenantId])).rows[0].id);
    expect((await admin.post(`/api/admin/teams/${team}/members`, { userId: cust })).status).toBe(400);
  });

  it('objective edits go through the one versioned, audited write path', async () => {
    const o = (await admin.post('/api/objectives/create', { title: 'Grow retention' })).body;
    const u = (await admin.put(`/api/objectives/${o.id}`, { title: 'Grow retention to 95%', version: o.version })).body;
    expect(u.version).toBe(o.version + 1);
    expect((await admin.put(`/api/objectives/${o.id}`, { title: 'Stale', version: o.version })).status).toBe(409);
    const a = await withOwner((db) => db.query(`select count(*)::int n from audit_events where tenant_id = $1 and action = 'objective.updated'`, [org.tenantId]));
    expect(a.rows[0].n).toBe(1);
  });

  it('automation depth is tracked per async chain, not process-wide', async () => {
    let inner = -1, sibling = -1;
    await Promise.all([
      asAutomation(async () => { await new Promise((r) => setTimeout(r, 20)); inner = currentAutomationDepth(); }),
      (async () => { await new Promise((r) => setTimeout(r, 5)); sibling = currentAutomationDepth(); })(),
    ]);
    expect(inner).toBe(1); expect(sibling).toBe(0);
  });
});
