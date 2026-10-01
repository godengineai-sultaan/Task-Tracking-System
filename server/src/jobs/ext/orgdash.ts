import { registerInsightsExport } from '../../services/ext/orgdash.js';

/** Background jobs for the 'orgdash' feature area: the worker renders 'insights' CSV exports (re-authorized at generation time). */
export default function register() {
  registerInsightsExport();
}
