import { registerTrendsExport } from '../../services/ext/trends.js';

/** Background jobs, tenant ticks and task-event listeners for the 'trends' feature area. */
export default function register() {
  // Trends are computed on request from current records; the worker only needs the CSV export renderer.
  registerTrendsExport();
}
