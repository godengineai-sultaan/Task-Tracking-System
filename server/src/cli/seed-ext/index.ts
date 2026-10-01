import type { SeedCtx } from './types.js';
import planning from './planning.js';
import templates from './templates.js';
import automation, { seedAutomationHistory } from './automation.js';
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

/**
 * Runs every feature area's demo fixtures inside the seed transaction. Order matters:
 * trends seeds detailed personal history first, orgdash fills the remaining person-days,
 * and profitability sizes budgets last, against all recorded time.
 */
export async function seedExtensions(ctx: SeedCtx) {
  await planning(ctx);
  await templates(ctx);
  await automation(ctx);
  await escalation(ctx);
  await seedAutomationHistory(ctx); // names a task the escalation fixtures blocked
  await teamreview(ctx);
  await objectives(ctx);
  await whatif(ctx);
  await clientbrand(ctx);
  await pwa(ctx);
  await calendar(ctx);
  await trends(ctx);
  await orgdash(ctx);
  await profitability(ctx);
}
