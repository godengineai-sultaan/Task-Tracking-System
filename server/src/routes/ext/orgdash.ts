import type { FastifyInstance } from 'fastify';
import { tx } from '../../app.js';
import { computeInsights, insightsOptions, insightsQuery, registerInsightsExport } from '../../services/ext/orgdash.js';

/** Routes for the 'orgdash' feature area: organization & team Insights (read-only analytics, authorized per request). */
export default async function (app: FastifyInstance) {
  registerInsightsExport();
  app.get('/api/insights', async (req) => tx(req, (db, a) => computeInsights(db, a, insightsQuery.parse(req.query))));
  app.get('/api/insights/options', async (req) => tx(req, (db, a) => insightsOptions(db, a)));
}
