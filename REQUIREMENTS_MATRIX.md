# Requirements matrix

Source: `05_Task_and_Productivity_Final_Plan.md` (scope authority) and `05_Task_and_Productivity_Claude_Code_Prompt.md`.

**Status key:**
- **Done**: implemented, persisted server-side and covered by a test that ran.
- **Done (manual QA)**: implemented and checked in a real browser, but no automated test.
- **Partial**: implemented with a stated limit.
- **Dependency**: needs something only you can supply (credentials, policy, review).
- **Optional ext.**: an optional extension in the plan, not built.

**Test references:**
- `U`: `tests/unit.test.ts`
- `W`: `tests/workflow.test.ts`
- `S`: `tests/security.test.ts`
- `I`: `tests/integrations.test.ts`
- `E`: `e2e/journeys.spec.ts` (Playwright, real Chromium)

All listed tests passed on 2026‑10‑01: 47 unit/integration tests and 14 browser journeys.

## Daily routine (plan §2, §4, §5; prompt "My Day")

| # | Requirement | Implementation | Verification | Status |
|---|---|---|---|---|
| 1 | Up to three intended outcomes per day | `daily_plans`/`daily_plan_items` (partial unique index on position 1–3); `PUT /api/my-day/plan`; My Day screen | W "limits intended outcomes to three…"; E "employee daily routine" | Done |
| 2 | Replanning keeps a visible scope change with a reason | `removed_at`/`removed_reason`; shown in My Day, recap and report | W same test | Done |
| 3 | One-line/keyboard quick capture with proposed fields for confirmation | Deterministic parser `parseQuickCapture` (dates, durations, `#PROJ`, `!prio`, `@owner`, `/category`); `Q` shortcut; ⌘K palette; preview before create | U parser tests; W "creates a task from one line"; E journey | Done |
| 4 | Inline one-click status changes; dialog only when a reason is needed | `StatusControl` (blocked/cancel/reopen/unblock dialogs); board drag and drop | W blocked/review tests; E journey + keyboard board test | Done |
| 5 | Editable, confirmed end-of-day recap; corrections are versioned | `daily_reviews` + `daily_review_versions`; reason required after confirmation; report re-snapshotted | W "confirm → v1 snapshot; …correction requires a reason" | Done |
| 6 | Under two minutes of daily admin, validated with realistic journeys | Real interaction timings stored in `ux_timings` (plan, recap, capture, status) and shown as the median/p90 "Median daily logging overhead" on Admin → Operations | E journey: full automated routine 0.67 s (`test-results/routine-timings.json`). **Automation speed, not a human measurement** | Partial: instrumented; the human goal **needs pilot users** (dependency) |
| 7 | Confirmed no-work / non-working day differs from a missing recap | `day_type` (`work`/`no_work`/`non_working`) | W "missing recap is Insufficient Data…" | Done |

## Task model (plan §4–§6; prompt "task/project/milestone…")

| # | Requirement | Implementation | Verification | Status |
|---|---|---|---|---|
| 8 | Task, project, milestone, objective, owner, priority, due date | `tasks`, `projects`, `milestones`, `objectives`; task detail, project pages, Leadership objectives | W, E | Done |
| 9 | Dependencies (cycle-safe) and checklists | `task_dependencies` (recursive cycle check), `checklist_items` | W "dependencies reject cycles" | Done |
| 10 | Collaborators; one accountable owner | `task_collaborators`; owner unchanged | Manual QA | Done (manual QA) |
| 11 | Evidence: link, private file, restricted source reference | `evidence_links`, `stored_files` (per-tenant private storage, SHA-256 integrity) | W evidence test; S restricted evidence test | Done |
| 12 | Reviewer/acceptance; Done only when acceptance is satisfied | State machine: review-required work reaches Done only through reviewer accept; owners cannot self-accept | W "review-required work…" | Done |
| 13 | Blockers: reason, cause, person/party waited on, next follow-up | `blockers`; follow-up editing; daily reminder job | W blocked test | Done |
| 14 | Recurring work without duplicates | `recurring_templates`; unique (template, occurrence_date); hourly scheduler | W "generates one task per occurrence…" | Done |
| 15 | Reopen/rework history with reason | `reopen_count`, state history, review change requests feed "Rework" | W reopen test | Done |
| 16 | List and Kanban views, saved filters, mobile use, sensible defaults | Tasks page (list/board, filters, saved views); mobile FAB + drawer nav | E keyboard board, mobile test | Done |
| 17 | Optimistic concurrency (no silent overwrite) | `version` column; 409 on stale write | W "rejects stale writes" | Done |
| 18 | Permission-scoped search, export and visibility | `taskVisibility()` predicate in list, search, detail and exports; RLS | S tenant isolation + role scoping | Done |

## Time, calendar, capacity (plan §6, §8)

| # | Requirement | Implementation | Verification | Status |
|---|---|---|---|---|
| 19 | Optional timer + manual entry + correction with explicit source | `time_entries.source` (timer/manual/calendar/integration); `time_entry_revisions`; only the owner corrects | W recap test (correction); S "managers cannot edit…" | Done |
| 20 | Working schedules, holidays, leave (full/half), zero-capacity → Not Applicable | `work_schedules` (tenant default + per user), `holidays`, `leave_entries`; `dayCapacity()` | U capacity tests; W leave test | Done |
| 21 | Allocation assumptions | `capacity_allocations` with assumption text; project page form; capacity view | Manual QA | Done (manual QA) |
| 22 | Overlap / event de-duplication; never count a meeting twice | `allocateDay()` sweep-line, counts once, lists conflicts; ICS/event idempotency | U overlap tests; I ICS test (45 min, 15 min conflict) | Done |
| 23 | Planned vs confirmed vs inferred time shown separately | Day report `plannedEstimateMinutes`, `explainedMinutes`, `inferredUnconfirmedMinutes` | Manual QA (Analytics day view) | Done (manual QA) |
| 24 | Team capacity / overload view | `GET /api/team/capacity`; Capacity page (load, estimate coverage, leave strip) | Manual QA | Done (manual QA) |

## Analytics and reports (plan §7, §7A; prompt)

| # | Requirement | Implementation | Verification | Status |
|---|---|---|---|---|
| 25 | Individual dashboard for every user (founders included) with day/week/month/custom | `buildReport()`; My Analytics page; managers/admin can open others in scope | W, S, E report test | Done |
| 26 | Intended/accepted outcomes, carryovers, time categories, coverage, unknown time, blockers, deadlines, evidence, rework, trends, recommendations | Report sections + KPI tiles + daily chart with table view + trend vs previous period + rule-based recommendations | W, E | Done |
| 27 | Explainable On Track / Needs Attention / Insufficient Data (+ Not Applicable), tied to role commitments | `assessDay`/`assessPeriod` with reasons, facts and assumptions from `role_profiles` | W assessment tests | Done |
| 28 | Coverage is never labelled productivity; unknown time never imputed | Definitions + UI copy; unknown is hatched, not a category | U allocation; manual QA | Done |
| 29 | Provisional vs confirmed vs manager-reviewed report | `reportState`; `report_versions` snapshots (period, definitions version, data, reason) | W recap test | Done |
| 30 | PDF/CSV exports from authorized records; reconcile after corrections | Export jobs, re-authorized at generation, private storage, formula-injection guard | W CSV reconcile; I PDF test; S cross-tenant export denied; U CSV guard | Done |

## Admin Daily Routine and oversight (plan §7B)

| # | Requirement | Implementation | Verification | Status |
|---|---|---|---|---|
| 31 | Main admin sees every authorized employee's daily routine; separate from system admin | `routine_admin` role; `GET /api/admin/routine`; founders follow the declared policy | S role scoping + founder policy; E admin journey | Done |
| 32 | Filters: date, employee, department, project, recap/assessment status | Routine page filters | E (department filter) | Done |
| 33 | Timeline + individual report drill-down | `GET /api/admin/routine/:userId` (state changes, time by source, evidence, blockers, comments, corrections, recap versions) | E admin journey | Done |
| 34 | Team managers stay team-scoped | `reviewableUserIds`, `canViewPersonRecords` | S, E manager test | Done |
| 35 | Clarification, review note, acknowledge, follow-up, blocker help, reallocation; never overwrite submitted work | `manager_reviews`; employee response thread; notifications | W manager review test; E admin journey | Done |
| 36 | Admin task visibility doesn't reveal HR/private sources | Restricted evidence masked; meeting titles governed by policy | S restricted evidence | Done |
| 37 | Company rollups without ranking dissimilar roles | Routine rollups; Leadership aggregates; no ranking anywhere | Manual QA | Done (manual QA) |
| 38 | Leadership delivery/capacity views; cost analysis with confidential rates | Leadership page; `cost_rates` visible to `cost_viewer` only | Manual QA | Done (manual QA) |
| 39 | Customer-scoped projects | Customer role sees only its customer's projects and client-visible tasks | E client portal | Done |

## Integrations (plan "Integration contracts"; prompt)

| # | Requirement | Implementation | Verification | Status |
|---|---|---|---|---|
| 40 | Shared event envelope, HMAC sender authentication, replay window, tenant match, de-duplication, recorded result | `receiveInbound()`; `integration_events` unique (connection, event_id); durable processing job | I approval contract test | Done |
| 41 | Approved requests → one execution task (owner, due, scope ref, completion conditions) | `module_approvals` handler, external-key idempotency | I (redelivery creates no duplicate) | Done |
| 42 | PO/offer document linked as a restricted reference | `module_documents` handler adds restricted `source_ref` evidence (visible to owner only) | I "documents and KYC contracts" | Done |
| 43 | Missing KYC/document follow-ups | `module_kyc` handler (required item/status refs only; de-duplicated) | I "documents and KYC contracts" | Done |
| 44 | Credential rotation/offboarding metadata-only; secrets rejected and not stored | `module_vault` handler + `scanForSecrets` on every payload | U scanner; I vault test | Done |
| 45 | Opt-in calendar import with confirmation and de-duplication; private events masked | ICS upload (title/time only) → suggestions → confirm | I ICS test | Done |
| 46 | Issues/helpdesk/code suggestions grouped, confirm-first | Aggregated suggestions by external ref; accept creates one task or links evidence | I issues test | Done |
| 47 | Live Google/Microsoft calendar, GitHub/Jira/helpdesk OAuth connectors | Generic signed webhook + ICS are implemented; OAuth apps are not | — | **Dependency**: OAuth client credentials and provider app registration |
| 48 | No covert keylogging/screenshots/microphone | Not implemented by design; stated in Settings | — | Done (by design) |

## Platform, security, operations (plan "Consolidated implementation foundation")

| # | Requirement | Implementation | Verification | Status |
|---|---|---|---|---|
| 49 | Tenant boundary on every row, export, job and event | Postgres RLS on all tenant tables (app role has no BYPASSRLS); jobs re-scope per tenant | S "row-level security blocks…" | Done |
| 50 | Roles, invitations, sessions, MFA, deactivation, access review | Roles array; invitations (hashed one-time token, 7-day expiry); httpOnly cookie sessions; TOTP MFA; deactivation kills sessions; People admin | S MFA, deactivation tests | Done |
| 51 | Server-side authorization at action time (incl. search/exports/workers) | Route guards + export re-authorization in the job | S, I | Done |
| 52 | Audit: actor, tenant, resource/version, reason, authority, correlation, outcome; append-only; tamper detection | `audit_events` + trigger + per-tenant SHA-256 chain + verify endpoint | S audit test (tamper detected) | Done. Threat boundary documented: a DB superuser can still rewrite the chain; an external WORM archive is a release gate |
| 53 | Transactional outbox, retries/backoff, dead-letter, no duplicates on timeout | `jobs` table; idempotency keys; admin retry | W recurring idempotency; I redelivery | Done |
| 54 | Backups, restore drill, reconciliation | `scripts/backup.sh`, `scripts/restore.sh`, `verify-restore.ts` | Drill run 2026‑10‑01: counts reconcile, audit chain OK, RLS OK, files OK | Done (manual drill) |
| 55 | Observability separate from staff analytics | `/api/health`, JSON request logs, Admin → Operations aggregates | Manual QA | Done (manual QA) |
| 56 | Retention | `retention.purge` job per tenant policy, audited | I "retention" | Done |
| 57 | Commercial: org onboarding, plans, seats, modules, branding, data export | Signup/bootstrap; seat enforcement on invite/reactivate; modules; org JSON export (no secrets) | S export test | Partial: billing/payment is a **dependency** (no payment provider) |
| 58 | AI: permitted scope only, versioned prompts, sources, human review, no fake output | `ai.ts` (task draft, recap draft), `ai_runs` log, accept/edit/reject decision; disabled without key + tenant opt-in | W "AI boundary" (503, no fabricated runs) | Partial: **dependency** on an `ANTHROPIC_API_KEY`; the live model path is not verified |
| 59 | Voice-note capture | Not built; toggle shown disabled | — | Optional ext. |
| 60 | Email/chat notification delivery | In-app notifications; invitation links copied manually | — | **Dependency**: SMTP/chat credentials |
| 61 | Premium accessible responsive UI, light/dark | Token design system, validated chart palette, focus trap, keyboard board, axe AA | E axe on 7 screens (0 serious/critical); mobile no-overflow; manual light/dark/tablet | Done |
| 62 | Independent security review / legal / HR policy approval | — | — | **Dependency** (cannot be self-certified) |
