import type { SeedCtx } from './types.js';
import { encrypt, newToken, sha256 } from '../../lib/crypto.js';

/** Fictional DEMO fixtures for the 'calendar' feature area. */
export default async function seed(ctx: SeedCtx) {
  const { q1, ins, U, today } = ctx;
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60000);

  // Rahul subscribes to his work calendar by its (fictional, non-resolving) secret iCal address.
  const conn = await q1(`select id from integration_connections where user_id = $1 and kind = 'ics_calendar' order by created_at limit 1`, [U.rahul]);
  if (conn) await ctx.q(`update integration_connections set last_sync_at = $2 where id = $1`, [conn.id, minutesAgo(35)]);
  if (conn) await ins('calendar_subscriptions', { user_id: U.rahul, connection_id: conn.id, url_enc: encrypt('https://calendar.northwind.example/ical/rahul-demo-7f3k/basic.ics'),
    url_host: 'calendar.northwind.example', status: 'active', last_fetch_at: minutesAgo(35), last_success_at: minutesAgo(35), last_status: 'ok',
    last_result: { received: 1, duplicates: 6, notModified: false }, created_at: today.minus({ days: 9 }).set({ hour: 10 }).toJSDate() });

  // Priya publishes her personal feed to her phone calendar (only a hash of the random token is stored; nobody knows it).
  await ins('calendar_feed_tokens', { user_id: U.priya, token_hash: sha256(newToken(32)), created_by: U.priya,
    created_at: today.minus({ days: 12 }).set({ hour: 9, minute: 20 }).toJSDate(), last_used_at: minutesAgo(80) });

  // Asha imported the organization holiday file that produced the seeded holidays.
  await ins('holiday_imports', { source_kind: 'file', source_label: 'northwind-holidays-2026.ics', status: 'imported', imported_count: 2, skipped_count: 0,
    items: JSON.stringify([{ date: '2026-10-02', name: 'Gandhi Jayanti', status: 'new', past: false }, { date: '2026-11-09', name: 'Diwali (observed)', status: 'new', past: false }]),
    warnings: '[]', created_by: U.asha, created_at: today.minus({ days: 20 }).set({ hour: 11 }).toJSDate(), confirmed_by: U.asha,
    confirmed_at: today.minus({ days: 20 }).set({ hour: 11, minute: 2 }).toJSDate() });
}
