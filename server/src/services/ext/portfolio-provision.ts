import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Db } from '../../lib/db.js';
import { many, one } from '../../lib/db.js';
import { audit } from '../../lib/audit.js';
import { insertItems, itemSchema, saveVersion, templateSchema, validateItems, type TemplateInput } from './templates.js';

/**
 * The LORD portfolio catalog (server/src/catalog/portfolio.json): 2 companies, 32 products, each with KPI definitions,
 * workstreams, activity/work-item types and 3 playbooks. Provisioning is idempotent per tenant and keyed by stable keys:
 * companies by code, products by key, KPIs by (product, key), playbooks by task_templates.starter_key 'catalog:<PRODUCT>:<n>'.
 * Product-to-company ownership is not in the catalog: products are created without a company (an administrator assigns it).
 */
export interface CatalogItem {
  title: string; description?: string; category: string; priority: string; estimate_minutes: number | null; due_offset_days: number | null;
  owner_hint?: string; requires_review?: boolean; requires_evidence?: boolean; checklist?: string[]; depends_on_positions?: number[];
}
export interface CatalogTemplate { name: string; description: string; category: string; items: CatalogItem[] }
export interface CatalogKpi { key: string; name: string; unit: string; direction: string; cadence: string; source: string; definition: string }
export interface CatalogProduct {
  number: number; key: string; name: string; tagline: string; layer: string; revenue_engine: string; description: string;
  customer_segments: string[]; workstreams: { name: string; description: string }[]; templates: CatalogTemplate[]; kpis: CatalogKpi[];
  activity_types: { key: string; label: string; description: string }[]; work_item_types: { key: string; label: string; default_category: string; default_priority: string }[];
  risks: string[]; grounding_notes: string;
}
export interface Catalog { catalog_version: string; source: string; note: string; companies: { code: string; name: string; role?: string }[]; products: CatalogProduct[] }

let cached: Catalog | null = null;
export function loadCatalog(): Catalog {
  cached ??= JSON.parse(readFileSync(resolve(import.meta.dirname, '../../catalog/portfolio.json'), 'utf8')) as Catalog;
  return cached;
}

/** Catalog playbook categories are task categories; templates use the template library's categories. */
const TEMPLATE_CATEGORY: Record<string, TemplateInput['category']> = {
  delivery: 'product', research: 'product', sales: 'client', operations: 'operations', finance: 'finance', support: 'client', admin: 'operations',
};
export const catalogTemplateKey = (productKey: string, n: number) => `catalog:${productKey}:${n}`;

export function catalogTemplateInput(t: CatalogTemplate): TemplateInput {
  const input = templateSchema.parse({
    name: t.name.slice(0, 120), description: t.description, category: TEMPLATE_CATEGORY[t.category] ?? 'other', visibility: 'company',
    items: t.items.map((it) => itemSchema.parse({
      title: it.title, description: it.description ?? '', category: it.category, priority: it.priority, estimateMinutes: it.estimate_minutes ?? null,
      dueOffsetDays: it.due_offset_days ?? null, ownerHint: (it.owner_hint ?? '').slice(0, 80), checklist: it.checklist ?? [],
      requiresReview: !!it.requires_review, requiresEvidence: !!it.requires_evidence, dependsOn: it.depends_on_positions ?? [],
    })),
  });
  validateItems(input.items);
  return input;
}
const catalogSnapshot = (p: CatalogProduct) => ({
  customer_segments: p.customer_segments, workstreams: p.workstreams, activity_types: p.activity_types, work_item_types: p.work_item_types,
  risks: p.risks, grounding_notes: p.grounding_notes,
});

function canonical(v: any): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}
const templateSnapshot = (input: TemplateInput) => ({ name: input.name, description: input.description, category: input.category, visibility: input.visibility, items: input.items });

interface Counts { created: number; updated: number; unchanged: number }
export interface ProvisionSummary {
  dryRun: boolean; catalogVersion: string; source: string;
  companies: { created: number; existing: number };
  products: Counts; kpis: Counts; templates: Counts & { customized: number };
  totals: { companies: number; products: number; kpis: number; templates: number };
  /** Playbooks edited in the app since they were provisioned: re-provisioning leaves them as they are. */
  customizedTemplates: string[];
}

/**
 * Create or refresh the catalog for one tenant. Queries filter by tenant explicitly so this also runs under the owner role (seed).
 * dryRun runs the same steps inside a savepoint and rolls them back, so the preview counts are exactly what an apply would do.
 */
export async function provisionPortfolio(db: Db, tenantId: string, actorId: string | null, opts: { dryRun?: boolean } = {}): Promise<ProvisionSummary> {
  if (!opts.dryRun) return provision(db, tenantId, actorId, false);
  await db.query('savepoint portfolio_preview');
  try { return await provision(db, tenantId, actorId, true); } finally { await db.query('rollback to savepoint portfolio_preview'); }
}

async function provision(db: Db, tenantId: string, actorId: string | null, dryRun: boolean): Promise<ProvisionSummary> {
  const cat = loadCatalog();
  const s: ProvisionSummary = {
    dryRun, catalogVersion: cat.catalog_version, source: cat.source, companies: { created: 0, existing: 0 },
    products: { created: 0, updated: 0, unchanged: 0 }, kpis: { created: 0, updated: 0, unchanged: 0 }, templates: { created: 0, updated: 0, unchanged: 0, customized: 0 },
    totals: { companies: cat.companies.length, products: cat.products.length, kpis: 0, templates: 0 }, customizedTemplates: [],
  };
  for (const c of cat.companies) {
    const r = await one(db, `insert into companies (tenant_id, code, name) values ($1,$2,$3) on conflict (tenant_id, code) do nothing returning id`, [tenantId, c.code, c.name]);
    if (r) s.companies.created++; else s.companies.existing++;
  }
  for (const p of cat.products) {
    const snapshot = catalogSnapshot(p);
    const cur = await one(db, `select * from products where tenant_id = $1 and key = $2`, [tenantId, p.key]);
    let productId: string;
    if (!cur) {
      productId = (await one(db, `insert into products (tenant_id, key, number, name, tagline, layer, revenue_engine, description, catalog, catalog_version)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
      [tenantId, p.key, p.number, p.name, p.tagline, p.layer, p.revenue_engine, p.description, JSON.stringify(snapshot), cat.catalog_version]))!.id;
      s.products.created++;
    } else {
      productId = cur.id;
      // Names and descriptions an administrator edited (version > 1) are kept; catalog facts are refreshed.
      const keepText = cur.version > 1;
      const next = { number: p.number, layer: p.layer, revenue_engine: p.revenue_engine, catalog: snapshot, catalog_version: cat.catalog_version,
        name: keepText ? cur.name : p.name, tagline: keepText ? cur.tagline : p.tagline, description: keepText ? cur.description : p.description };
      const same = canonical(next) === canonical({ number: cur.number, layer: cur.layer, revenue_engine: cur.revenue_engine, catalog: cur.catalog,
        catalog_version: cur.catalog_version, name: cur.name, tagline: cur.tagline, description: cur.description });
      if (same) s.products.unchanged++;
      else {
        await db.query(`update products set number = $2, layer = $3, revenue_engine = $4, catalog = $5, catalog_version = $6, name = $7, tagline = $8, description = $9,
            updated_at = now() where id = $1`,
        [productId, next.number, next.layer, next.revenue_engine, JSON.stringify(snapshot), next.catalog_version, next.name, next.tagline, next.description]);
        s.products.updated++;
      }
    }

    for (const [i, k] of p.kpis.entries()) {
      s.totals.kpis++;
      const r = await one(db, `insert into product_kpis (tenant_id, product_id, key, name, unit, direction, cadence, source, definition, position)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        on conflict (product_id, key) do update set name = excluded.name, unit = excluded.unit, direction = excluded.direction, cadence = excluded.cadence,
          source = excluded.source, definition = excluded.definition, position = excluded.position, updated_at = now()
        where (product_kpis.name, product_kpis.unit, product_kpis.direction, product_kpis.cadence, product_kpis.source, product_kpis.definition, product_kpis.position)
          is distinct from (excluded.name, excluded.unit, excluded.direction, excluded.cadence, excluded.source, excluded.definition, excluded.position)
        returning (xmax = 0) as inserted`,
      [tenantId, productId, k.key, k.name, k.unit ?? '', k.direction, k.cadence, k.source ?? 'platform', k.definition ?? '', i + 1]);
      if (!r) s.kpis.unchanged++; else if (r.inserted) s.kpis.created++; else s.kpis.updated++;
    }

    for (const [i, tpl] of p.templates.entries()) {
      s.totals.templates++;
      const key = catalogTemplateKey(p.key, i + 1);
      const input = catalogTemplateInput(tpl);
      const t = await one(db, `select * from task_templates where tenant_id = $1 and starter_key = $2`, [tenantId, key]);
      if (!t) {
        const row = await one(db, `insert into task_templates (tenant_id, name, description, category, visibility, is_starter, starter_key, product_id)
          values ($1,$2,$3,$4,'company',true,$5,$6) returning *`, [tenantId, input.name, input.description, input.category, key, productId]);
        await insertItems(db, tenantId, row.id, input.items);
        await saveVersion(db, row, input, `Catalog ${cat.catalog_version}`, null);
        s.templates.created++;
        continue;
      }
      const latest = await one(db, `select snapshot, created_by from task_template_versions where template_id = $1 order by version desc limit 1`, [t.id]);
      if (latest && canonical(latest.snapshot) === canonical(templateSnapshot(input)) && t.product_id === productId) { s.templates.unchanged++; continue; }
      if (latest?.created_by) { s.templates.customized++; s.customizedTemplates.push(`${p.name}: ${t.name}`); continue; }
      const row = await one(db, `update task_templates set name = $2, description = $3, category = $4, product_id = $5, version = version + 1, updated_at = now()
        where id = $1 returning *`, [t.id, input.name, input.description, input.category, productId]);
      await db.query(`delete from task_template_items where template_id = $1`, [t.id]);
      await insertItems(db, tenantId, t.id, input.items);
      await saveVersion(db, row, input, `Catalog ${cat.catalog_version}`, null);
      s.templates.updated++;
    }
  }
  if (!dryRun) await audit(db, { tenantId, actorId, action: 'portfolio.provisioned', resourceType: 'tenant', resourceId: tenantId, authority: actorId ? 'system_admin' : 'system',
    details: { catalogVersion: cat.catalog_version, companies: s.companies, products: s.products, kpis: s.kpis, templates: s.templates } });
  return s;
}

/** Products in the catalog that are not provisioned yet (dry-run detail for the admin preview). */
export async function missingCatalogProducts(db: Db, tenantId: string) {
  const have = new Set((await many(db, `select key from products where tenant_id = $1`, [tenantId])).map((r) => r.key));
  return loadCatalog().products.filter((p) => !have.has(p.key)).map((p) => ({ key: p.key, name: p.name, number: p.number }));
}
