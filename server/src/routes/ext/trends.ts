import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tx } from '../../app.js';
import { authorizeTrends, buildPersonalTrends, registerTrendsExport } from '../../services/ext/trends.js';

/** Routes for the 'trends' feature area: personal weekly trends and focus review (read-only; same access rules as individual reports). */
export default async function (app: FastifyInstance) {
  registerTrendsExport();
  app.get('/api/trends/personal', async (req) => tx(req, async (db, a) => {
    const q = z.object({
      userId: z.string().uuid().optional(),
      weeks: z.coerce.number().int().min(4).max(26).default(12),
      end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }).parse(req.query);
    const uid = q.userId ?? a.id;
    await authorizeTrends(db, a, uid);
    return buildPersonalTrends(db, uid, q.weeks, q.end);
  }));
}
