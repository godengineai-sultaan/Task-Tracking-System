import ical from 'node-ical';
import type { Db } from '../../lib/db.js';
import { many, one } from '../../lib/db.js';
import { audit } from '../../lib/audit.js';
import { decrypt, encrypt } from '../../lib/crypto.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { type Actor, has, requireStaff } from '../access.js';
import { createConnection, ingestIcs } from '../integrations.js';
import { notify } from '../notify.js';
import { localToday } from '../calendar.js';
import { type FetchDeps, FetchGuardError, type GuardedResult, assertPublicUrl, defaultDeps, guardedFetch } from './calendar-fetch.js';

/** Network seam: tests swap in a local fake resolver/request so no real network is used. */
let fetchDeps: FetchDeps = defaultDeps;
export function setCalendarFetchDeps(d: FetchDeps | null) { fetchDeps = d ?? defaultDeps; }

const userMessage = (e: any) => (e instanceof FetchGuardError ? e.message : e?.message ?? 'Unexpected error');

// ---------------------------------------------------------------- ICS URL subscription

/** Meetings from the last 7 days are offered after they end; events still in progress wait for the next sync. */
const SUBSCRIPTION_LOOKBACK_DAYS = 7;

async function ownConnection(db: Db, a: Actor) {
  return one(db, `select * from integration_connections where user_id = $1 and kind = 'ics_calendar' and status <> 'revoked' order by created_at limit 1`, [a.id]);
}

function present(s: any) {
  if (!s) return null;
  return { id: s.id, host: s.url_host, status: s.status, lastFetchAt: s.last_fetch_at, lastSuccessAt: s.last_success_at, lastStatus: s.last_status,
    lastError: s.last_error, lastResult: s.last_result, failures: s.consecutive_failures, createdAt: s.created_at };
}

export async function subscriptionState(db: Db, a: Actor) {
  requireStaff(a);
  const conn = await ownConnection(db, a);
  const sub = conn ? await one(db, `select * from calendar_subscriptions where connection_id = $1`, [conn.id]) : null;
  return { connectionId: conn?.id ?? null, connectionStatus: conn?.status ?? null, subscription: present(sub) };
}

/** The subscription shown to the user: the one on their current (not revoked) calendar connection. */
async function ownSubscription(db: Db, a: Actor) {
  requireStaff(a);
  const conn = await ownConnection(db, a);
  const s = conn ? await one(db, `select s.*, $2::text connection_status from calendar_subscriptions s where s.connection_id = $1`, [conn.id, conn.status]) : null;
  if (!s) throw notFound('No calendar subscription');
  return s;
}

/**
 * What a sync needs from the database before it goes to the network. Request handlers read the plan in one transaction, fetch with no
 * transaction open (a slow or hostile server must not hold a database connection or row lock), then apply the result in a second one.
 */
export interface SyncPlan { id: string; urlEnc: string; headers: Record<string, string> }
export type Fetched = { ok: GuardedResult } | { err: unknown };

function planFor(s: any): SyncPlan {
  const headers: Record<string, string> = {};
  // A 304 means the file is unchanged, not that no meeting has ended since: conditional requests are used only until the earliest
  // meeting that was still running or upcoming at the last full read has ended (and at most for PENDING_HORIZON_MS).
  const due = s.last_result?.nextDueAt;
  if (due && Date.parse(due) > Date.now()) {
    if (s.etag) headers['if-none-match'] = s.etag;
    if (s.last_modified) headers['if-modified-since'] = s.last_modified;
  }
  return { id: s.id, urlEnc: s.url_enc, headers };
}

/** Network step only: never touches the database and never throws. */
export async function fetchPlan(p: SyncPlan): Promise<Fetched> {
  try { return { ok: await guardedFetch(decrypt(p.urlEnc), { headers: p.headers, deps: fetchDeps }) }; } catch (err) { return { err }; }
}

/** Validate a new address (scheme, host and DNS) before any transaction is opened. */
export async function checkSubscriptionUrl(a: Actor, url: string) {
  requireStaff(a);
  try { return await assertPublicUrl(url, fetchDeps); } catch (e) { throw badRequest(userMessage(e)); }
}

export async function saveSubscription(db: Db, a: Actor, u: URL): Promise<SyncPlan> {
  requireStaff(a);
  const conn = (await ownConnection(db, a)) ?? (await createConnection(db, a, { kind: 'ics_calendar', name: 'My work calendar (ICS)' }));
  const sub = await one(db, `insert into calendar_subscriptions (tenant_id, user_id, connection_id, url_enc, url_host) values ($1,$2,$3,$4,$5)
    on conflict (connection_id) do update set url_enc = excluded.url_enc, url_host = excluded.url_host, status = 'active', etag = null, last_modified = null,
      last_status = null, last_error = null, last_result = '{}'::jsonb, consecutive_failures = 0, updated_at = now()
    returning *`, [a.tenantId, a.id, conn.id, encrypt(u.toString()), u.host]);
  // One subscription per person: an address left on an earlier, revoked connection is a stale credential.
  await db.query(`delete from calendar_subscriptions where user_id = $1 and id <> $2`, [a.id, sub.id]);
  // The address is a credential: only the host is ever logged or returned.
  await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'calendar.subscription.set', resourceType: 'calendar_subscription', resourceId: sub.id, details: { host: u.host } });
  return planFor(sub);
}

export async function setSubscriptionStatus(db: Db, a: Actor, status: 'active' | 'paused') {
  const s = await ownSubscription(db, a);
  await db.query(`update calendar_subscriptions set status = $2, updated_at = now() where id = $1`, [s.id, status]);
  await audit(db, { tenantId: a.tenantId, actorId: a.id, action: `calendar.subscription.${status === 'active' ? 'resume' : 'pause'}`, resourceType: 'calendar_subscription', resourceId: s.id });
  return subscriptionState(db, a);
}

/** Removes the stored address. Already-imported events and your decisions on suggestions are kept. */
export async function removeSubscription(db: Db, a: Actor) {
  const s = await ownSubscription(db, a);
  await db.query(`delete from calendar_subscriptions where id = $1`, [s.id]);
  await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'calendar.subscription.remove', resourceType: 'calendar_subscription', resourceId: s.id, details: { host: s.url_host } });
  return subscriptionState(db, a);
}

/** "Sync now", step 1 (in a transaction): checks, then the plan the caller fetches with no transaction open. */
export async function planManualSync(db: Db, a: Actor) {
  const s = await ownSubscription(db, a);
  if (s.status !== 'active') throw badRequest('The subscription is paused. Resume it to sync.');
  if (s.connection_status !== 'active' && s.connection_status !== 'error') throw badRequest('Your calendar connection is paused. Resume it to sync.');
  return planFor(s);
}

/** "Sync now", step 3 (in a new transaction): apply the fetched result. */
export async function finishManualSync(db: Db, a: Actor, plan: SyncPlan, fetched: Fetched) {
  requireStaff(a);
  await syncSubscription(db, plan.id, 'manual', { plan, fetched });
  return subscriptionState(db, a);
}

/** Upcoming meetings are looked at this far ahead; an unchanged calendar is still fully re-read at least this often. */
const PENDING_HORIZON_MS = 24 * 3600_000;

/**
 * Fetch one subscription (SSRF-guarded, conditional GET) and ingest new, already-ended events as confirm-first suggestions. Never throws on
 * fetch errors: they are recorded on the subscription. `pre` carries a result fetched outside the transaction (manual sync).
 */
export async function syncSubscription(db: Db, subscriptionId: string, trigger: 'manual' | 'schedule', pre?: { plan: SyncPlan; fetched: Fetched }) {
  const s = await one(db, `select s.*, c.status connection_status, u.status user_status from calendar_subscriptions s
    join integration_connections c on c.id = s.connection_id join users u on u.id = s.user_id
    where s.id = $1 for update of s skip locked`, [subscriptionId]);
  if (!s || s.status !== 'active' || ['paused', 'revoked'].includes(s.connection_status) || s.user_status !== 'active') return { skipped: true };
  if (pre && pre.plan.urlEnc !== s.url_enc) return { skipped: true }; // the address changed while this fetch was in flight
  const f = pre?.fetched ?? (await fetchPlan(planFor(s)));
  await db.query('savepoint calendar_sync');
  try {
    if ('err' in f) throw f.err;
    const r = f.ok;
    // Unchanged file: the meetings still pending are the same, so the next due full read stays the same.
    let result: { received: number; duplicates: number; unreadable?: number; notModified: boolean; nextDueAt: string | null } =
      { received: 0, duplicates: 0, notModified: true, nextDueAt: s.last_result?.nextDueAt ?? null };
    if (r.status === 'ok') {
      if (!r.text.includes('BEGIN:VCALENDAR')) throw new FetchGuardError('not_calendar', 'The address did not return a calendar (ICS) file');
      const now = Date.now();
      const ing = await ingestIcs(db, s.tenant_id, s.connection_id, r.text,
        { from: new Date(now - SUBSCRIPTION_LOOKBACK_DAYS * 86400000), to: new Date(now + PENDING_HORIZON_MS), endedBy: new Date(now) });
      result = { received: ing.received, duplicates: ing.duplicates, unreadable: ing.unreadable, notModified: false,
        nextDueAt: new Date(Math.min(ing.nextEnd?.getTime() ?? Infinity, now + PENDING_HORIZON_MS)).toISOString() };
    }
    await db.query('release savepoint calendar_sync');
    await db.query(`update calendar_subscriptions set last_fetch_at = now(), last_success_at = now(), last_status = $2, last_error = null, consecutive_failures = 0,
        last_result = $3, etag = coalesce($4, etag), last_modified = coalesce($5, last_modified), updated_at = now() where id = $1`,
      [s.id, r.status === 'ok' ? 'ok' : 'not_modified', result, r.status === 'ok' ? r.etag : null, r.status === 'ok' ? r.lastModified : null]);
    await db.query(`update integration_connections set last_sync_at = now(), last_error = null, status = case when status = 'error' then 'active' else status end where id = $1`, [s.connection_id]);
    if (trigger === 'manual' || result.received > 0)
      await audit(db, { tenantId: s.tenant_id, actorId: trigger === 'manual' ? s.user_id : null, action: 'calendar.subscription.sync', resourceType: 'calendar_subscription', resourceId: s.id,
        details: { trigger, received: result.received, duplicates: result.duplicates, notModified: result.notModified } });
    return result;
  } catch (e: any) {
    await db.query('rollback to savepoint calendar_sync');
    const msg = userMessage(e).slice(0, 500);
    const row = await one(db, `update calendar_subscriptions set last_fetch_at = now(), last_status = 'error', last_error = $2, consecutive_failures = consecutive_failures + 1,
        updated_at = now() where id = $1 returning consecutive_failures`, [s.id, msg]);
    if (row?.consecutive_failures === 3)
      await notify(db, s.tenant_id, s.user_id, 'calendar_sync', 'Calendar subscription is failing', `The last 3 syncs failed: ${msg}`, '/integrations');
    return { error: msg };
  }
}

/** Hourly: queue a sync for each active subscription of an active person not fetched in the last 50 minutes (failing ones back off to every 6 hours). */
export async function dueSubscriptions(db: Db) {
  return many(db, `select s.id from calendar_subscriptions s join integration_connections c on c.id = s.connection_id join users u on u.id = s.user_id
    where s.status = 'active' and c.status in ('active','error') and u.status = 'active'
      and (s.last_fetch_at is null or s.last_fetch_at < now() - interval '50 minutes')
      and (s.consecutive_failures < 3 or s.last_fetch_at < now() - interval '6 hours')`);
}

// ---------------------------------------------------------------- Holiday import

export interface HolidayItem { date: string; name: string; status: 'new' | 'exists'; existingName?: string; past: boolean }
const MAX_HOLIDAY_DAYS = 31, MAX_ITEMS = 1000;
const pad = (n: number) => String(n).padStart(2, '0');
const localKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Read all-day entries from an ICS file. Dates and names come only from the file; timed and over-long entries are skipped with a warning. */
export function parseHolidayIcs(text: string, now = new Date()) {
  let parsed: any;
  try { parsed = ical.sync.parseICS(text); } catch (e: any) { throw badRequest(`Could not read the calendar file: ${e.message}`); }
  // Date-only values are local-midnight Dates in node-ical: compare and format with local getters.
  const from = new Date(now.getFullYear() - 1, 0, 1), to = new Date(now.getFullYear() + 3, 11, 31);
  const byDate = new Map<string, string[]>();
  let timed = 0, outside = 0, tooLong = 0, cancelled = 0, unreadable = 0;
  for (const ev of Object.values(parsed) as any[]) {
    if (ev?.type !== 'VEVENT' || !ev.start) continue;
    if (String(ev.status ?? '').toUpperCase() === 'CANCELLED') { cancelled++; continue; }
    if (!(ev.datetype === 'date' || ev.start?.dateOnly)) { timed++; continue; }
    let instances: any[] = [];
    try { instances = ical.expandRecurringEvent(ev, { from, to }) as any[]; } catch { unreadable++; continue; }
    if (!instances.length) { outside++; continue; }
    for (const inst of instances) {
      const start = new Date(inst.start), end = new Date(inst.end ?? inst.start);
      const days: string[] = [];
      for (const d = new Date(start); d < end || days.length === 0; d.setDate(d.getDate() + 1)) {
        days.push(localKey(d));
        if (days.length > MAX_HOLIDAY_DAYS) break;
      }
      if (days.length > MAX_HOLIDAY_DAYS) { tooLong++; continue; }
      const raw = typeof inst.summary === 'object' ? inst.summary?.val : inst.summary ?? ev.summary;
      const name = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Holiday';
      for (const k of days) { const names = byDate.get(k) ?? []; if (!names.includes(name)) names.push(name); byDate.set(k, names); }
    }
  }
  const warnings: string[] = [];
  if (timed) warnings.push(`${timed} timed event(s) skipped: holidays are imported only from all-day entries.`);
  if (outside) warnings.push(`${outside} entr${outside === 1 ? 'y' : 'ies'} outside ${from.getFullYear()}–${to.getFullYear()} skipped.`);
  if (tooLong) warnings.push(`${tooLong} entr${tooLong === 1 ? 'y' : 'ies'} longer than ${MAX_HOLIDAY_DAYS} days skipped.`);
  if (cancelled) warnings.push(`${cancelled} cancelled entr${cancelled === 1 ? 'y' : 'ies'} skipped.`);
  if (unreadable) warnings.push(`${unreadable} entr${unreadable === 1 ? 'y' : 'ies'} with an unreadable repeat rule skipped.`);
  let items = [...byDate.entries()].sort(([x], [y]) => (x < y ? -1 : 1)).map(([date, names]) => ({ date, name: names.join(' / ').slice(0, 120) }));
  if (items.length > MAX_ITEMS) { warnings.push(`Only the first ${MAX_ITEMS} dates are shown.`); items = items.slice(0, MAX_ITEMS); }
  return { items, warnings };
}

function requireHolidayAdmin(a: Actor) { if (!has(a, 'system_admin')) throw forbidden('Only a system administrator can import holidays'); }

export interface HolidaySource { kind: 'file' | 'url'; label: string; text: string }

/** Read the uploaded text or fetch the https address. Called before any transaction is opened, so a slow server holds no database connection. */
export async function readHolidaySource(a: Actor, input: { source: 'file'; ics: string; fileName?: string } | { source: 'url'; url: string }): Promise<HolidaySource> {
  requireHolidayAdmin(a);
  if (input.source === 'file')
    return { kind: 'file', text: input.ics, label: (input.fileName ?? '').replace(/[^\w .()-]/g, '').trim().slice(0, 120) || 'Uploaded file' };
  let r;
  try { r = await guardedFetch(input.url, { deps: fetchDeps }); } catch (e) { throw badRequest(userMessage(e)); }
  if (r.status !== 'ok' || !r.text.includes('BEGIN:VCALENDAR')) throw badRequest('The address did not return a calendar (ICS) file');
  return { kind: 'url', text: r.text, label: new URL(input.url).host }; // the full address may be secret; keep only the host
}

export async function previewHolidayImport(db: Db, a: Actor, src: HolidaySource) {
  requireHolidayAdmin(a);
  const { text, label } = src;
  const { items, warnings } = parseHolidayIcs(text);
  const t = await one(db, `select timezone from tenants where id = $1`, [a.tenantId]);
  const today = localToday(t.timezone);
  const existing = new Map((await many(db, `select date, name from holidays where date = any($1::date[])`, [items.map((i) => i.date)])).map((h) => [h.date, h.name]));
  const full: HolidayItem[] = items.map((i) => ({ ...i, status: existing.has(i.date) ? 'exists' : 'new', ...(existing.has(i.date) ? { existingName: existing.get(i.date) } : {}), past: i.date < today }));
  const row = await one(db, `insert into holiday_imports (tenant_id, source_kind, source_label, items, warnings, created_by) values ($1,$2,$3,$4,$5,$6) returning id, created_at`,
    [a.tenantId, src.kind, label, JSON.stringify(full), JSON.stringify(warnings), a.id]);
  return { id: row.id, sourceLabel: label, items: full, warnings, counts: { total: full.length, new: full.filter((i) => i.status === 'new').length, existing: full.filter((i) => i.status === 'exists').length } };
}

/** Import selected dates from a stored preview. Idempotent: a confirmed preview returns its original result; existing dates are never overwritten. */
export async function confirmHolidayImport(db: Db, a: Actor, id: string, dates?: string[]) {
  requireHolidayAdmin(a);
  const imp = await one(db, `select *, created_at < now() - interval '24 hours' expired from holiday_imports where id = $1 for update`, [id]);
  if (!imp) throw notFound('Import preview not found');
  if (imp.status === 'imported') return { imported: imp.imported_count, skipped: imp.skipped_count, alreadyConfirmed: true };
  if (imp.expired) throw badRequest('This preview has expired. Preview the file again.');
  const items: HolidayItem[] = imp.items;
  const known = new Set(items.map((i) => i.date));
  if (dates?.some((d) => !known.has(d))) throw badRequest('Only dates read from the previewed file can be imported');
  const chosen = dates ? new Set(dates) : new Set(items.filter((i) => i.status === 'new').map((i) => i.date));
  let imported = 0, skipped = 0;
  const importedDates: string[] = [];
  for (const i of items) {
    if (!chosen.has(i.date)) continue;
    const r = await one(db, `insert into holidays (tenant_id, date, name) values ($1,$2,$3) on conflict (tenant_id, date) do nothing returning id`, [a.tenantId, i.date, i.name]);
    if (r) { imported++; importedDates.push(i.date); } else skipped++;
  }
  await db.query(`update holiday_imports set status = 'imported', imported_count = $2, skipped_count = $3, confirmed_by = $4, confirmed_at = now() where id = $1`, [id, imported, skipped, a.id]);
  await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'holiday.import', resourceType: 'holiday_import', resourceId: id,
    details: { source: imp.source_kind, label: imp.source_label, imported, skipped, dates: importedDates } });
  return { imported, skipped, alreadyConfirmed: false };
}

export async function recentHolidayImports(db: Db, a: Actor) {
  requireHolidayAdmin(a);
  return many(db, `select i.id, i.source_kind, i.source_label, i.imported_count, i.skipped_count, i.confirmed_at, u.name confirmed_by_name
    from holiday_imports i left join users u on u.id = i.confirmed_by where i.status = 'imported' order by i.confirmed_at desc limit 10`);
}
