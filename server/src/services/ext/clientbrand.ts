import { DateTime } from 'luxon';
import PDFDocument from 'pdfkit';
import type { Db } from '../../lib/db.js';
import { many, one } from '../../lib/db.js';
import { audit } from '../../lib/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { type Actor, has, isStaff } from '../access.js';
import { notify } from '../notify.js';
import { drawPdfBrandHeader, type PdfBrand } from './clientbrand-brand.js';

/**
 * Client update reports. A highlights snapshot only ever holds client-visible facts:
 *  - tasks with customer_visible = true in a project that belongs to the client;
 *  - milestones that contain at least one such task (progress counts shared tasks only).
 * Internal time, people analytics, internal notes, task owners and estimates are never read into it.
 */
export interface HighlightItem { id: string; title: string; milestone: string | null }
export interface Highlights {
  generatedAt: string;
  project: { name: string; key: string; outcome: string; targetDate: string | null; status: string };
  milestones: { id: string; name: string; dueDate: string | null; status: string; done: number; total: number }[];
  completed: (HighlightItem & { completedOn: string })[];
  upcoming: (HighlightItem & { dueDate: string | null; status: string })[];
}

const UPCOMING_DAYS = 21;
const MAX_ITEMS = 40;

/** Owner of the client project, leadership and system admins prepare and publish updates. */
export function canManage(a: Actor, project: { owner_id: string | null }) {
  return isStaff(a) && (has(a, 'leadership') || has(a, 'system_admin') || project.owner_id === a.id);
}

/** Client projects this staff member can prepare updates for. */
export async function manageableProjects(db: Db, a: Actor) {
  if (!isStaff(a)) throw forbidden();
  const all = has(a, 'leadership') || has(a, 'system_admin');
  return many(db, `select p.id, p.key, p.name, p.status, p.target_date, p.owner_id, u.name owner_name, c.name customer_name,
      (select count(*) from tasks t where t.project_id = p.id and t.customer_visible)::int shared_tasks,
      (select count(*) from client_updates cu where cu.project_id = p.id and cu.status = 'draft')::int drafts,
      (select max(cu.published_at) from client_updates cu where cu.project_id = p.id and cu.status = 'published') last_published_at,
      (select count(*) from users cu where cu.customer_id = p.customer_id and cu.status = 'active' and 'customer' = any(cu.roles))::int client_users
    from projects p join customers c on c.id = p.customer_id left join users u on u.id = p.owner_id
    where p.status <> 'archived' and ($1::boolean or p.owner_id = $2) order by p.status <> 'active', p.name`, [all, a.id]);
}

async function loadClientProject(db: Db, projectId: string) {
  const p = await one(db, `select p.*, c.name customer_name from projects p join customers c on c.id = p.customer_id where p.id = $1`, [projectId]);
  if (!p) throw notFound('Client project not found (only projects linked to a client can have client updates)');
  return p;
}
export async function loadManagedProject(db: Db, a: Actor, projectId: string) {
  const p = await loadClientProject(db, projectId);
  if (!canManage(a, p)) throw forbidden('Only the project owner, leadership or a system admin can prepare client updates for this project');
  return p;
}

const tenantTz = async (db: Db, tenantId: string) => (await one(db, `select timezone from tenants where id = $1`, [tenantId])).timezone as string;

/** Build the client-visible snapshot for a project and period. */
export async function buildHighlights(db: Db, tenantId: string, projectId: string, start: string, end: string): Promise<Highlights> {
  const tz = await tenantTz(db, tenantId);
  const p = await loadClientProject(db, projectId);
  const milestones = await many(db, `select m.id, m.name, m.due_date, m.status,
      count(*) filter (where t.status = 'done')::int done, count(*) filter (where t.status <> 'cancelled')::int total
    from milestones m join tasks t on t.milestone_id = m.id and t.project_id = m.project_id and t.customer_visible
    where m.project_id = $1 and m.status <> 'cancelled' group by m.id order by m.due_date nulls last, m.name`, [projectId]);
  const completed = await many(db, `select t.id, t.title, m.name milestone, (coalesce(t.accepted_at, t.done_at) at time zone $4)::date::text completed_on
    from tasks t left join milestones m on m.id = t.milestone_id
    where t.project_id = $1 and t.customer_visible and t.status = 'done' and (coalesce(t.accepted_at, t.done_at) at time zone $4)::date between $2 and $3
    order by completed_on, t.title limit ${MAX_ITEMS}`, [projectId, start, end, tz]);
  const until = DateTime.fromISO(end).plus({ days: UPCOMING_DAYS }).toISODate();
  const upcoming = await many(db, `select t.id, t.title, m.name milestone, t.due_date, t.status
    from tasks t left join milestones m on m.id = t.milestone_id
    where t.project_id = $1 and t.customer_visible and t.status not in ('done','cancelled')
      and (t.due_date <= $2 or (t.due_date is null and t.status in ('in_progress','in_review','blocked')))
    order by t.due_date nulls last, t.title limit ${MAX_ITEMS}`, [projectId, until]);
  return {
    generatedAt: new Date().toISOString(),
    project: { name: p.name, key: p.key, outcome: p.business_outcome ?? '', targetDate: p.target_date, status: p.status },
    milestones: milestones.map((m) => ({ id: m.id, name: m.name, dueDate: m.due_date, status: m.status, done: m.done, total: m.total })),
    completed: completed.map((t) => ({ id: t.id, title: t.title, milestone: t.milestone, completedOn: t.completed_on })),
    upcoming: upcoming.map((t) => ({ id: t.id, title: t.title, milestone: t.milestone, dueDate: t.due_date, status: t.status })),
  };
}

/** Defence in depth: drop anything that is no longer shared with the client (sharing can be withdrawn after a draft is built). */
async function pruneToVisible(db: Db, projectId: string, h: Highlights): Promise<Highlights> {
  const vis = new Set((await many(db, `select id from tasks where project_id = $1 and customer_visible`, [projectId])).map((r) => r.id));
  const ms = new Set((await many(db, `select distinct milestone_id id from tasks where project_id = $1 and customer_visible and milestone_id is not null`, [projectId])).map((r) => r.id));
  return { ...h, milestones: (h.milestones ?? []).filter((m) => ms.has(m.id)), completed: (h.completed ?? []).filter((t) => vis.has(t.id)), upcoming: (h.upcoming ?? []).filter((t) => vis.has(t.id)) };
}

/** Monday..Sunday of the week containing `now` (tenant local). */
export function weekPeriod(now: DateTime) {
  const s = now.startOf('week');
  return { start: s.toISODate()!, end: s.plus({ days: 6 }).toISODate()! };
}

/** Create a draft for the period, or return the existing update for it (idempotent per project + period). */
export async function createDraft(db: Db, a: Actor | null, tenantId: string, projectId: string, start: string, end: string, source: 'manual' | 'scheduled') {
  if (end < start) throw badRequest('The period must end on or after its start');
  if (DateTime.fromISO(end).diff(DateTime.fromISO(start), 'days').days > 92) throw badRequest('A client update can cover at most 92 days');
  const highlights = await buildHighlights(db, tenantId, projectId, start, end);
  const row = await one(db, `insert into client_updates (tenant_id, project_id, period_start, period_end, highlights, source, created_by, updated_by)
    values ($1,$2,$3,$4,$5,$6,$7,$7) on conflict (tenant_id, project_id, period_start, period_end) do nothing returning *`,
    [tenantId, projectId, start, end, highlights, source, a?.id ?? null]);
  if (!row) return { update: await one(db, `select * from client_updates where project_id = $1 and period_start = $2 and period_end = $3`, [projectId, start, end]), created: false };
  await audit(db, { tenantId, actorId: a?.id ?? null, action: 'client_update.create', resourceType: 'client_update', resourceId: row.id, resourceVersion: row.version,
    authority: a ? null : 'weekly schedule (tenant setting)', details: { projectId, periodStart: start, periodEnd: end, source,
      counts: { milestones: highlights.milestones.length, completed: highlights.completed.length, upcoming: highlights.upcoming.length } } });
  return { update: row, created: true };
}

/** Weekly tick: prepare (never publish) drafts for active client projects on Fridays from noon, tenant local time. */
export async function createWeeklyDrafts(db: Db, tenantId: string, now?: DateTime) {
  const s = await one(db, `select weekly_drafts from tenant_branding where tenant_id = $1`, [tenantId]);
  if (!s?.weekly_drafts) return 0;
  const local = (now ?? DateTime.now()).setZone(await tenantTz(db, tenantId));
  if (local.weekday !== 5 || local.hour < 12) return 0;
  const { start, end } = weekPeriod(local);
  const projects = await many(db, `select p.id, p.name, p.owner_id from projects p where p.customer_id is not null and p.status in ('active','on_hold')
    and exists (select 1 from tasks t where t.project_id = p.id and t.customer_visible)`);
  let n = 0;
  for (const p of projects) {
    const r = await createDraft(db, null, tenantId, p.id, start, end, 'scheduled');
    if (!r.created) continue;
    n++;
    if (p.owner_id) await notify(db, tenantId, p.owner_id, 'client_update_draft', `Client update draft ready: ${p.name}`,
      'Review the summary and highlights, then publish when you are happy with it. Nothing is shared until you publish.', `/client-updates?update=${r.update.id}`);
  }
  return n;
}

// ---------- Reading ----------
const SELECT = `select cu.*, p.name project_name, p.key project_key, p.customer_id, p.owner_id project_owner_id, p.status project_status, c.name customer_name,
    pb.name published_by_name, ub.name updated_by_name, cb.name created_by_name
  from client_updates cu join projects p on p.id = cu.project_id left join customers c on c.id = p.customer_id
  left join users pb on pb.id = cu.published_by left join users ub on ub.id = cu.updated_by left join users cb on cb.id = cu.created_by`;

/** Exactly what the client sees. Used for the customer portal, the staff preview and the PDF. */
async function clientView(db: Db, r: any) {
  return {
    id: r.id, projectId: r.project_id, projectName: r.project_name, projectKey: r.project_key, customerName: r.customer_name,
    periodStart: r.period_start, periodEnd: r.period_end, summary: r.summary, publishedAt: r.published_at, publishedByName: r.published_by_name,
    highlights: await pruneToVisible(db, r.project_id, r.highlights),
  };
}
async function staffView(db: Db, a: Actor, r: any) {
  return { ...(await clientView(db, r)), status: r.status, version: r.version, source: r.source, createdAt: r.created_at, updatedAt: r.updated_at,
    createdByName: r.created_by_name, updatedByName: r.updated_by_name, canEdit: canManage(a, { owner_id: r.project_owner_id }) };
}

export async function listUpdates(db: Db, a: Actor, f: { projectId?: string; status?: 'draft' | 'published' }) {
  if (has(a, 'customer')) {
    if (!a.customerId) return [];
    const rows = await many(db, `${SELECT} where p.customer_id = $1 and p.status <> 'archived' and cu.status = 'published' and ($2::uuid is null or cu.project_id = $2)
      order by cu.period_end desc, cu.published_at desc limit 100`, [a.customerId, f.projectId ?? null]);
    return Promise.all(rows.map((r) => clientView(db, r)));
  }
  const all = has(a, 'leadership') || has(a, 'system_admin');
  const rows = await many(db, `${SELECT} where p.customer_id is not null and ($1::boolean or p.owner_id = $2) and ($3::uuid is null or cu.project_id = $3)
    and ($4::text is null or cu.status = $4) order by cu.period_end desc, cu.updated_at desc limit 200`, [all, a.id, f.projectId ?? null, f.status ?? null]);
  return Promise.all(rows.map((r) => staffView(db, a, r)));
}

async function loadRow(db: Db, id: string) { return one(db, `${SELECT} where cu.id = $1`, [id]); }

/** Customers: only published updates of their own (non-archived) projects. Staff: only projects they can manage. Anything else is "not found". */
export async function getUpdate(db: Db, a: Actor, id: string) {
  const r = await loadRow(db, id);
  if (has(a, 'customer')) {
    if (!r || r.status !== 'published' || !a.customerId || r.customer_id !== a.customerId || r.project_status === 'archived') throw notFound('Update not found');
    return clientView(db, r);
  }
  if (!r || !canManage(a, { owner_id: r.project_owner_id })) throw notFound('Update not found');
  return staffView(db, a, r);
}

async function loadEditable(db: Db, a: Actor, id: string) {
  const r = await loadRow(db, id);
  if (!r || has(a, 'customer') || !canManage(a, { owner_id: r.project_owner_id })) throw notFound('Update not found');
  return r;
}
async function bump(db: Db, id: string, version: number, set: string, params: unknown[], status: 'draft' | 'published') {
  const r = await one(db, `update client_updates set ${set}, version = version + 1, updated_at = now() where id = $1 and version = $2 and status = '${status}' returning *`,
    [id, version, ...params]);
  if (!r) throw conflict('This update changed since you opened it. Reload to see the latest version.');
  return r;
}

export async function editDraft(db: Db, a: Actor, id: string, b: { version: number; summary?: string; removeItemIds?: string[] }) {
  const r = await loadEditable(db, a, id);
  if (r.status !== 'draft') throw conflict('Published updates cannot be edited. Unpublish it first to make corrections.');
  const drop = new Set(b.removeItemIds ?? []);
  const h: Highlights = r.highlights;
  const highlights = { ...h, milestones: h.milestones.filter((m) => !drop.has(m.id)), completed: h.completed.filter((t) => !drop.has(t.id)), upcoming: h.upcoming.filter((t) => !drop.has(t.id)) };
  const u = await bump(db, id, b.version, `summary = coalesce($3, summary), highlights = $4, updated_by = $5`, [b.summary ?? null, highlights, a.id], 'draft');
  await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'client_update.edit', resourceType: 'client_update', resourceId: id, resourceVersion: u.version,
    details: { summaryChanged: b.summary !== undefined && b.summary !== r.summary, removedItems: [...drop].length } });
  return getUpdate(db, a, id);
}

export async function refreshDraft(db: Db, a: Actor, id: string, version: number) {
  const r = await loadEditable(db, a, id);
  if (r.status !== 'draft') throw conflict('Published updates cannot be refreshed. Unpublish it first.');
  const highlights = await buildHighlights(db, a.tenantId, r.project_id, r.period_start, r.period_end);
  const u = await bump(db, id, version, `highlights = $3, updated_by = $4`, [highlights, a.id], 'draft');
  await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'client_update.refresh', resourceType: 'client_update', resourceId: id, resourceVersion: u.version });
  return getUpdate(db, a, id);
}

/** Publishing is an explicit human action. Nothing is emailed: clients see it in the portal (and an in-app notification). */
export async function publishUpdate(db: Db, a: Actor, id: string, version: number) {
  const r = await loadEditable(db, a, id);
  if (r.status !== 'draft') throw conflict('This update is already published.');
  if (!r.summary.trim()) throw badRequest('Write a summary for the client before publishing.');
  const highlights = await pruneToVisible(db, r.project_id, r.highlights);
  const u = await bump(db, id, version, `status = 'published', highlights = $3, published_by = $4, published_at = now(), updated_by = $4`, [highlights, a.id], 'draft');
  await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'client_update.publish', resourceType: 'client_update', resourceId: id, resourceVersion: u.version,
    authority: 'explicit publish by staff', details: { projectId: r.project_id, customerId: r.customer_id, periodStart: r.period_start, periodEnd: r.period_end } });
  const clients = await many(db, `select id from users where customer_id = $1 and status = 'active' and 'customer' = any(roles)`, [r.customer_id]);
  for (const c of clients) await notify(db, a.tenantId, c.id, 'client_update', `New update: ${r.project_name}`, `Update for ${r.period_start} to ${r.period_end}`, `/portal?update=${id}`);
  return getUpdate(db, a, id);
}

export async function unpublishUpdate(db: Db, a: Actor, id: string, version: number, reason: string) {
  const r = await loadEditable(db, a, id);
  if (r.status !== 'published') throw conflict('This update is not published.');
  const u = await bump(db, id, version, `status = 'draft', published_by = null, published_at = null, updated_by = $3`, [a.id], 'published');
  await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'client_update.unpublish', resourceType: 'client_update', resourceId: id, resourceVersion: u.version, reason });
  return getUpdate(db, a, id);
}

export async function discardDraft(db: Db, a: Actor, id: string, version: number) {
  const r = await loadEditable(db, a, id);
  if (r.status !== 'draft') throw conflict('Published updates cannot be discarded. Unpublish it first.');
  const d = await db.query(`delete from client_updates where id = $1 and version = $2 and status = 'draft'`, [id, version]);
  if (!d.rowCount) throw conflict('This update changed since you opened it. Reload to see the latest version.');
  await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'client_update.discard', resourceType: 'client_update', resourceId: id, resourceVersion: version,
    details: { projectId: r.project_id, periodStart: r.period_start, periodEnd: r.period_end } });
  return { ok: true };
}

// ---------- PDF ----------
const fmtDay = (d: string | null) => (d ? DateTime.fromISO(d).toFormat('d LLL yyyy') : 'No date');
const STATUS: Record<string, string> = { backlog: 'Not started', planned: 'Planned', in_progress: 'In progress', blocked: 'Waiting', in_review: 'In review', done: 'Done', cancelled: 'Cancelled' };

/** Branded PDF of the client view. Helvetica only (no arrows or check marks). */
export function renderUpdatePdf(v: Awaited<ReturnType<typeof clientView>> & { status?: string }, brand: PdfBrand): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `${v.projectName} update ${v.periodStart} to ${v.periodEnd}`, Author: brand.name } });
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    drawPdfBrandHeader(doc, brand);
    const h = v.highlights;
    const h2 = (t: string) => doc.moveDown(0.8).font('Helvetica-Bold').fontSize(12).fillColor('#111827').text(t).moveDown(0.25);
    const p = (t: string, color = '#374151', size = 10) => doc.font('Helvetica').fontSize(size).fillColor(color).text(t, { lineGap: 2 });
    if (v.status === 'draft') p('DRAFT - not yet shared with the client', '#a32626', 9);
    doc.font('Helvetica-Bold').fontSize(18).fillColor('#111827').text(`${v.projectName} - project update`).moveDown(0.2);
    p(`${fmtDay(v.periodStart)} to ${fmtDay(v.periodEnd)}${v.customerName ? ` | Prepared for ${v.customerName}` : ''}`, '#4b5563');
    if (v.publishedAt) p(`Published ${DateTime.fromJSDate(new Date(v.publishedAt)).toFormat('d LLL yyyy')}${v.publishedByName ? ` by ${v.publishedByName}` : ''}`, '#6b7280', 9);
    h2('Summary');
    p(v.summary.trim() || 'No summary written yet.');
    h2('Milestone progress');
    if (!h.milestones.length) p('No shared milestones yet.', '#6b7280');
    for (const m of h.milestones) {
      const pctDone = m.total ? Math.round((m.done / m.total) * 100) : 0;
      p(`${m.name}: ${m.done} of ${m.total} shared items done (${pctDone}%) | ${m.status === 'done' ? 'Milestone complete' : `Due ${fmtDay(m.dueDate)}`}`);
    }
    h2('Completed this period');
    if (!h.completed.length) p('No shared deliverables were completed in this period.', '#6b7280');
    for (const t of h.completed) p(`- ${t.title}${t.milestone ? ` (${t.milestone})` : ''} | ${fmtDay(t.completedOn)}`);
    h2('Coming up');
    if (!h.upcoming.length) p('No upcoming shared work scheduled.', '#6b7280');
    for (const t of h.upcoming) p(`- ${t.title}${t.milestone ? ` (${t.milestone})` : ''} | ${STATUS[t.status] ?? t.status}${t.dueDate ? `, due ${fmtDay(t.dueDate)}` : ''}`);
    doc.moveDown(1.2).font('Helvetica').fontSize(7.5).fillColor('#6b7280')
      .text(`Prepared by ${brand.name}. This update lists only milestones and deliverables your project team shares with you; target dates can change.`);
    doc.end();
  });
}
