import type { FastifyInstance } from 'fastify';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { actorOf, tx } from '../../app.js';
import { one } from '../../lib/db.js';
import { audit } from '../../lib/audit.js';
import { AppError, badRequest, forbidden, notFound } from '../../lib/errors.js';
import { readStored, storeFile } from '../../lib/storage.js';
import { has, isStaff } from '../../services/access.js';
import {
  DEFAULT_ACCENT, HEX, LOGO_MAX_BYTES, MIN_CONTRAST, contrastWithWhite, loadBranding, loadPdfBrand, nearestAccessibleShade, validateLogo,
} from '../../services/ext/clientbrand-brand.js';
import {
  createDraft, discardDraft, editDraft, getUpdate, listUpdates, loadManagedProject, manageableProjects, publishUpdate, refreshDraft, renderUpdatePdf,
  unpublishUpdate, weekPeriod,
} from '../../services/ext/clientbrand.js';

const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const idParam = (req: any) => z.object({ id: uuid }).parse(req.params).id;
const versionBody = z.object({ version: z.number().int().min(1) });

/** Routes for the 'clientbrand' feature area: tenant branding and client update reports. */
export default async function (app: FastifyInstance) {
  // ---------- Branding ----------
  app.get('/api/branding', async (req) => tx(req, async (db, a) => {
    const b = await loadBranding(db, a.tenantId);
    return {
      displayName: b.name, accent: b.accent, defaultAccent: DEFAULT_ACCENT, version: b.version, updatedAt: b.updatedAt,
      logo: b.logoFileId ? { url: `/api/branding/logo?v=${b.logoFileId}`, mime: b.logoMime } : null,
      ...(isStaff(a) ? { weeklyDrafts: b.weeklyDrafts } : {}),
      canEdit: has(a, 'system_admin'),
    };
  }));

  app.put('/api/branding', async (req) => tx(req, async (db, a) => {
    if (!has(a, 'system_admin')) throw forbidden('Only a system admin can change branding');
    const b = z.object({
      displayName: z.string().trim().min(2).max(120),
      accent: z.string().trim().toLowerCase().regex(HEX, 'Use a 6-digit hex colour such as #256abf').nullable(),
      version: z.number().int().min(0),
    }).parse(req.body);
    if (b.accent && contrastWithWhite(b.accent) < MIN_CONTRAST) {
      const ratio = Math.round(contrastWithWhite(b.accent) * 100) / 100;
      const suggestion = nearestAccessibleShade(b.accent);
      throw new AppError(400, 'contrast', `White text on ${b.accent} has ${ratio}:1 contrast; at least ${MIN_CONTRAST}:1 is required. The nearest accessible shade is ${suggestion}.`,
        { ratio, suggestion, suggestionRatio: Math.round(contrastWithWhite(suggestion) * 100) / 100 });
    }
    const before = await loadBranding(db, a.tenantId);
    const row = await one(db, `insert into tenant_branding (tenant_id, accent, updated_by) values ($1,$2,$3)
      on conflict (tenant_id) do update set accent = excluded.accent, updated_by = excluded.updated_by, version = tenant_branding.version + 1, updated_at = now()
      where tenant_branding.version = $4 returning version`, [a.tenantId, b.accent, a.id, b.version]);
    if (!row) throw new AppError(409, 'conflict', 'Branding changed since you opened it. Reload to see the latest version.');
    if (b.displayName !== before.name) await db.query(`update tenants set name = $2 where id = $1`, [a.tenantId, b.displayName]);
    await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'branding.update', resourceType: 'tenant_branding', resourceId: a.tenantId, resourceVersion: row.version,
      details: { displayName: { from: before.name, to: b.displayName }, accent: { from: before.accent, to: b.accent } } });
    return { ok: true, version: row.version };
  }));

  app.post('/api/branding/logo', async (req) => {
    const a = actorOf(req);
    if (!has(a, 'system_admin')) throw forbidden('Only a system admin can change the logo');
    if (!req.isMultipart()) throw badRequest('Upload the logo as a file');
    let buf: Buffer, filename: string;
    try {
      const file = await req.file({ limits: { fileSize: LOGO_MAX_BYTES, files: 1 } });
      if (!file) throw badRequest('No file');
      buf = await file.toBuffer(); filename = file.filename;
    } catch (e: any) {
      if (e?.code === 'FST_REQ_FILE_TOO_LARGE') throw badRequest('Logo must be 200 KB or smaller.');
      throw e;
    }
    const v = validateLogo(buf);
    if ('error' in v) throw badRequest(v.error);
    return tx(req, async (db) => {
      const ext = v.mime === 'image/png' ? 'png' : v.mime === 'image/jpeg' ? 'jpg' : 'svg';
      const stored = await storeFile(db, a.tenantId, buf, `logo.${ext}`, v.mime, 'import', a.id);
      await db.query(`update stored_files set purpose = 'branding' where id = $1`, [stored.id]);
      const row = await one(db, `insert into tenant_branding (tenant_id, logo_file_id, updated_by) values ($1,$2,$3)
        on conflict (tenant_id) do update set logo_file_id = excluded.logo_file_id, updated_by = excluded.updated_by, version = tenant_branding.version + 1, updated_at = now()
        returning version`, [a.tenantId, stored.id, a.id]);
      await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'branding.logo_upload', resourceType: 'tenant_branding', resourceId: a.tenantId, resourceVersion: row.version,
        details: { mime: v.mime, size: buf.length, originalName: String(filename).slice(0, 120), sha256: stored.sha256 } });
      return { ok: true, version: row.version, logo: { url: `/api/branding/logo?v=${stored.id}`, mime: v.mime } };
    });
  });

  app.delete('/api/branding/logo', async (req) => tx(req, async (db, a) => {
    if (!has(a, 'system_admin')) throw forbidden('Only a system admin can change the logo');
    const row = await one(db, `update tenant_branding set logo_file_id = null, updated_by = $2, version = version + 1, updated_at = now() where tenant_id = $1 returning version`, [a.tenantId, a.id]);
    await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'branding.logo_remove', resourceType: 'tenant_branding', resourceId: a.tenantId, resourceVersion: row?.version ?? null });
    return { ok: true, version: row?.version ?? 0 };
  }));

  // Logo bytes: only for signed-in users of this tenant (RLS-scoped lookup). SVGs are pre-validated and additionally sandboxed.
  app.get('/api/branding/logo', async (req, reply) => {
    const out = await tx(req, async (db, a) => {
      const f = await one(db, `select f.* from tenant_branding b join stored_files f on f.id = b.logo_file_id where b.tenant_id = $1`, [a.tenantId]);
      if (!f) throw notFound('No logo');
      return { f, data: await readStored(f) };
    });
    reply.header('content-type', out.f.mime).header('cache-control', 'private, max-age=86400')
      .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
      .header('content-disposition', `inline; filename="${out.f.filename}"`);
    return reply.send(out.data);
  });

  // ---------- Client updates (staff) ----------
  app.get('/api/client-updates/projects', async (req) => tx(req, async (db, a) => manageableProjects(db, a)));

  app.put('/api/client-updates/settings', async (req) => tx(req, async (db, a) => {
    if (!isStaff(a) || (!has(a, 'leadership') && !has(a, 'system_admin'))) throw forbidden('Leadership or a system admin can change this setting');
    const b = z.object({ weeklyDrafts: z.boolean() }).parse(req.body);
    await db.query(`insert into tenant_branding (tenant_id, weekly_drafts, updated_by) values ($1,$2,$3)
      on conflict (tenant_id) do update set weekly_drafts = excluded.weekly_drafts, updated_by = excluded.updated_by, updated_at = now()`, [a.tenantId, b.weeklyDrafts, a.id]);
    await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'client_update.settings', resourceType: 'tenant_branding', resourceId: a.tenantId, details: b });
    return { weeklyDrafts: b.weeklyDrafts };
  }));

  app.get('/api/client-updates', async (req) => tx(req, async (db, a) => {
    const q = z.object({ projectId: uuid.optional(), status: z.enum(['draft', 'published']).optional() }).parse(req.query);
    return listUpdates(db, a, q);
  }));

  app.post('/api/client-updates', async (req) => tx(req, async (db, a) => {
    const b = z.object({ projectId: uuid, periodStart: date.optional(), periodEnd: date.optional() }).parse(req.body);
    const p = await loadManagedProject(db, a, b.projectId);
    const tz = (await one(db, `select timezone from tenants where id = $1`, [a.tenantId])).timezone;
    const week = weekPeriod(DateTime.now().setZone(tz));
    const r = await createDraft(db, a, a.tenantId, p.id, b.periodStart ?? week.start, b.periodEnd ?? week.end, 'manual');
    return { ...(await getUpdate(db, a, r.update.id)), created: r.created };
  }));

  app.get('/api/client-updates/:id', async (req) => tx(req, (db, a) => getUpdate(db, a, idParam(req))));

  app.patch('/api/client-updates/:id', async (req) => tx(req, async (db, a) => {
    const b = z.object({ version: z.number().int().min(1), summary: z.string().max(8000).optional(), removeItemIds: z.array(uuid).max(200).optional() }).parse(req.body);
    return editDraft(db, a, idParam(req), b);
  }));
  app.post('/api/client-updates/:id/refresh', async (req) => tx(req, (db, a) => refreshDraft(db, a, idParam(req), versionBody.parse(req.body).version)));
  app.post('/api/client-updates/:id/publish', async (req) => tx(req, (db, a) => publishUpdate(db, a, idParam(req), versionBody.parse(req.body).version)));
  app.post('/api/client-updates/:id/unpublish', async (req) => tx(req, async (db, a) => {
    const b = versionBody.extend({ reason: z.string().trim().min(3).max(500) }).parse(req.body);
    return unpublishUpdate(db, a, idParam(req), b.version, b.reason);
  }));
  app.delete('/api/client-updates/:id', async (req) => tx(req, (db, a) => discardDraft(db, a, idParam(req), versionBody.parse(req.body).version)));

  // Branded PDF of exactly what the client sees. Customers: published updates of their own projects only.
  app.get('/api/client-updates/:id/pdf', async (req, reply) => {
    const out = await tx(req, async (db, a) => {
      const v: any = await getUpdate(db, a, idParam(req));
      const buf = await renderUpdatePdf(v, await loadPdfBrand(db, a.tenantId));
      await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'client_update.download', resourceType: 'client_update', resourceId: v.id, details: { format: 'pdf' } });
      return { buf, name: `${v.projectKey}-update-${v.periodEnd}${v.status === 'draft' ? '-DRAFT' : ''}.pdf` };
    });
    reply.header('content-type', 'application/pdf').header('content-disposition', `attachment; filename="${out.name}"`);
    return reply.send(out.buf);
  });
}
