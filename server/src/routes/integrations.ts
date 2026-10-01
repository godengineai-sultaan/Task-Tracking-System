import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tx } from '../app.js';
import { config } from '../lib/config.js';
import { many, one, withSystem, withTenant } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { forbidden, notFound } from '../lib/errors.js';
import { has } from '../services/access.js';
import { CONNECTION_KINDS, SCHEMA_VERSION, createConnection, decideSuggestion, importIcs, receiveInbound, reprocessEvent } from '../services/integrations.js';

export async function integrationRoutes(app: FastifyInstance) {
  app.get('/api/integrations', async (req) => tx(req, async (db, a) => {
    const t = await one(db, `select slug from tenants where id = $1`, [a.tenantId]);
    const rows = await many(db, `select c.id, c.kind, c.name, c.status, c.settings, c.last_sync_at, c.last_error, c.created_at, c.user_id,
        (select count(*) from integration_events e where e.connection_id = c.id)::int events,
        (select count(*) from integration_events e where e.connection_id = c.id and e.status in ('rejected','ignored'))::int not_applied
      from integration_connections c where c.user_id = $1 or ($2::boolean and c.user_id is null) order by c.created_at`, [a.id, has(a, 'system_admin')]);
    return { connections: rows.map((r) => ({ ...r, inboundUrl: r.user_id ? null : `${config.publicUrl.replace(/:\d+$/, ':' + config.port)}/api/inbound/${t.slug}/${r.id}` })),
      schemaVersion: SCHEMA_VERSION, kinds: CONNECTION_KINDS };
  }));
  app.post('/api/integrations', async (req) => tx(req, async (db, a) => {
    const b = z.object({ kind: z.enum(CONNECTION_KINDS), name: z.string().min(1).max(120), settings: z.record(z.string(), z.unknown()).optional() }).parse(req.body);
    return createConnection(db, a, b);
  }));
  app.patch('/api/integrations/:id', async (req) => tx(req, async (db, a) => {
    const c = await one(db, `select * from integration_connections where id = $1`, [(req.params as any).id]);
    if (!c) throw notFound();
    if (c.user_id ? c.user_id !== a.id : !has(a, 'system_admin')) throw forbidden();
    const b = z.object({ status: z.enum(['active', 'paused', 'revoked']) }).parse(req.body);
    await db.query(`update integration_connections set status = $2 where id = $1`, [c.id, b.status]);
    await audit(db, { tenantId: a.tenantId, actorId: a.id, action: `integration.${b.status}`, resourceType: 'integration_connection', resourceId: c.id });
    return { ok: true };
  }));
  app.get('/api/integrations/:id/events', async (req) => tx(req, async (db, a) => {
    const c = await one(db, `select * from integration_connections where id = $1`, [(req.params as any).id]);
    if (!c || (c.user_id ? c.user_id !== a.id : !has(a, 'system_admin'))) throw notFound();
    return many(db, `select id, event_id, event_type, schema_version, resource_id, occurred_at, received_at, status, result, correlation_id from integration_events
      where connection_id = $1 order by received_at desc limit 100`, [c.id]);
  }));
  app.post('/api/integrations/events/:id/reprocess', async (req) => tx(req, async (db, a) => { await reprocessEvent(db, a, (req.params as any).id); return { ok: true }; }));
  app.post('/api/integrations/:id/ics', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => tx(req, async (db, a) => {
    const { ics } = z.object({ ics: z.string().min(10).max(5_000_000) }).parse(req.body);
    return importIcs(db, a, (req.params as any).id, ics);
  }));

  app.post('/api/suggestions/:id/decide', async (req) => tx(req, async (db, a) => {
    const b = z.object({ decision: z.enum(['accept', 'dismiss']), taskId: z.string().uuid().optional() }).parse(req.body);
    return decideSuggestion(db, a, (req.params as any).id, b.decision, { taskId: b.taskId });
  }));

  // Signed machine-to-machine delivery from other modules / tools. Authenticated by HMAC, not by session.
  app.post('/api/inbound/:slug/:connectionId', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { slug, connectionId } = req.params as any;
    const t = await withSystem((db) => one(db, `select id from tenants where slug = $1 and status = 'active'`, [slug]));
    if (!t) throw notFound('Unknown connection');
    const result = await withTenant(t.id, (db) => receiveInbound(db, t.id, connectionId, req.rawBody ?? '', req.headers['x-signature'] as string, req.headers['x-timestamp'] as string));
    return reply.status(result.status === 'rejected' ? 422 : result.status === 'duplicate' ? 200 : 202).send(result);
  });
}
