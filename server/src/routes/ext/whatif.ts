import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tx } from '../../app.js';
import { audit } from '../../lib/audit.js';
import { many, one } from '../../lib/db.js';
import { conflict, notFound } from '../../lib/errors.js';
import { assertInScope, planningContext, referencedUserIds, scenarioShape, simulate, simulateSchema, simulationScope } from '../../services/ext/whatif.js';

const scenarioBody = z.object({ name: z.string().trim().min(1).max(120), ...scenarioShape });
const cols = `id, name, horizon_days, people, changes, unestimated_minutes, version, created_at, updated_at`;

/** Routes for the 'whatif' feature area: read-only capacity/deadline simulation and the actor's saved scenarios. */
export default async function (app: FastifyInstance) {
  app.get('/api/whatif/context', async (req) => tx(req, (db, a) => planningContext(db, a)));

  // Read-only: never writes tasks, calendars, leave or audit rows.
  app.post('/api/whatif/simulate', async (req) => tx(req, (db, a) => simulate(db, a, simulateSchema.parse(req.body))));

  app.get('/api/whatif/scenarios', async (req) => tx(req, async (db, a) => {
    await simulationScope(db, a);
    return many(db, `select ${cols} from whatif_scenarios where created_by = $1 order by updated_at desc limit 100`, [a.id]);
  }));

  app.get('/api/whatif/scenarios/:id', async (req) => tx(req, async (db, a) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await simulationScope(db, a);
    const s = await one(db, `select ${cols} from whatif_scenarios where id = $1 and created_by = $2`, [id, a.id]);
    if (!s) throw notFound('Scenario not found');
    return s;
  }));

  app.post('/api/whatif/scenarios', async (req) => tx(req, async (db, a) => {
    const b = scenarioBody.parse(req.body);
    assertInScope(await simulationScope(db, a), [...(b.people ?? []), ...referencedUserIds(b.changes)]);
    const s = await one(db, `insert into whatif_scenarios (tenant_id, name, horizon_days, people, changes, unestimated_minutes, created_by)
      values ($1,$2,$3,$4,$5,$6,$7) returning ${cols}`, [a.tenantId, b.name, b.horizonDays, b.people ?? [], JSON.stringify(b.changes), b.unestimatedMinutes, a.id]);
    await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'whatif.scenario.create', resourceType: 'whatif_scenario', resourceId: s.id, resourceVersion: 1,
      details: { name: b.name, changes: b.changes.length, people: (b.people ?? []).length } });
    return s;
  }));

  app.put('/api/whatif/scenarios/:id', async (req) => tx(req, async (db, a) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = scenarioBody.extend({ version: z.number().int().min(1) }).parse(req.body);
    assertInScope(await simulationScope(db, a), [...(b.people ?? []), ...referencedUserIds(b.changes)]);
    const cur = await one(db, `select id, version from whatif_scenarios where id = $1 and created_by = $2`, [id, a.id]);
    if (!cur) throw notFound('Scenario not found');
    const s = await one(db, `update whatif_scenarios set name = $3, horizon_days = $4, people = $5, changes = $6, unestimated_minutes = $7,
        version = version + 1, updated_at = now() where id = $1 and version = $2 returning ${cols}`,
      [id, b.version, b.name, b.horizonDays, b.people ?? [], JSON.stringify(b.changes), b.unestimatedMinutes]);
    if (!s) throw conflict('This scenario was changed elsewhere. Reload it and try again.', { currentVersion: cur.version });
    await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'whatif.scenario.update', resourceType: 'whatif_scenario', resourceId: id, resourceVersion: s.version,
      details: { name: b.name, changes: b.changes.length } });
    return s;
  }));

  app.delete('/api/whatif/scenarios/:id', async (req) => tx(req, async (db, a) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const s = await one(db, `delete from whatif_scenarios where id = $1 and created_by = $2 returning id, name, version`, [id, a.id]);
    if (!s) throw notFound('Scenario not found');
    await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'whatif.scenario.delete', resourceType: 'whatif_scenario', resourceId: id, resourceVersion: s.version,
      details: { name: s.name } });
    return { ok: true };
  }));
}
