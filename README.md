# Task Tracking and Productivity

A standalone, multi-tenant work-tracking application: task tracking plus productivity analysis dashboards that are built only from recorded work evidence.

## What it does

**Core**

- My Day: up to three outcomes, one-line capture, one-click status, optional timer, confirmed recap.
- Tasks and projects: list and Kanban views, reviews, evidence, blockers, recurring work.
- Individual analytics: explainable day, week, month and custom reports with PDF/CSV export.
- Admin Daily Routine: company-wide drill-down for the main administrator; managers see their own team.
- Leadership delivery and capacity views, plus a client portal.
- Work-tool connections (calendar file import, issue tracker, helpdesk, code host) that only suggest; nothing is recorded until you confirm.

**Premium extensions (added 2026-10-01)**

| Area | What it gives you | Where |
|---|---|---|
| Planning | "Suggest my day" ranks your own open work with the reasons and a capacity check; optional in-app reminders to plan and to confirm the recap; a weekly self-summary | My Day |
| Templates | A library of reusable task playbooks (six starters), with a three-step apply wizard that schedules due dates on working days; save a project as a template | Templates |
| Automation | No-code rules ("when this happens, if these conditions, do these actions"), with a test run that changes nothing and a run log | Automations |
| Escalation | A working-day ladder for open blockers (person waited on, then manager, then main admins), a once-a-day "nudge", and a blocker aging view | Task detail, Blocker escalation, Administration → Escalation |
| Team review | A weekly review workspace for managers and the main admin; employees respond under "My weekly reviews" | Weekly team review |
| Objectives | Objectives and key results with progress roll-up, an explained forecast, owner check-ins and a weekly early warning | Objectives, Leadership |
| What-if | A read-only capacity and deadline simulator (leave, reassignment, deadline and allocation changes), with saved private scenarios | Team capacity → What-if, command palette |
| Profitability | Project budgets, cost to date, burn rate, forecast and threshold alerts; money is shown only to cost viewers | Profitability, project page |
| Client branding | Organization logo, accent colour and branded PDFs; client weekly updates prepared from client-visible work and published to the portal | Administration → Branding, Client updates, Portal |
| Installable app | Install on phone or desktop, offline quick capture that syncs later, optional voice dictation into quick capture | Any page |
| Calendar | Subscribe to your work calendar by its secret address (no OAuth), a personal read-only calendar feed, and holiday import | Integrations, Calendar & leave |
| Insights | Organization and team analytics with trends, definitions and rule-based observations about groups (never single people) | Insights |
| Trends | Your own 12-week trends (focus time, meetings, carryover, estimate accuracy and more) with a gentle pattern review | My Analytics → Trends |

This module is standalone: it does not depend on, or include features of, the other office modules (no approvals, document generator, KYC or password vault).

Built from `05_Task_and_Productivity_Final_Plan.md` (the scope authority). See `REQUIREMENTS_MATRIX.md` for status per requirement, `docs/USER_GUIDE.md` for how each role uses the product and `PROGRESS.md` for the current state.

> This product records **work evidence**. Logging coverage is not productivity, unknown time is not idle time, and nothing captures screens, keystrokes or audio. There is no single productivity score and nobody is ranked. Every assessment, forecast and observation lists the facts and assumptions behind it, and no AI output is ever invented: the planning, forecast and pattern features are rule-based.

## Quick start (macOS, local)

Prerequisites: Node ≥ 22, PostgreSQL 18 client/server binaries on `PATH` (Homebrew `postgresql@18`), and `openssl`.

```bash
npm install
```
```bash
npm run db:init
```
```bash
npm run db:seed
```
```bash
npm run dev
```

Then open http://localhost:5173.

- `db:init` creates a **project-local** Postgres cluster in `.data/pg` on port **54335**. It doesn't touch system services. It also generates `.env` from `.env.example` with random local passwords and an encryption key, and creates the `taskapp` and `taskapp_test` databases.
- `db:seed` loads **fictional DEMO fixtures** (organization `demo`, "Northwind Labs (DEMO DATA)"): about two weeks of detailed recent history for 8 staff and 1 client user, about 12 weeks of older closed history (for Insights and Trends), and sample data for every extension area (rules, budgets, objectives, client updates and so on). The shared demo password is written to `.data/demo-credentials.txt` (git-ignored) and regenerated on every seed.
- `dev` runs the API on :4300 (auto-migrates, runs the job worker) and the Vite web app on :5173 (proxies `/api` and `/calendar-feed`).
- The service worker (installable app, offline capture) registers only on production builds (`npm run build`, then `npm start`), never under Vite dev. App icons are regenerated with `npx tsx server/src/services/ext/pwa-icons.ts`.

Demo sign-ins (organization `demo`):

| Email | Role |
|---|---|
| asha@northwind.example | Founder; main admin + system admin + leadership + cost viewer |
| priya@northwind.example | Engineering manager (team-scoped) |
| rahul@northwind.example, sara@…, dev@…, meera@…, kabir@… | Employees |
| vikram@northwind.example | Co-founder (leadership) |
| lena@globex.example | Client portal |

### Production-style run

```bash
npm run build
```
```bash
npm start
```

The API serves the built app from `dist/` on `PORT` (default 4300).

### Real organization (no demo data)

```bash
npm run bootstrap -- --org "Acme Pvt Ltd" --slug acme --tz Asia/Kolkata --name "Jane Admin" --email jane@acme.example
```

The password is prompted for, or read from `BOOTSTRAP_PASSWORD`; it is never printed. You can also use **Create one** on the sign-in page (`ALLOW_SIGNUP=0` disables it).

## Tests

Test suites: 308 unit/integration tests and 107 browser tests at integration (final counts in PROGRESS.md).

```bash
npm test
```

Vitest runs against a fresh `taskapp_test` database (in a worktree, `taskapp_test_<name>`), recreated each run. Core files:
- `tests/unit.test.ts`, `tests/workflow.test.ts`, `tests/security.test.ts`, `tests/integrations.test.ts`: tenant isolation (including RLS), role scoping and founder visibility, the state machine, optimistic concurrency, recap versioning, report/CSV reconciliation, zero capacity and leave, signed work-tool deliveries, ICS privacy, exports, audit tamper detection, MFA, retention and the AI boundary.
- `tests/core-fixes.test.ts`: fixes made while integrating the extensions.
- One file per extension area: `planning`, `templates`, `automation`, `escalation`, `teamreview`, `objectives`, `whatif`, `profitability`, `clientbrand`, `pwa`, `calendar`, `orgdash`, `trends` (`tests/<area>.test.ts`).

```bash
npm run test:e2e
```

Playwright runs in real Chromium against the production build on :4310, after re-seeding the demo tenant:
- `e2e/journeys.spec.ts`: employee routine, admin drill-down, manager scope, report and PDF download, keyboard board moves, client portal, axe WCAG A/AA checks and mobile layout.
- One spec per extension area (`e2e/<area>.spec.ts`), each with axe checks on its new screens.

```bash
npm run typecheck
```

## Configuration (`.env`)

See `.env.example`. Key settings:
- `DATABASE_URL` (app role, subject to RLS) and `MIGRATION_DATABASE_URL` (owner role for migrations/seed/backup).
- `APP_ENCRYPTION_KEY` (AES-256-GCM for MFA and webhook secrets).
- `STORAGE_DIR` (private files).
- `PUBLIC_URL`, `SESSION_TTL_HOURS`, `LOGIN_RATE_LIMIT`.
- `ANTHROPIC_API_KEY` / `AI_MODEL`: optional AI drafting, disabled when empty.

## Architecture

```
web/ (React 19 + Vite + Tailwind 4 + TanStack Query)       server/ (Fastify 5 + pg + zod + luxon)
  pages/  My Day · Tasks · Task detail · Recap ·             routes/    auth · tasks · projects · myday · reports · admin · integrations
          Analytics · Routine · Person day · Capacity ·      services/  access (authorization) · tasks (state machine, parser, recurring)
          Leadership · Projects · Calendar · Recurring ·                calendar (capacity) · analytics (reports, assessments) · myday (plan,
          Integrations · Admin · Settings · Portal ·                    time, recap) · oversight (routine, timeline, capacity, leadership) ·
          Blockers                                                      exports (PDF/CSV + registry) · integrations (contract, ICS) ·
  pages/ext/  Templates · Automations · Team review ·                   events (task event bus) · notify · ai (optional)
          Objectives · What-if · Profitability ·             lib/       db (RLS transactions) · audit (hash chain) · jobs (outbox) · crypto ·
          Client updates · Insights                                     storage · errors
  components/ ui kit · shell · quick capture ·              routes/ext, services/ext, jobs/ext   one file per extension area
              status control · time                         cli/seed-ext                       demo fixtures per extension area
  components/ext/  per-area components                      migrations/ 001–004 core and scaffolding, 005–016 one per extension area
  pwa.ts, public/ (manifest, sw.js, offline.html, icons)
PostgreSQL 18: every tenant table has row-level security; the app role cannot bypass it. Jobs are rows in the same transaction (outbox).
```

Every request runs in one database transaction with the tenant set (`tx(req, (db, a) => ...)` in `server/src/app.ts`).

### Extension points

The 13 extension areas plug into the core through a small set of seams, so each area lives in its own files:

| Extension point | Where | How it works |
|---|---|---|
| Task event bus | `server/src/services/events.ts` | Core task services emit `task.created`, `task.status_changed`, `task.reviewed`, `task.reopened`, `task.reassigned`, `task.updated` and `blocker.raised`. Listeners registered with `onTaskEvent` run inside the same transaction as the change. Changes made by automation run inside `asAutomation`, which raises the event depth per async call chain (AsyncLocalStorage); listeners do nothing at depth 3 or more (loop guard). Used by automation rules and team review. |
| Tenant ticks | `server/src/jobs/index.ts` | `registerTenantTick(kind)` adds a job kind that the hourly `scheduler.tick` enqueues once per tenant per hour (idempotency key `kind:tenant:hour`). |
| Export registry | `server/src/services/exports.ts` | `registerExportReport(name, def)` adds a report with `authorize`, `build`, and optional `csv` and `pdf` (the PDF receives the organization brand). Exports are authorized when requested and again when generated. Registered: `team_weekly`, `profitability`, `insights`, `personal_trends`. |
| Routes | `server/src/routes/ext/index.ts` | One Fastify plugin per area. |
| Jobs | `server/src/jobs/ext/index.ts` | `registerExtJobs()` calls each area's job, tick and listener registration. |
| Demo seeders | `server/src/cli/seed-ext/index.ts` | Called at the end of `npm run db:seed`; fictional DEMO data only. |
| Web | `web/src/pages/ext/`, `web/src/components/ext/` | Routes in `web/src/main.tsx`, navigation in `web/src/components/Shell.tsx`, admin tabs in `web/src/pages/Admin.tsx`. |
| Schema | `server/migrations/005`–`016` | One migration per area; every new table has row-level security and grants for the app role. |

## Documents

- `REQUIREMENTS_MATRIX.md`: every requirement with its implementation, verification, status and dependency.
- `REPOSITORY_RESEARCH.md`: candidates compared, licences, pinned versions, decisions.
- `PROGRESS.md`: what's done, check results, open dependencies, next steps.
- `docs/OPERATOR_GUIDE.md`: administration, extension settings, scheduled jobs, backup/restore, monitoring, security boundaries, release gates.
- `docs/USER_GUIDE.md`: what each screen is for and how each role does the common jobs.
- `THIRD_PARTY_NOTICES.md`: licences of reused components.
