import { beforeAll, describe, expect, it } from 'vitest';
import { login, makeOrg, withOwner, type Org } from './helpers.js';

// Server support for the web audit fixes: navigation flags and branding in /api/me (seams-9, ux-11, ux-13),
// and per-task edit/reassign permissions so the UI never offers actions the server will refuse (ux-3).
let org: Org;
const ids: Record<string, string> = {};
const sessions: Record<string, Awaited<ReturnType<typeof login>>> = {};
const as = async (key: string) => (sessions[key] ??= await login(org, key)); // one login per person (login is rate limited)

beforeAll(async () => {
  org = await makeOrg();
  await withOwner(async (db) => {
    const T = org.tenantId; const U = org.users;
    const q1 = async (sql: string, p: unknown[]) => (await db.query(sql, p)).rows[0];
    const cust = (await q1(`insert into customers (tenant_id, name) values ($1,'Acme (test client)') returning id`, [T])).id;
    // emp owns a client project; emp2 owns only an internal project; outsider owns only an archived client project.
    ids.client = (await q1(`insert into projects (tenant_id, key, name, customer_id, owner_id) values ($1,'CLI','Client work',$2,$3) returning id`, [T, cust, U.emp])).id;
    ids.internal = (await q1(`insert into projects (tenant_id, key, name, owner_id) values ($1,'INT','Internal work',$2) returning id`, [T, U.emp2])).id;
    await db.query(`insert into projects (tenant_id, key, name, customer_id, owner_id, status) values ($1,'OLD','Old client work',$2,$3,'archived')`, [T, cust, U.outsider]);
    ids.task = (await q1(`insert into tasks (tenant_id, title, owner_id, created_by, project_id) values ($1,'Internal task',$2,$2,$3) returning id`, [T, U.emp2, ids.internal])).id;
    await db.query(`insert into tenant_branding (tenant_id, accent) values ($1,'#0f766e')`, [T]);
  });
});

describe('/api/me navigation flags and branding', () => {
  it('reports which project kinds the person owns, so the nav matches what the server allows', async () => {
    const flags = async (key: string) => { const r = await (await as(key)).get('/api/me'); expect(r.status).toBe(200); return [r.body.user.ownsProjects, r.body.user.ownsClientProjects]; };
    expect(await flags('emp')).toEqual([true, true]);
    expect(await flags('emp2')).toEqual([true, false]);
    expect(await flags('outsider')).toEqual([false, false]); // archived projects do not count
    expect(await flags('manager')).toEqual([false, false]);
  });

  it('includes the tenant accent and logo so the brand applies on first paint', async () => {
    const r = await (await as('emp')).get('/api/me');
    expect(r.body.branding).toEqual({ accent: '#0f766e', logoUrl: null });
  });
});

describe('task permissions in list and detail', () => {
  it('flags each listed task with can_edit using the same rule as the status endpoint', async () => {
    const editable = async (key: string) => {
      const r = await (await as(key)).get(`/api/tasks?projectId=${ids.internal}`);
      expect(r.status).toBe(200);
      return r.body.find((t: any) => t.id === ids.task)?.can_edit;
    };
    expect(await editable('emp2')).toBe(true); // owner
    expect(await editable('manager')).toBe(true); // owner's manager
    expect(await editable('admin')).toBe(true); // routine admin
    expect(await editable('outsider')).toBe(false); // sees the company project, cannot change the task
    const refused = await (await as('outsider')).post(`/api/tasks/${ids.task}/status`, { to: 'in_progress', version: 1 });
    expect(refused.status).toBe(403);
  });

  it('says whether the viewer may reassign the task', async () => {
    const reassign = async (key: string) => (await (await as(key)).get(`/api/tasks/${ids.task}`)).body.canReassign;
    expect(await reassign('emp2')).toBe(true);
    expect(await reassign('outsider')).toBe(false);
  });
});
