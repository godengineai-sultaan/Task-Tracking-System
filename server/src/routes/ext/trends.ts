import type { FastifyInstance } from 'fastify';
import { tx } from '../../app.js';
import { authorizeTrends, buildPersonalTrends, registerTrendsExport, trendsParams } from '../../services/ext/trends.js';

/** Routes for the 'trends' feature area: personal weekly trends and focus review (read-only; same access rules as individual reports). */
export default async function (app: FastifyInstance) {
  registerTrendsExport();
  app.get('/api/trends/personal', async (req) => tx(req, async (db, a) => {
    const q = trendsParams.parse(req.query);
    const uid = q.userId ?? a.id;
    await authorizeTrends(db, a, uid);
    return buildPersonalTrends(db, uid, q.weeks, q.end);
  }));
}
