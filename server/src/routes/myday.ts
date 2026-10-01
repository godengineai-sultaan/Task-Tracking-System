import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tx } from '../app.js';
import { many, one } from '../lib/db.js';
import { badRequest } from '../lib/errors.js';
import { assertCanViewPerson, requireStaff } from '../services/access.js';
import { addManualEntry, correctEntry, deleteEntry, getMyDay, getRecap, saveRecap, setPlan, startTimer, stopTimer } from '../services/myday.js';
import { localToday } from '../services/calendar.js';
import { draftRecap, draftTask, recordDecision } from '../services/ai.js';

const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const iso = z.string().datetime({ offset: true });
const category = z.enum(['task', 'meeting', 'admin', 'learning', 'other']);

export async function myDayRoutes(app: FastifyInstance) {
  app.get('/api/my-day', async (req) => tx(req, (db, a) => getMyDay(db, a, z.object({ date: date.optional() }).parse(req.query).date)));

  app.put('/api/my-day/plan', async (req) => tx(req, async (db, a) => {
    const b = z.object({ date: date.optional(), taskIds: z.array(uuid).max(3), reason: z.string().max(500).optional(), focusNote: z.string().max(500).optional(),
      elapsedMs: z.number().int().min(0).max(3600000).optional() }).parse(req.body);
    const d = b.date ?? localToday(a.timezone);
    if (d < localToday(a.timezone)) throw badRequest('Past plans cannot be changed — add context in that day\'s recap instead');
    await setPlan(db, a, d, b.taskIds, b.reason, b.focusNote);
    if (b.elapsedMs) await db.query(`insert into ux_timings (tenant_id, user_id, flow, duration_ms, date) values ($1,$2,'plan',$3,$4)`, [a.tenantId, a.id, b.elapsedMs, d]);
    return getMyDay(db, a, d);
  }));

  app.post('/api/timer/start', async (req) => tx(req, async (db, a) => {
    const b = z.object({ taskId: uuid.nullable().optional(), category: category.default('task') }).parse(req.body);
    if (!b.taskId && b.category === 'task') throw badRequest('Pick a task or a category (meeting, admin, learning, other)');
    return startTimer(db, a, b.taskId ?? null, b.category);
  }));
  app.post('/api/timer/stop', async (req) => tx(req, (db, a) => stopTimer(db, a)));

  app.get('/api/time-entries', async (req) => tx(req, async (db, a) => {
    const q = z.object({ from: iso, to: iso, userId: uuid.optional() }).parse(req.query);
    const uid = q.userId ?? a.id;
    await assertCanViewPerson(db, a, uid);
    return many(db, `select te.*, t.title task_title, (select count(*) from time_entry_revisions r where r.time_entry_id = te.id)::int revisions
      from time_entries te left join tasks t on t.id = te.task_id where te.user_id = $1 and te.deleted_at is null and te.started_at < $3 and coalesce(te.ended_at, now()) > $2
      order by te.started_at`, [uid, q.from, q.to]);
  }));
  app.post('/api/time-entries', async (req) => tx(req, async (db, a) => {
    const b = z.object({ taskId: uuid.nullable().optional(), category: category.default('task'), startedAt: iso, endedAt: iso, note: z.string().max(500).optional() }).parse(req.body);
    if (!b.taskId && b.category === 'task') throw badRequest('Pick a task or a non-task category');
    return addManualEntry(db, a, b);
  }));
  app.patch('/api/time-entries/:id', async (req) => tx(req, async (db, a) => {
    const b = z.object({ taskId: uuid.nullable().optional(), category: category.optional(), startedAt: iso.optional(), endedAt: iso.optional(), note: z.string().max(500).optional(),
      version: z.number().int(), reason: z.string().min(1).max(500) }).parse(req.body);
    return correctEntry(db, a, (req.params as any).id, b);
  }));
  app.delete('/api/time-entries/:id', async (req) => tx(req, async (db, a) => {
    const { reason } = z.object({ reason: z.string().min(1).max(500) }).parse(req.body ?? {});
    await deleteEntry(db, a, (req.params as any).id, reason);
    return { ok: true };
  }));
  app.get('/api/time-entries/:id/revisions', async (req) => tx(req, async (db, a) => {
    const te = await one(db, `select user_id from time_entries where id = $1`, [(req.params as any).id]);
    if (!te) throw badRequest('Not found');
    await assertCanViewPerson(db, a, te.user_id);
    return many(db, `select r.*, u.name actor_name from time_entry_revisions r left join users u on u.id = r.actor_id where r.time_entry_id = $1 order by r.at`, [(req.params as any).id]);
  }));

  app.get('/api/recap', async (req) => tx(req, async (db, a) => {
    requireStaff(a);
    const q = z.object({ date: date.optional(), userId: uuid.optional() }).parse(req.query);
    const uid = q.userId ?? a.id;
    await assertCanViewPerson(db, a, uid);
    return getRecap(db, a, uid, q.date ?? localToday(a.timezone));
  }));
  const recapSchema = z.object({ date, summary: z.string().max(5000).default(''), blockersNote: z.string().max(3000).optional(), nextSteps: z.string().max(3000).optional(),
    contextNote: z.string().max(3000).optional(), dayType: z.enum(['work', 'no_work', 'non_working']).optional(), changeReason: z.string().max(500).optional(),
    overheadMs: z.number().int().min(0).max(3600000).optional() });
  app.put('/api/recap', async (req) => tx(req, (db, a) => saveRecap(db, a, recapSchema.parse(req.body), false)));
  app.post('/api/recap/confirm', async (req) => tx(req, (db, a) => saveRecap(db, a, recapSchema.parse(req.body), true)));

  app.post('/api/ux-timing', async (req) => tx(req, async (db, a) => {
    const b = z.object({ flow: z.enum(['plan', 'recap', 'quick_capture', 'status_update', 'timer']), durationMs: z.number().int().min(0).max(3600000) }).parse(req.body);
    await db.query(`insert into ux_timings (tenant_id, user_id, flow, duration_ms, date) values ($1,$2,$3,$4,$5)`, [a.tenantId, a.id, b.flow, b.durationMs, localToday(a.timezone)]);
    return { ok: true };
  }));

  app.get('/api/suggestions', async (req) => tx(req, (db, a) => many(db, `select * from suggestions where user_id = $1 and status = 'open' order by created_at desc`, [a.id])));

  // Optional AI drafts (proposals only)
  app.post('/api/ai/task-draft', async (req) => tx(req, (db, a) => draftTask(db, a, z.object({ note: z.string() }).parse(req.body).note, localToday(a.timezone))));
  app.post('/api/ai/recap-draft', async (req) => tx(req, (db, a) => draftRecap(db, a, z.object({ date }).parse(req.body).date)));
  app.post('/api/ai/runs/:id/decision', async (req) => tx(req, async (db, a) => {
    await recordDecision(db, a, (req.params as any).id, z.object({ decision: z.enum(['accepted', 'edited', 'rejected']) }).parse(req.body).decision);
    return { ok: true };
  }));
}
