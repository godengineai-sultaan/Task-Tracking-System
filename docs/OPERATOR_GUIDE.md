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
9. Optional, premium extensions (details in §9):
   - **Administration → Branding**: display name, accent colour and logo.
   - **Calendar & leave → Holidays → Import**: load the year's public holidays from an .ics file or address.
   - **Administration → Escalation**: decide whether the blocker escalation ladder is on (it is off by default).
   - **Administration → Organization**: decide whether voice dictation in quick capture is allowed (off by default).
   - **Automations**: review the preset recipes before switching any rule on.

## 2. Roles

| Role | Can |
|---|---|
| member | Own My Day, tasks, time, recap, analytics and trends; templates; what-if for themselves; own calendar subscription and feed; respond to weekly reviews |
| manager (via team) | Team members' routines, reports, capacity, review actions; weekly team review; team Insights; blocker aging for the team; team automation rules; company templates; what-if for the team |
| routine_admin | Every employee's recorded routine and report (founders per policy); company-wide team review, Insights with per-person workload rows, and blocker aging |
| leadership | Leadership delivery view, objectives (create and edit), allocations; Insights as aggregates only; what-if for anyone; client updates; budgets in hours (money needs cost_viewer) |
| system_admin | Organization configuration, people and access, audit, jobs, operations, integrations; branding; escalation policy; company automation rules; holiday import; objectives; client updates |
| cost_viewer | Confidential cost rates, project cost analysis, budget money figures and money alerts; with project owner, leadership or system_admin also edits budgets |
| customer | Client portal only: its projects' milestones, client-visible tasks and published client updates. Client accounts cannot be added to staff teams |

Deactivating a user ends their sessions immediately. Every role change is audited with before and after values.

## 3. Daily operations

- **Health:** `GET /api/health` returns DB reachability and the job queue (ready, dead, oldest age).
- **Logs:** structured JSON lines on stdout (request id, method, path, status, duration, user id). Secrets, tokens and document contents are never logged.
- **Jobs:** **Administration → Jobs** lists recent jobs. Failed jobs retry with exponential backoff (5 attempts, 3 for exports) and then move to `dead`. Fix the cause, then press **Retry**.
- **Operations metrics:** **Administration → Operations** shows aggregate product health: median/p90 daily logging overhead against the 2-minute target, recap adoption, blocker age, deadline reliability, evidence coverage, manager follow-ups, AI usage, queue and integration health. These are kept separate from individual staff analytics.
- **Audit:** **Administration → Audit → Verify chain** recomputes the per-organization SHA-256 hash chain.
- **Retention:** runs per the organization's `retention_days` (telemetry, old notifications, ignored integration events, and automation run logs, which are kept at most 365 days). Use **Run retention now** to trigger it; every purge is audited. Planning reminder records (`planning_nudges`) are not purged yet.

### Scheduled jobs

The worker enqueues `scheduler.tick` once an hour. For each organization it then enqueues the core jobs and every registered *tenant tick*, each at most once per organization per hour. A job that fails retries with backoff and then appears under **Administration → Jobs** as `dead`.

| Job | Runs | What it does |
|---|---|---|
| `recurring.generate` (core) | Hourly | Creates due occurrences of recurring work (one task per occurrence). |
| `blockers.remind` (core) | Hourly | Reminds owners on a blocker's follow-up date. Stands down while blocker escalation is on, so owners are not reminded twice. |
| `retention.purge` (core) | When an admin presses **Run retention now** (Administration → Organization); it is not on the hourly schedule | Deletes expired telemetry, notifications, ignored integration events and old automation runs; audited. |
| `planning.nudges` | Hourly tick | Sends "Plan your day" (from scheduled start + 15 min, only if nothing is planned) and "Confirm your recap" (last 45 min of the schedule) reminders, once per person per day, only on working days and only to people who have not opted out. Queues `planning.nudge` for a single person. |
| `automation.time_rules` | Hourly tick | Runs "due soon" and "overdue" automation rules, once per rule, task and due date. |
| `escalation.evaluate` | Hourly tick | Moves open blockers up the escalation ladder by working days and sends owner follow-up reminders. Does nothing while the policy is off. |
| `teamreview.remind` | Hourly tick (acts on Mondays) | Reminds each team manager once a week that the weekly review is ready. |
| `objectives.weekly_status` | Hourly tick (acts once a week) | Records one status snapshot per objective per ISO week and notifies the owner when the status turns at risk or off track. |
| `profitability.alerts` | Hourly tick, and after each budget save | Sends a budget alert once per threshold crossed. |
| `clientbrand.weekly` | Hourly tick (acts on Fridays from noon, tenant time) | Prepares client update drafts when "Prepare drafts every Friday" is on. Never publishes. |
| `calendar.subscriptions.tick` | Hourly tick | Queues `calendar.subscription.sync` for each active subscription not fetched in the last 50 minutes (failing ones back off to every 6 hours). |

Insights and personal trends have no jobs: they are computed live on each request.

## 4. Backup and restore

```bash
npm run backup
```

This writes `.data/backups/<timestamp>/` containing:
- `db.dump` (pg_dump custom format);
- `storage.tgz` (private files);
- `counts.txt`;
- `SHA256SUMS`.

All tables added by the premium extensions (migrations 005–016) are in the same database, so `db.dump` already contains them: `planning_preferences`, `planning_nudges`, `task_templates`, `task_template_items`, `task_template_versions`, `task_template_applications`, `automation_rules`, `automation_runs`, `blocker_escalations`, `blocker_nudges`, `weekly_reviews`, `objective_key_results`, `objective_checkins`, `objective_status_history`, `whatif_scenarios`, `project_budgets`, `project_budget_alerts`, `tenant_branding`, `client_updates`, `calendar_subscriptions`, `calendar_feed_tokens` and `holiday_imports`. The escalation policy lives in `tenants.settings`. Uploaded logos are private files and are in `storage.tgz`.

Copy backups off the machine; encryption at rest is the backup target's responsibility. `APP_ENCRYPTION_KEY` must be backed up **separately**. Without it, MFA secrets, webhook secrets and calendar subscription addresses cannot be decrypted, though all business data remains readable.

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
- **Calendar subscriptions (outbound fetch):** addresses are stored encrypted and shown back only as their host. Every fetch is SSRF-guarded (see §9.4).
- **Calendar feeds (inbound, no session):** `/calendar-feed/<tenant>.<secret>.ics` is protected only by the secret in the address. Only a SHA-256 hash of the secret is stored; unknown, revoked or inactive feeds return 404; the route is rate-limited (120 requests per minute).
- **Logos:** checked by content (PNG, JPEG or SVG, at most 200 KB); unsafe SVGs are refused, not cleaned. Logos are served only to signed-in users of the same organization, with a CSP sandbox header.
- **Offline data on devices:** queued captures are kept in the browser's IndexedDB, labelled with the user, until they sync. Sign-out clears them and the app caches.
- **Not collected, by design:** screenshots, keystrokes, microphone recordings, browser activity, mouse scoring. Optional voice dictation produces text only; this product stores no audio.

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

Added with the premium extensions:

10. If voice dictation is enabled: a privacy review. Dictation uses the browser's speech service (Chrome sends the audio to its vendor), which is outside this product's control.
11. Network egress policy for calendar subscriptions and holiday import by address: outbound HTTPS on port 443 to public addresses only. Review the SSRF guard in the security review.
12. TLS and a stable `PUBLIC_URL` before people subscribe to personal calendar feeds, because the feed address carries its own secret.
13. A decision on notification volume before switching on escalation or automation rules: when escalation is first enabled, every due step for existing old blockers fires at once.

## 8. Maintenance

- Monthly: run `npm outdated` and `npm audit`; upgrade patch/minor versions after `npm test` and `npm run test:e2e` pass.
- Schema changes: add `server/migrations/NNN_name.sql`. Migrations apply automatically at API start and through `npm run db:migrate`, each in its own transaction, recorded in `schema_migrations`.
- Run a restore drill at least quarterly and after any schema migration.

## 9. Premium extensions: operator steps

All of these are in-app only: nothing is emailed or posted to chat until a delivery provider is configured (release gate 6).

### 9.1 Blocker escalation policy

- **Where:** Administration → Escalation (system_admin edits; others see a read-only summary). Managers and admins see blocker aging at **Blocker escalation** (`/blockers`).
- **Settings:** on/off (default off); remind the owner on the follow-up date; three steps in working days, which must be in order: the person waited on (default 2), the owner's team manager (default 4), main admins (default 7); stay quiet while the owner is on full-day leave.
- **How it counts:** working days on the blocker owner's own calendar (schedule, holidays, and leave when quiet-on-leave is set). An owner with no schedule and no organization default never escalates. Each step fires once per blocker; a skipped step (for example, waiting on an external party, or an owner with no manager) is recorded with a reason. Resolving the blocker stops the ladder.
- **Nudge:** anyone who can contribute to the task can nudge the internal person a blocker waits on, once per day per blocker.
- **Saving:** saves are versioned (a stale save gets a conflict) and audited as `escalation.policy.update`.
- **Before switching it on:** expect a burst of notifications for old blockers (release gate 13). Consider starting with long steps and shortening them later.

### 9.2 Branding (logo and accent)

- **Where:** Administration → Branding (system_admin).
- **Display name** is the organization name.
- **Accent colour:** saved only if white text on it reaches 4.5:1 contrast; otherwise the page offers the nearest darker shade (**Use nearest shade**). It applies at once in light and dark mode.
- **Logo:** PNG, JPEG or SVG, at most 200 KB (PNG at most 4096 px). SVGs with scripts, event handlers, external links, DOCTYPE/ENTITY declarations or CSS imports are refused with a clear message.
- **PDFs:** exports and client updates carry a header with the name, logo and an accent line. SVG logos are not drawn in PDFs (the name is shown instead), so upload a PNG if the logo should appear on PDFs.

### 9.3 Automation rules

- **Who can create:** company-wide rules: system_admin. Team rules: managers, limited to the people they manage; the team is checked again every time the rule runs.
- **Shape:** one trigger (task created, status changed, blocker raised, task reviewed, task reopened, due soon, overdue), optional conditions, up to 6 actions (notify, create follow-up, set priority, set reviewer, add checklist item, add comment, assign). Six preset recipes are available.
- **Safety:** use **Test against a task** before switching a rule on; it changes nothing. Each rule runs in its own savepoint, so a failing rule is recorded as a failed run and never blocks the person's change.
- **Loop guard:** a change made by a rule can trigger other rules, but rules do not act at depth 3 or more; such runs are logged as skipped.
- **Time rules** run hourly, once per rule, task and due date; overdue rules ignore tasks more than 30 days overdue. A failed time-rule run is not retried for that due date.
- **Run log:** Automations → run log, filterable; it hides titles of tasks the viewer cannot see. Every executed action is audited with authority `automation_rule:<id>`.
- **Retention:** run logs are deleted after the organization's retention period, capped at 365 days.

### 9.4 Calendar subscriptions and personal feeds

**Subscriptions (staff, Integrations → My work calendar → Subscribe by address).** A person pastes the secret iCal address from Google or Outlook. One subscription per person. The address is stored encrypted and shown back only as its host. An hourly job syncs it; meetings that ended in the last 7 days become confirm-first time suggestions. **Sync now** is available (rate-limited). Pausing or revoking the calendar connection stops syncing. After a revoke the encrypted address stays stored until the person removes it or saves a new one.

SSRF protections on every fetch (subscriptions and holiday import by address):
- https only, on port 443; no user name or password in the address;
- every hop, including redirects (at most 3), is resolved by DNS and refused if any address is private, loopback, link-local, carrier-grade NAT, multicast, reserved or a cloud metadata endpoint; host names such as `localhost`, `*.local`, `*.internal` and `metadata` are refused;
- the connection is pinned to the checked address, so DNS rebinding cannot redirect it;
- 15-second total time limit and 5 MB body limit;
- manual syncs fetch with no database transaction open. Scheduled syncs still fetch inside the job's transaction, so a slow server can hold that job for up to 15 seconds.

**Personal feeds (staff, Integrations → Calendar feed).** Creates a read-only address that calendar apps can subscribe to: `<PUBLIC_URL with the API port>/calendar-feed/<tenant id>.<secret>.ics`. In local development this is `http://localhost:4300/calendar-feed/…`. It contains only that person's open task due dates (title and link), today's outcomes and their leave; never other people's data or task descriptions.
- The address is shown **once**. Only a hash of the secret is stored.
- **Rotate** replaces the address and stops the old one immediately; **Revoke** turns the feed off. Both are audited (`calendar.feed.create`, `calendar.feed.rotate`, `calendar.feed.revoke`).
- Deactivating a user stops their feed.
- Ask people to rotate their feed if the address may have been shared.

### 9.5 Holiday import

- **Where:** Calendar & leave → Holidays → Import (system_admin).
- **Source:** an .ics file, or an https address (same SSRF guard as above).
- **Flow:** preview first, choose the dates, then confirm. Only all-day entries are read; timed entries and entries longer than 31 days are skipped with a warning; at most 1,000 entries. Existing holidays are never overwritten. Confirming a preview twice returns the first result. Imports are audited (`holiday.import`) and listed under recent imports.

### 9.6 Budgets and cost alerts

- **Prerequisite:** cost rates per person (Administration → People → cost rates, visible to cost viewers). Hours from people without a rate, or with a rate in another currency, are shown separately and never priced at zero. There is no currency conversion.
- **Where:** the Budget card on a project page; the portfolio at **Profitability**.
- **Who can edit:** a cost viewer who is also the project owner, leadership or a system admin. Saves are versioned; deleting needs a reason; changes are audited without amounts.
- **Billing types:** fixed fee, time and materials (needs a bill rate), internal.
- **Alerts:** thresholds default to 75, 90 and 100%. Each threshold alerts once; changing the amount, hours, currency, billing type or bill rate re-arms them. Recipients: the project owner and cost viewers who can see the project; money alerts go to cost viewers only.
- **Who sees money:** cost viewers only. Project owners and leadership without cost access see hours only; everyone else is refused.

### 9.7 Client updates

- **Who:** the client project's owner, leadership and system admins, at **Client updates**.
- **Content:** prepared only from client-visible work (tasks marked visible to the client, and milestones containing them), plus a free-text summary. Client visibility is checked again when the update is read and when it is published.
- **Publishing:** preview exactly what the client sees, then **Publish**. Client users get an in-app notification; nothing is emailed. **Unpublish** needs a reason. Only drafts can be discarded. Every change is versioned and audited.
- **Weekly drafts:** leadership or a system admin can switch on "Prepare drafts every Friday". The job prepares drafts from noon on Fridays (organization time zone) and never publishes; a discarded draft is not re-created that week.
- **Portal:** clients see published updates for their own active projects, with a branded PDF.

### 9.8 Installable app, offline capture and voice

- **Install:** people use their browser's install or "Add to Home Screen" option. The service worker is served only by production builds (`npm start`).
- **What is cached:** the app shell, icons and the offline page only. API data is never cached. Opening the app while offline shows the offline page; captures can be made offline only from an app that is already open.
- **Offline capture:** quick capture switches to "Save offline". Items are kept in the browser (IndexedDB), labelled with the user, and sync when the connection returns, when the app is reopened, every 30 seconds or on **Sync now**. Each capture carries a request id, so retries never create duplicate tasks. Words like "today" mean the day of capture.
- **Sign-out:** the app warns about unsynced captures, then deletes the queue and the app caches from the device. If a session simply expires, the queue stays until the next sign-in; if a different person signs in on that device, the previous person's queued captures are deleted, not sent.
- **Updates:** after a deploy, open apps show "A new version is available – Reload". A deploy that changes only `offline.html`, icons or the manifest reaches installed apps only with the next build that changes the app bundle.
- **Voice:** off by default; switch on under Administration → Organization. It uses the browser's speech service and produces text for the one-line parser, which the person confirms. See release gate 10.

### 9.9 Planning reminders (nudges) and opt-outs

- Reminders are on by default for every staff member. Each person can switch off "Remind me to plan my day" and "Remind me to confirm my recap" under **My Day → Reminders**. Changes are audited.
- They are sent only on that person's working days (never on holidays, full-day leave or non-working days), at most once per day per kind, and only while the worker runs on time: a job that starts after its window has closed is skipped.
- A person with an invalid time zone gets no reminders or suggestions; check the time zone in their profile.

### 9.10 New release gates

See §7, items 10–13.
