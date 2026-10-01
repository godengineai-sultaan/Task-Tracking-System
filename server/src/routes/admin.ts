import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tx } from '../app.js';
import { config } from '../lib/config.js';
import { many, one, withSystem } from '../lib/db.js';
import { audit, verifyAuditChain } from '../lib/audit.js';
import { newToken, sha256 } from '../lib/crypto.js';
import { enqueue } from '../lib/jobs.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { ALL_ROLES, type Actor, has, require as requireRole } from '../services/access.js';

const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const sysAdmin = (a: Actor) => requireRole(a, 'system_admin');

export async function adminRoutes(app: FastifyInstance) {
  // ----- Organization configuration -----
  app.get('/api/admin/tenant', async (req) => tx(req, async (db, a) => {
    sysAdmin(a);
    const t = await one(db, `select * from tenants where id = $1`, [a.tenantId]);
    const seats = await one(db, `select count(*) filter (where status = 'active' and not ('customer' = any(roles)))::int active,
      count(*) filter (where status = 'active' and 'customer' = any(roles))::int customers from users`);
    return { ...t, seats };
  }));
  app.patch('/api/admin/tenant', async (req) => tx(req, async (db, a) => {
    sysAdmin(a);
    const b = z.object({
      name: z.string().min(2).max(120).optional(), legalName: z.string().max(200).nullable().optional(), timezone: z.string().optional(),
      logoUrl: z.string().url().nullable().optional(), contactEmail: z.string().email().nullable().optional(), address: z.string().max(500).nullable().optional(),
      plan: z.enum(['team', 'organization', 'enterprise']).optional(), seatLimit: z.number().int().min(1).max(100000).optional(),
      modules: z.array(z.enum(['tasks', 'analytics', 'admin_routine', 'integrations', 'customer_portal', 'ai_drafting'])).optional(),
      settings: z.object({
        founders_visible_to_routine_admin: z.boolean().optional(), include_meetings_in_work_policy: z.boolean().optional(),
        coverage_threshold: z.number().min(0).max(1).optional(), retention_days: z.number().int().min(30).max(3650).optional(),
        voice_capture_enabled: z.boolean().optional(), ai_enabled: z.boolean().optional(),
        evidence_required_categories: z.array(z.string()).optional(), review_required_categories: z.array(z.string()).optional(),
      }).optional(), onboarded: z.boolean().optional(),
    }).parse(req.body);
    const t = await one(db, `update tenants set name = coalesce($2,name), legal_name = case when $3 then $4 else legal_name end, timezone = coalesce($5,timezone),
        logo_url = case when $6 then $7 else logo_url end, contact_email = case when $8 then $9 else contact_email end, address = case when $10 then $11 else address end,
        plan = coalesce($12,plan), seat_limit = coalesce($13,seat_limit), modules = coalesce($14,modules), settings = settings || coalesce($15,'{}'::jsonb),
        onboarded_at = case when $16 then coalesce(onboarded_at, now()) else onboarded_at end where id = $1 returning *`,
      [a.tenantId, b.name ?? null, 'legalName' in b, b.legalName ?? null, b.timezone ?? null, 'logoUrl' in b, b.logoUrl ?? null, 'contactEmail' in b, b.contactEmail ?? null,
       'address' in b, b.address ?? null, b.plan ?? null, b.seatLimit ?? null, b.modules ?? null, b.settings ?? null, b.onboarded === true]);
    await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'tenant.update', resourceType: 'tenant', resourceId: a.tenantId, details: { fields: Object.keys(b), settings: b.settings } });
    return t;
  }));

  // ----- People -----
  app.get('/api/admin/users', async (req) => tx(req, async (db, a) => {
    sysAdmin(a);
    return many(db, `select u.id, u.email, u.name, u.title, u.roles, u.status, u.is_founder, u.department_id, u.role_profile_id, u.customer_id, u.timezone, u.mfa_enabled,
      u.last_login_at, d.name department, rp.name role_profile, c.name customer from users u left join departments d on d.id = u.department_id
      left join role_profiles rp on rp.id = u.role_profile_id left join customers c on c.id = u.customer_id order by u.status, u.name`);
  }));
  app.patch('/api/admin/users/:id', async (req) => tx(req, async (db, a) => {
    sysAdmin(a);
    const id = (req.params as any).id;
    const b = z.object({ roles: z.array(z.enum(ALL_ROLES as [string, ...string[]])).min(1).optional(), title: z.string().max(120).optional(),
      departmentId: uuid.nullable().optional(), roleProfileId: uuid.nullable().optional(), customerId: uuid.nullable().optional(), isFounder: z.boolean().optional(),
      status: z.enum(['active', 'deactivated']).optional(), timezone: z.string().nullable().optional() }).parse(req.body);
    if (id === a.id && (b.status === 'deactivated' || (b.roles && !b.roles.includes('system_admin')))) throw badRequest('You cannot remove your own administrator access');
    if (b.roles?.includes('customer') && b.roles.length > 1) throw badRequest('Customer accounts cannot hold staff roles');
    const before = await one(db, `select roles, status from users where id = $1`, [id]);
    if (!before) throw notFound();
    if (b.status === 'active' && before.status !== 'active') {
      const t = await one(db, `select seat_limit from tenants where id = $1`, [a.tenantId]);
      const s = await one(db, `select count(*)::int n from users where status = 'active' and not ('customer' = any(roles))`);
      if (s.n >= t.seat_limit) throw forbidden('No seats available on the current plan');
    }
    const u = await one(db, `update users set roles = coalesce($2,roles), title = coalesce($3,title), department_id = case when $5 then $4 else department_id end,
        role_profile_id = case when $7 then $6 else role_profile_id end, customer_id = case when $9 then $8 else customer_id end, is_founder = coalesce($10,is_founder),
        status = coalesce($11,status), timezone = case when $13 then $12 else timezone end where id = $1 returning id, roles, status`,
      [id, b.roles ?? null, b.title ?? null, b.departmentId ?? null, 'departmentId' in b, b.roleProfileId ?? null, 'roleProfileId' in b, b.customerId ?? null, 'customerId' in b,
       b.isFounder ?? null, b.status ?? null, b.timezone ?? null, 'timezone' in b]);
    if (b.status === 'deactivated') await withSystem((s) => s.query(`delete from sessions where user_id = $1`, [id]));
    await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'user.update', resourceType: 'user', resourceId: id, authority: 'system_admin',
      details: { before: { roles: before.roles, status: before.status }, after: { roles: u.roles, status: u.status } } });
    return u;
  }));
  app.get('/api/admin/invitations', async (req) => tx(req, async (db, a) => {
    sysAdmin(a);
    return many(db, `select i.id, i.email, i.name, i.roles, i.expires_at, i.accepted_at, i.revoked_at, i.created_at, u.name created_by_name from invitations i
      left join users u on u.id = i.created_by order by i.created_at desc limit 100`);
  }));
  app.post('/api/admin/invitations', async (req) => tx(req, async (db, a) => {
    sysAdmin(a);
    const b = z.object({ email: z.string().email(), name: z.string().min(1).max(120), roles: z.array(z.enum(ALL_ROLES as [string, ...string[]])).min(1).default(['member']),
      departmentId: uuid.nullable().optional() }).parse(req.body);
    const exists = await one(db, `select status from users where lower(email) = lower($1)`, [b.email]);
    if (exists?.status === 'active') throw badRequest('That person already has an active account');
    const token = newToken(24);
    const t = await one(db, `select slug from tenants where id = $1`, [a.tenantId]);
    const inv = await one(db, `insert into invitations (tenant_id, email, name, roles, department_id, token_hash, expires_at, created_by)
      values ($1,$2,$3,$4,$5,$6, now() + interval '7 days', $7) returning id, email, expires_at`, [a.tenantId, b.email, b.name, b.roles, b.departmentId ?? null, sha256(token), a.id]);
    await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'invitation.create', resourceType: 'invitation', resourceId: inv.id, details: { roles: b.roles } });
    // Email delivery is an external dependency; the admin shares this one-time link directly.
    return { ...inv, link: `${config.publicUrl}/join/${t.slug}/${token}` };
  }));
  app.post('/api/admin/invitations/:id/revoke', async (req) => tx(req, async (db, a) => {
    sysAdmin(a);
    await db.query(`update invitations set revoked_at = now() where id = $1 and accepted_at is null`, [(req.params as any).id]);
    await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'invitation.revoke', resourceType: 'invitation', resourceId: (req.params as any).id });
    return { ok: true };
  }));

  // ----- Simple reference data -----
  const simple = (table: 'departments' | 'customers', label: string) => {
    app.get(`/api/admin/${table}`, async (req) => tx(req, (db) => many(db, `select * from ${table} order by name`)));
    app.post(`/api/admin/${table}`, async (req) => tx(req, async (db, a) => {
      sysAdmin(a);
      const { name } = z.object({ name: z.string().min(1).max(120) }).parse(req.body);
      const r = await one(db, `insert into ${table} (tenant_id, name) values ($1,$2) returning *`, [a.tenantId, name]);
      await audit(db, { tenantId: a.tenantId, actorId: a.id, action: `${label}.create`, resourceType: label, resourceId: r.id });
      return r;
    }));
  };
  simple('departments', 'department');
  simple('customers', 'customer');

  app.get('/api/admin/role-profiles', async (req) => tx(req, (db) => many(db, `select * from role_profiles order by name`)));
  const rpSchema = z.object({ name: z.string().min(1).max(80), description: z.string().max(500).default(''), commitmentTarget: z.number().min(0).max(1),
    coverageTarget: z.number().min(0).max(1), judgeByClosedTasks: z.boolean(), outcomeGuidance: z.string().max(1000).default('') });
  app.post('/api/admin/role-profiles', async (req) => tx(req, async (db, a) => {
    sysAdmin(a);
    const b = rpSchema.parse(req.body);
    return one(db, `insert into role_profiles (tenant_id, name, description, commitment_target, coverage_target, judge_by_closed_tasks, outcome_guidance)
      values ($1,$2,$3,$4,$5,$6,$7) returning *`, [a.tenantId, b.name, b.description, b.commitmentTarget, b.coverageTarget, b.judgeByClosedTasks, b.outcomeGuidance]);
  }));
  app.put('/api/admin/role-profiles/:id', async (req) => tx(req, async (db, a) => {
    sysAdmin(a);
    const b = rpSchema.parse(req.body);
    const r = await one(db, `update role_profiles set name=$2, description=$3, commitment_target=$4, coverage_target=$5, judge_by_closed_tasks=$6, outcome_guidance=$7 where id=$1 returning *`,
      [(req.params as any).id, b.name, b.description, b.commitmentTarget, b.coverageTarget, b.judgeByClosedTasks, b.outcomeGuidance]);
    await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'role_profile.update', resourceType: 'role_profile', resourceId: r.id, details: b });
    return r;
  }));

  // ----- Teams -----
  app.get('/api/admin/teams', async (req) => tx(req, (db) => many(db, `select t.*, u.name manager_name, d.name department_name,
    coalesce((select json_agg(json_build_object('id', mu.id, 'name', mu.name) order by mu.name) from team_members m join users mu on mu.id = m.user_id where m.team_id = t.id), '[]') members
    from teams t left join users u on u.id = t.manager_id left join departments d on d.id = t.department_id order by t.name`)));
  app.post('/api/admin/teams', async (req) => tx(req, async (db, a) => {
    sysAdmin(a);
    const b = z.object({ name: z.string().min(1).max(120), managerId: uuid.nullable().optional(), departmentId: uuid.nullable().optional() }).parse(req.body);
    const t = await one(db, `insert into teams (tenant_id, name, manager_id, department_id) values ($1,$2,$3,$4) returning *`, [a.tenantId, b.name, b.managerId ?? null, b.departmentId ?? null]);
    if (b.managerId) await db.query(`update users set roles = array_append(roles, 'manager') where id = $1 and not ('manager' = any(roles))`, [b.managerId]);
    await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'team.create', resourceType: 'team', resourceId: t.id });
    return t;
  }));
  app.patch('/api/admin/teams/:id', async (req) => tx(req, async (db, a) => {
    sysAdmin(a);
    const b = z.object({ managerId: uuid.nullable().optional(), name: z.string().min(1).max(120).optional() }).parse(req.body);
    const t = await one(db, `update teams set name = coalesce($2,name), manager_id = case when $4 then $3 else manager_id end where id = $1 returning *`,
      [(req.params as any).id, b.name ?? null, b.managerId ?? null, 'managerId' in b]);
    if (b.managerId) await db.query(`update users set roles = array_append(roles, 'manager') where id = $1 and not ('manager' = any(roles))`, [b.managerId]);
    await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'team.update', resourceType: 'team', resourceId: t.id, details: b });
    return t;
  }));
  app.post('/api/admin/teams/:id/members', async (req) => tx(req, async (db, a) => {
    sysAdmin(a);
    const { userId } = z.object({ userId: uuid }).parse(req.body);
    await db.query(`insert into team_members (tenant_id, team_id, user_id) values ($1,$2,$3) on conflict do nothing`, [a.tenantId, (req.params as any).id, userId]);
    await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'team.member_add', resourceType: 'team', resourceId: (req.params as any).id, details: { userId } });
    return { ok: true };
  }));
  app.delete('/api/admin/teams/:id/members/:uid', async (req) => tx(req, async (db, a) => {
    sysAdmin(a);
    await db.query(`delete from team_members where team_id = $1 and user_id = $2`, [(req.params as any).id, (req.params as any).uid]);
    await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'team.member_remove', resourceType: 'team', resourceId: (req.params as any).id, details: { userId: (req.params as any).uid } });
    return { ok: true };
  }));

  // ----- Working calendar -----
  app.get('/api/calendar/schedule', async (req) => tx(req, async (db, a) => {
    const { userId } = z.object({ userId: uuid.optional() }).parse(req.query);
    const uid = userId ?? a.id;
    const own = await many(db, `select * from work_schedules where user_id = $1 order by weekday`, [uid]);
    const def = await many(db, `select * from work_schedules where user_id is null order by weekday`);
    return { userId: uid, usesDefault: own.length === 0, schedule: own.length ? own : def, tenantDefault: def };
  }));
  app.put('/api/calendar/schedule', async (req) => tx(req, async (db, a) => {
    const b = z.object({ userId: uuid.nullable(), days: z.array(z.object({ weekday: z.number().int().min(1).max(7), startMinute: z.number().int().min(0).max(1439),
      endMinute: z.number().int().min(1).max(1440), breakMinutes: z.number().int().min(0).max(480) })).max(7), useDefault: z.boolean().optional() }).parse(req.body);
    if (b.userId === null || b.userId !== a.id) sysAdmin(a);
    for (const d of b.days) if (d.endMinute <= d.startMinute || d.breakMinutes >= d.endMinute - d.startMinute) throw badRequest('Each day needs an end after its start and a break shorter than the day');
    await db.query(`delete from work_schedules where ${b.userId ? 'user_id = $1' : 'user_id is null and $1::uuid is null'}`, [b.userId]);
    if (!b.useDefault) for (const d of b.days)
      await db.query(`insert into work_schedules (tenant_id, user_id, weekday, start_minute, end_minute, break_minutes) values ($1,$2,$3,$4,$5,$6)`,
        [a.tenantId, b.userId, d.weekday, d.startMinute, d.endMinute, d.breakMinutes]);
    await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'schedule.update', resourceType: 'work_schedule', resourceId: b.userId ?? 'tenant_default', details: { days: b.days.length } });
    return { ok: true };
  }));
  app.get('/api/calendar/holidays', async (req) => tx(req, (db) => many(db, `select * from holidays order by date`)));
  app.post('/api/calendar/holidays', async (req) => tx(req, async (db, a) => {
    sysAdmin(a);
    const b = z.object({ date, name: z.string().min(1).max(120) }).parse(req.body);
    const h = await one(db, `insert into holidays (tenant_id, date, name) values ($1,$2,$3) returning *`, [a.tenantId, b.date, b.name]);
    await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'holiday.create', resourceType: 'holiday', resourceId: h.id });
    return h;
  }));
  app.delete('/api/calendar/holidays/:id', async (req) => tx(req, async (db, a) => {
    sysAdmin(a);
    await db.query(`delete from holidays where id = $1`, [(req.params as any).id]);
    await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'holiday.delete', resourceType: 'holiday', resourceId: (req.params as any).id });
    return { ok: true };
  }));
  app.get('/api/calendar/leave', async (req) => tx(req, async (db, a) => {
    const { userId } = z.object({ userId: uuid.optional() }).parse(req.query);
    if (userId && userId !== a.id && !has(a, 'system_admin') && !a.managedUserIds.includes(userId) && !has(a, 'routine_admin')) throw forbidden();
    const scope = has(a, 'system_admin') || has(a, 'routine_admin') ? null : [a.id, ...a.managedUserIds];
    return many(db, `select l.*, u.name user_name from leave_entries l join users u on u.id = l.user_id
      where ($1::uuid is null or l.user_id = $1) and ($2::uuid[] is null or l.user_id = any($2::uuid[])) order by l.start_date desc limit 200`, [userId ?? null, scope]);
  }));
  app.post('/api/calendar/leave', async (req) => tx(req, async (db, a) => {
    const b = z.object({ userId: uuid.optional(), startDate: date, endDate: date, portion: z.enum(['full', 'half_am', 'half_pm']).default('full'),
      kind: z.enum(['leave', 'sick', 'training', 'other']).default('leave'), note: z.string().max(500).default('') }).parse(req.body);
    const uid = b.userId ?? a.id;
    if (uid !== a.id && !has(a, 'system_admin') && !a.managedUserIds.includes(uid)) throw forbidden('You can record your own leave, or your team\'s as their manager');
    if (b.endDate < b.startDate) throw badRequest('End date must be on or after start date');
    if (b.portion !== 'full' && b.startDate !== b.endDate) throw badRequest('Half-day leave covers a single date');
    const l = await one(db, `insert into leave_entries (tenant_id, user_id, start_date, end_date, portion, kind, note, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
      [a.tenantId, uid, b.startDate, b.endDate, b.portion, b.kind, b.note, a.id]);
    await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'leave.create', resourceType: 'leave', resourceId: l.id, details: { userId: uid } });
    return l;
  }));
  app.delete('/api/calendar/leave/:id', async (req) => tx(req, async (db, a) => {
    const l = await one(db, `select * from leave_entries where id = $1`, [(req.params as any).id]);
    if (!l) throw notFound();
    if (l.user_id !== a.id && !has(a, 'system_admin') && !a.managedUserIds.includes(l.user_id)) throw forbidden();
    await db.query(`delete from leave_entries where id = $1`, [l.id]);
    await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'leave.delete', resourceType: 'leave', resourceId: l.id });
    return { ok: true };
  }));

  // ----- Capacity allocation and cost rates -----
  app.post('/api/admin/allocations', async (req) => tx(req, async (db, a) => {
    if (!has(a, 'system_admin') && !has(a, 'leadership')) throw forbidden();
    const b = z.object({ userId: uuid, projectId: uuid, percent: z.number().int().min(1).max(100), startDate: date, endDate: date.nullable().optional(), assumption: z.string().max(500).default('') }).parse(req.body);
    const total = await one(db, `select coalesce(sum(percent),0)::int p from capacity_allocations where user_id = $1 and start_date <= coalesce($3::date, '9999-12-31') and (end_date is null or end_date >= $2)`, [b.userId, b.startDate, b.endDate ?? null]);
    const r = await one(db, `insert into capacity_allocations (tenant_id, user_id, project_id, percent, start_date, end_date, assumption) values ($1,$2,$3,$4,$5,$6,$7) returning *`,
      [a.tenantId, b.userId, b.projectId, b.percent, b.startDate, b.endDate ?? null, b.assumption]);
    await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'allocation.create', resourceType: 'capacity_allocation', resourceId: r.id });
    return { ...r, warning: total.p + b.percent > 100 ? `Allocations now total ${total.p + b.percent}% for this person in that period` : null };
  }));
  app.delete('/api/admin/allocations/:id', async (req) => tx(req, async (db, a) => {
    if (!has(a, 'system_admin') && !has(a, 'leadership')) throw forbidden();
    await db.query(`delete from capacity_allocations where id = $1`, [(req.params as any).id]);
    return { ok: true };
  }));
  app.get('/api/admin/cost-rates', async (req) => tx(req, async (db, a) => {
    requireRole(a, 'cost_viewer');
    return many(db, `select c.*, u.name user_name from cost_rates c join users u on u.id = c.user_id order by u.name, c.effective_from desc`);
  }));
  app.post('/api/admin/cost-rates', async (req) => tx(req, async (db, a) => {
    requireRole(a, 'cost_viewer'); sysAdmin(a);
    const b = z.object({ userId: uuid, hourlyRate: z.number().min(0).max(1e6), currency: z.string().length(3).default('INR'), effectiveFrom: date }).parse(req.body);
    const r = await one(db, `insert into cost_rates (tenant_id, user_id, hourly_rate, currency, effective_from) values ($1,$2,$3,$4,$5) returning *`,
      [a.tenantId, b.userId, b.hourlyRate, b.currency.toUpperCase(), b.effectiveFrom]);
    await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'cost_rate.create', resourceType: 'cost_rate', resourceId: r.id }); // amount intentionally not logged
    return r;
  }));

  // ----- Audit, jobs, operations -----
  app.get('/api/admin/audit', async (req) => tx(req, async (db, a) => {
    sysAdmin(a);
    const q = z.object({ action: z.string().optional(), actorId: uuid.optional(), before: z.coerce.number().int().optional() }).parse(req.query);
    return many(db, `select e.id, e.action, e.resource_type, e.resource_id, e.resource_version, e.reason, e.authority, e.outcome, e.details, e.at, e.correlation_id, u.name actor_name
      from audit_events e left join users u on u.id = e.actor_id where ($1::text is null or e.action like $1 || '%') and ($2::uuid is null or e.actor_id = $2)
      and ($3::bigint is null or e.id < $3) order by e.id desc limit 100`, [q.action ?? null, q.actorId ?? null, q.before ?? null]);
  }));
  app.get('/api/admin/audit/verify', async (req) => tx(req, async (db, a) => { sysAdmin(a); return verifyAuditChain(db, a.tenantId); }));

  app.get('/api/admin/jobs', async (req) => tx(req, async (db, a) => {
    sysAdmin(a);
    return withSystem((s) => many(s, `select id, kind, status, attempts, max_attempts, run_at, last_error, created_at, finished_at from jobs
      where tenant_id = $1 order by created_at desc limit 100`, [a.tenantId]));
  }));
  app.post('/api/admin/jobs/:id/retry', async (req) => tx(req, async (db, a) => {
    sysAdmin(a);
    const r = await withSystem((s) => one(s, `update jobs set status = 'queued', run_at = now(), attempts = 0, last_error = null where id = $1 and tenant_id = $2 and status = 'dead' returning id`,
      [(req.params as any).id, a.tenantId]));
    if (!r) throw badRequest('Only dead-lettered jobs can be retried');
    await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'job.retry', resourceType: 'job', resourceId: r.id });
    return { ok: true };
  }));

  /** Product/operational metrics — kept separate from staff analytics; aggregate only, no individual rows. */
  app.get('/api/admin/operations', async (req) => tx(req, async (db, a) => {
    sysAdmin(a);
    const overhead = await many(db, `with daily as (select user_id, date, sum(duration_ms) ms from ux_timings where date >= current_date - 30 and flow in ('plan','recap','quick_capture','status_update') group by 1,2)
      select count(*)::int user_days, percentile_cont(0.5) within group (order by ms)::int median_ms, percentile_cont(0.9) within group (order by ms)::int p90_ms from daily`);
    const byFlow = await many(db, `select flow, count(*)::int n, percentile_cont(0.5) within group (order by duration_ms)::int median_ms from ux_timings where date >= current_date - 30 group by flow`);
    const activation = await one(db, `select count(*) filter (where status = 'active' and not ('customer' = any(roles)))::int active_staff,
      count(*) filter (where last_login_at > now() - interval '7 days')::int weekly_active from users`);
    const recap = await one(db, `select count(*) filter (where status <> 'draft')::int confirmed, count(distinct user_id)::int users,
      count(*) filter (where version > 1)::int corrected from daily_reviews where date >= current_date - 30`);
    const blockers = await one(db, `select count(*)::int open, coalesce(percentile_cont(0.5) within group (order by extract(epoch from now() - raised_at) / 3600), 0)::int median_age_h from blockers where resolved_at is null`);
    const deadlines = await one(db, `select count(*) filter (where status = 'done' and done_at::date <= due_date)::int met, count(*) filter (where status = 'done' and done_at::date > due_date)::int late,
      count(*) filter (where status not in ('done','cancelled') and due_date < current_date)::int overdue from tasks where due_date >= current_date - 30`);
    const evidence = await one(db, `select count(*) filter (where requires_evidence)::int required, count(*) filter (where requires_evidence and exists (select 1 from evidence_links e where e.task_id = t.id))::int with_evidence
      from tasks t where status = 'done' and accepted_at >= now() - interval '30 days'`);
    const followUps = await one(db, `select count(*)::int n from manager_reviews where created_at >= now() - interval '30 days'`);
    const ai = await one(db, `select count(*)::int runs, count(*) filter (where status = 'failed')::int failed, coalesce(sum(input_tokens),0)::int input_tokens, coalesce(sum(output_tokens),0)::int output_tokens,
      count(*) filter (where decision = 'accepted')::int accepted, count(*) filter (where decision = 'edited')::int edited, count(*) filter (where decision = 'rejected')::int rejected
      from ai_runs where created_at >= now() - interval '30 days'`);
    const jobs = await withSystem((s) => one(s, `select count(*) filter (where status = 'queued')::int queued, count(*) filter (where status = 'dead')::int dead,
      count(*) filter (where status = 'succeeded' and finished_at > now() - interval '1 day')::int succeeded_24h,
      coalesce(extract(epoch from now() - min(run_at) filter (where status = 'queued' and run_at <= now())), 0)::int oldest_ready_age_s from jobs where tenant_id = $1`, [a.tenantId]));
    const integrations = await many(db, `select c.id, c.name, c.kind, c.status, c.last_sync_at, c.last_error,
      (select count(*) from integration_events e where e.connection_id = c.id)::int events,
      (select count(*) from integration_events e where e.connection_id = c.id and e.status = 'rejected')::int rejected from integration_connections c`);
    return { window: 'last 30 days', loggingOverhead: { ...overhead[0], target_ms: 120000, byFlow,
        note: 'Measured from real in-app interactions (plan, recap, quick capture, status updates). The <2 minute target is a goal to validate with pilot users.' },
      activation, recap, blockers, deadlines, evidence, managerFollowUps: followUps.n, ai, jobs, integrations };
  }));

  app.post('/api/admin/retention/run', async (req) => tx(req, async (db, a) => {
    sysAdmin(a);
    await enqueue(db, { tenantId: a.tenantId, kind: 'retention.purge', payload: {} });
    await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'retention.requested', resourceType: 'tenant', resourceId: a.tenantId });
    return { ok: true, note: 'Retention runs in the background according to the configured retention_days.' };
  }));
}
