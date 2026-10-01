import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import QRCode from 'qrcode';
import { SESSION_COOKIE, actorOf, tx } from '../app.js';
import { config } from '../lib/config.js';
import { withSystem, withTenant, one, many } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { base32Encode, decrypt, encrypt, hashPassword, newToken, sha256, verifyPassword, verifyTotp } from '../lib/crypto.js';
import { AppError, badRequest, forbidden, unauthorized } from '../lib/errors.js';
import { randomBytes } from 'node:crypto';
import { aiStatus } from '../services/ai.js';
import { localToday } from '../services/calendar.js';
import { isStaff } from '../services/access.js';
import { loadBranding } from '../services/ext/clientbrand-brand.js';

const password = z.string().min(10, 'Use at least 10 characters').max(200);
const MFA_SESSION_ATTEMPTS = 5, MFA_ACCOUNT_ATTEMPTS = 10;

async function startSession(reply: FastifyReply, tenantId: string, userId: string, mfaPending: boolean, ip: string, ua: string) {
  const token = newToken();
  await withSystem((db) => db.query(`insert into sessions (token_hash, tenant_id, user_id, mfa_pending, expires_at, ip, user_agent)
    values ($1,$2,$3,$4, now() + ($5 || ' hours')::interval, $6, $7)`, [sha256(token), tenantId, userId, mfaPending, mfaPending ? '0.25' : String(config.sessionTtlHours), ip, ua.slice(0, 300)]));
  reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: config.production, path: '/', maxAge: mfaPending ? 900 : config.sessionTtlHours * 3600 });
}

export async function authRoutes(app: FastifyInstance) {
  app.post('/api/auth/login', { config: { rateLimit: { max: Number(process.env.LOGIN_RATE_LIMIT || 10), timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = z.object({ organization: z.string().min(2), email: z.string().email(), password: z.string().min(1) }).parse(req.body);
    const tenant = await withSystem((db) => one(db, `select id, status from tenants where slug = $1`, [b.organization.trim().toLowerCase()]));
    const fail = () => { throw unauthorized('Organization, email or password is incorrect'); };
    if (!tenant || tenant.status !== 'active') { await hashPassword('timing-equalizer'); fail(); }
    const user = await withTenant(tenant.id, (db) => one(db, `select * from users where lower(email) = lower($1)`, [b.email]));
    // Unknown or inactive accounts still pay one password hash, so response time does not reveal which emails exist.
    const ok = user && user.status === 'active' ? await verifyPassword(b.password, user.password_hash) : (await hashPassword('timing-equalizer'), false);
    await withTenant(tenant.id, (db) => audit(db, { tenantId: tenant.id, actorId: user?.id ?? null, action: 'auth.login', resourceType: 'user', resourceId: user?.id ?? null,
      outcome: ok ? (user.mfa_enabled ? 'mfa_required' : 'success') : 'failure', details: { ip: req.ip } }));
    if (!ok) fail();
    await startSession(reply, tenant.id, user.id, user.mfa_enabled, req.ip, String(req.headers['user-agent'] ?? ''));
    if (!user.mfa_enabled) await withTenant(tenant.id, (db) => db.query(`update users set last_login_at = now() where id = $1`, [user.id]));
    return { mfaRequired: user.mfa_enabled };
  });

  app.post('/api/auth/mfa', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(req.body);
    const token = req.cookies[SESSION_COOKIE];
    const s = token ? await withSystem((db) => one(db, `select * from sessions where token_hash = $1 and expires_at > now() and mfa_pending`, [sha256(token)])) : null;
    if (!s) throw unauthorized('Sign in again');
    const u = await withTenant(s.tenant_id, (db) => one(db, `select * from users where id = $1`, [s.user_id]));
    if (u?.mfa_locked_until && new Date(u.mfa_locked_until) > new Date()) throw new AppError(429, 'rate_limited', 'Too many incorrect codes. Wait 15 minutes and sign in again.');
    if (!u?.mfa_secret_enc || !verifyTotp(decrypt(u.mfa_secret_enc), b.code)) {
      // Failed codes count against this sign-in (dropped after 5) and the account (locked 15 minutes after 10 in a row).
      const f = await withSystem((db) => one(db, `update sessions set mfa_failures = mfa_failures + 1 where id = $1 returning mfa_failures`, [s.id]));
      if ((f?.mfa_failures ?? 0) >= MFA_SESSION_ATTEMPTS) await withSystem((db) => db.query(`delete from sessions where id = $1`, [s.id]));
      if (u) await withTenant(s.tenant_id, (db) => db.query(`update users set mfa_failed_attempts = mfa_failed_attempts + 1,
        mfa_locked_until = case when mfa_failed_attempts + 1 >= $2 then now() + interval '15 minutes' else mfa_locked_until end where id = $1`, [u.id, MFA_ACCOUNT_ATTEMPTS]));
      throw unauthorized((f?.mfa_failures ?? 0) >= MFA_SESSION_ATTEMPTS ? 'Too many incorrect codes. Sign in again.' : 'That code is not valid');
    }
    await withTenant(s.tenant_id, (db) => db.query(`update users set mfa_failed_attempts = 0, mfa_locked_until = null where id = $1`, [u.id]));
    await withSystem((db) => db.query(`delete from sessions where id = $1`, [s.id]));
    await startSession(reply, s.tenant_id, s.user_id, false, req.ip, String(req.headers['user-agent'] ?? ''));
    await withTenant(s.tenant_id, (db) => db.query(`update users set last_login_at = now() where id = $1`, [s.user_id]));
    return { ok: true };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await withSystem((db) => db.query(`delete from sessions where token_hash = $1`, [sha256(token)]));
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  // Commercial onboarding: create an organization (tenant) with its first system administrator.
  app.post('/api/auth/signup', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (req, reply) => {
    if (process.env.ALLOW_SIGNUP === '0') throw forbidden('Self-service signup is disabled on this server');
    const b = z.object({
      organizationName: z.string().min(2).max(120), slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/, 'Lowercase letters, numbers and dashes'),
      timezone: z.string().min(2), name: z.string().min(1).max(120), email: z.string().email(), password,
      plan: z.enum(['team', 'organization', 'enterprise']).default('team'),
    }).parse(req.body);
    const exists = await withSystem((db) => one(db, `select 1 from tenants where slug = $1`, [b.slug]));
    if (exists) throw badRequest('That organization address is taken');
    const seat = { team: 25, organization: 250, enterprise: 5000 }[b.plan];
    const tenant = await withSystem((db) => one(db, `insert into tenants (slug, name, timezone, plan, seat_limit, settings) values ($1,$2,$3,$4,$5,$6) returning *`,
      [b.slug, b.organizationName, b.timezone, b.plan, seat, { founders_visible_to_routine_admin: true, include_meetings_in_work_policy: true, coverage_threshold: 0.5,
        retention_days: 730, ai_enabled: false, voice_capture_enabled: false, evidence_required_categories: [], review_required_categories: [] }]));
    const hash = await hashPassword(b.password);
    const user = await withTenant(tenant.id, async (db) => {
      const u = await one(db, `insert into users (tenant_id, email, name, password_hash, roles, is_founder) values ($1,$2,$3,$4,$5,true) returning id`,
        [tenant.id, b.email, b.name, hash, ['member', 'system_admin', 'routine_admin', 'leadership', 'manager', 'cost_viewer']]);
      for (let wd = 1; wd <= 5; wd++) await db.query(`insert into work_schedules (tenant_id, weekday, start_minute, end_minute, break_minutes) values ($1,$2,540,1050,60)`, [tenant.id, wd]);
      await db.query(`insert into role_profiles (tenant_id, name, description, commitment_target, coverage_target, judge_by_closed_tasks, outcome_guidance) values
        ($1,'General','Default profile',0.6,0.5,true,''),
        ($1,'Founder / Leadership','Negotiations, hiring and strategy rarely map to closed-task counts',0.5,0.4,false,'Judge by declared outcomes and decisions, not task counts.'),
        ($1,'Engineering','Delivery work with review',0.6,0.5,true,'Research and incidents can be valuable with few closed tasks.'),
        ($1,'Support','Ticket and incident response',0.6,0.5,true,'')`, [tenant.id]);
      await audit(db, { tenantId: tenant.id, actorId: u.id, action: 'tenant.create', resourceType: 'tenant', resourceId: tenant.id, details: { plan: b.plan } });
      return u;
    });
    await startSession(reply, tenant.id, user.id, false, req.ip, String(req.headers['user-agent'] ?? ''));
    return { ok: true, slug: tenant.slug };
  });

  app.get('/api/tenants/:slug/public', async (req) => {
    const { slug } = req.params as { slug: string };
    const t = await withSystem((db) => one(db, `select name, logo_url from tenants where slug = $1 and status = 'active'`, [slug]));
    return t ?? { name: null };
  });

  app.get('/api/me', async (req) => tx(req, async (db, a) => {
    const t = await one(db, `select id, slug, name, legal_name, timezone, logo_url, plan, seat_limit, modules, settings, onboarded_at from tenants where id = $1`, [a.tenantId]);
    const u = await one(db, `select id, email, name, title, roles, is_founder, timezone, mfa_enabled, department_id, role_profile_id from users where id = $1`, [a.id]);
    const unread = await one(db, `select count(*)::int n from notifications where user_id = $1 and read_at is null`, [a.id]);
    // Navigation flags: project owners can open Profitability (hours view) and, for client projects, Client updates.
    const owns = await one(db, `select bool_or(true) any_project, coalesce(bool_or(customer_id is not null), false) client_project
      from projects where owner_id = $1 and status <> 'archived' and $2::boolean`, [a.id, isStaff(a)]);
    // Accent and logo come with the session so the brand applies on first paint (the full branding query follows).
    const b = await loadBranding(db, a.tenantId);
    return { user: { ...u, managedUserIds: a.managedUserIds, effectiveTimezone: a.timezone, ownsProjects: !!owns.any_project, ownsClientProjects: owns.client_project },
      tenant: t, unreadNotifications: unread.n, today: localToday(a.timezone), ai: aiStatus(a),
      branding: { accent: b.accent, logoUrl: b.logoFileId ? `/api/branding/logo?v=${b.logoFileId}` : null } };
  }));

  app.patch('/api/me', async (req) => tx(req, async (db, a) => {
    const b = z.object({ name: z.string().min(1).max(120).optional(), timezone: z.string().nullable().optional() }).parse(req.body);
    await db.query(`update users set name = coalesce($2, name), timezone = case when $3::boolean then $4 else timezone end where id = $1`,
      [a.id, b.name ?? null, 'timezone' in b, b.timezone ?? null]);
    return { ok: true };
  }));

  app.post('/api/me/password', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req) => tx(req, async (db, a) => {
    const b = z.object({ current: z.string(), next: password }).parse(req.body);
    const u = await one(db, `select password_hash from users where id = $1`, [a.id]);
    if (!(await verifyPassword(b.current, u.password_hash))) throw badRequest('Current password is incorrect');
    await db.query(`update users set password_hash = $2 where id = $1`, [a.id, await hashPassword(b.next)]);
    await withSystem((s) => s.query(`delete from sessions where user_id = $1 and token_hash <> $2`, [a.id, sha256(req.cookies[SESSION_COOKIE] ?? '')]));
    await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'auth.password_change', resourceType: 'user', resourceId: a.id });
    return { ok: true };
  }));

  app.post('/api/me/mfa/setup', async (req) => tx(req, async (db, a) => {
    const secret = base32Encode(randomBytes(20));
    await db.query(`update users set mfa_secret_enc = $2 where id = $1 and not mfa_enabled`, [a.id, encrypt(secret)]);
    const t = await one(db, `select name from tenants where id = $1`, [a.tenantId]);
    const uri = `otpauth://totp/${encodeURIComponent(`${t.name}:${a.email}`)}?secret=${secret}&issuer=${encodeURIComponent('Task Tracking')}`;
    return { secret, uri, qr: await QRCode.toDataURL(uri) };
  }));
  app.post('/api/me/mfa/enable', async (req) => tx(req, async (db, a) => {
    const b = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(req.body);
    const u = await one(db, `select mfa_secret_enc from users where id = $1`, [a.id]);
    if (!u.mfa_secret_enc || !verifyTotp(decrypt(u.mfa_secret_enc), b.code)) throw badRequest('That code is not valid — check your authenticator app time');
    await db.query(`update users set mfa_enabled = true where id = $1`, [a.id]);
    await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'auth.mfa_enable', resourceType: 'user', resourceId: a.id });
    return { ok: true };
  }));
  app.post('/api/me/mfa/disable', async (req) => tx(req, async (db, a) => {
    const b = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(req.body);
    const u = await one(db, `select mfa_secret_enc from users where id = $1`, [a.id]);
    if (!u.mfa_secret_enc || !verifyTotp(decrypt(u.mfa_secret_enc), b.code)) throw badRequest('That code is not valid');
    await db.query(`update users set mfa_enabled = false, mfa_secret_enc = null where id = $1`, [a.id]);
    await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'auth.mfa_disable', resourceType: 'user', resourceId: a.id });
    return { ok: true };
  }));

  // Invitation acceptance: /join/:tenant/:token
  app.get('/api/join/:slug/:token', async (req) => {
    const { slug, token } = req.params as any;
    const t = await withSystem((db) => one(db, `select id, name from tenants where slug = $1`, [slug]));
    if (!t) throw badRequest('Invitation not found');
    const inv = await withTenant(t.id, (db) => one(db, `select email, name, expires_at, accepted_at, revoked_at from invitations where token_hash = $1`, [sha256(token)]));
    if (!inv || inv.accepted_at || inv.revoked_at || new Date(inv.expires_at) < new Date()) throw badRequest('This invitation is no longer valid');
    return { organization: t.name, email: inv.email, name: inv.name };
  });
  app.post('/api/join/:slug/:token', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { slug, token } = req.params as any;
    const b = z.object({ password, name: z.string().min(1).max(120).optional() }).parse(req.body);
    const t = await withSystem((db) => one(db, `select id, seat_limit from tenants where slug = $1`, [slug]));
    if (!t) throw badRequest('Invitation not found');
    const userId = await withTenant(t.id, async (db) => {
      const inv = await one(db, `select * from invitations where token_hash = $1 for update`, [sha256(token)]);
      if (!inv || inv.accepted_at || inv.revoked_at || new Date(inv.expires_at) < new Date()) throw badRequest('This invitation is no longer valid');
      // An invitation never takes over an existing account: active accounts sign in, and a deactivated account
      // can only come back through an invitation issued after it was deactivated.
      const existing = await one(db, `select id, status, deactivated_at from users where lower(email) = lower($1)`, [inv.email]);
      if (existing?.status === 'active') throw badRequest('This invitation is no longer valid — that person already has an account. Sign in instead.');
      if (existing?.status === 'deactivated' && (!existing.deactivated_at || new Date(inv.created_at) <= new Date(existing.deactivated_at)))
        throw badRequest('This invitation is no longer valid');
      const seats = await one(db, `select count(*)::int n from users where status = 'active' and not ('customer' = any(roles))`);
      if (!inv.roles.includes('customer') && seats.n >= t.seat_limit) throw forbidden('The organization has used all of its seats. Ask an administrator to free or add seats.');
      const u = await one(db, `insert into users (tenant_id, email, name, password_hash, roles, department_id) values ($1,$2,$3,$4,$5,$6)
        on conflict (tenant_id, lower(email)) do update set password_hash = excluded.password_hash, status = 'active', roles = excluded.roles returning id`,
        [t.id, inv.email, b.name ?? inv.name, await hashPassword(b.password), inv.roles, inv.department_id]);
      await db.query(`update invitations set accepted_at = now() where id = $1`, [inv.id]);
      await db.query(`update invitations set revoked_at = now() where lower(email) = lower($1) and id <> $2 and accepted_at is null and revoked_at is null`, [inv.email, inv.id]);
      await audit(db, { tenantId: t.id, actorId: u.id, action: 'invitation.accept', resourceType: 'invitation', resourceId: inv.id });
      return u.id;
    });
    await withSystem((db) => db.query(`delete from sessions where user_id = $1`, [userId]));
    await startSession(reply, t.id, userId, false, req.ip, String(req.headers['user-agent'] ?? ''));
    return { ok: true };
  });

  app.get('/api/notifications', async (req) => tx(req, (db, a) =>
    many(db, `select * from notifications where user_id = $1 order by created_at desc limit 50`, [a.id])));
  app.post('/api/notifications/read', async (req) => tx(req, async (db, a) => {
    const b = z.object({ ids: z.array(z.string().uuid()).optional() }).parse(req.body ?? {});
    await db.query(`update notifications set read_at = now() where user_id = $1 and read_at is null and ($2::uuid[] is null or id = any($2::uuid[]))`, [a.id, b.ids ?? null]);
    return { ok: true };
  }));
  void actorOf;
}
