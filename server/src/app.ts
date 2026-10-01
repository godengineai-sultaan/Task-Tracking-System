import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fstatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ZodError } from 'zod';
import { config } from './lib/config.js';
import { AppError, unauthorized } from './lib/errors.js';
import { withSystem, withTenant, one, type Db } from './lib/db.js';
import { sha256 } from './lib/crypto.js';
import { log } from './lib/log.js';
import { type Actor, loadActor } from './services/access.js';
import { authRoutes } from './routes/auth.js';
import { taskRoutes } from './routes/tasks.js';
import { myDayRoutes } from './routes/myday.js';
import { reportRoutes } from './routes/reports.js';
import { adminRoutes } from './routes/admin.js';
import { integrationRoutes } from './routes/integrations.js';
import { projectRoutes } from './routes/projects.js';
import { extRoutes } from './routes/ext/index.js';
import { FOCUS_HEADER, actorScope, requestFocus } from './services/ext/portfolio-scope.js';

declare module 'fastify' {
  interface FastifyRequest { actor?: Actor; rawBody?: string }
}

export const SESSION_COOKIE = 'tt_sid';
const PUBLIC = [/^\/api\/auth\/(login|mfa|logout|signup)$/, /^\/api\/join\//, /^\/api\/inbound\//, /^\/api\/health$/, /^\/api\/tenants\/[^/]+\/public$/];

export function actorOf(req: FastifyRequest): Actor {
  if (!req.actor) throw unauthorized();
  return req.actor;
}
/**
 * Run a handler in a tenant-scoped RLS transaction as the signed-in actor. The actor's product scope always applies;
 * the product focus header applies only to GET requests on the list endpoints in FOCUS_PATHS (services/ext/portfolio-scope.ts).
 */
export async function tx<T>(req: FastifyRequest, fn: (db: Db, a: Actor) => Promise<T>) {
  const a = actorOf(req);
  const focus = requestFocus(a, req.method, req.url, req.headers[FOCUS_HEADER]);
  return withTenant(a.tenantId, (db) => fn(db, a), actorScope(a, focus));
}

export async function buildApp() {
  const app = Fastify({ logger: false, bodyLimit: 6 * 1024 * 1024, trustProxy: false, genReqId: () => crypto.randomUUID() });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 15 * 1024 * 1024, files: 1 } });
  await app.register(rateLimit, { global: false });

  // Keep raw body for webhook signature verification.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as FastifyRequest).rawBody = body as string;
    if (!body) return done(null, {});
    try { done(null, JSON.parse(body as string)); } catch { done(new AppError(400, 'bad_json', 'Invalid JSON body'), undefined); }
  });

  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'same-origin');
    reply.header('x-frame-options', 'DENY');
    if (!req.url.startsWith('/api/')) return;
    reply.header('cache-control', 'no-store');
    const path = req.url.split('?')[0];
    // CSRF: state-changing API calls must come from our own fetch client (custom header is not sendable cross-site without CORS).
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !path.startsWith('/api/inbound/') && req.headers['x-requested-with'] !== 'fetch')
      throw new AppError(403, 'csrf', 'Missing request header');
    const token = req.cookies[SESSION_COOKIE];
    if (token) {
      const s = await withSystem((db) => one(db, `select * from sessions where token_hash = $1 and expires_at > now()`, [sha256(token)]));
      if (s && !s.mfa_pending) {
        const a = await withTenant(s.tenant_id, (db) => loadActor(db, s.tenant_id, s.user_id));
        if (a) req.actor = a;
      }
    }
    if (!req.actor && !PUBLIC.some((re) => re.test(path))) throw unauthorized();
  });

  app.setErrorHandler((err: any, req, reply: FastifyReply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: 'validation', message: err.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '), issues: err.issues });
    }
    if (err instanceof AppError) return reply.status(err.status).send({ error: err.code, message: err.message, details: err.details });
    if (err.statusCode === 429) return reply.status(429).send({ error: 'rate_limited', message: 'Too many attempts. Wait a minute and try again.' });
    if (err.code === '23505') return reply.status(409).send({ error: 'conflict', message: 'That already exists.' });
    if (err.code === '23503') return reply.status(400).send({ error: 'bad_reference', message: 'A referenced record does not exist.' });
    if (err.code === '23514' || err.code === '22P02' || err.code === '22007' || err.code === '22008') return reply.status(400).send({ error: 'bad_request', message: 'Invalid value.' });
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: 'bad_request', message: err.message });
    log.error({ reqId: req.id, url: req.url, err: err.message, stack: err.stack?.split('\n').slice(0, 4).join(' | ') }, 'unhandled error');
    return reply.status(500).send({ error: 'internal', message: 'Something went wrong on the server. It has been logged.', requestId: req.id });
  });

  app.addHook('onResponse', async (req, reply) => {
    if (req.url.startsWith('/api/')) log.info({ reqId: req.id, m: req.method, u: req.url.split('?')[0], s: reply.statusCode, ms: Math.round(reply.elapsedTime), user: req.actor?.id }, 'request');
  });

  app.get('/api/health', async () => {
    const db = await withSystem((db) => one(db, `select now() as now`));
    const q = await withSystem((db) => one(db, `select count(*) filter (where status = 'queued' and run_at <= now())::int ready,
      count(*) filter (where status = 'dead')::int dead, extract(epoch from now() - min(run_at) filter (where status = 'queued' and run_at <= now()))::int oldest_age_s
      from jobs where status in ('queued','dead')`));
    return { ok: true, db: !!db, queue: q };
  });

  await app.register(authRoutes);
  await app.register(taskRoutes);
  await app.register(projectRoutes);
  await app.register(myDayRoutes);
  await app.register(reportRoutes);
  await app.register(adminRoutes);
  await app.register(integrationRoutes);
  await extRoutes(app);

  const dist = resolve(process.cwd(), 'dist');
  if (existsSync(dist)) {
    await app.register(fstatic, { root: dist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.status(404).send({ error: 'not_found', message: 'Not found' });
      return reply.sendFile('index.html');
    });
  }
  return app;
}
