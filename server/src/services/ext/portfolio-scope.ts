import type { Db, ProductScope } from '../../lib/db.js';
import { many, one } from '../../lib/db.js';
import { AppError, badRequest, forbidden } from '../../lib/errors.js';
import { type Actor, ALL_PRODUCT_ROLES, has, inProductScope, isStaff, productScopeSetting } from '../access.js';

/**
 * Product partitions (see migrations/018_portfolio.sql).
 *
 * SCOPE  (app.product_scope) is set for every request from the actor: which products' work exists for them at all.
 * FOCUS  (app.product_focus) narrows list views to one product ('<uuid>') or to company-wide work ('none'). It comes from the
 *        'x-product-focus' request header and applies ONLY to GET requests on the list endpoints below. Single-resource GETs,
 *        personal pages and every write ignore it. A focus outside the actor's scope is refused (403), never widened.
 */
export const FOCUS_PATHS: ReadonlySet<string> = new Set([
  '/api/tasks', '/api/projects', '/api/milestones', '/api/search', '/api/recurring',
  '/api/templates', '/api/automations', '/api/automations/runs',
  '/api/objectives', '/api/objectives/overview',
  '/api/leadership/delivery', '/api/insights', '/api/insights/options', '/api/team/capacity', '/api/whatif/context',
  '/api/profitability/portfolio', '/api/profitability/badges', '/api/client-updates', '/api/client-updates/projects',
  '/api/integrations',
]);
export const FOCUS_HEADER = 'x-product-focus';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 'none' | product uuid | null (no focus). Throws 400 for a malformed value and 403 for a product outside the actor's scope. */
export function parseFocus(a: Actor, raw: unknown): string | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (v === undefined || v === null || v === '' || v === 'all') return null;
  if (v === 'none') return 'none';
  if (typeof v !== 'string' || !UUID.test(v)) throw badRequest('x-product-focus must be "all", "none" or a product id');
  const id = v.toLowerCase();
  if (!inProductScope(a, id)) throw new AppError(403, 'focus_out_of_scope', 'That product is not available to you. Showing all your products instead.');
  return id;
}

/** The focus that applies to this request: only GET requests on FOCUS_PATHS. */
export function requestFocus(a: Actor, method: string, url: string, header: unknown): string | null {
  if (method !== 'GET') return null;
  if (!FOCUS_PATHS.has(url.split('?')[0])) return null;
  return parseFocus(a, header);
}

/** Transaction settings for an actor (scope always; focus only when given). */
export function actorScope(a: Actor, focus: string | null = null): ProductScope {
  return { scope: productScopeSetting(a), focus };
}

/** Apply an actor's product scope (and optional focus) inside an already-open transaction (jobs, CLI-free system paths). */
export async function applyProductScope(db: Db, a: Actor, focus: string | null = null) {
  const s = actorScope(a, focus);
  await db.query("select set_config('app.product_scope', $1, true), set_config('app.product_focus', $2, true)", [s.scope, s.focus ?? '']);
}

/** Whether the organization has any products (independent of the caller's scope). */
export async function tenantHasProducts(db: Db) {
  return !!(await one(db, `select app_tenant_has_products() as has`))?.has;
}

/** Can this actor add or change work in the product? All-scope roles, leads and members; any staff on company-visible products; never viewers. */
export function canWriteProduct(a: Actor, p: { id: string; visibility: string }) {
  if (!isStaff(a)) return false;
  if (ALL_PRODUCT_ROLES.some((r) => has(a, r))) return true;
  const role = a.productRoles[p.id];
  if (role) return role !== 'viewer';
  return p.visibility === 'company';
}

/**
 * A product work can be filed into: visible to the actor (row-level security), not archived, and writable by the actor.
 * a = null (system work) only checks that it exists and is not archived.
 */
export async function assertProductUsable(db: Db, a: Actor | null, productId: string) {
  const p = await one(db, `select id, name, status, visibility from products where id = $1`, [productId]);
  if (!p) throw badRequest('Product not found');
  if (p.status === 'archived') throw badRequest(`${p.name} is archived. Choose an active product.`);
  if (a && !canWriteProduct(a, p)) throw forbidden(`You have view-only access to ${p.name}`);
  return p;
}

/** People who can own, review or collaborate on work in a product: all-scope roles, leads and members, or anyone when the product is company-visible. */
export async function productWorkers(db: Db, productId: string, userIds: string[]) {
  return many<{ id: string; name: string; ok: boolean }>(db, `select u.id, u.name,
      (u.roles && $3::text[] or exists (select 1 from products p where p.id = $1 and p.visibility = 'company')
        or exists (select 1 from product_members m where m.product_id = $1 and m.user_id = u.id and m.role in ('lead','member'))) as ok
    from users u where u.id = any($2::uuid[])`, [productId, userIds, ALL_PRODUCT_ROLES]);
}
/** Refuse to give product work to someone who could not see it afterwards. */
export async function assertUsersInProduct(db: Db, productId: string | null | undefined, userIds: (string | null | undefined)[]) {
  const ids = [...new Set(userIds.filter((x): x is string => !!x))];
  if (!productId || !ids.length) return;
  const rows = await productWorkers(db, productId, ids);
  const bad = rows.find((r) => !r.ok);
  if (bad) {
    const p = await one(db, `select name from products where id = $1`, [productId]);
    throw badRequest(`${bad.name} is not a member of ${p?.name ?? 'this product'}. Add them to the product first.`);
  }
}
