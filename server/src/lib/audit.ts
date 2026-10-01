import { sha256 } from './crypto.js';
import type { Db } from './db.js';

export interface AuditInput {
  tenantId: string; actorId: string | null; action: string; resourceType: string;
  resourceId?: string | null; resourceVersion?: number | null; reason?: string | null;
  authority?: string | null; correlationId?: string | null; outcome?: string; details?: Record<string, unknown>;
}

/** Append to the tenant hash chain. Serialized per tenant with an advisory transaction lock. */
export async function audit(db: Db, a: AuditInput) {
  await db.query('select pg_advisory_xact_lock(hashtext($1))', [a.tenantId]);
  const prev = await db.query('select hash from audit_events where tenant_id = $1 order by id desc limit 1', [a.tenantId]);
  const prevHash: string = prev.rows[0]?.hash ?? 'genesis';
  const at = new Date().toISOString();
  const body = canonical(a, at);
  const hash = sha256(prevHash + body);
  await db.query(
    `insert into audit_events (tenant_id, actor_id, action, resource_type, resource_id, resource_version, reason, authority,
       correlation_id, outcome, details, at, prev_hash, hash)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [a.tenantId, a.actorId, a.action, a.resourceType, a.resourceId ?? null, a.resourceVersion ?? null, a.reason ?? null,
     a.authority ?? null, a.correlationId ?? null, a.outcome ?? 'success', a.details ?? {}, at, prevHash, hash]);
}

function canonical(a: AuditInput, at: string) {
  return JSON.stringify([a.tenantId, a.actorId, a.action, a.resourceType, a.resourceId ?? null, a.resourceVersion ?? null,
    a.reason ?? null, a.authority ?? null, a.correlationId ?? null, a.outcome ?? 'success', sortKeys(a.details ?? {}), at]);
}
function sortKeys(v: any): any {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}

/** Recompute the chain; returns the first broken event id or null. */
export async function verifyAuditChain(db: Db, tenantId: string) {
  const rows = (await db.query('select * from audit_events where tenant_id = $1 order by id', [tenantId])).rows;
  let prev = 'genesis';
  for (const r of rows) {
    const body = canonical({ tenantId: r.tenant_id, actorId: r.actor_id, action: r.action, resourceType: r.resource_type,
      resourceId: r.resource_id, resourceVersion: r.resource_version, reason: r.reason, authority: r.authority,
      correlationId: r.correlation_id, outcome: r.outcome, details: r.details }, new Date(r.at).toISOString());
    if (r.prev_hash !== prev || r.hash !== sha256(prev + body)) return { ok: false, brokenAt: r.id, checked: rows.length };
    prev = r.hash;
  }
  return { ok: true, brokenAt: null, checked: rows.length };
}
