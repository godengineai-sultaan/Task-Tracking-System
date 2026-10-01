import PDFDocument from 'pdfkit';
import type { Db } from '../lib/db.js';
import { one } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { enqueue } from '../lib/jobs.js';
import { storeFile } from '../lib/storage.js';
import { badRequest, forbidden } from '../lib/errors.js';
import { type Actor, assertCanViewPerson, has, loadActor } from './access.js';
import { buildReport } from './analytics.js';
import { leadershipDelivery, routineTable } from './oversight.js';
import { drawPdfBrandHeader, loadPdfBrand, type PdfBrand } from './ext/clientbrand-brand.js';

/** Extension point: feature areas register additional export report types (authorized + rendered server-side). */
export interface ExportReportDef {
  authorize(db: Db, a: Actor, params: any): Promise<void>;
  build(db: Db, a: Actor, params: any): Promise<{ data: any; name: string }>;
  csv?(data: any): string;
  /** `brand` (organization name, accent, raster logo) is supplied so the report can call drawPdfBrandHeader(doc, brand). */
  pdf?(data: any, a: Actor, brand?: PdfBrand): Promise<Buffer>;
}
const extraReports = new Map<string, ExportReportDef>();
export function registerExportReport(name: string, def: ExportReportDef) { extraReports.set(name, def); }

export interface ExportParams { userId?: string; kind?: 'day' | 'week' | 'month' | 'custom'; start?: string; end?: string; date?: string; departmentId?: string; projectId?: string }

export async function requestExport(db: Db, a: Actor, format: 'pdf' | 'csv', report: string, params: ExportParams & Record<string, any>) {
  await authorizeExport(db, a, report, params);
  const ext = extraReports.get(report);
  if (ext && !(format === 'csv' ? ext.csv : ext.pdf)) throw badRequest(`This report is not available as ${format.toUpperCase()}`);
  const row = await one(db, `insert into exports (tenant_id, requested_by, format, report, params) values ($1,$2,$3,$4,$5) returning *`, [a.tenantId, a.id, format, report, params]);
  await enqueue(db, { tenantId: a.tenantId, kind: 'export.generate', payload: { exportId: row.id }, idempotencyKey: `export:${row.id}`, maxAttempts: 3 });
  await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'export.request', resourceType: 'export', resourceId: row.id, details: { format, report, params } });
  return row;
}

async function authorizeExport(db: Db, a: Actor, report: string, p: any) {
  const ext = extraReports.get(report);
  if (ext) return ext.authorize(db, a, p);
  if (report === 'individual') {
    if (!p.userId || !p.start || !p.end) throw badRequest('userId, start and end are required');
    await assertCanViewPerson(db, a, p.userId);
  } else if (report === 'team_daily') {
    if (!p.date) throw badRequest('date is required');
    if (!has(a, 'routine_admin') && !a.managedUserIds.length) throw forbidden();
  } else if (report === 'delivery') {
    if (!has(a, 'leadership') && !has(a, 'routine_admin')) throw forbidden();
  } else throw badRequest('Unknown report');
}

/** Job: re-authorize as the requester at generation time, then render from current records. */
export async function generateExport(db: Db, exportId: string) {
  const ex = await one(db, `select * from exports where id = $1`, [exportId]);
  if (!ex || ex.status === 'ready') return;
  await db.query(`update exports set status = 'running' where id = $1`, [exportId]);
  const a = await loadActor(db, ex.tenant_id, ex.requested_by);
  if (!a) { await db.query(`update exports set status = 'failed', error = 'Requester is no longer active' where id = $1`, [exportId]); return; }
  try { await authorizeExport(db, a, ex.report, ex.params); } catch {
    await db.query(`update exports set status = 'failed', error = 'Requester is no longer authorized for this report' where id = $1`, [exportId]); return;
  }
  const p = ex.params as ExportParams;
  let data: any, name: string;
  const ext = extraReports.get(ex.report);
  if (ext) {
    const built = await ext.build(db, a, ex.params);
    const buf = ex.format === 'csv' ? Buffer.from(ext.csv!(built.data), 'utf8') : await ext.pdf!(built.data, a, await loadPdfBrand(db, ex.tenant_id));
    const file = await storeFile(db, ex.tenant_id, buf, `${built.name}.${ex.format}`, ex.format === 'csv' ? 'text/csv' : 'application/pdf', 'export', a.id);
    await db.query(`update exports set status = 'ready', file_id = $2, completed_at = now() where id = $1`, [exportId, file.id]);
    return;
  }
  if (ex.report === 'individual') { data = await buildReport(db, p.userId!, p.kind ?? 'custom', p.start!, p.end!); name = `report-${slug(data.subject.name)}-${p.start}-to-${p.end}`; }
  else if (ex.report === 'team_daily') { data = await routineTable(db, a, { date: p.date!, departmentId: p.departmentId, projectId: p.projectId }); name = `daily-routine-${p.date}`; }
  else { data = await leadershipDelivery(db, a); name = `delivery-${new Date().toISOString().slice(0, 10)}`; }
  const buf = ex.format === 'csv' ? Buffer.from(toCsv(ex.report, data), 'utf8') : await toPdf(ex.report, data, a, await loadPdfBrand(db, ex.tenant_id));
  const file = await storeFile(db, ex.tenant_id, buf, `${name}.${ex.format}`, ex.format === 'csv' ? 'text/csv' : 'application/pdf', 'export', a.id);
  await db.query(`update exports set status = 'ready', file_id = $2, completed_at = now() where id = $1`, [exportId, file.id]);
}
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');

// ---------- CSV ----------
export function csvCell(v: unknown) {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // spreadsheet formula injection guard
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const csv = (rows: unknown[][]) => rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
const pctv = (v: number | null | undefined) => (v === null || v === undefined ? 'N/A' : (v * 100).toFixed(0) + '%');

export function toCsv(report: string, d: any) {
  if (report === 'individual') {
    const head = [['Report', `${d.subject.name} — ${d.period.kind} ${d.period.start} to ${d.period.end}`], ['State', d.reportState], ['Assessment', d.assessment.label],
      ['Definitions', d.definitions.version], ['Generated', d.generatedAt], []];
    const rows = [['date', 'capacity_status', 'available_min', 'confirmed_min', 'unknown_min', 'logging_coverage', 'task_min', 'meeting_min', 'admin_min', 'learning_min', 'other_min',
      'outside_schedule_min', 'conflict_min', 'intended_outcomes', 'accepted_planned', 'carryovers', 'blocked_min', 'recap_state', 'recap_version', 'assessment']];
    for (const day of d.days) {
      const t = day.time;
      rows.push([day.date, day.capacity.status, day.capacity.availableMinutes, t.explainedMinutes, t.unknownMinutes, day.capacity.availableMinutes ? pctv(t.coverage) : 'N/A',
        t.byCategory.task, t.byCategory.meeting, t.byCategory.admin, t.byCategory.learning, t.byCategory.other, t.outsideScheduleMinutes,
        t.conflicts.reduce((s: number, c: any) => s + c.minutes, 0), day.intendedOutcomes.length, day.acceptedPlanned, day.carryovers.length, day.blockedMinutes,
        day.reportState, day.recap?.version ?? '', day.assessment.label]);
    }
    const s = d.summary;
    const totals = [[], ['Totals'], ['available_min', s.availableMinutes], ['confirmed_min', s.explainedMinutes], ['unknown_min', s.unknownMinutes], ['logging_coverage', pctv(s.loggingCoverage)],
      ['planned_commitment_completion', pctv(s.plannedCommitmentCompletion)], ['accepted_outcomes', s.acceptedOutcomes], ['evidence_coverage', pctv(s.evidenceCoverage)],
      ['rework', s.reworkCount], ['deadlines_met', s.deadlines.met], ['deadlines_late', s.deadlines.late], ['deadlines_overdue', s.deadlines.overdue]];
    return csv([...head, ...rows, ...totals]);
  }
  if (report === 'team_daily') {
    return csv([['date', 'employee', 'department', 'capacity', 'available_min', 'plan', 'accepted_planned', 'in_progress', 'blocked', 'overdue', 'confirmed_min', 'unknown_min', 'coverage', 'recap_status', 'assessment'],
      ...d.rows.map((r: any) => [r.date, r.user.name, r.user.department ?? '', r.capacityStatus, r.availableMinutes, r.plan.map((p: any) => `${p.title} [${p.status}]`).join(' | '),
        r.acceptedPlanned, r.inProgress, r.blocked, r.overdue, r.explainedMinutes, r.unknownMinutes, r.availableMinutes ? pctv(r.coverage) : 'N/A', r.recapStatus, r.assessment])]);
  }
  return csv([['project', 'key', 'status', 'owner', 'customer', 'open', 'done', 'blocked', 'overdue', 'in_review', 'reworked', 'remaining_estimate_min', 'target_date'],
    ...d.projects.map((p: any) => [p.name, p.key, p.status, p.owner ?? '', p.customer ?? '', p.open, p.done, p.blocked, p.overdue, p.in_review, p.reworked, p.remaining_estimate, p.target_date ?? ''])]);
}

// ---------- PDF ----------
const hm = (m: number) => `${Math.floor(m / 60)}h ${Math.round(m % 60)}m`;
export function toPdf(report: string, d: any, a: Actor, brand?: PdfBrand): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: 'Task Tracking report', Author: 'Task Tracking and Productivity' } });
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    if (brand) drawPdfBrandHeader(doc, brand);
    const h1 = (t: string) => doc.font('Helvetica-Bold').fontSize(18).fillColor('#111827').text(t).moveDown(0.3);
    const h2 = (t: string) => { doc.moveDown(0.6).font('Helvetica-Bold').fontSize(12).fillColor('#111827').text(t).moveDown(0.2); };
    const p = (t: string, color = '#374151') => doc.font('Helvetica').fontSize(9.5).fillColor(color).text(t, { lineGap: 2 });
    const kv = (k: string, v: string) => { doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#111827').text(`${k}: `, { continued: true }).font('Helvetica').fillColor('#374151').text(v); };
    const footer = `Generated ${new Date().toISOString()} for ${a.name}. Authorized records only. Logging coverage is not productivity; unknown time is not idle time.`;
    if (report === 'individual') {
      const s = d.summary;
      h1(`${d.subject.name} — ${d.period.kind === 'day' ? 'Daily' : d.period.kind[0].toUpperCase() + d.period.kind.slice(1) + 'ly'} report`);
      p(`${d.period.start}${d.period.end !== d.period.start ? ` to ${d.period.end}` : ''} · ${d.subject.title || ''} ${d.subject.department ? '· ' + d.subject.department : ''} · ${d.timezone}`);
      p(`Report state: ${d.reportState.replace('_', ' ')} · Metric definitions ${d.definitions.version}`, '#6b7280');
      h2(`Assessment: ${d.assessment.label.replace('_', ' ').toUpperCase()}`);
      d.assessment.reasons.forEach((r: string) => p(`• ${r}`));
      d.assessment.facts.forEach((r: string) => p(`– ${r}`, '#4b5563'));
      p(`Assumptions: ${d.assessment.assumptions.join('; ')}`, '#6b7280');
      h2('Time allocation');
      kv('Available', hm(s.availableMinutes)); kv('Confirmed', `${hm(s.explainedMinutes)} (${pctv(s.loggingCoverage)} logging coverage)`); kv('Unknown', hm(s.unknownMinutes));
      kv('By category', Object.entries(s.byCategory).map(([k, v]) => `${k} ${hm(v as number)}`).join(', '));
      if (s.conflictMinutes) kv('Overlaps counted once', hm(s.conflictMinutes));
      h2('Delivery');
      kv('Intended outcomes accepted', `${s.acceptedPlannedOutcomes}/${s.intendedOutcomes} (${pctv(s.plannedCommitmentCompletion)})`);
      kv('Accepted outcomes', String(s.acceptedOutcomes)); kv('Carryovers', String(s.carryovers)); kv('Evidence coverage', pctv(s.evidenceCoverage)); kv('Rework', String(s.reworkCount));
      kv('Deadlines', `${s.deadlines.met} met, ${s.deadlines.late} late, ${s.deadlines.overdue} overdue, ${s.deadlines.open} open`);
      d.acceptedOutcomes.slice(0, 25).forEach((o: any) => p(`+ ${o.title}${o.project ? ` (${o.project})` : ''}${o.reviewed ? ' — reviewer accepted' : ' — self-accepted'}`));
      h2('Bottlenecks');
      if (!d.blockers.length) p('No blockers recorded.');
      d.blockers.slice(0, 20).forEach((b: any) => p(`• ${b.task}: ${b.reason} [${b.cause}] waiting on ${b.waitingOn || '—'}${b.resolvedAt ? ' (resolved)' : ''}`));
      if (d.trend) { h2('Trend vs previous period'); p(`Commitment completion ${pctv(d.trend.plannedCommitmentCompletion.previous)} to ${pctv(d.trend.plannedCommitmentCompletion.current)}; coverage ${pctv(d.trend.loggingCoverage.previous)} to ${pctv(d.trend.loggingCoverage.current)}; blocked ${hm(d.trend.blockedMinutes.previous)} to ${hm(d.trend.blockedMinutes.current)}.`); p(d.trend.note, '#6b7280'); }
      h2('Recommendations');
      if (!d.recommendations.length) p('No actions suggested.');
      d.recommendations.forEach((r: any) => p(`> ${r.text}`));
      h2('Daily detail');
      for (const day of d.days) {
        p(`${day.date} · ${day.capacity.status} · ${day.capacity.availableMinutes ? `${hm(day.time.explainedMinutes)}/${hm(day.capacity.availableMinutes)} confirmed` : 'Not applicable (zero capacity)'} · ${day.acceptedPlanned}/${day.intendedOutcomes.length} outcomes · recap ${day.recap ? `${day.recap.status} v${day.recap.version}` : 'missing'} · ${day.assessment.label.replace('_', ' ')}`);
      }
    } else if (report === 'team_daily') {
      h1(`Daily routine — ${d.date}`);
      p(`Scope: ${d.scope}. Recap completion ${pctv(d.rollup.recapCompletion)}, ${d.rollup.missing} missing, ${d.rollup.blocked} blocked tasks, ${d.rollup.overdue} overdue.`);
      for (const r of d.rows) {
        h2(`${r.user.name}${r.user.department ? ` · ${r.user.department}` : ''}`);
        p(`Capacity ${r.capacityStatus} (${hm(r.availableMinutes)}) · recap ${r.recapStatus} · ${r.assessment.replace('_', ' ')}`);
        p(`Plan: ${r.plan.map((x: any) => `${x.title} [${x.status}]`).join('; ') || 'none'}`);
        p(`Confirmed ${hm(r.explainedMinutes)}, unknown ${hm(r.unknownMinutes)} · in progress ${r.inProgress}, blocked ${r.blocked}, overdue ${r.overdue}`);
      }
    } else {
      h1('Delivery overview');
      for (const pr of d.projects) p(`${pr.key} ${pr.name} — open ${pr.open}, done ${pr.done}, blocked ${pr.blocked}, overdue ${pr.overdue}, in review ${pr.in_review}${pr.target_date ? `, target ${pr.target_date}` : ''}`);
      h2('Open milestones');
      for (const m of d.milestones) p(`${m.project}: ${m.name} — ${m.done}/${m.tasks} tasks done${m.due_date ? `, due ${m.due_date}` : ''}`);
      h2('Blocker patterns');
      for (const b of d.blockerPatterns) p(`${b.cause}: ${b.open} open, average age ${b.avg_age_hours}h`);
    }
    doc.moveDown(1).font('Helvetica').fontSize(7.5).fillColor('#9ca3af').text(footer);
    doc.end();
  });
}
