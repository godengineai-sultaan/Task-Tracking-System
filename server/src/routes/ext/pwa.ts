import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tx } from '../../app.js';
import { requireStaff } from '../../services/access.js';
import { syncOfflineCapture } from '../../services/ext/pwa.js';

const captureSchema = z.object({
  clientRequestId: z.string().min(8).max(100).regex(/^[A-Za-z0-9_-]+$/),
  userId: z.string().uuid().optional(),
  text: z.string().trim().min(1).max(500),
  capturedAt: z.string().datetime({ offset: true }),
  projectId: z.string().uuid().nullable().optional(),
  addToMyDay: z.boolean().optional(),
});

/** Routes for the 'pwa' feature area: syncing quick captures queued on a device while offline. */
export default async function (app: FastifyInstance) {
  app.post('/api/pwa/captures', async (req) => tx(req, async (db, a) => {
    requireStaff(a);
    return syncOfflineCapture(db, a, captureSchema.parse(req.body), req.id);
  }));
}
