import { z } from 'zod';
import type { Db } from '../../lib/db.js';
import { many, one } from '../../lib/db.js';
import { audit } from '../../lib/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { type Actor, has, isStaff, requireStaff, taskVisibility } from '../access.js';
import { notify } from '../notify.js';
import { localToday } from '../calendar.js';
import { parseFocus, tenantHasProducts } from './portfolio-scope.js';

/**
 * Portfolio core: companies, products visible to the actor, product administration and membership, and the per-user product focus.
 * Row-level security already limits every query here to the actor's product scope.
 */
export const canManagePortfolio = (a: Actor) => has(a, 'system_admin');
export const isProductLead = (a: Actor, productId: string) => a.productRoles[productId] === 'lead';
const canSeeMembers = (a: Actor, productId: string) =>
  canManagePortfolio(a) || isProductLead(a, productId) || has(a, 'leadership') || has(a, 'routine_admin');

async function taskCounts(db: Db, a: Actor, productIds: string[] | null) {
  const [vis, params] = taskVisibility(a, 3);
  const rows = await many(db, `select t.product_id,
      count(*) filter (where t.status not in ('done','cancelled'))::int open_tasks,
      count(*) filter (where t.status not in ('done','cancelled') and t.due_date < $1::date)::int overdue_tasks,
      count(*) filter (where t.status = 'blocked')::int blocked_tasks
    from tasks t left join projects p on p.id = t.project_id
    where t.product_id is not null and ($2::uuid[] is null or t.product_id = any($2::uuid[])) and ${vis}
    group by t.product_id`, [localToday(a.timezone), productIds, ...params]);
  return new Map(rows.map((r) => [r.product_id, r]));
}

const PRODUCT_COLUMNS = `p.id, p.key, p.number, p.name, p.tagline, p.layer, p.revenue_engine, p.description, p.company_id, c.code company_code, c.name company_name,
  p.company_confirmed, p.website_url, p.visibility, p.status, p.version, p.catalog_version,
  (select count(*) from product_members m where m.product_id = p.id)::int member_count,
  coalesce((select json_agg(json_build_object('id', u.id, 'name', u.name) order by u.name) from product_members m join users u on u.id = m.user_id
    where m.product_id = p.id and m.role = 'lead'), '[]'::json) leads`;

/** GET /api/portfolio: companies, the products this actor can see (with their role, leads and task counts), and whether they administer it. */
export async function portfolioOverview(db: Db, a: Actor) {
  requireStaff(a);
  const [companies, products] = [
    await many(db, `select id, code, name, legal_name, cin, gstin, registered_address, website, version from companies order by code`),
    await many(db, `select ${PRODUCT_COLUMNS} from products p left join companies c on c.id = p.company_id order by p.number nulls last, p.name`),
  ];
  const counts = await taskCounts(db, a, null);
  return {
    tenantHasProducts: products.length > 0 || (await tenantHasProducts(db)),
    scope: a.productScope === 'all' ? 'all' : 'members',
    canManage: canManagePortfolio(a),
    companies,
    products: products.map((p) => {
      const c = counts.get(p.id);
      return { ...p, my_role: a.productRoles[p.id] ?? null, open_tasks: c?.open_tasks ?? 0, overdue_tasks: c?.overdue_tasks ?? 0, blocked_tasks: c?.blocked_tasks ?? 0 };
    }),
  };
}

export async function loadProduct(db: Db, id: string) {
  if (!z.string().uuid().safeParse(id).success) throw notFound('Product not found');
  const p = await one(db, `select * from products where id = $1`, [id]);
  if (!p) throw notFound('Product not found');
  return p;
}

/** GET /api/products/:id (row-level security returns nothing for products outside the actor's scope). */
export async function productDetail(db: Db, a: Actor, id: string) {
  requireStaff(a);
  await loadProduct(db, id);
  const p = await one(db, `select ${PRODUCT_COLUMNS}, p.catalog from products p left join companies c on c.id = p.company_id where p.id = $1`, [id]);
  const kpis = await many(db, `select key, name, unit, direction, cadence, source, definition, position from product_kpis where product_id = $1 order by position, key`, [id]);
  const projects = await many(db, `select id, key, name, status from projects where product_id = $1 and status <> 'archived' order by name`, [id]);
  const c = (await taskCounts(db, a, [id])).get(id);
  return {
    product: { ...p, my_role: a.productRoles[id] ?? null, open_tasks: c?.open_tasks ?? 0, overdue_tasks: c?.overdue_tasks ?? 0, blocked_tasks: c?.blocked_tasks ?? 0 },
    kpis, projects,
    permissions: { canManage: canManagePortfolio(a), canManageMembers: canManagePortfolio(a) || isProductLead(a, id), canSeeMembers: canSeeMembers(a, id) },
  };
}

const nullableText = (max: number) => z.string().trim().max(max).nullable().transform((v) => (v ? v : null));
const httpUrl = z.string().trim().url().max(500).refine((u) => /^https?:\/\//i.test(u), 'Only http(s) links');
export const productPatchSchema = z.object({
  version: z.number().int(),
  name: z.string().trim().min(1).max(200).optional(),
  tagline: z.string().trim().max(300).optional(),
  description: z.string().max(10000).optional(),
  companyId: z.string().uuid().nullable().optional(),
  companyConfirmed: z.boolean().optional(),
  websiteUrl: httpUrl.nullable().optional().or(z.literal('').transform(() => null)),
  visibility: z.enum(['members', 'company']).optional(),
  status: z.enum(['active', 'paused', 'archived']).optional(),
});

/** PATCH /api/products/:id (system admins). Changing the company makes the assignment provisional again unless it is confirmed in the same change. */
export async function patchProduct(db: Db, a: Actor, id: string, b: z.infer<typeof productPatchSchema>) {
  if (!canManagePortfolio(a)) throw forbidden('Only a system admin can change products');
  const cur = await loadProduct(db, id);
  if (b.version !== cur.version) throw conflict('This product was changed by someone else. Reload to see the latest version.', { currentVersion: cur.version });
  if (b.companyId && !(await one(db, `select 1 from companies where id = $1`, [b.companyId]))) throw badRequest('Company not found');
  const companyId = 'companyId' in b ? b.companyId ?? null : cur.company_id;
  const next = {
    name: b.name ?? cur.name, tagline: b.tagline ?? cur.tagline, description: b.description ?? cur.description, company_id: companyId,
    company_confirmed: b.companyConfirmed ?? (companyId !== cur.company_id ? false : cur.company_confirmed),
    website_url: 'websiteUrl' in b ? b.websiteUrl ?? null : cur.website_url, visibility: b.visibility ?? cur.visibility, status: b.status ?? cur.status,
  };
  if (next.company_confirmed && !next.company_id) throw badRequest('Choose a company before confirming it');
  const changed = Object.fromEntries(Object.entries(next).filter(([k, v]) => cur[k] !== v).map(([k, v]) => [k, { from: cur[k], to: v }]));
  if (!Object.keys(changed).length) return cur;
  const r = await one(db, `update products set name = $3, tagline = $4, description = $5, company_id = $6, company_confirmed = $7, website_url = $8, visibility = $9,
      status = $10, version = version + 1, updated_at = now() where id = $1 and version = $2 returning *`,
  [id, b.version, next.name, next.tagline, next.description, next.company_id, next.company_confirmed, next.website_url, next.visibility, next.status]);
  if (!r) throw conflict('This product was changed by someone else. Reload to see the latest version.');
  await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'product.update', resourceType: 'product', resourceId: id, resourceVersion: r.version,
    authority: 'system_admin', details: { key: cur.key, changed } });
  return r;
}

// ---------- Membership ----------
export async function productMembers(db: Db, a: Actor, productId: string) {
  requireStaff(a);
  await loadProduct(db, productId);
  if (!canSeeMembers(a, productId)) throw forbidden('Only a system admin, product leads, leadership or the main admin can see product members');
  return many(db, `select m.user_id, m.role, m.created_at, u.name, u.email, u.title, ab.name added_by_name from product_members m join users u on u.id = m.user_id
    left join users ab on ab.id = m.added_by where m.product_id = $1 order by case m.role when 'lead' then 0 when 'member' then 1 else 2 end, u.name`, [productId]);
}

function assertManageMembers(a: Actor, productId: string) {
  if (!canManagePortfolio(a) && !isProductLead(a, productId)) throw forbidden('Only a system admin or a lead of this product can change its members');
}
const ROLE_LABEL: Record<string, string> = { lead: 'lead', member: 'member', viewer: 'viewer (read only)' };

export async function addProductMember(db: Db, a: Actor, productId: string, userId: string, role: 'lead' | 'member' | 'viewer') {
  const p = await loadProduct(db, productId);
  assertManageMembers(a, productId);
  const u = await one(db, `select id, name, status, roles from users where id = $1`, [userId]);
  if (!u || u.status !== 'active' || u.roles.includes('customer')) throw badRequest('Members must be active staff');
  const prev = await one(db, `select role from product_members where product_id = $1 and user_id = $2`, [productId, userId]);
  if (prev?.role === role) return { userId, role, changed: false };
  if (prev?.role === 'lead' && role !== 'lead') await assertNotLastLead(db, a, productId);
  await db.query(`insert into product_members (tenant_id, product_id, user_id, role, added_by) values ($1,$2,$3,$4,$5)
    on conflict (product_id, user_id) do update set role = excluded.role`, [a.tenantId, productId, userId, role, a.id]);
  await audit(db, { tenantId: a.tenantId, actorId: a.id, action: prev ? 'product.member_role_changed' : 'product.member_added', resourceType: 'product', resourceId: productId,
    authority: canManagePortfolio(a) ? 'system_admin' : 'product_lead', details: { key: p.key, userId, role, previousRole: prev?.role ?? null } });
  if (userId !== a.id) await notify(db, a.tenantId, userId, 'product_membership', prev ? `Your role in ${p.name} is now ${ROLE_LABEL[role]}` : `Added to ${p.name} as ${ROLE_LABEL[role]}`,
    `By ${a.name}`, `/products/${productId}`);
  return { userId, role, changed: true };
}

async function assertNotLastLead(db: Db, a: Actor, productId: string) {
  if (canManagePortfolio(a)) return;
  const n = await one(db, `select count(*)::int n from product_members where product_id = $1 and role = 'lead'`, [productId]);
  if ((n?.n ?? 0) <= 1) throw badRequest('A product needs at least one lead. Make someone else a lead first.');
}

export async function removeProductMember(db: Db, a: Actor, productId: string, userId: string) {
  const p = await loadProduct(db, productId);
  assertManageMembers(a, productId);
  const m = await one(db, `select role from product_members where product_id = $1 and user_id = $2`, [productId, userId]);
  if (!m) throw notFound('Not a member of this product');
  if (m.role === 'lead') await assertNotLastLead(db, a, productId);
  await db.query(`delete from product_members where product_id = $1 and user_id = $2`, [productId, userId]);
  // Work they own stays in the product; it is reported so the lead can reassign it.
  const open = await one(db, `select count(*)::int n from tasks where product_id = $1 and owner_id = $2 and status not in ('done','cancelled')`, [productId, userId]);
  await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'product.member_removed', resourceType: 'product', resourceId: productId,
    authority: canManagePortfolio(a) ? 'system_admin' : 'product_lead', details: { key: p.key, userId, role: m.role, openTasksOwned: open?.n ?? 0 } });
  if (userId !== a.id) await notify(db, a.tenantId, userId, 'product_membership', `Removed from ${p.name}`, `By ${a.name}`, null);
  return { ok: true, openTasksOwned: open?.n ?? 0 };
}

// ---------- Companies ----------
const CIN = /^[LU][0-9]{5}[A-Z]{2}[0-9]{4}[A-Z]{3}[0-9]{6}$/;
const GSTIN = /^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]Z[0-9A-Z]$/;
export const companyPatchSchema = z.object({
  version: z.number().int(),
  name: z.string().trim().min(1).max(200).optional(),
  legalName: nullableText(300).optional(),
  cin: nullableText(21).optional().refine((v) => !v || CIN.test(v.toUpperCase()), 'CIN must be the 21-character corporate identity number'),
  gstin: nullableText(15).optional().refine((v) => !v || GSTIN.test(v.toUpperCase()), 'GSTIN must be the 15-character GST number'),
  registeredAddress: nullableText(1000).optional(),
  website: httpUrl.nullable().optional().or(z.literal('').transform(() => null)),
});

/** PATCH /api/companies/:id (system admins): legal details are entered by an administrator, versioned and audited. */
export async function patchCompany(db: Db, a: Actor, id: string, b: z.infer<typeof companyPatchSchema>) {
  if (!canManagePortfolio(a)) throw forbidden('Only a system admin can change company details');
  if (!z.string().uuid().safeParse(id).success) throw notFound('Company not found');
  const cur = await one(db, `select * from companies where id = $1`, [id]);
  if (!cur) throw notFound('Company not found');
  if (b.version !== cur.version) throw conflict('This company was changed by someone else. Reload to see the latest version.', { currentVersion: cur.version });
  const next = {
    name: b.name ?? cur.name, legal_name: 'legalName' in b ? b.legalName ?? null : cur.legal_name,
    cin: 'cin' in b ? b.cin?.toUpperCase() ?? null : cur.cin, gstin: 'gstin' in b ? b.gstin?.toUpperCase() ?? null : cur.gstin,
    registered_address: 'registeredAddress' in b ? b.registeredAddress ?? null : cur.registered_address, website: 'website' in b ? b.website ?? null : cur.website,
  };
  const changed = Object.fromEntries(Object.entries(next).filter(([k, v]) => cur[k] !== v).map(([k, v]) => [k, { from: cur[k], to: v }]));
  if (!Object.keys(changed).length) return cur;
  const r = await one(db, `update companies set name = $3, legal_name = $4, cin = $5, gstin = $6, registered_address = $7, website = $8, version = version + 1, updated_at = now()
    where id = $1 and version = $2 returning *`, [id, b.version, next.name, next.legal_name, next.cin, next.gstin, next.registered_address, next.website]);
  if (!r) throw conflict('This company was changed by someone else. Reload to see the latest version.');
  await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'company.update', resourceType: 'company', resourceId: id, resourceVersion: r.version,
    authority: 'system_admin', details: { code: cur.code, changed } });
  return r;
}

// ---------- Preferences ----------
const FOCUS_KEY = 'product_focus';
/** The stored product focus: 'all', 'none' or a product id still inside the actor's scope (otherwise 'all'). */
export async function getPreferences(db: Db, a: Actor) {
  const r = await one(db, `select value from user_preferences where user_id = $1 and key = $2`, [a.id, FOCUS_KEY]);
  let focus: string = typeof r?.value === 'string' ? r.value : 'all';
  if (focus !== 'all' && focus !== 'none') {
    let ok = false;
    try { ok = !!parseFocus(a, focus) && !!(await one(db, `select 1 from products where id = $1`, [focus])); } catch { ok = false; }
    if (!ok) focus = 'all';
  }
  return { productFocus: focus };
}
export const preferencesSchema = z.object({ productFocus: z.union([z.literal('all'), z.literal('none'), z.string().uuid()]) });
export async function putPreferences(db: Db, a: Actor, b: z.infer<typeof preferencesSchema>) {
  if (!isStaff(a)) throw forbidden();
  const focus = b.productFocus === 'all' ? 'all' : parseFocus(a, b.productFocus) ?? 'all';
  if (focus !== 'all' && focus !== 'none' && !(await one(db, `select 1 from products where id = $1`, [focus]))) throw badRequest('Product not found');
  await db.query(`insert into user_preferences (tenant_id, user_id, key, value) values ($1,$2,$3,$4)
    on conflict (user_id, key) do update set value = excluded.value, updated_at = now()`, [a.tenantId, a.id, FOCUS_KEY, JSON.stringify(focus)]);
  return { productFocus: focus };
}
