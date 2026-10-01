import ical from 'node-ical';
import type { Db } from '../lib/db.js';
import { many, one } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { decrypt, encrypt, hmacHex, newToken, safeEqualHex } from '../lib/crypto.js';
import { enqueue } from '../lib/jobs.js';
import { type Actor, has } from './access.js';
import { createTask } from './tasks.js';
import { notify } from './notify.js';

export const CONNECTION_KINDS = ['ics_calendar', 'issues', 'helpdesk', 'code', 'module_approvals', 'module_documents', 'module_kyc', 'module_vault'] as const;
const PERSONAL_KINDS = new Set(['ics_calendar']);
export const SCHEMA_VERSION = '1.0';

/** Keys that must never appear in any inbound payload (vault, offboarding and every other module). */
const FORBIDDEN_KEY = /(pass(word)?|secret|token|api[_-]?key|private[_-]?key|credential[_-]?value|otp|pin|cvv|ssn|aadhaar|pan[_-]?number|passport[_-]?number|salary|compensation)/i;
const SECRET_VALUE = /(-----BEGIN [A-Z ]*PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\bghp_[A-Za-z0-9]{30,}\b|\bsk-[A-Za-z0-9-_]{20,}\b|\bxox[bap]-[A-Za-z0-9-]{10,})/;
export function scanForSecrets(v: unknown, path = 'payload'): string | null {
  if (typeof v === 'string') return SECRET_VALUE.test(v) ? `${path} looks like a secret value` : null;
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) { const r = scanForSecrets(v[i], `${path}[${i}]`); if (r) return r; } return null; }
  if (v && typeof v === 'object') {
    for (const [k, val] of Object.entries(v)) {
      if (FORBIDDEN_KEY.test(k) && !/(_ref|_reference|_id)$/i.test(k)) return `${path}.${k} is a forbidden field (metadata-only contract)`;
      const r = scanForSecrets(val, `${path}.${k}`); if (r) return r;
    }
  }
  return null;
}

export async function createConnection(db: Db, a: Actor, input: { kind: string; name: string; settings?: object }) {
  if (!CONNECTION_KINDS.includes(input.kind as any)) throw badRequest('Unknown integration kind');
  const personal = PERSONAL_KINDS.has(input.kind);
  if (!personal && !has(a, 'system_admin')) throw forbidden('Only a system administrator can add organization integrations');
  const secret = personal ? null : newToken(32);
  const row = await one(db, `insert into integration_connections (tenant_id, user_id, kind, name, secret_enc, settings, created_by)
    values ($1,$2,$3,$4,$5,$6,$7) returning id, kind, name, status, settings, created_at`,
    [a.tenantId, personal ? a.id : null, input.kind, input.name, secret ? encrypt(secret) : null, input.settings ?? {}, a.id]);
  await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'integration.create', resourceType: 'integration_connection', resourceId: row.id, details: { kind: input.kind } });
  // Secret is shown once, at creation. It is stored encrypted and never returned again.
  return { ...row, secret };
}

export interface Envelope {
  event_id: string; event_type: string; schema_version: string; tenant_id: string; entity_id?: string; resource_id?: string;
  resource_version?: string | number; occurred_at?: string; actor_reference?: string; correlation_id?: string; payload?: any;
}

/** Verify a signed inbound delivery and store it (deduplicated). Processing happens in a durable job. */
export async function receiveInbound(db: Db, tenantId: string, connectionId: string, rawBody: string, signature: string | undefined, timestamp: string | undefined) {
  const conn = await one(db, `select * from integration_connections where id = $1`, [connectionId]);
  if (!conn || !conn.secret_enc) throw notFound('Unknown connection');
  if (conn.status !== 'active') throw forbidden('Connection is not active');
  const ts = Number(timestamp);
  if (!ts || Math.abs(Date.now() / 1000 - ts) > 300) throw forbidden('Missing or stale timestamp');
  const expected = hmacHex(decrypt(conn.secret_enc), `${ts}.${rawBody}`);
  if (!signature || !safeEqualHex(signature.replace(/^sha256=/, ''), expected)) throw forbidden('Invalid signature');
  let env: Envelope;
  try { env = JSON.parse(rawBody); } catch { throw badRequest('Body must be JSON'); }
  for (const k of ['event_id', 'event_type', 'schema_version', 'tenant_id'] as const) if (!env[k]) throw badRequest(`Missing ${k}`);
  if (env.tenant_id !== tenantId) throw forbidden('tenant_id does not match this connection');
  if (String(env.schema_version).split('.')[0] !== SCHEMA_VERSION.split('.')[0]) throw badRequest(`Unsupported schema_version ${env.schema_version}`);
  const leak = scanForSecrets(env.payload ?? {});
  const row = await one(db, `insert into integration_events (tenant_id, connection_id, event_id, event_type, schema_version, entity_id, resource_id, resource_version,
      occurred_at, actor_reference, correlation_id, payload, status, result)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) on conflict (connection_id, event_id) do nothing returning id`,
    [tenantId, connectionId, env.event_id, env.event_type, env.schema_version, env.entity_id ?? null, env.resource_id ?? null,
     env.resource_version != null ? String(env.resource_version) : null, env.occurred_at ?? null, env.actor_reference ?? null, env.correlation_id ?? null,
     leak ? { redacted: true } : minimize(env.payload ?? {}), leak ? 'rejected' : 'received', leak ? `Rejected: ${leak}. Payload was not stored.` : null]);
  await db.query(`update integration_connections set last_sync_at = now(), last_error = $2 where id = $1`, [connectionId, leak ? `Rejected event ${env.event_id}: ${leak}` : null]);
  if (!row) return { status: 'duplicate' as const };
  if (leak) {
    await audit(db, { tenantId, actorId: null, action: 'integration.event.rejected', resourceType: 'integration_event', resourceId: row.id, reason: leak, outcome: 'rejected' });
    return { status: 'rejected' as const, reason: leak };
  }
  await enqueue(db, { tenantId, kind: 'integration.process', payload: { eventId: row.id }, idempotencyKey: `integration.process:${row.id}` });
  return { status: 'accepted' as const, id: row.id };
}

function minimize(p: any) {
  // Keep only scalar metadata and short arrays; drop large bodies.
  const out: any = {};
  for (const [k, v] of Object.entries(p ?? {})) {
    if (typeof v === 'string') out[k] = v.slice(0, 500);
    else if (typeof v === 'number' || typeof v === 'boolean' || v === null) out[k] = v;
    else if (Array.isArray(v)) out[k] = v.slice(0, 20).map((x) => (typeof x === 'string' ? x.slice(0, 300) : x));
  }
  return out;
}

async function userByEmail(db: Db, email?: string) {
  if (!email) return null;
  return one(db, `select id, name from users where lower(email) = lower($1) and status = 'active' and not ('customer' = any(roles))`, [email]);
}

/** Durable job: turn a stored event into a task, follow-up, restricted reference or suggestion. Idempotent. */
export async function processEvent(db: Db, eventId: string) {
  const ev = await one(db, `select e.*, c.kind connection_kind, c.user_id connection_user_id from integration_events e
    join integration_connections c on c.id = e.connection_id where e.id = $1`, [eventId]);
  if (!ev || ev.status !== 'received') return;
  const p = ev.payload;
  const tenantId = ev.tenant_id;
  const done = async (status: string, result: string) =>
    db.query(`update integration_events set status = $2, result = $3 where id = $1`, [eventId, status, result]);
  const keyBase = `${ev.connection_id}:${ev.resource_id ?? p.external_id ?? ev.event_id}`;

  switch (ev.connection_kind) {
    case 'module_approvals': {
      if (ev.event_type !== 'approval.approved') return done('ignored', `Event type ${ev.event_type} does not create work`);
      const owner = await userByEmail(db, p.owner_email);
      if (!owner) return done('ignored', `No active staff member for owner ${p.owner_email ?? '(missing)'}`);
      const r = await createTask(db, null, tenantId, {
        title: p.title || `Execute approved ${p.kind ?? 'request'} ${p.request_ref ?? ''}`.trim(), ownerId: owner.id, dueDate: p.due_date ?? null,
        category: p.kind === 'payment' || p.kind === 'purchase' ? 'finance' : 'operations', sourceType: 'approval', requiresEvidence: true,
        acceptanceCriteria: (p.completion_conditions ?? []).join('\n'), checklist: p.completion_conditions ?? [],
        sourceRef: { module: 'approvals', request_ref: p.request_ref, approved_scope_ref: p.approved_scope_ref, resource_version: ev.resource_version },
        externalKey: `approval:${keyBase}`,
      }, { authority: 'approved_request', correlationId: ev.correlation_id });
      return done('applied', r.created ? `Created task ${r.task.id}` : `Already delivered — existing task ${r.task.id} kept (no duplicate)`);
    }
    case 'module_documents': {
      if (ev.event_type !== 'document.finalized') return done('ignored', `Event type ${ev.event_type} not handled`);
      const task = p.related_request_ref
        ? await one(db, `select * from tasks where source_ref->>'request_ref' = $1 order by created_at limit 1`, [p.related_request_ref])
        : null;
      if (!task) return done('ignored', `No task linked to request ${p.related_request_ref ?? '(none)'}`);
      const exists = await one(db, `select id from evidence_links where task_id = $1 and source_module = 'documents' and source_reference = $2`, [task.id, p.document_ref]);
      if (exists) return done('applied', 'Reference already attached');
      await db.query(`insert into evidence_links (tenant_id, task_id, kind, label, source_module, source_reference, restricted, allowed_user_ids)
        values ($1,$2,'source_ref',$3,'documents',$4,true,$5)`,
        [tenantId, task.id, `${p.kind ?? 'Document'} (final, confidential)`, p.document_ref, [task.owner_id]]);
      return done('applied', `Restricted document reference attached to task ${task.id}`);
    }
    case 'module_kyc': {
      if (ev.event_type !== 'kyc.document_missing') return done('ignored', `Event type ${ev.event_type} not handled`);
      const owner = await userByEmail(db, p.owner_email);
      if (!owner) return done('ignored', `No active staff member for owner ${p.owner_email ?? '(missing)'}`);
      const r = await createTask(db, null, tenantId, {
        title: `Follow up: ${p.required_item ?? 'missing document'} for ${p.subject_ref ?? 'subject'}`, ownerId: owner.id, dueDate: p.due_date ?? null,
        category: 'operations', sourceType: 'kyc', sourceRef: { module: 'kyc', subject_ref: p.subject_ref, required_item: p.required_item, status: p.status },
        externalKey: `kyc:${ev.connection_id}:${p.subject_ref}:${p.required_item}`,
      }, { authority: 'kyc_module', correlationId: ev.correlation_id });
      return done('applied', r.created ? `Created follow-up ${r.task.id}` : 'Follow-up already exists (deduplicated)');
    }
    case 'module_vault': {
      if (!['access.offboarding', 'credential.rotation_due'].includes(ev.event_type)) return done('ignored', `Event type ${ev.event_type} not handled`);
      const owner = await userByEmail(db, p.owner_email);
      if (!owner) return done('ignored', `No active staff member for owner ${p.owner_email ?? '(missing)'}`);
      const what = ev.event_type === 'access.offboarding' ? `Remove access to ${p.system_name ?? 'system'} for ${p.person_ref ?? 'departing user'}` : `Rotate credential for ${p.system_name ?? 'system'}`;
      const r = await createTask(db, null, tenantId, {
        title: what, ownerId: owner.id, dueDate: p.due_date ?? null, category: 'operations', sourceType: 'offboarding', requiresEvidence: false,
        description: `Secure reference: ${p.credential_ref ?? 'n/a'}. Open the password vault to perform this action — no secret is stored in this task.`,
        sourceRef: { module: 'vault', credential_ref: p.credential_ref, system_name: p.system_name, person_ref: p.person_ref },
        externalKey: `vault:${ev.connection_id}:${ev.event_type}:${p.credential_ref}:${p.person_ref ?? ''}`,
      }, { authority: 'vault_module', correlationId: ev.correlation_id });
      return done('applied', r.created ? `Created metadata-only task ${r.task.id}` : 'Task already exists (deduplicated)');
    }
    case 'issues': case 'helpdesk': case 'code': {
      const owner = await userByEmail(db, p.assignee_email ?? p.author_email);
      if (!owner) return done('ignored', 'No matching staff member — nothing suggested');
      const ref = String(p.issue_ref ?? p.ticket_ref ?? p.external_id ?? ev.resource_id ?? ev.event_id);
      const existingTask = await one(db, `select id, title from tasks where external_key = $1 or (source_ref->>'external_ref') = $2 limit 1`, [`${ev.connection_kind}:${ref}`, ref]);
      const kind = existingTask ? 'link_to_task' : ev.connection_kind === 'code' ? 'link_to_task' : 'task';
      const title = existingTask ? `Link ${ev.event_type} to "${existingTask.title}"` : p.title ? `${p.title}` : `${ev.event_type} ${ref}`;
      // Aggregate related events under one suggestion per external reference.
      await db.query(`insert into suggestions (tenant_id, user_id, kind, dedupe_key, event_ids, title, data, matched_task_id)
        values ($1,$2,$3,$4,array[$5::uuid],$6,$7,$8)
        on conflict (tenant_id, user_id, dedupe_key) do update set event_ids = array_append(suggestions.event_ids, $5::uuid),
          data = suggestions.data || jsonb_build_object('event_count', coalesce((suggestions.data->>'event_count')::int, 1) + 1)`,
        [tenantId, owner.id, kind, `${ev.connection_kind}:${ref}`, eventId, title.slice(0, 200),
         { source: ev.connection_kind, ref, url: p.url ?? null, event_type: ev.event_type, event_count: 1 }, existingTask?.id ?? null]);
      return done('suggested', `Suggestion for ${owner.name} (confirmation required)`);
    }
    case 'ics_calendar': {
      if (!ev.connection_user_id) return done('ignored', 'Calendar not linked to a user');
      if (p.all_day) return done('ignored', 'All-day event — not treated as meeting time');
      const exists = await one(db, `select id from time_entries where source = 'calendar' and source_event_id = $1 and deleted_at is null`, [eventId]);
      if (exists) return done('applied', 'Already confirmed as time');
      if (Date.parse(p.start) > Date.now()) return done('ignored', 'Future event — suggested after it happens');
      await db.query(`insert into suggestions (tenant_id, user_id, kind, dedupe_key, event_ids, title, data)
        values ($1,$2,'time_entry',$3,array[$4::uuid],$5,$6) on conflict (tenant_id, user_id, dedupe_key) do nothing`,
        [tenantId, ev.connection_user_id, `cal:${ev.event_id}`, eventId, p.summary || 'Meeting', { started_at: p.start, ended_at: p.end, category: 'meeting', source: 'calendar' }]);
      return done('suggested', 'Meeting suggested as time (confirmation required)');
    }
  }
  return done('ignored', 'Unhandled connection kind');
}

/** Parse an uploaded ICS file. Only start/end and title are kept; descriptions, attendees and locations are not imported. */
export async function importIcs(db: Db, a: Actor, connectionId: string, icsText: string) {
  const conn = await one(db, `select * from integration_connections where id = $1 and user_id = $2 and kind = 'ics_calendar'`, [connectionId, a.id]);
  if (!conn) throw notFound('Calendar connection not found');
  if (icsText.length > 5_000_000) throw badRequest('Calendar file is too large');
  let parsed: any;
  try { parsed = ical.sync.parseICS(icsText); } catch (e: any) {
    await db.query(`update integration_connections set last_error = $2, status = 'error' where id = $1`, [connectionId, `Parse error: ${e.message}`]);
    throw badRequest(`Could not read calendar file: ${e.message}`);
  }
  const from = new Date(Date.now() - 31 * 86400000), to = new Date(Date.now() + 1 * 86400000);
  let received = 0, duplicates = 0;
  for (const ev of Object.values(parsed) as any[]) {
    if (ev.type !== 'VEVENT' || !ev.start) continue;
    const instances = ev.rrule ? ical.expandRecurringEvent(ev, { from, to }) : [{ start: ev.start, end: ev.end ?? ev.start, summary: ev.summary, isFullDay: ev.datetype === 'date' }];
    for (const inst of instances as any[]) {
      const start = new Date(inst.start), end = new Date(inst.end ?? inst.start);
      if (start < from || start > to || !(end > start)) continue;
      const priv = ['PRIVATE', 'CONFIDENTIAL'].includes(String(ev.class ?? '').toUpperCase());
      const summary = priv ? 'Private event' : String(typeof inst.summary === 'object' ? inst.summary?.val ?? '' : inst.summary ?? ev.summary ?? '').slice(0, 200);
      const eventId = `${ev.uid}:${start.toISOString()}`;
      const row = await one(db, `insert into integration_events (tenant_id, connection_id, event_id, event_type, schema_version, resource_id, occurred_at, payload)
        values ($1,$2,$3,'calendar.event',$4,$5,$6,$7) on conflict (connection_id, event_id) do nothing returning id`,
        [a.tenantId, connectionId, eventId, SCHEMA_VERSION, ev.uid, start.toISOString(),
         { summary, start: start.toISOString(), end: end.toISOString(), all_day: !!inst.isFullDay }]);
      if (!row) { duplicates++; continue; }
      received++;
      await enqueue(db, { tenantId: a.tenantId, kind: 'integration.process', payload: { eventId: row.id }, idempotencyKey: `integration.process:${row.id}` });
    }
  }
  await db.query(`update integration_connections set last_sync_at = now(), last_error = null, status = 'active' where id = $1`, [connectionId]);
  await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'integration.ics_import', resourceType: 'integration_connection', resourceId: connectionId, details: { received, duplicates } });
  return { received, duplicates };
}

export async function decideSuggestion(db: Db, a: Actor, id: string, decision: 'accept' | 'dismiss', opts: { taskId?: string } = {}) {
  const s = await one(db, `select * from suggestions where id = $1 and user_id = $2 for update`, [id, a.id]);
  if (!s) throw notFound('Suggestion not found');
  if (s.status !== 'open') return { status: s.status };
  let result: any = null;
  if (decision === 'accept') {
    if (s.kind === 'time_entry') {
      const dup = await one(db, `select id from time_entries where source = 'calendar' and source_event_id = $1 and deleted_at is null`, [s.event_ids[0]]);
      if (!dup) result = await one(db, `insert into time_entries (tenant_id, user_id, task_id, category, started_at, ended_at, source, source_event_id, note)
        values ($1,$2,$3,'meeting',$4,$5,'calendar',$6,$7) returning *`,
        [a.tenantId, a.id, opts.taskId ?? null, s.data.started_at, s.data.ended_at, s.event_ids[0], s.title]);
      await db.query(`update integration_events set status = 'applied', result = 'Confirmed as meeting time' where id = any($1::uuid[])`, [s.event_ids]);
    } else if (s.kind === 'task') {
      const r = await createTask(db, a, a.tenantId, { title: s.title, sourceType: 'integration', externalKey: `${s.data.source}:${s.data.ref}`,
        sourceRef: { module: s.data.source, external_ref: s.data.ref, url: s.data.url } });
      result = r.task;
      if (s.data.url) await db.query(`insert into evidence_links (tenant_id, task_id, kind, label, url, added_by) values ($1,$2,'link',$3,$4,$5)`,
        [a.tenantId, r.task.id, `${s.data.source} ${s.data.ref}`, s.data.url, a.id]);
      await db.query(`update integration_events set status = 'applied', result = $2 where id = any($1::uuid[])`, [s.event_ids, `Task ${r.task.id}`]);
    } else if (s.kind === 'link_to_task') {
      const taskId = opts.taskId ?? s.matched_task_id;
      if (!taskId) throw badRequest('Choose the task to link this activity to');
      const t = await one(db, `select id from tasks where id = $1`, [taskId]);
      if (!t) throw notFound('Task not found');
      if (s.data.url) await db.query(`insert into evidence_links (tenant_id, task_id, kind, label, url, added_by) values ($1,$2,'link',$3,$4,$5)`,
        [a.tenantId, taskId, `${s.data.source} ${s.data.ref} (${s.data.event_count ?? 1} event(s))`, s.data.url, a.id]);
      await db.query(`update tasks set source_ref = coalesce(source_ref, '{}'::jsonb) || jsonb_build_object('external_ref', $2::text) where id = $1`, [taskId, s.data.ref]);
      await db.query(`update integration_events set status = 'applied', result = $2 where id = any($1::uuid[])`, [s.event_ids, `Linked to task ${taskId}`]);
      result = { taskId };
    }
  } else {
    await db.query(`update integration_events set status = 'ignored', result = 'Dismissed by user' where id = any($1::uuid[])`, [s.event_ids]);
  }
  await db.query(`update suggestions set status = $2, decided_at = now() where id = $1`, [id, decision === 'accept' ? 'accepted' : 'dismissed']);
  await audit(db, { tenantId: a.tenantId, actorId: a.id, action: `suggestion.${decision}`, resourceType: 'suggestion', resourceId: id, details: { kind: s.kind } });
  return { status: decision === 'accept' ? 'accepted' : 'dismissed', result };
}

export async function reprocessEvent(db: Db, a: Actor, eventId: string) {
  if (!has(a, 'system_admin')) throw forbidden();
  const ev = await one(db, `select * from integration_events where id = $1`, [eventId]);
  if (!ev) throw notFound();
  if (ev.status === 'rejected') throw badRequest('Rejected events are not stored and cannot be reprocessed; ask the sender to redeliver without secrets.');
  await db.query(`update integration_events set status = 'received', result = 'Reprocess requested' where id = $1`, [eventId]);
  await enqueue(db, { tenantId: a.tenantId, kind: 'integration.process', payload: { eventId } });
  await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'integration.reprocess', resourceType: 'integration_event', resourceId: eventId });
}

export { notify };
