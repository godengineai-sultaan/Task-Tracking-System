import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { actorOf, tx } from '../../app.js';
import { checkSubscriptionUrl, confirmHolidayImport, fetchPlan, finishManualSync, planManualSync, previewHolidayImport, readHolidaySource, recentHolidayImports,
  removeSubscription, saveSubscription, setSubscriptionStatus, subscriptionState } from '../../services/ext/calendar.js';
import { FEED_PATH, feedState, revokeFeed, rotateFeed, serveFeed } from '../../services/ext/calendar-feed.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const url = z.string().trim().min(10).max(2048);

/** Routes for the 'calendar' feature area: ICS URL subscription, personal calendar feed, holiday import. */
export default async function (app: FastifyInstance) {
  // ---- ICS URL subscription (own calendar only)
  app.get('/api/calendar/subscription', async (req) => tx(req, (db, a) => subscriptionState(db, a)));
  // Network I/O (DNS and the fetch) happens with no transaction open: a slow server must not hold a database connection or row lock.
  app.put('/api/calendar/subscription', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const u = await checkSubscriptionUrl(actorOf(req), z.object({ url }).parse(req.body).url);
    const plan = await tx(req, (db, a) => saveSubscription(db, a, u));
    const fetched = await fetchPlan(plan);
    return tx(req, (db, a) => finishManualSync(db, a, plan, fetched));
  });
  app.patch('/api/calendar/subscription', async (req) => tx(req, (db, a) => setSubscriptionStatus(db, a, z.object({ status: z.enum(['active', 'paused']) }).parse(req.body).status)));
  app.delete('/api/calendar/subscription', async (req) => tx(req, (db, a) => removeSubscription(db, a)));
  app.post('/api/calendar/subscription/sync', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const plan = await tx(req, (db, a) => planManualSync(db, a));
    const fetched = await fetchPlan(plan);
    return tx(req, (db, a) => finishManualSync(db, a, plan, fetched));
  });

  // ---- Personal calendar feed (token management needs a session; the feed itself is authenticated by its secret token)
  app.get('/api/calendar/feed', async (req) => tx(req, (db, a) => feedState(db, a)));
  app.post('/api/calendar/feed/rotate', async (req) => tx(req, (db, a) => rotateFeed(db, a)));
  app.delete('/api/calendar/feed', async (req) => tx(req, (db, a) => revokeFeed(db, a)));
  const feed = async (req: FastifyRequest, reply: FastifyReply) => {
    const { file } = z.object({ file: z.string().max(200) }).parse(req.params);
    const body = await serveFeed(file);
    if (body === null) return reply.status(404).header('cache-control', 'no-store').type('text/plain; charset=utf-8').send('Not found');
    return reply.header('cache-control', 'private, max-age=900').header('x-robots-tag', 'noindex')
      .header('content-disposition', 'inline; filename="work.ics"').type('text/calendar; charset=utf-8').send(body);
  };
  const feedOpts = { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } };
  app.get(`${FEED_PATH}/:file`, feedOpts, feed);
  // Spec path. Reachable without a session only once the core PUBLIC list in app.ts allows /api/calendar-feed/.
  app.get(`/api${FEED_PATH}/:file`, feedOpts, feed);

  // ---- Holiday import (system administrators): preview, then confirm
  app.post('/api/calendar/holidays/import/preview', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const src = await readHolidaySource(actorOf(req), z.discriminatedUnion('source', [
      z.object({ source: z.literal('file'), ics: z.string().min(10).max(5_000_000), fileName: z.string().max(200).optional() }),
      z.object({ source: z.literal('url'), url }),
    ]).parse(req.body));
    return tx(req, (db, a) => previewHolidayImport(db, a, src));
  });
  app.post('/api/calendar/holidays/import/:id/confirm', async (req) => tx(req, (db, a) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { dates } = z.object({ dates: z.array(date).max(1000).optional() }).parse(req.body);
    return confirmHolidayImport(db, a, id, dates);
  }));
  app.get('/api/calendar/holidays/imports', async (req) => tx(req, (db, a) => recentHolidayImports(db, a)));
}
