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
- `CF`: `tests/core-fixes.test.ts` (fixes made while integrating the extensions)
- Extension areas: `tests/<area>.test.ts` (vitest) and `e2e/<area>.spec.ts` (Playwright), named in each row of the last section.

The core rows below were verified on 2026‑10‑01 with 47 unit/integration tests and 14 browser journeys. At integration of the premium extensions the suites hold 308 unit/integration tests and 107 browser tests; final run results are in `PROGRESS.md`.

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

## Integrations (work tools only; this module is standalone)

| # | Requirement | Implementation | Verification | Status |
|---|---|---|---|---|
| 40 | Shared event envelope, HMAC sender authentication, replay window, tenant match, de-duplication, recorded result | `receiveInbound()`; `integration_events` unique (connection, event_id); durable processing job | I approval contract test | Done |
| 41–44 | ~~Cross-module contracts (approvals, documents, KYC, vault)~~ | **Removed 2026‑10‑01 by owner decision: this module stays standalone.** Migration `002_standalone.sql` drops those connector kinds and task sources | — | Out of scope |
| 45 | Opt-in calendar import with confirmation and de-duplication; private events masked | ICS upload (title/time only) → suggestions → confirm. Since 2026‑10‑01 also by secret ICS address (row 112) | I ICS test | Done |
| 46 | Issues/helpdesk/code suggestions grouped, confirm-first | Aggregated suggestions by external ref; accept creates one task or links evidence | I issues test | Done |
| 47 | Live Google/Microsoft calendar, GitHub/Jira/helpdesk OAuth connectors | Generic signed webhook, ICS upload and ICS address subscription (row 112) are implemented; OAuth apps are not | — | **Dependency**: OAuth client credentials and provider app registration |
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
| 57 | Commercial: org onboarding, plans, seats, modules, branding, data export | Signup/bootstrap; seat enforcement on invite/reactivate; modules; org JSON export (no secrets); branding since 2026‑10‑01 (row 103) | S export test | Partial: billing/payment is a **dependency** (no payment provider) |
| 58 | AI: permitted scope only, versioned prompts, sources, human review, no fake output | `ai.ts` (task draft, recap draft), `ai_runs` log, accept/edit/reject decision; disabled without key + tenant opt-in | W "AI boundary" (503, no fabricated runs) | Partial: **dependency** on an `ANTHROPIC_API_KEY`; the live model path is not verified |
| 59 | Voice-note capture | Built 2026‑10‑01 as an opt-in organization setting (Administration → Organization, `voice_capture_enabled`, off by default). Uses the browser's Web Speech API for a transcript only; the text goes to the one-line parser for confirmation; no audio is stored by this product | `e2e/pwa.spec.ts` (stand-in recogniser; real speech recognition not exercised) | Done |
| 60 | Email/chat notification delivery | In-app notifications; invitation links copied manually | — | **Dependency**: SMTP/chat credentials |
| 61 | Premium accessible responsive UI, light/dark | Token design system, validated chart palette, focus trap, keyboard board, axe AA | E axe on 7 screens (0 serious/critical); mobile no-overflow; manual light/dark/tablet | Done |
| 62 | Independent security review / legal / HR policy approval | — | — | **Dependency** (cannot be self-certified) |

## Premium extensions (2026-10-01)

Thirteen feature areas built in parallel and merged on 2026‑10‑01. Each area has its own migration, `server/src/{routes,services,jobs}/ext/<area>.ts`, a demo seeder in `server/src/cli/seed-ext/` and web code in `web/src/{pages,components}/ext/`. Every new table has row-level security and app-role grants. Every material change is audited. Nothing in this section ranks people or produces a single productivity score.

| # | Capability | Implementation (files, routes) | Verification | Status | Dependencies |
|---|---|---|---|---|---|
| **Planning** | | `services/ext/planning.ts`, `routes/ext/planning.ts`, `jobs/ext/planning.ts`, migration `005_planning.sql`, `components/ext/PlanningAssistant.tsx` | `tests/planning.test.ts`, `e2e/planning.spec.ts` | | |
| 63 | Suggest my day: rank the person's own open work with points and plain reasons; set aside blocked, in-review, waiting and finished work with a reason; keep chosen outcomes and fill up to three; capacity check; Not Applicable on zero-capacity days | `GET /api/planning/suggest?date=` (rules and assumptions returned in the response); My Day → Suggest my day | planning tests and spec | Done | — |
| 64 | Reminders to plan the day and confirm the recap, with personal opt-out | Hourly tenant tick `planning.nudges` plus `planning.nudge`; tables `planning_preferences`, `planning_nudges` (once per person, day and kind); `GET/PUT /api/planning/preferences`; My Day → Reminders. Only on days with capacity > 0: plan reminder from scheduled start + 15 min, recap reminder in the last 45 min | planning tests | Partial: in-app only | Email/chat delivery |
| 65 | Weekly self-summary | `GET /api/planning/weekly-summary?date=` (self only, others get 403); My Day → Weekly summary. Edits are not saved; copy them | planning tests and spec | Done | — |
| 66 | A plan keeps outcomes that are already finished | `setPlan` in `services/myday.ts` only rejects newly added done or cancelled tasks | CF "a plan keeps an outcome after it is done…" | Done | — |
| **Templates** | | `services/ext/templates.ts`, `templates-starters.ts`, `routes/ext/templates.ts`, migration `006_templates.sql`, `pages/ext/Templates.tsx` | `tests/templates.test.ts`, `e2e/templates.spec.ts` | | |
| 67 | Template library with versions; six starter playbooks provisioned once per organization on first use; company and private templates | Tables `task_templates`, `task_template_items`, `task_template_versions`; `GET/POST /api/templates`, `GET/PUT /api/templates/:id`, `GET /api/templates/:id/versions/:v`, `POST /api/templates/:id/{duplicate,archive}`; `/templates` | templates tests and spec | Done | — |
| 68 | Apply wizard: preview, then create tasks with due dates counted in each owner's working days (weekends, holidays, full-day leave skipped) | `POST /api/templates/:id/{preview,apply}` (idempotent per apply key, version-locked); `task_template_applications`; `GET /api/template-applications/:id`; tasks get source `template` and the template version. Preview warns when a step is due before a step it depends on | templates tests and spec | Done | — |
| 69 | Permissions: company templates edited by managers and system admins; private templates by their creator; assignment to self, managed people, project members (project owners) or anyone (main/system admin) | `GET /api/templates/assignees`; server-side checks in the service | templates tests | Done | — |
| 70 | Save a project as a template | `POST /api/templates/from-project` | templates tests | Partial: the dialog has no task picker, so projects with more than 100 visible tasks cannot be saved from the UI (the API accepts `taskIds`) | — |
| **Automation** | | `services/ext/automation.ts`, `routes/ext/automation.ts`, `jobs/ext/automation.ts`, migration `007_automation.sql`, `pages/ext/Automations.tsx`, `components/ext/AutomationBuilder.tsx` | `tests/automation.test.ts`, `e2e/automation.spec.ts` | | |
| 71 | No-code rules: trigger, optional conditions, up to 6 actions; six preset recipes; on/off switch | Tables `automation_rules`, `automation_runs`; `GET/POST /api/automations`, `PUT/DELETE /api/automations/:id`, `PATCH /api/automations/:id/enabled`; `/automations` | automation tests and spec | Done | — |
| 72 | Event triggers: task created, status changed (from/to), blocker raised, task reviewed, task reopened | Task event bus (`onTaskEvent`), inside the transaction of the change. Each rule runs in its own savepoint: a failing rule is recorded as a failed run and the person's change still goes through | automation tests | Done | — |
| 73 | Time triggers: due soon / overdue by N days | Hourly tenant tick `automation.time_rules`; once per rule, task and due date; overdue rules ignore tasks more than 30 days overdue | automation tests | Partial: a failed time-rule run is not retried for that due date | — |
| 74 | Actions: notify, create follow-up, set priority, set reviewer, add checklist item, add comment, assign | Each executed action is audited with authority `automation_rule:<id>`; the task returned to the client is re-read after rules ran, so its version is current | automation tests; CF | Done | — |
| 75 | Who can create rules | Company rules: system admins. Team rules: managers, limited to the people they manage, re-checked when the rule runs | automation tests | Done | — |
| 76 | Loop guard | Rules do not act at event depth 3 or more and record a skipped run; depth is tracked per async call chain (AsyncLocalStorage) | automation tests; CF "automation depth is tracked per async chain…" | Done | — |
| 77 | Test a rule against a task without changing anything | `POST /api/automations/test` (read-only; a rolled-back savepoint guarantees no writes) | automation tests and spec | Done | — |
| 78 | Run log with retention | `GET /api/automations/runs` (hides titles of tasks the viewer cannot see); `retention.purge` deletes runs older than the organization's retention, capped at 365 days | automation tests | Done | — |
| **Escalation** | | `services/ext/escalation.ts`, `routes/ext/escalation.ts`, `jobs/ext/escalation.ts`, migration `008_escalation.sql`, `components/ext/{AdminEscalation,EscalationBlocker}.tsx`, `pages/Blockers.tsx` | `tests/escalation.test.ts`, `e2e/escalation.spec.ts` | | |
| 79 | Escalation policy (on/off, owner reminder, working-day steps, quiet while owner on leave) | `tenants.settings.escalation`; `GET/PUT /api/escalation/policy` (system admin only, versioned, audited `escalation.policy.update`); Administration → Escalation. Default: off; 2 / 4 / 7 working days | escalation tests and spec | Done | — |
| 80 | Working-day ladder: person waited on, then the owner's manager, then main admins | Hourly tenant tick `escalation.evaluate`; table `blocker_escalations` (each level once per blocker); skipped steps recorded with a reason; resolving the blocker stops the ladder; the core `blockers.remind` stands down while escalation is on | escalation tests | Partial: in-app only; counts only the owner's calendar | Email/chat delivery |
| 81 | Nudge the internal person a blocker waits on | `POST /api/blockers/:id/nudge` (once per day per blocker per person, otherwise 429); table `blocker_nudges`; `GET /api/blockers/:id/escalation`; Task detail → blocker card | escalation tests and spec | Done | — |
| 82 | Blocker aging view (lists blockers, not people; ages in working days) | `GET /api/escalation/blockers` (managers: their team; main and system admins: company; founder policy honoured; members 403); `/blockers` and Administration → Escalation | escalation tests and spec | Done | — |
| **Weekly team review** | | `services/ext/teamreview.ts`, `routes/ext/teamreview.ts`, `jobs/ext/teamreview.ts`, migration `009_teamreview.sql`, `pages/ext/TeamReview.tsx` | `tests/teamreview.test.ts`, `e2e/teamreview.spec.ts` | | |
| 83 | Weekly review workspace: each person's week from the individual report (assessment with facts and assumptions, outcomes, carryovers, coverage, unknown time, blockers, deadlines, recaps); alphabetical, never ranked | `GET /api/team-review?week=&includeMe=1`; `/team-review` | teamreview tests and spec | Done (no paging for very large scopes) | — |
| 84 | Acknowledge, mark discussed or request follow-up (optionally creating a follow-up task); never changes recaps or time | Table `weekly_reviews`; `POST /api/team-review/reviews` (version required on update) | teamreview tests | Done | — |
| 85 | Employee sees and responds to reviews | `GET /api/team-review/mine`; `POST /api/team-review/reviews/:id/respond`; navigation "My weekly reviews" for all staff | teamreview tests and spec | Done | — |
| 86 | Monday reminder to managers; notice when a follow-up task is done | Tenant tick `teamreview.remind` (once per manager per week); task event listener | teamreview tests | Partial: in-app only | Email/chat delivery |
| 87 | Team week export | Export report `team_weekly` (CSV and PDF; same authorization as the page, checked again at generation) | teamreview tests | Done (PDF renders Latin script only) | — |
| **Objectives** | | `services/ext/objectives.ts`, `routes/ext/objectives.ts`, `jobs/ext/objectives.ts`, migration `010_objectives.sql`, `pages/ext/{Objectives,ObjectiveDetail}.tsx` | `tests/objectives.test.ts`, `e2e/objectives.spec.ts` | | |
| 88 | Objectives with key results; created and edited by leadership or system admins; owners maintain key results and check in | Table `objective_key_results`; `GET /api/objectives/overview`, `POST /api/objectives/create`, `GET/PUT /api/objectives/:id`, `POST/PATCH/DELETE …/key-results`, `POST/DELETE …/milestones`; customers 403 | objectives tests and spec | Done | — |
| 89 | Progress roll-up from linked milestones' tasks (estimate-weighted when 80% have estimates) and key results; missing data listed, never imputed | Same service | objectives tests | Done | — |
| 90 | Explained forecast: on track / at risk / off track / insufficient data, with reasons, facts, assumptions and rules | Worse of elapsed-time and 4-week velocity signals; thresholds in `OKR_RULES` | objectives tests | Done (linear heuristic) | — |
| 91 | Owner check-ins with confidence trend (context only; never changes the status) | Table `objective_checkins`; `POST /api/objectives/:id/checkins` | objectives tests and spec | Done | — |
| 92 | Weekly early warning to the owner when the status turns at risk or off track | Tenant tick `objectives.weekly_status`; table `objective_status_history` (one snapshot per objective per ISO week) | objectives tests | Done | — |
| 93 | Objective edits are versioned and audited | `objectives.version`; `PUT /api/objectives/:id` and the core `PATCH /api/objectives/:id` | CF "objective edits through the basic endpoint…" | Partial: linking a milestone from the project page is not audited | — |
| **What-if planner** | | `services/ext/whatif.ts`, `routes/ext/whatif.ts`, migration `011_whatif.sql`, `pages/ext/WhatIf.tsx` | `tests/whatif.test.ts`, `e2e/whatif.spec.ts` | | |
| 94 | Deterministic, read-only simulation of leave, reassignment, deadline, allocation and added-work changes; baseline vs scenario per task and per person, findings and an explicit assumptions list | `POST /api/whatif/simulate` (writes nothing, not even audit rows), `GET /api/whatif/context`; `/capacity/what-if`. Unestimated work uses a stated assumption (default 60 min); "unclaimed capacity" is a planning figure, not idleness | whatif tests and spec | Done | — |
| 95 | Scope: employees plan for themselves, managers for their team, main admin for reviewable people, leadership and system admin for anyone; inactive people left out with a finding; tasks the viewer cannot open shown as "Private task" | Service checks | whatif tests | Done | — |
| 96 | Saved scenarios, private to their creator, versioned and audited | Table `whatif_scenarios`; `GET/POST /api/whatif/scenarios`, `GET/PUT/DELETE /api/whatif/scenarios/:id` | whatif tests | Done | — |
| 97 | Capacity page: What-if button and "Projected late" column | `pages/Capacity.tsx` | whatif spec | Done | — |
| **Profitability** | | `services/ext/profitability.ts`, `routes/ext/profitability.ts`, `jobs/ext/profitability.ts`, migration `012_profitability.sql`, `pages/ext/Profitability.tsx`, `components/ext/ProfitabilityParts.tsx` | `tests/profitability.test.ts`, `e2e/profitability.spec.ts` | | |
| 98 | Project budgets: fixed fee, time and materials, internal; amount, hours, currency, bill rate, dates, alert thresholds | Table `project_budgets`; `GET/PUT/DELETE /api/projects/:id/budget` (versioned; delete needs a reason; audited without amounts). Editing needs cost viewer plus project owner, leadership or system admin | profitability tests and spec | Done | — |
| 99 | Cost to date, revenue, margin, 4-week burn, forecast at completion, consumption of amount and hours; every figure with facts and assumptions | Confirmed time priced at each person's cost rate on the entry date; hours with no rate or another currency reported separately, never priced at zero | profitability tests | Partial: no currency conversion; forecast is a lower bound when estimates are missing | — |
| 100 | Confidentiality: money only for cost viewers; project owners and leadership without cost access see hours only; others 403 | Service checks | profitability tests | Done | — |
| 101 | Budget alerts once per threshold (default 75 / 90 / 100%), re-armed when the budget changes | Table `project_budget_alerts`; tenant tick `profitability.alerts` and after each save; notification `budget_alert` to the project owner and cost viewers who can see the project (money alerts to cost viewers only) | profitability tests | Partial: in-app only | Email/chat delivery |
| 102 | Portfolio view, project budget card, budget chip on Projects; export | `GET /api/profitability/portfolio`, `GET /api/profitability/badges`; `/profitability`; export report `profitability` (CSV and PDF) | profitability tests and spec | Done | — |
| **Client branding and updates** | | `services/ext/{clientbrand,clientbrand-brand}.ts`, `routes/ext/clientbrand.ts`, `jobs/ext/clientbrand.ts`, migration `013_clientbrand.sql`, `pages/ext/ClientUpdates.tsx`, `components/ext/{AdminBranding,BrandMark,ClientbrandUpdateView}.tsx` | `tests/clientbrand.test.ts`, `e2e/clientbrand.spec.ts` | | |
| 103 | Branding: display name, accent colour (white text must reach 4.5:1, otherwise the nearest darker shade is offered), logo (PNG, JPEG or SVG, ≤ 200 KB; unsafe SVG refused) | Table `tenant_branding`; `GET/PUT /api/branding`; `POST/DELETE/GET /api/branding/logo` (private storage, same-tenant users only, CSP sandbox); Administration → Branding (system admin) | clientbrand tests and spec | Done | — |
| 104 | Branded PDFs (existing exports and client updates) | Header with name, logo and accent line via `drawPdfBrandHeader` | clientbrand tests | Partial: SVG logos are not embedded in PDFs (name only) | — |
| 105 | Client weekly updates from client-visible work only, with exact client preview, publish and unpublish (reason required) | Table `client_updates`; `GET/POST /api/client-updates`, `GET /api/client-updates/projects`, `GET/PATCH/DELETE /api/client-updates/:id`, `POST …/:id/{refresh,publish,unpublish}`; `/client-updates`. Project owner, leadership and system admin only; versioned and audited | clientbrand tests and spec | Partial: publishing notifies client users in the app only | Email delivery |
| 106 | Optional "prepare drafts every Friday" (never publishes) | `PUT /api/client-updates/settings`; tenant tick `clientbrand.weekly` (Fridays from noon, tenant time) | clientbrand tests | Done | — |
| 107 | Portal shows published updates with a branded PDF; customers never see drafts or other customers' updates | `pages/Portal.tsx` (`/portal?update=ID`); `GET /api/client-updates/:id/pdf` | clientbrand tests and spec | Done | — |
| **Installable app (PWA)** | | `web/public/{manifest.webmanifest,sw.js,offline.html,icons}`, `web/src/pwa.ts`, `services/ext/pwa.ts`, `routes/ext/pwa.ts`, migration `014_pwa.sql`, `components/ext/PwaStatus.tsx` | `tests/pwa.test.ts`, `e2e/pwa.spec.ts` | | |
| 108 | Installable app with icons and shortcuts; service worker caches only the app shell (never `/api`) with an offline page; "new version available" prompt | Registers on production builds only | pwa spec | Done (update prompt checked by code reading, no e2e) | — |
| 109 | Offline quick capture that syncs idempotently | IndexedDB outbox per user; `tasks.client_request_id`; `POST /api/tasks` accepts `clientRequestId` (a repeat returns the original, `replayed: true`); `POST /api/pwa/captures` reads "today" as the capture day | pwa tests and spec | Done | — |
| 110 | Sign-out warns about unsynced captures, then clears the outbox and caches | `confirmSignOut`, `clearOfflineData` in `web/src/pwa.ts` | pwa spec | Done | — |
| 111 | Mobile bottom navigation under 1024 px | `web/src/components/Shell.tsx` | pwa spec | Done | — |
| **Calendar without OAuth** | | `services/ext/{calendar,calendar-fetch,calendar-feed}.ts`, `routes/ext/calendar.ts`, `jobs/ext/calendar.ts`, migration `015_calendar.sql`, `components/ext/Calendar*.tsx` | `tests/calendar.test.ts`, `e2e/calendar.spec.ts` | | |
| 112 | Subscribe to a work calendar by its secret iCal address; ended meetings (last 7 days) become confirm-first suggestions | Table `calendar_subscriptions` (address encrypted); `GET/PUT/PATCH/DELETE /api/calendar/subscription`, `POST /api/calendar/subscription/sync`; tenant tick `calendar.subscriptions.tick` and `calendar.subscription.sync`; SSRF-guarded fetch; Integrations → My work calendar | calendar tests and spec | Done | — |
| 113 | Personal read-only calendar feed (own task due dates, today's outcomes, own leave) with rotate and revoke | Table `calendar_feed_tokens` (hashed); `GET /api/calendar/feed`, `POST /api/calendar/feed/rotate`, `DELETE /api/calendar/feed`; feed served at `/calendar-feed/<tenant>.<secret>.ics`; Integrations → Calendar feed | calendar tests and spec | Partial: served outside `/api` (`/calendar-feed/…`) because `/api` paths require a session | — |
| 114 | Holiday import from an .ics file or https address: preview, then confirm; never overwrites existing holidays | Table `holiday_imports`; `POST /api/calendar/holidays/import/preview`, `POST /api/calendar/holidays/import/:id/confirm`, `GET /api/calendar/holidays/imports`; system admin only; Calendar & leave → Holidays → Import | calendar tests and spec | Done | — |
| **Insights (organization and team analytics)** | | `services/ext/{orgdash,orgdashRules}.ts`, `routes/ext/orgdash.ts`, migration `016_orgdash.sql` (indexes only), `pages/ext/Insights.tsx` | `tests/orgdash.test.ts`, `e2e/orgdash.spec.ts` | | |
| 115 | Insights dashboard: 12 KPI tiles with deltas, trend charts with table view, blocker causes, cycle time, department and workload tables, versioned definitions (`insights-v1`); zero capacity shown as N/A | `GET /api/insights`, `GET /api/insights/options`; `/insights`; computed live with SQL aggregates and the same allocation and capacity rules as individual reports | orgdash tests and spec | Done | — |
| 116 | Scope and privacy: managers see their teams; main admin sees the company with per-person workload rows (alphabetical, labelled as load); leadership-only users see aggregates, with groups under 3 people withheld and a differencing guard; founder policy honoured | Service checks | orgdash tests | Partial: small groups can still show through in edge cases (leave-thinned weeks, non-nested filters) | — |
| 117 | Rule-based observations about groups of 3 or more, never single people, with facts and assumptions | `orgdashRules.ts` | orgdash tests | Done | — |
| 118 | CSV export | Export report `insights` (CSV only; PDF returns 400) | orgdash tests | Done | — |
| **Personal trends** | | `services/ext/trends.ts`, `routes/ext/trends.ts`, `components/ext/TrendsView.tsx`, `pages/Analytics.tsx` | `tests/trends.test.ts`, `e2e/trends.spec.ts` | | |
| 119 | Personal 4–26 week trends (default 12): planned completion, accepted outcomes, coverage (record completeness), unknown time, blocked time, meeting share, focus time, fragmentation, carryover, estimate accuracy, recap completion; leave-only weeks Not Applicable; today excluded | `GET /api/trends/personal?userId=&weeks=&end=` (same access as the individual report); My Analytics → Trends (`?view=trends`); definitions `trends-v1` | trends tests and spec | Done | — |
| 120 | Pattern review: nine rule-based observations about the person's own records, each with facts, a gentle suggestion and assumptions; no comparison with other people | `TREND_THRESHOLDS` in `services/ext/trends.ts` | trends tests | Done | — |
| 121 | CSV export | Export report `personal_trends` (CSV only) | trends tests | Done | — |
| **Integration fixes** | | Shared core files | `tests/core-fixes.test.ts` | | |
| 122 | Private projects are hidden from the one-line parser (online and offline capture) and refuse tasks from non-members | `projectVisibleSql` in `services/tasks.ts`; `routes/tasks.ts`; `services/ext/pwa.ts` | CF "private projects are hidden…" | Done | — |
| 123 | Client accounts cannot be added to staff teams or reached through manager scope | `routes/admin.ts`; `services/access.ts` | CF "client accounts cannot be added…" | Done | — |
| **Cross-module features** | | | | | |
| 124 | Approvals, document generator, KYC, password vault | Not built by any extension; this module stays standalone (see rows 41–44) | — | Out of scope | — |
