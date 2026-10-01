# Operator guide

## 1. First-time setup for a real organization

1. Install and initialise the database: `npm install`, then `npm run db:init`. Don't run `db:seed` in production.
2. Create the organization and its first administrator:
   `npm run bootstrap -- --org "<legal name>" --slug <sign-in-name> --tz <IANA zone> --name "<admin>" --email <email>`
3. Sign in, then open **Administration → Organization**:
   - Fill in company details. Leave unknown facts empty; nothing is invented.
   - Set the plan and seat limit.
   - Set the visibility policy: founders visible to the main admin, meeting titles in the timeline.
   - Set the minimum logging coverage needed before a day is assessed.
   - Set the categories that require evidence or review.
   - Set retention.
4. Open **Calendar & leave** and set the organization's default working schedule and holidays.
5. Open **Administration → Teams & departments** to create departments, teams (with a manager) and clients.
6. Open **Administration → Role profiles** and set commitments per role. For example, founders and sales are not judged by closed-task counts.
7. Open **Administration → People → Invite**. Invitations produce a one-time link valid for 7 days; email delivery is not configured, so share the link directly. Give the `routine_admin` role (company-wide staff records) only to the explicitly authorized main administrator. It is separate from `system_admin`.
8. Optional: under **Integrations**, add organization connections. Each one shows its signing secret **once**.

## 2. Roles

| Role | Can |
|---|---|
| member | Own My Day, tasks, time, recap, analytics |
| manager (via team) | Team members' routines, reports, capacity, review actions |
| routine_admin | Every employee's recorded routine and report (founders per policy) |
| leadership | Leadership delivery view, objectives, allocations |
| system_admin | Organization configuration, people and access, audit, jobs, operations, integrations |
| cost_viewer | Confidential cost rates and project cost analysis |
| customer | Client portal only: its projects' milestones and client-visible tasks |

Deactivating a user ends their sessions immediately. Every role change is audited with before and after values.

## 3. Daily operations

- **Health:** `GET /api/health` returns DB reachability and the job queue (ready, dead, oldest age).
- **Logs:** structured JSON lines on stdout (request id, method, path, status, duration, user id). Secrets, tokens and document contents are never logged.
- **Jobs:** **Administration → Jobs** lists recent jobs. Failed jobs retry with exponential backoff (5 attempts, 3 for exports) and then move to `dead`. Fix the cause, then press **Retry**.
- **Operations metrics:** **Administration → Operations** shows aggregate product health: median/p90 daily logging overhead against the 2-minute target, recap adoption, blocker age, deadline reliability, evidence coverage, manager follow-ups, AI usage, queue and integration health. These are kept separate from individual staff analytics.
- **Audit:** **Administration → Audit → Verify chain** recomputes the per-organization SHA-256 hash chain.
- **Retention:** runs per the organization's `retention_days` (telemetry, old notifications, ignored integration events). Use **Run retention now** to trigger it; every purge is audited.

## 4. Backup and restore

```bash
npm run backup
```

This writes `.data/backups/<timestamp>/` containing:
- `db.dump` (pg_dump custom format);
- `storage.tgz` (private files);
- `counts.txt`;
- `SHA256SUMS`.

Copy backups off the machine; encryption at rest is the backup target's responsibility. `APP_ENCRYPTION_KEY` must be backed up **separately**. Without it, MFA secrets and webhook secrets cannot be decrypted, though all business data remains readable.

**Restore drill.** It restores into a scratch database and never touches live data:

```bash
bash scripts/restore.sh .data/backups/<timestamp>
```
```bash
npx tsx server/src/cli/verify-restore.ts taskapp_restore_drill
```

The drill verifies checksums, reconciles row counts and verifies every audit chain. It confirms RLS still hides all rows when no tenant context is set, and re-hashes every stored file. The last drill ran on 2026‑10‑01 and passed all checks.

**Real restore over live data** requires `CONFIRM_RESTORE=yes bash scripts/restore.sh <dir> taskapp`. Stop the app first. Afterwards:
- re-check that deactivated users and revoked integrations from after the backup are still deactivated and revoked;
- re-apply them if needed.

Restores do not replay access changes made after the backup.

## 5. Work-tool integration contract (issues, helpdesk, code host)

`POST /api/inbound/<org-slug>/<connection-id>` with these headers:
- `X-Timestamp: <unix seconds>` (5-minute window);
- `X-Signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>`.

The body is the shared envelope: `event_id, event_type, schema_version (1.x), tenant_id, entity_id, resource_id, resource_version, occurred_at, actor_reference, correlation_id, payload`.

Responses:
- `202`: accepted.
- `200 {status: duplicate}`: this `event_id` was already received.
- `422`: payload rejected. Any field named like password, secret, token or key, or any value that looks like a secret, causes rejection, and the payload is **not stored**.
- `403`: bad signature, stale timestamp or wrong tenant.

| Connection | Event types | Effect |
|---|---|---|
| Issues / helpdesk / code | any | Confirm-first suggestion for the assignee, grouped by external reference |
| Calendar (ICS upload) | — | Past meetings become confirm-first time suggestions (title and time only; private events masked) |

## 6. Data and security boundaries

- **Tenant isolation:** PostgreSQL row-level security on every tenant table. The app connects as `taskapp` (no BYPASSRLS) and sets `app.tenant_id` per transaction. Migrations and backups use `taskapp_owner`.
- **Sessions:** random 256-bit tokens; only their SHA-256 hashes are stored. Cookies are httpOnly, SameSite=Lax, and `Secure` when `NODE_ENV=production`.
  - State-changing API calls need the `X-Requested-With: fetch` header (CSRF defence).
  - Login is rate-limited.
  - Passwords are hashed with scrypt. Optional TOTP MFA.
- **Files:** private per-tenant directory (mode 700/600), served only through authorized routes, SHA-256 verified on read.
- **Confidential references:** stored as a label + ID pointing to a document kept elsewhere (e.g. an HR file). Only the owner and the person who added it can see them; task visibility never grants access to the content.
- **Exports** are authorized at request time and again when generated. Files belong to the requester. CSV cells are guarded against formula injection.
- **AI (optional):** off unless the organization enables it *and* `ANTHROPIC_API_KEY` is set.
  - Only the person's own task titles and notes are sent.
  - Prompts are versioned (`task_draft@v1`, `recap_draft@v1`); every run is logged with model, tokens and the user's accept/edit/reject decision.
  - Drafts are never saved without the person confirming them.
- **Not collected, by design:** screenshots, keystrokes, microphone, browser activity, mouse scoring.

## 7. Release gates (must pass before production use)

These are **not** satisfied by this build and cannot be self-certified:

1. Independent security review and penetration test (authz matrix, RLS policies, webhook surface, file handling).
2. Legal/HR review of the monitoring and visibility policy, employee notice, retention periods and data-subject access for every jurisdiction where staff work.
3. Pilot with representative users to *measure* daily logging overhead against the < 2-minute goal (instrumented in Operations), recap usefulness, and manager follow-up effort.
4. TLS termination and a managed PostgreSQL with point-in-time recovery, encrypted off-site backups, and a tested restore runbook in the target environment.
5. Tamper-evident audit archive outside the database (e.g. WORM storage). The in-database hash chain detects edits but cannot stop a database superuser rewriting history.
6. Email/chat delivery provider for notifications and invitations (credentials).
7. OAuth app registrations for live calendar, issue and helpdesk connectors, if wanted.
8. Payment provider and billing terms for commercial plans (currently configuration only).
9. If AI drafting is enabled: provider data-processing terms, an evaluation of the drafts on real (consented) data, and a decision on data location.

## 8. Maintenance

- Monthly: run `npm outdated` and `npm audit`; upgrade patch/minor versions after `npm test` and `npm run test:e2e` pass.
- Schema changes: add `server/migrations/NNN_name.sql`. Migrations apply automatically at API start and through `npm run db:migrate`, each in its own transaction, recorded in `schema_migrations`.
- Run a restore drill at least quarterly and after any schema migration.
