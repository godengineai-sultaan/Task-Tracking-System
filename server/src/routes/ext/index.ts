import type { FastifyInstance } from 'fastify';
import planning from './planning.js';
import templates from './templates.js';
import automation from './automation.js';
import escalation from './escalation.js';
import teamreview from './teamreview.js';
import objectives from './objectives.js';
import whatif from './whatif.js';
import profitability from './profitability.js';
import clientbrand from './clientbrand.js';
import pwa from './pwa.js';
import calendar from './calendar.js';
import orgdash from './orgdash.js';
import trends from './trends.js';
import portfolioCore from './portfolio-core.js';
import portfolio from './portfolio.js';
import connectors from './connectors.js';
import productanalytics from './productanalytics.js';

/** Feature-area route plugins. Each area owns its own file. */
export async function extRoutes(app: FastifyInstance) {
  await app.register(planning);
  await app.register(templates);
  await app.register(automation);
  await app.register(escalation);
  await app.register(teamreview);
  await app.register(objectives);
  await app.register(whatif);
  await app.register(profitability);
  await app.register(clientbrand);
  await app.register(pwa);
  await app.register(calendar);
  await app.register(orgdash);
  await app.register(trends);
  await app.register(portfolioCore);
  await app.register(portfolio);
  await app.register(connectors);
  await app.register(productanalytics);
}
