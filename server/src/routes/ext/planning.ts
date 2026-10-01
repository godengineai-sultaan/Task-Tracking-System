import type { FastifyInstance } from 'fastify';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { tx } from '../../app.js';
import { forbidden } from '../../lib/errors.js';
import { requireStaff } from '../../services/access.js';
import { getPreferences, setPreferences, suggestDay, weeklySummary } from '../../services/ext/planning.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((v) => DateTime.fromISO(v).isValid, 'Invalid date');

/** Routes for the 'planning' feature area: plan-my-day suggestions, nudge preferences, weekly self-summary. */
export default async function (app: FastifyInstance) {
  app.get('/api/planning/suggest', async (req) => tx(req, (db, a) => suggestDay(db, a, z.object({ date: date.optional() }).parse(req.query).date)));

  app.get('/api/planning/preferences', async (req) => tx(req, (db, a) => { requireStaff(a); return getPreferences(db, a.id); }));
  app.put('/api/planning/preferences', async (req) => tx(req, (db, a) =>
    setPreferences(db, a, z.object({ planNudge: z.boolean().optional(), recapNudge: z.boolean().optional() }).strict().parse(req.body))));

  // A self-summary is private to its author: managers and admins use the existing reports instead.
  app.get('/api/planning/weekly-summary', async (req) => tx(req, (db, a) => {
    const q = z.object({ date: date.optional(), userId: z.string().uuid().optional() }).parse(req.query);
    if (q.userId && q.userId !== a.id) throw forbidden('A weekly self-summary is only available to the person it describes.');
    return weeklySummary(db, a, q.date);
  }));
}
