import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tx } from '../../app.js';
import { badges, deleteBudget, portfolio, projectBudget, saveBudget } from '../../services/ext/profitability.js';

const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const money = z.number().finite().nonnegative().max(1e12);

const budgetSchema = z.object({
  billingType: z.enum(['fixed_fee', 'time_and_materials', 'internal']),
  budgetAmount: money.nullable().optional(),
  currency: z.string().regex(/^[A-Z]{3}$/, 'Use a 3-letter currency code such as INR or USD'),
  budgetHours: z.number().finite().nonnegative().max(1e6).nullable().optional(),
  billRate: money.nullable().optional(),
  startDate: date.nullable().optional(),
  endDate: date.nullable().optional(),
  alertThresholds: z.array(z.number().int().min(1).max(500)).min(1).max(6).default([75, 90, 100]),
  notes: z.string().max(2000).default(''),
  version: z.number().int().positive().optional(),
}).superRefine((b, ctx) => {
  if (b.budgetAmount == null && b.budgetHours == null) ctx.addIssue({ code: 'custom', path: ['budgetAmount'], message: 'Set a budget amount, budget hours, or both' });
  if (b.billingType === 'fixed_fee' && !b.budgetAmount) ctx.addIssue({ code: 'custom', path: ['budgetAmount'], message: 'A fixed-fee project needs the fee as its budget amount' });
  if (b.billingType === 'time_and_materials' && b.billRate == null) ctx.addIssue({ code: 'custom', path: ['billRate'], message: 'Time-and-materials billing needs a bill rate' });
  if (b.startDate && b.endDate && b.endDate < b.startDate) ctx.addIssue({ code: 'custom', path: ['endDate'], message: 'End date is before the start date' });
});

/** Routes for the 'profitability' feature area: project budgets, burn and margin (authorization in the service). */
export default async function (app: FastifyInstance) {
  app.get('/api/profitability/portfolio', async (req) => tx(req, (db, a) => {
    const f = z.object({ status: z.string().max(40).optional(), billingType: z.enum(['fixed_fee', 'time_and_materials', 'internal']).optional() }).parse(req.query);
    return portfolio(db, a, f);
  }));
  app.get('/api/profitability/badges', async (req) => tx(req, (db, a) => badges(db, a)));
  app.get('/api/projects/:id/budget', async (req) => tx(req, (db, a) => projectBudget(db, a, z.object({ id: uuid }).parse(req.params).id)));
  app.put('/api/projects/:id/budget', async (req) => tx(req, (db, a) => saveBudget(db, a, z.object({ id: uuid }).parse(req.params).id, budgetSchema.parse(req.body))));
  app.delete('/api/projects/:id/budget', async (req) => tx(req, (db, a) => {
    const b = z.object({ version: z.number().int().positive(), reason: z.string().trim().min(3, 'Give a reason for removing the budget').max(500) }).parse(req.body);
    return deleteBudget(db, a, z.object({ id: uuid }).parse(req.params).id, b.version, b.reason);
  }));
}
