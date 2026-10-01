# Progress

_Last updated: 2026‑10‑01_

## State

All phases in the plan's build table (§12) are implemented as a runnable local application:

- **First usable release:** My Day, quick capture, board/list, status history, blockers, daily review.
- **Operational release:** review/evidence, optional time entries, working calendar, individual analytics and reports, Admin Daily Routine, recurring tasks.
- **Assisted release:** signed integration contracts, ICS calendar import, issue/helpdesk/code suggestions, de-duplication, confirm-first suggestions, optional AI drafts. The AI drafts are not verified live because no key is configured.
- **Commercial release:** tenant onboarding and bootstrap, plans, seats and modules, customer portal, leadership/capacity/cost views, exports, organization data export.

Per-requirement status: `REQUIREMENTS_MATRIX.md`. Open items are external dependencies or release gates, listed below.

## Check results (actual runs, 2026‑10‑01)

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

## Decisions

- **Stack:** TypeScript end to end; Fastify 5 + PostgreSQL 18 (local project cluster, port 54335) + React 19/Vite/Tailwind 4. Port 54329 was already used by the sibling *Request Approval System* project.
- **Isolation:** PostgreSQL RLS on all tenant tables, using separate owner and app roles.
- **Jobs:** an in-database outbox queue rather than pg-boss/graphile-worker, so jobs commit atomically with business changes and are tenant-visible in admin. See `REPOSITORY_RESEARCH.md`.
- **No code copied** from AGPL/GPL products; they were used as UX references only.
- **Charts** are lightweight accessible HTML with a table view; no chart library.
- **Assessments** are rule-based and explainable, using role profiles. There is no composite productivity score and no ranking.

## Open dependencies (need you or an external party)

1. Pilot users to measure real daily overhead and recap usefulness.
2. `ANTHROPIC_API_KEY` and an organization decision to enable AI drafting, to verify the live AI path.
3. SMTP or chat credentials for notification and invitation delivery. Invitations currently produce a link to share manually.
4. OAuth app credentials for live Google/Microsoft calendar and issue/helpdesk connectors. Signed webhooks and ICS import work now.
5. Payment provider for commercial billing. Plans and seats are configuration only.
6. Independent security review; legal/HR approval of visibility, notice and retention policy.
7. Production hosting: TLS, managed Postgres with PITR, off-site encrypted backups, external WORM audit archive.

## Next actionable step

Run an internal pilot. Bootstrap the real organization (`docs/OPERATOR_GUIDE.md` §1), invite 5–10 people across different roles, and review Administration → Operations weekly for overhead, recap adoption and follow-up effort. In parallel, schedule the security review against the release gates in `docs/OPERATOR_GUIDE.md` §7.

## Resume note

To continue in a new session:
1. Read this file, then `REQUIREMENTS_MATRIX.md`.
2. Start the stack: `npm run db:start`, then `npm run dev`.
3. Before changing code, run `npm test` and `npm run test:e2e`; both should be green.
