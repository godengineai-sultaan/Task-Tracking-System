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

/** Feature-area job registrations (registerJob / registerTenantTick / onTaskEvent listeners). */
export function registerExtJobs() {
  planning();
  templates();
  automation();
  escalation();
  teamreview();
  objectives();
  whatif();
  profitability();
  clientbrand();
  pwa();
  calendar();
  orgdash();
  trends();
}
