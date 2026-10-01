import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tx } from '../../app.js';
import { require, requireStaff } from '../../services/access.js';
import { blockerAging, blockerEscalation, loadPolicy, nudgeBlocker, policySchema, savePolicy } from '../../services/ext/escalation.js';

const id = z.object({ id: z.string().uuid() });

/** Routes for the 'escalation' feature area: policy, nudges, per-blocker history and the blocker-aging view. */
export default async function (app: FastifyInstance) {
  app.get('/api/escalation/policy', async (req) => tx(req, async (db, a) => {
    requireStaff(a);
    return loadPolicy(db, a.tenantId);
  }));

  app.put('/api/escalation/policy', async (req) => tx(req, async (db, a) => {
    require(a, 'system_admin');
    const body = z.object({ policy: policySchema, version: z.number().int().min(0) }).parse(req.body);
    return savePolicy(db, a, body.policy, body.version, req.id);
  }));

  app.get('/api/escalation/blockers', async (req) => tx(req, (db, a) => blockerAging(db, a)));

  app.get('/api/blockers/:id/escalation', async (req) => tx(req, async (db, a) => {
    requireStaff(a);
    return blockerEscalation(db, a, id.parse(req.params).id);
  }));

  app.post('/api/blockers/:id/nudge', async (req) => tx(req, async (db, a) => {
    const b = z.object({ note: z.string().trim().max(500).default('') }).parse(req.body ?? {});
    return nudgeBlocker(db, a, id.parse(req.params).id, b.note, req.id);
  }));
}
