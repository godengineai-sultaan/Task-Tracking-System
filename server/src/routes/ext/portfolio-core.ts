import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tx } from '../../app.js';
import { forbidden } from '../../lib/errors.js';
import { has } from '../../services/access.js';
import {
  addProductMember, companyPatchSchema, getPreferences, patchCompany, patchProduct, portfolioOverview, preferencesSchema, productDetail,
  productMembers, productPatchSchema, putPreferences, removeProductMember,
} from '../../services/ext/portfolio.js';
import { missingCatalogProducts, provisionPortfolio } from '../../services/ext/portfolio-provision.js';

const id = z.object({ id: z.string().uuid() });

/** Portfolio core: companies, products, product membership, per-user product focus and catalog provisioning. */
export default async function (app: FastifyInstance) {
  app.get('/api/portfolio', async (req) => tx(req, (db, a) => portfolioOverview(db, a)));

  app.get('/api/products/:id', async (req) => tx(req, (db, a) => productDetail(db, a, (req.params as any).id)));
  app.patch('/api/products/:id', async (req) => tx(req, (db, a) => patchProduct(db, a, id.parse(req.params).id, productPatchSchema.parse(req.body))));

  app.get('/api/products/:id/members', async (req) => tx(req, (db, a) => productMembers(db, a, id.parse(req.params).id)));
  app.post('/api/products/:id/members', async (req) => tx(req, async (db, a) => {
    const b = z.object({ userId: z.string().uuid(), role: z.enum(['lead', 'member', 'viewer']).default('member') }).parse(req.body);
    return addProductMember(db, a, id.parse(req.params).id, b.userId, b.role);
  }));
  app.delete('/api/products/:id/members/:userId', async (req) => tx(req, async (db, a) => {
    const p = z.object({ id: z.string().uuid(), userId: z.string().uuid() }).parse(req.params);
    return removeProductMember(db, a, p.id, p.userId);
  }));

  app.patch('/api/companies/:id', async (req) => tx(req, (db, a) => patchCompany(db, a, (req.params as any).id, companyPatchSchema.parse(req.body))));

  app.get('/api/me/preferences', async (req) => tx(req, (db, a) => getPreferences(db, a)));
  app.put('/api/me/preferences', async (req) => tx(req, (db, a) => putPreferences(db, a, preferencesSchema.parse(req.body))));

  // Catalog provisioning (system admins): GET is a dry-run preview of exactly what POST would create or update.
  app.get('/api/admin/portfolio/provision', async (req) => tx(req, async (db, a) => {
    if (!has(a, 'system_admin')) throw forbidden('Only a system admin can provision the portfolio');
    const missing = await missingCatalogProducts(db, a.tenantId);
    return { ...(await provisionPortfolio(db, a.tenantId, a.id, { dryRun: true })), missingProducts: missing };
  }));
  app.post('/api/admin/portfolio/provision', async (req) => tx(req, async (db, a) => {
    if (!has(a, 'system_admin')) throw forbidden('Only a system admin can provision the portfolio');
    return provisionPortfolio(db, a.tenantId, a.id);
  }));
}
