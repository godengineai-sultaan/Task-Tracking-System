# Progress

_Last updated: 2026‑10‑01_

## State

All phases in the plan's build table (§12) are implemented as a runnable local application:

- **First usable release:** My Day, quick capture, board/list, status history, blockers, daily review.
- **Operational release:** review/evidence, optional time entries, working calendar, individual analytics and reports, Admin Daily Routine, recurring tasks.
- **Assisted release:** signed integration contracts, ICS calendar import, issue/helpdesk/code suggestions, de-duplication, confirm-first suggestions, optional AI drafts. The AI drafts are not verified live because no key is configured.
- **Commercial release:** tenant onboarding and bootstrap, plans, seats and modules, customer portal, leadership/capacity/cost views, exports, organization data export.

**Premium extensions (2026‑10‑01).** Thirteen feature areas are built, reviewed and merged into `main`: planning (plan my day, reminders, weekly summary), templates, automation rules, blocker escalation, weekly team review, objectives with forecasts, what-if planner, profitability, client branding and updates, installable app with offline capture and voice, calendar without OAuth (subscriptions, personal feed, holiday import), Insights (organization and team analytics) and personal trends. An integration pass then fixed issues that crossed areas (see below).

Per-requirement status: `REQUIREMENTS_MATRIX.md` (the extensions are rows 63–124). Open items are external dependencies, release gates or the known limitations listed below.

## Check results

Final verification results: see the integration section

At integration the suites hold 308 unit/integration tests and 107 browser tests.

### Core release checks (actual runs, 2026‑10‑01, before the extensions)

| Check | Command | Result |
|---|---|---|
| Type checking (server + web) | `npm run typecheck` | Pass, 0 errors |
| Unit + integration tests (fresh test DB) | `npm test` | **47 passed**, 0 failed |
| Browser journeys + axe + mobile (Chromium, production build) | `npm run test:e2e` | **14 passed**, 0 failed |
| Accessibility | axe WCAG 2 A/AA on My Day, Tasks, Recap, Analytics, Daily Routine, Capacity, Leadership | 0 serious/critical violations, after fixing accent contrast (4.41→5.3:1) and avatar contrast |
| Responsive | Playwright at 390×844 (no horizontal overflow); manual checks at 768×1024 and 1440×900 | Pass, after fixing grid min-width overflow |
| Light/dark themes | Manual review in the browser pane | Pass |
| Dependency advisories | `npm audit` (all and runtime-only) | 0 vulnerabilities |
| Backup → restore drill | `npm run backup`, `scripts/restore.sh`, `verify-restore.ts` | Row counts reconcile; audit chain OK; RLS OK; 0 file checksum mismatches |
| Bootstrap CLI | Run against the test DB | Org + admin created |
| Chart palette | dataviz `validate_palette.js`, light and dark | All checks pass. Light-mode contrast WARN on 3 hues mitigated by legend + table view |

**Measured vs goal.** The automated end-to-end routine (plan 3 outcomes, one-line capture, inline status change, confirm recap) completed in 0.67 s of browser time. That shows the click path is short; it is **not** a measurement of human logging overhead. Real overhead is recorded per user in `ux_timings` and summarised as the median/p90 on Administration → Operations, and must be validated with pilot users.

## Integration (premium extensions, 2026‑10‑01)

Each area was merged in this order: planning, templates, automation, escalation, teamreview, objectives, whatif, profitability, clientbrand, pwa, calendar, orgdash, trends. The integration commit then fixed issues that reviewers found in shared core files, each covered by `tests/core-fixes.test.ts` or by the area tests:

- A day plan keeps outcomes that are already done (before, finishing one outcome blocked any change to the plan).
- Automation depth is tracked per request (AsyncLocalStorage) instead of process-wide, so concurrent requests cannot skip each other's rules.
- Task endpoints return the task as it is after automation rules ran, so the client's next edit does not hit a version conflict.
- The one-line parser (online and offline capture) only finds projects the person can see; private projects refuse tasks from non-members.
- Client accounts cannot be added to staff teams, and are excluded from manager scope.
- Objective edits through the basic endpoint are versioned and audited.
- Retention now also deletes automation run logs (at most 365 days).
- Navigation: "My weekly reviews" for all staff, a **Blocker escalation** page for managers and admins, Profitability for leadership, and the What-if planner in the command palette.
- Demo seeds coordinated across areas; tests in worktrees now use their own test database; the Vite dev server proxies `/calendar-feed`.

## Decisions

- **Stack:** TypeScript end to end; Fastify 5 + PostgreSQL 18 (local project cluster, port 54335) + React 19/Vite/Tailwind 4. Port 54329 was already used by the sibling *Request Approval System* project.
- **Isolation:** PostgreSQL RLS on all tenant tables, using separate owner and app roles. Every table added by the extensions follows the same rule.
- **Jobs:** an in-database outbox queue rather than pg-boss/graphile-worker, so jobs commit atomically with business changes and are tenant-visible in admin. See `REPOSITORY_RESEARCH.md`.
- **No code copied** from AGPL/GPL products; they were used as UX references only.
- **Charts** are lightweight accessible HTML/SVG with a table view; no chart library.
- **Assessments** are rule-based and explainable, using role profiles. There is no composite productivity score and no ranking. The extensions keep this: planning suggestions, objective forecasts, Insights observations and trend patterns are rules that return their facts and assumptions, and no AI is used in them.
- **Standalone (owner decision, 2026‑10‑01):** this module does not include approvals, document generation, KYC or a password vault, and no extension adds them.
- **Parallel feature build:** the 13 extensions were built in parallel, one git worktree and branch per area, each with its own database. Each area went through three passes: build, then an adversarial review that fixed defects, then a UX and accessibility review (axe in light and dark mode, phone and desktop widths). Areas were then merged one by one and integrated.
- **Extension points instead of shared edits:** the core gained a task event bus, hourly tenant ticks, an export registry and per-area route, job, seeder and page folders, so areas could be built without editing each other's files. See README → Architecture.
- **No new dependencies:** the extensions reuse the existing libraries (see `REPOSITORY_RESEARCH.md`, addendum).
- **In-app notifications only** until an email/chat provider is supplied.
- **Calendar feed path:** feeds are served at `/calendar-feed/<token>.ics` (outside `/api`), because every `/api` path requires a session.

## Open dependencies (need you or an external party)

1. **Pilot measurement:** pilot users to measure real daily overhead, recap usefulness and manager follow-up effort, and whether reminders, escalation and automation help or add noise.
2. **Email/chat delivery:** SMTP or chat credentials. Invitations, reminders, escalations, budget alerts, review notices and client update notices are in-app only.
3. **SSO:** an identity provider (SAML/OIDC) and its configuration. Sign-in is email and password with optional TOTP MFA.
4. **OAuth calendar connectors:** OAuth app credentials for live Google/Microsoft calendar and issue/helpdesk connectors. Signed webhooks, ICS upload and ICS address subscriptions work now.
5. **Payments:** a payment provider for commercial billing. Plans and seats are configuration only.
6. **Multi-language:** translations and a decision on languages. The interface is English only, and PDFs render Latin script only.
7. **Independent security review**, including the new surfaces: the unauthenticated calendar feed, the SSRF guard on outbound fetches, the SVG logo validator and offline data on devices.
8. **Legal/HR policy:** approval of visibility, employee notice, retention, the use of browser speech services if voice is enabled, and client update content rules.
9. `ANTHROPIC_API_KEY` and an organization decision to enable AI drafting, to verify the live AI path.
10. **Production hosting:** TLS, managed Postgres with PITR, off-site encrypted backups, external WORM audit archive.

## Known limitations

Collected from the build and review notes of every area, grouped and de-duplicated. Items fixed at integration are not repeated here.

**Notifications**
- Everything new is in-app only (see dependency 2). Reminders and alerts depend on the worker running on time; a reminder whose window has passed is skipped.
- Switching escalation on (or shortening its steps) sends every due step for old blockers at once.
- Applying a template to someone sends one notification per created task.
- Objective status changes in the middle of a week are noticed on the next weekly run; notices go to the current owner even if that account is deactivated.

**Scale**
- Weekly team review and its export build each person's report one after another with no paging: fine for tens of people, slow for a large company-wide scope.
- Planning reminders and escalation load each person's calendar separately inside one per-organization job; one failure rolls back that organization's run for the hour. The blocker aging view has no row limit.
- The what-if planner simulates at most 150 people per run.
- Scheduled calendar syncs fetch inside the job's transaction (up to 15 s). DNS lookups use the system resolver, which a slow DNS server can tie up. A person's very large or minute-level repeating calendar can create heavy sync work.

**Calculation assumptions (all stated in the product)**
- Planning: suggestions for a future date use today's task states and a full day; carry-overs look back 14 days and, for a future date, count today's unfinished plan; a past week's summary lists "due next week" tasks that are now overdue.
- Templates: due dates come from step offsets (0–365 working days) and do not move for dependencies (the preview warns); categories are a fixed list; no reviewer picker in the wizard.
- Automation: conditions are checked against the task as it was when the event fired; time rules fire once per rule, task and due date, ignore tasks more than 30 days overdue, and are not retried after a failure; "set reviewer: manager" picks the owner's alphabetically first manager when the owner is on several teams.
- Escalation counts working days on the blocker owner's calendar only; an owner with no schedule never escalates; steps fire on the first hourly run after local midnight.
- Objectives: a linear forecast with fixed thresholds; key results assume higher is better; a milestone belongs to one objective; if nothing was accepted in the look-back window the pace signal says off track.
- What-if: the baseline gives all available time to open tasks (allocations and meetings only when modelled); reviewer time, dependencies, half-day leave and date-bounded allocation changes are not modelled; the first day counts in full; "today" is the viewer's time zone; the Capacity page's "Projected late" horizon is approximated in calendar days.
- Profitability: time overlapping on two projects is counted in both; there is no currency conversion; time-and-materials revenue needs a bill rate; cost and forecast are lower bounds while hours are unpriced or tasks unestimated.
- Insights: computed live, so past weeks change when records are corrected; organization events use the tenant time zone while person-days use each person's zone; tasks count for their current owner; estimate accuracy sums raw entries (overlaps included); a project filter covers the people involved, not project-only time; capacity is not scaled by allocations; person-days count from the period start because there is no join date.
- Trends: estimates are compared with the owner's own confirmed time only; a focus block ends when the task changes; thresholds are fixed in code; trends are not saved as report versions; shares can exceed 100% because the window includes the break; weeks after deactivation still count; a forgotten timer fills a past day to midnight (the last three are shared with core reports).
- A user with an invalid time zone is treated as never working: no reminders and no suggestions.

**Privacy and access edges**
- Insights for leadership-only viewers: a weekly figure can come from only one or two people when the rest are on leave, and comparing non-nested filters (a department and a team) can still narrow a group.
- A system admin without the main admin role sees company-wide blocker aging, including titles of tasks they cannot otherwise open (the links return 404).
- Leadership and system admins can simulate anyone in the what-if planner, including founders, regardless of the founder visibility policy. Saved scenarios can store ids of tasks the creator cannot see (checked again, and refused, when simulated).
- Linking a milestone to an objective from the project page needs only project edit rights and is not audited.
- Private templates whose creator is removed become invisible to everyone.
- Revoking the calendar connection keeps the encrypted subscription address until the person removes it.
- If a session expires, queued offline captures stay on the device until the next sign-in; if a different person signs in, they are deleted, not sent.
- Voice dictation relies on the browser's speech service; in Chrome the audio goes to the browser vendor.

**Product gaps**
- Weekly summary edits are not saved.
- Saving a project as a template from the UI is limited to 100 visible tasks (the API accepts a task list).
- Calendar subscriptions import only meetings that ended in the last 7 days, do not drop cancelled single events, accept https on port 443 only and cap the raw body at 5 MB. The feed address uses `PUBLIC_URL` with the API port.
- PDFs do not draw SVG logos (the name is shown) and do not render non-Latin text. Insights and trends export CSV only.
- Offline captures sync only while the app is open (no background sync); starting the app offline shows the offline page; an AI-drafted capture interrupted by a lost connection shows an error instead of being queued; a capture time from a device with a wrong clock is accepted as-is; a deploy that changes only the offline page, icons or manifest reaches installed apps with the next bundle change; the "new version" prompt has no browser test.
- Milestones have no client-visibility flag: one counts as client-visible when it contains a shared task. The core portal milestone list still shows all milestones of the client's projects.
- The default accent shows briefly before the organization's accent loads.
- Migration 013 adds `branding` to the stored-files purpose check; any later migration that rebuilds that check must keep it.
- Retention runs only when an admin presses **Run retention now**, and does not purge `planning_nudges`.
- Clients who type `/analytics` see a generic "no access" card rather than a redirect to the portal.
- Demo data: budget dates are fixed (2026‑08‑01 to 2026‑12‑15) and one objective's status depends on the seeding date, so a much later re-seed shows less variety; one demo calendar subscription points at a fictional `.example` host and shows a DNS error after the hourly sync.

**Shared UI components**
- The segmented control puts every option in the Tab order and has no arrow-key support.
- Form fields do not link hints and errors with `aria-describedby`; stat hint icons work on hover only.
- The generic error card does not say what failed, and the project pages do not offer Retry.
- On phones and tablets (640–1023 px) toasts can cover the bottom navigation and the bottom part of bottom-sheet dialogs.

**Development process**
- In worktrees `node_modules` is a symlink that `.gitignore` (`node_modules/`) does not match, so commits must add files by explicit path, never `git add -A`.
- `git stash` is shared across worktrees; do not pop stashes from another worktree.

## Next actionable step

Once the final verification above is green, run an internal pilot. Bootstrap the real organization (`docs/OPERATOR_GUIDE.md` §1), set branding and import holidays, invite 5–10 people across roles, and introduce the extensions in stages: week 1 core routine with planning reminders and templates; week 2 weekly team review and Insights; week 3 escalation (with long steps) and one or two tested automation recipes. Review Administration → Operations weekly for overhead, recap adoption and follow-up effort. In parallel, schedule the security review against the release gates in `docs/OPERATOR_GUIDE.md` §7, including items 10–13.

## Resume note

To continue in a new session:
1. Read this file, then `REQUIREMENTS_MATRIX.md`.
2. Start the stack: `npm run db:start`, then `npm run dev`.
3. Before changing code, run `npm test` and `npm run test:e2e`; both should be green.
4. New feature work goes behind the extension points (README → Architecture); commit by explicit path.
