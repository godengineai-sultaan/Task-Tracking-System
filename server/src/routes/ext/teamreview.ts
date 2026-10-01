import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tx } from '../../app.js';
import { requireStaff } from '../../services/access.js';
import { myWeeklyReviews, recordWeeklyReview, registerTeamWeeklyExport, respondToWeeklyReview, teamWeek } from '../../services/ext/teamreview.js';

const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const flag = z.enum(['0', '1', 'true', 'false']).optional().transform((v) => v === '1' || v === 'true');

/** Routes for the 'teamreview' feature area: weekly team review for managers and the main admin; employees respond to their own reviews. */
export default async function (app: FastifyInstance) {
  registerTeamWeeklyExport();

  app.get('/api/team-review', async (req) => tx(req, async (db, a) => {
    requireStaff(a);
    const q = z.object({ week: date.optional(), includeMe: flag }).parse(req.query);
    return teamWeek(db, a, { week: q.week, includeMe: q.includeMe });
  }));

  app.get('/api/team-review/mine', async (req) => tx(req, async (db, a) => {
    requireStaff(a);
    const q = z.object({ limit: z.coerce.number().int().min(1).max(100).default(26) }).parse(req.query);
    return myWeeklyReviews(db, a, q.limit);
  }));

  app.post('/api/team-review/reviews', async (req) => tx(req, async (db, a) => {
    requireStaff(a);
    const b = z.object({
      subjectUserId: uuid, week: date, action: z.enum(['acknowledge', 'discussed', 'needs_follow_up']),
      note: z.string().max(3000).optional(), version: z.number().int().positive().optional(),
      followUp: z.object({ title: z.string().trim().min(1).max(300), dueDate: date.nullish() }).optional(),
    }).strict().parse(req.body);
    return recordWeeklyReview(db, a, b);
  }));

  app.post('/api/team-review/reviews/:id/respond', async (req) => tx(req, async (db, a) => {
    requireStaff(a);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ response: z.string().max(3000), version: z.number().int().positive() }).strict().parse(req.body);
    return respondToWeeklyReview(db, a, id, b);
  }));
}
