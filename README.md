# Task Tracking and Productivity

A multi-tenant work-tracking application covering:

- My Day: up to three outcomes, one-line capture, one-click status, optional timer, confirmed recap.
- Tasks and projects: list and Kanban views, reviews, evidence, blockers, recurring work.
- Individual analytics: explainable day, week, month and custom reports with PDF/CSV export.
- Admin Daily Routine: company-wide drill-down for the main administrator; managers see their own team.
- Leadership delivery and capacity views, plus a client portal.
- Work-tool connections (calendar file import, issue tracker, helpdesk, code host) that only suggest; nothing is recorded until you confirm.
- Standalone: this module does not depend on or include features of the other office modules.

Built from `05_Task_and_Productivity_Final_Plan.md` (the scope authority). See `REQUIREMENTS_MATRIX.md` for status per requirement and `PROGRESS.md` for the current state.

> This product records **work evidence**. Logging coverage is not productivity, unknown time is not idle time, and nothing captures screens, keystrokes or audio.

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
- `db:seed` loads **fictional DEMO fixtures** (organization `demo`, "Northwind Labs (DEMO DATA)"): about two weeks of realistic history for 8 staff and 1 client user. The shared demo password is written to `.data/demo-credentials.txt` (git-ignored) and regenerated on every seed.
- `dev` runs the API on :4300 (auto-migrates, runs the job worker) and the Vite web app on :5173 (proxies `/api`).

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

```bash
npm test
```

47 unit and integration tests run against a fresh `taskapp_test` database, recreated each run. They cover:
- tenant isolation, including RLS;
- role scoping and founder visibility policy;
- the state machine, optimistic concurrency, recap versioning and report/CSV reconciliation;
- zero-capacity, leave and overlap handling;
- signed work-tool deliveries, de-duplication and secret rejection;
- ICS privacy, exports, audit tamper detection, MFA, retention and the AI boundary.

```bash
npm run test:e2e
```

14 Playwright journeys run in real Chromium against the production build on :4310, after re-seeding the demo tenant:
- employee routine, admin drill-down, manager scope;
- report and PDF download, keyboard board moves, client portal;
- axe WCAG A/AA checks on 7 screens;
- mobile layout.

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
web/ (React 19 + Vite + Tailwind 4 + TanStack Query)       server/ (Fastify 5 + pg)
  pages/  My Day · Tasks · Task detail · Recap ·             routes/    auth · tasks · projects · myday · reports · admin · integrations
          Analytics · Routine · Person day · Capacity ·      services/  access (authorization) · tasks (state machine, parser, recurring)
          Leadership · Projects · Calendar · Recurring ·                calendar (capacity) · analytics (reports, assessments) · myday (plan,
          Integrations · Admin · Settings · Portal                      time, recap) · oversight (routine, timeline, capacity, leadership) ·
  components/ ui kit · shell · quick capture ·                          exports (PDF/CSV) · integrations (contract, ICS) · ai (optional)
              status control · time                         lib/       db (RLS transactions) · audit (hash chain) · jobs (outbox) · crypto
                                                            migrations/ 001_core.sql (schema, RLS policies, append-only audit)
PostgreSQL: every tenant table has row-level security; the app role cannot bypass it. Jobs are rows in the same transaction (outbox).
```

## Documents

- `REQUIREMENTS_MATRIX.md`: every requirement with its implementation, verification, status and dependency.
- `REPOSITORY_RESEARCH.md`: candidates compared, licences, pinned versions, decisions.
- `PROGRESS.md`: what's done, check results, open dependencies, next steps.
- `docs/OPERATOR_GUIDE.md`: administration, backup/restore, monitoring, security boundaries, release gates.
- `THIRD_PARTY_NOTICES.md`: licences of reused components.
