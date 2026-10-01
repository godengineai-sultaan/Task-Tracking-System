import { DateTime } from 'luxon';
import type { Db } from '../../lib/db.js';
import { many, one, withSystem, withTenant } from '../../lib/db.js';
import { audit } from '../../lib/audit.js';
import { config } from '../../lib/config.js';
import { newToken, sha256 } from '../../lib/crypto.js';
import { type Actor, requireStaff } from '../access.js';
import { localToday } from '../calendar.js';

/**
 * Personal read-only calendar feed: the user's own open task due dates (title + link), today's intended outcomes and their leave.
 * Never other people's data, never task descriptions. The token is `<tenant id>.<secret>`; only sha256(secret) is stored.
 */
export const FEED_PATH = '/calendar-feed';
const apiOrigin = () => config.publicUrl.replace(/:\d+$/, ':' + config.port);
const appOrigin = () => config.publicUrl.replace(/\/$/, '');

export async function feedState(db: Db, a: Actor) {
  requireStaff(a);
  const t = await one(db, `select created_at, last_used_at from calendar_feed_tokens where user_id = $1 and revoked_at is null`, [a.id]);
  return { active: !!t, createdAt: t?.created_at ?? null, lastUsedAt: t?.last_used_at ?? null };
}

/** Create a feed address, replacing (and immediately invalidating) any existing one. The address is returned once. */
export async function rotateFeed(db: Db, a: Actor) {
  requireStaff(a);
  const old = await many(db, `update calendar_feed_tokens set revoked_at = now() where user_id = $1 and revoked_at is null returning id`, [a.id]);
  const secret = newToken(32);
  const row = await one(db, `insert into calendar_feed_tokens (tenant_id, user_id, token_hash, created_by) values ($1,$2,$3,$2) returning id, created_at`, [a.tenantId, a.id, sha256(secret)]);
  await audit(db, { tenantId: a.tenantId, actorId: a.id, action: old.length ? 'calendar.feed.rotate' : 'calendar.feed.create', resourceType: 'calendar_feed_token', resourceId: row.id,
    details: { revoked: old.length } });
  return { url: `${apiOrigin()}${FEED_PATH}/${a.tenantId}.${secret}.ics`, createdAt: row.created_at };
}

export async function revokeFeed(db: Db, a: Actor) {
  requireStaff(a);
  const old = await many(db, `update calendar_feed_tokens set revoked_at = now() where user_id = $1 and revoked_at is null returning id`, [a.id]);
  for (const o of old) await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'calendar.feed.revoke', resourceType: 'calendar_feed_token', resourceId: o.id });
  return { active: false, createdAt: null, lastUsedAt: null };
}

const FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{32,64})\.ics$/;

/** Resolve a feed file name to its ICS body, or null for anything unknown, revoked or inactive (callers answer 404 without detail). */
export async function serveFeed(file: string): Promise<string | null> {
  const m = FILE.exec(file);
  if (!m) return null;
  const t = await withSystem((db) => one(db, `select id from tenants where id = $1 and status = 'active'`, [m[1]]));
  if (!t) return null;
  return withTenant(t.id, async (db) => {
    const tok = await one(db, `select k.id, k.user_id from calendar_feed_tokens k join users u on u.id = k.user_id
      where k.token_hash = $1 and k.revoked_at is null and u.status = 'active' and not ('customer' = any(u.roles))`, [sha256(m[2])]);
    if (!tok) return null;
    await db.query(`update calendar_feed_tokens set last_used_at = now() where id = $1 and (last_used_at is null or last_used_at < now() - interval '5 minutes')`, [tok.id]);
    return buildFeed(db, tok.user_id);
  });
}

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
/** RFC 5545 line folding at 75 octets. */
function fold(line: string) {
  const out: string[] = []; let cur = '', bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > (out.length ? 74 : 75)) { out.push(cur); cur = ''; bytes = 0; }
    cur += ch; bytes += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}
const ymd = (d: string) => d.replace(/-/g, '');
const nextDay = (d: string) => DateTime.fromISO(d).plus({ days: 1 }).toISODate()!;

const LEAVE_LABEL: Record<string, string> = { leave: 'Leave', sick: 'Leave', training: 'Training', other: 'Out of office' };
const PORTION: Record<string, string> = { half_am: ' (morning)', half_pm: ' (afternoon)' };

export async function buildFeed(db: Db, userId: string) {
  const u = await one(db, `select coalesce(u.timezone, t.timezone) tz from users u join tenants t on t.id = u.tenant_id where u.id = $1`, [userId]);
  const today = localToday(u?.tz || 'UTC');
  const due = await many(db, `select id, title, due_date from tasks where owner_id = $1 and due_date is not null and status not in ('done','cancelled')
    and due_date between $2::date - 30 and $2::date + 365 order by due_date, id limit 500`, [userId, today]);
  const outcomes = await many(db, `select i.id, i.position, t.id task_id, t.title from daily_plans p
    join daily_plan_items i on i.plan_id = p.id and i.removed_at is null join tasks t on t.id = i.task_id
    where p.user_id = $1 and p.date = $2 order by i.position`, [userId, today]);
  const leave = await many(db, `select id, start_date, end_date, portion, kind from leave_entries where user_id = $1
    and end_date >= $2::date - 30 and start_date <= $2::date + 365 order by start_date`, [userId, today]);

  const stamp = DateTime.utc().toFormat("yyyyMMdd'T'HHmmss'Z'");
  const link = (taskId: string) => `${appOrigin()}/tasks/${taskId}`;
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Task Tracking and Productivity//Personal feed//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:My work: due dates\\, outcomes and leave', 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H'];
  const event = (uid: string, start: string, endExclusive: string, summary: string, opts: { url?: string; busy?: boolean } = {}) => {
    lines.push('BEGIN:VEVENT', `UID:${uid}@task-tracking`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${ymd(start)}`, `DTEND;VALUE=DATE:${ymd(endExclusive)}`,
      `SUMMARY:${esc(summary)}`, `TRANSP:${opts.busy ? 'OPAQUE' : 'TRANSPARENT'}`);
    if (opts.url) lines.push(`URL:${opts.url}`, `DESCRIPTION:${esc(opts.url)}`);
    lines.push('END:VEVENT');
  };
  for (const t of due) event(`task-due-${t.id}`, t.due_date, nextDay(t.due_date), `Due: ${t.title}`, { url: link(t.id) });
  for (const o of outcomes) event(`outcome-${o.id}`, today, nextDay(today), `Today's outcome ${o.position}: ${o.title}`, { url: link(o.task_id) });
  for (const l of leave) event(`leave-${l.id}`, l.start_date, nextDay(l.end_date), `${LEAVE_LABEL[l.kind] ?? 'Leave'}${PORTION[l.portion] ?? ''}`, { busy: true });
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
