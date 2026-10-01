import type { FastifyInstance } from 'fastify';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { tx } from '../app.js';
import { many, one } from '../lib/db.js';
import { forbidden, notFound } from '../lib/errors.js';
import { readStored } from '../lib/storage.js';
import { assertCanViewPerson, has, requireStaff, reviewableUserIds } from '../services/access.js';
import { buildReport } from '../services/analytics.js';
import { localToday } from '../services/calendar.js';
import { leadershipDelivery, reviewAction, routineTable, teamCapacity, timeline } from '../services/oversight.js';
import { requestExport } from '../services/exports.js';

const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export function periodFor(kind: 'day' | 'week' | 'month' | 'custom', anchor: string, start?: string, end?: string) {
  const d = DateTime.fromISO(anchor);
  if (kind === 'day') return { start: anchor, end: anchor };
  if (kind === 'week') return { start: d.startOf('week').toISODate()!, end: d.endOf('week').toISODate()! };
  if (kind === 'month') return { start: d.startOf('month').toISODate()!, end: d.endOf('month').toISODate()! };
  if (!start || !end) throw new Error('custom period needs start and end');
  return { start, end };
}

export async function reportRoutes(app: FastifyInstance) {
  app.get('/api/reports/individual', async (req) => tx(req, async (db, a) => {
    requireStaff(a);
    const q = z.object({ userId: uuid.optional(), kind: z.enum(['day', 'week', 'month', 'custom']).default('day'), date: date.optional(), start: date.optional(), end: date.optional() }).parse(req.query);
    const uid = q.userId ?? a.id;
    await assertCanViewPerson(db, a, uid);
    const p = periodFor(q.kind, q.date ?? localToday(a.timezone), q.start, q.end);
    if (DateTime.fromISO(p.end).diff(DateTime.fromISO(p.start), 'days').days > 366) throw forbidden('Periods are limited to one year');
    const report = await buildReport(db, uid, q.kind, p.start, p.end);
    const versions = await many(db, `select id, version, status, reason, generated_at, definitions_version from report_versions
      where user_id = $1 and period_kind = $2 and period_start = $3 and period_end = $4 order by version desc`, [uid, q.kind, p.start, p.end]);
    return { ...report, versions };
  }));
  app.get('/api/reports/versions/:id', async (req) => tx(req, async (db, a) => {
    const v = await one(db, `select * from report_versions where id = $1`, [(req.params as any).id]);
    if (!v) throw notFound();
    await assertCanViewPerson(db, a, v.user_id);
    return v;
  }));

  app.get('/api/admin/routine', async (req) => tx(req, async (db, a) => {
    const q = z.object({ date: date.optional(), departmentId: uuid.optional(), projectId: uuid.optional(), userId: uuid.optional(), status: z.string().optional() }).parse(req.query);
    return routineTable(db, a, { ...q, date: q.date ?? localToday(a.timezone) });
  }));
  app.get('/api/admin/routine/:userId', async (req) => tx(req, async (db, a) => {
    const q = z.object({ date: date.optional() }).parse(req.query);
    return timeline(db, a, (req.params as any).userId, q.date ?? localToday(a.timezone));
  }));
  app.post('/api/manager-reviews', async (req) => tx(req, async (db, a) => {
    const b = z.object({
      subjectUserId: uuid, date, action: z.enum(['acknowledge', 'note', 'clarification_request', 'clarification_response', 'follow_up', 'blocker_help', 'reassign']),
      note: z.string().max(3000).optional(), taskId: uuid.optional(), blockerId: uuid.optional(), newOwnerId: uuid.optional(), parentId: uuid.optional(),
      followUp: z.object({ title: z.string().min(1).max(300), dueDate: date.optional(), ownerId: uuid.optional() }).optional(),
    }).parse(req.body);
    return reviewAction(db, a, b);
  }));
  app.get('/api/people', async (req) => tx(req, async (db, a) => {
    const ids = await reviewableUserIds(db, a);
    return many(db, `select u.id, u.name, u.title, u.is_founder, d.name department from users u left join departments d on d.id = u.department_id
      where u.id = any($1::uuid[]) order by u.id = $2 desc, u.name`, [ids, a.id]);
  }));

  app.get('/api/team/capacity', async (req) => tx(req, async (db, a) => {
    const q = z.object({ start: date.optional(), days: z.coerce.number().int().min(5).max(30).default(10) }).parse(req.query);
    return teamCapacity(db, a, q.start ?? localToday(a.timezone), q.days);
  }));
  app.get('/api/leadership/delivery', async (req) => tx(req, (db, a) => leadershipDelivery(db, a)));

  app.post('/api/exports', async (req) => tx(req, async (db, a) => {
    const b = z.object({ format: z.enum(['pdf', 'csv']), report: z.string().regex(/^[a-z_]{2,40}$/),
      params: z.object({ userId: uuid.optional(), kind: z.enum(['day', 'week', 'month', 'custom']).optional(), start: date.optional(), end: date.optional(),
        date: date.optional(), departmentId: uuid.optional(), projectId: uuid.optional() }).catchall(z.union([z.string().max(200), z.number(), z.boolean()])) }).parse(req.body);
    return requestExport(db, a, b.format, b.report, b.params);
  }));
  app.get('/api/exports', async (req) => tx(req, (db, a) => many(db, `select e.*, f.filename, f.size_bytes from exports e left join stored_files f on f.id = e.file_id
    where e.requested_by = $1 order by e.created_at desc limit 30`, [a.id])));
  app.get('/api/exports/:id', async (req) => tx(req, async (db, a) => {
    const e = await one(db, `select e.*, f.filename, f.size_bytes from exports e left join stored_files f on f.id = e.file_id where e.id = $1 and e.requested_by = $2`, [(req.params as any).id, a.id]);
    if (!e) throw notFound();
    return e;
  }));
  app.get('/api/exports/:id/file', async (req, reply) => {
    const out = await tx(req, async (db, a) => {
      const e = await one(db, `select * from exports where id = $1 and requested_by = $2 and status = 'ready'`, [(req.params as any).id, a.id]);
      if (!e) throw notFound('Export not ready');
      const f = await one(db, `select * from stored_files where id = $1`, [e.file_id]);
      return { f, data: await readStored(f) };
    });
    reply.header('content-type', out.f.mime).header('content-disposition', `attachment; filename="${out.f.filename}"`);
    return reply.send(out.data);
  });
  void has;
}
