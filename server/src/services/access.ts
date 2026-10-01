import type { Db } from '../lib/db.js';
import { many, one } from '../lib/db.js';
import { forbidden, notFound } from '../lib/errors.js';

export type Role = 'member' | 'manager' | 'leadership' | 'routine_admin' | 'system_admin' | 'cost_viewer' | 'customer';
export const ALL_ROLES: Role[] = ['member', 'manager', 'leadership', 'routine_admin', 'system_admin', 'cost_viewer', 'customer'];

export interface Actor {
  id: string;
  tenantId: string;
  name: string;
  email: string;
  roles: Set<Role>;
  isFounder: boolean;
  customerId: string | null;
  departmentId: string | null;
  timezone: string;
  /** Users in teams this actor manages (excludes self). */
  managedUserIds: string[];
  tenantSettings: TenantSettings;
  /** Products whose work this actor may see: 'all' (system/routine admins, leadership) or product ids (memberships + company-visible products;
   *  customers: the products of their own client projects). Enforced in the database through app.product_scope. */
  productScope: 'all' | string[];
  /** Explicit product memberships (lead / member / viewer), whatever the scope. */
  productRoles: Record<string, ProductRole>;
}
export type ProductRole = 'lead' | 'member' | 'viewer';
/** Roles that see every product of the organization. */
export const ALL_PRODUCT_ROLES: Role[] = ['system_admin', 'routine_admin', 'leadership'];

export interface TenantSettings {
  founders_visible_to_routine_admin?: boolean;
  include_meetings_in_work_policy?: boolean;
  coverage_threshold?: number;
  retention_days?: number;
  voice_capture_enabled?: boolean;
  ai_enabled?: boolean;
  evidence_required_categories?: string[];
  review_required_categories?: string[];
}

export const has = (a: Actor, r: Role) => a.roles.has(r);
export const isStaff = (a: Actor) => !a.roles.has('customer');

export async function loadActor(db: Db, tenantId: string, userId: string): Promise<Actor | null> {
  const u = await one(db,
    `select u.*, t.timezone as tenant_tz, t.settings as tenant_settings from users u join tenants t on t.id = u.tenant_id
     where u.id = $1 and u.tenant_id = $2 and u.status = 'active'`, [userId, tenantId]);
  if (!u) return null;
  const managed = await many<{ user_id: string }>(db,
    `select distinct tm.user_id from teams t join team_members tm on tm.team_id = t.id join users mu on mu.id = tm.user_id
     where t.manager_id = $1 and tm.user_id <> $1 and not ('customer' = any(mu.roles))`, [userId]);
  const roles = new Set<Role>(u.roles);
  // Product scope is computed here (no product scope applies while loading the actor) and enforced by row-level security per request.
  const memberships = await many<{ id: string; visibility: string; role: ProductRole | null }>(db,
    `select p.id, p.visibility, m.role from products p left join product_members m on m.product_id = p.id and m.user_id = $1
     where m.user_id is not null or p.visibility = 'company'`, [userId]);
  const productRoles: Record<string, ProductRole> = {};
  for (const m of memberships) if (m.role) productRoles[m.id] = m.role;
  let productScope: 'all' | string[];
  if (roles.has('customer')) {
    productScope = (await many(db, `select distinct product_id from projects where customer_id = $1 and product_id is not null`,
      [u.customer_id ?? '00000000-0000-0000-0000-000000000000'])).map((r) => r.product_id);
  } else if (ALL_PRODUCT_ROLES.some((r) => roles.has(r))) productScope = 'all';
  else productScope = memberships.map((m) => m.id);
  return {
    id: u.id, tenantId, name: u.name, email: u.email, roles, isFounder: u.is_founder,
    customerId: u.customer_id, departmentId: u.department_id, timezone: u.timezone || u.tenant_tz,
    managedUserIds: managed.map((m) => m.user_id), tenantSettings: u.tenant_settings || {},
    productScope, productRoles: roles.has('customer') ? {} : productRoles,
  };
}

/** Value for the app.product_scope setting: 'all', a comma-separated id list, or 'none' (company-wide rows only). */
export function productScopeSetting(a: Actor) {
  return a.productScope === 'all' ? 'all' : a.productScope.length ? a.productScope.join(',') : 'none';
}
/** Is this product (null = company-wide work) inside the actor's product scope? */
export function inProductScope(a: Actor, productId: string | null | undefined) {
  return !productId || a.productScope === 'all' || a.productScope.includes(productId);
}

export function require(a: Actor, ...anyOf: Role[]) {
  if (!anyOf.some((r) => a.roles.has(r))) throw forbidden();
}
export function requireStaff(a: Actor) { if (!isStaff(a)) throw forbidden(); }

/**
 * Whose recorded work (plans, recaps, time, reports, timeline) may this actor see?
 * self always; team managers: their team members; routine_admin: every employee
 * (founders only when the tenant policy declares founders visible, or the viewer is a founder).
 */
export async function canViewPersonRecords(db: Db, a: Actor, targetUserId: string): Promise<boolean> {
  if (targetUserId === a.id) return true;
  if (!isStaff(a)) return false;
  if (a.managedUserIds.includes(targetUserId)) return true;
  if (has(a, 'routine_admin')) {
    const t = await one(db, `select is_founder, roles from users where id = $1`, [targetUserId]);
    if (!t || t.roles.includes('customer')) return false;
    if (t.is_founder && a.tenantSettings.founders_visible_to_routine_admin === false && !a.isFounder) return false;
    return true;
  }
  return false;
}
export async function assertCanViewPerson(db: Db, a: Actor, userId: string) {
  if (!(await canViewPersonRecords(db, a, userId))) throw forbidden('You are not authorized to view this person\'s work records');
}

/** User ids whose daily routine this actor can review (admin table / team views). */
export async function reviewableUserIds(db: Db, a: Actor): Promise<string[]> {
  if (has(a, 'routine_admin')) {
    const hideFounders = a.tenantSettings.founders_visible_to_routine_admin === false && !a.isFounder;
    const rows = await many(db, `select id from users where status = 'active' and not ('customer' = any(roles))
      and ($1::boolean = false or is_founder = false or id = $2)`, [hideFounders, a.id]);
    return rows.map((r) => r.id);
  }
  return [a.id, ...a.managedUserIds];
}

/**
 * SQL predicate for tasks visible to the actor. `t` = tasks alias, `p` = left-joined projects alias.
 * Returns [sql, params] where params start at $offset.
 */
export function taskVisibility(a: Actor, offset: number): [string, unknown[]] {
  if (has(a, 'customer')) {
    return [`(p.customer_id = $${offset} and t.customer_visible = true and p.status <> 'archived')`, [a.customerId ?? '00000000-0000-0000-0000-000000000000']];
  }
  if (has(a, 'routine_admin')) return ['true', []];
  const me = `$${offset}`, managed = `$${offset + 1}`;
  return [`(
    t.owner_id = ${me} or t.created_by = ${me} or t.reviewer_id = ${me}
    or t.owner_id = any(${managed}::uuid[])
    or exists (select 1 from task_collaborators c where c.task_id = t.id and c.user_id = ${me})
    or (p.id is not null and p.visibility = 'company')
    or (p.id is not null and (p.owner_id = ${me} or exists (select 1 from project_members pm where pm.project_id = p.id and pm.user_id = ${me})))
    or exists (select 1 from blockers bw where bw.task_id = t.id and bw.resolved_at is null and bw.waiting_on_user_id = ${me})
  )`, [a.id, a.managedUserIds]];
}

export async function loadVisibleTask(db: Db, a: Actor, taskId: string) {
  const [vis, params] = taskVisibility(a, 2);
  const t = await one(db, `select t.*, p.owner_id as project_owner_id, p.customer_id as project_customer_id
    from tasks t left join projects p on p.id = t.project_id where t.id = $1 and ${vis}`, [taskId, ...params]);
  if (!t) throw notFound('Task not found');
  return t;
}

/** Contribute to a task: owner, collaborators, creator, reviewer, owner's manager, project owner, routine admin. */
export async function canContribute(db: Db, a: Actor, t: any): Promise<boolean> {
  if (!isStaff(a)) return false;
  if ([t.owner_id, t.created_by, t.reviewer_id, t.project_owner_id].includes(a.id)) return true;
  if (a.managedUserIds.includes(t.owner_id) || has(a, 'routine_admin')) return true;
  return !!(await one(db, `select 1 from task_collaborators where task_id = $1 and user_id = $2`, [t.id, a.id]));
}
export async function assertContribute(db: Db, a: Actor, t: any) {
  if (!(await canContribute(db, a, t))) throw forbidden('Only the owner, collaborators, reviewer or responsible manager can change this task');
}
/** Reassign/redistribute: current owner, owner's manager, project owner, routine admin. */
export function canReassign(a: Actor, t: any) {
  return t.owner_id === a.id || a.managedUserIds.includes(t.owner_id) || t.project_owner_id === a.id || has(a, 'routine_admin');
}

/** Restricted evidence keeps its source permission: only the adder, task owner and explicitly allowed users see the reference. */
export function canSeeRestrictedEvidence(a: Actor, ev: any, task: any) {
  if (!ev.restricted) return true;
  return ev.added_by === a.id || task.owner_id === a.id || (ev.allowed_user_ids || []).includes(a.id);
}
