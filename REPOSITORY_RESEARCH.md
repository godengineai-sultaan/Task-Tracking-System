# Repository research ledger

Engineering research for **Task Tracking and Productivity**. This is not shown on ordinary employee screens.

**Retrieval:** GitHub REST API (`/repos/{owner}/{repo}`, `/releases/latest`, `/commits/{default_branch}`) and the npm registry (`npm view`). First pass on 2026‑10‑01 at 04:37 UTC. Twelve repositories were rate-limited (unauthenticated API) and were re-queried at about 05:45 UTC the same day. Star counts and push dates are what the API returned at those times. They indicate popularity and activity, not quality or security.

**Security evidence:** `npm audit` (GitHub Advisory Database) was run on the installed dependency tree on 2026‑10‑01 and reported **0 vulnerabilities**, both runtime-only (`--omit=dev`) and for all dependencies. No independent security audit of any library was performed or found as part of this work. None is claimed.

**There is no official global GitHub quality rank.** The shortlists below are ranked by a transparent fit order: licence compatibility with a proprietary/commercial product, technical fit with the chosen stack, maintenance evidence, and the effort to reuse.

---

## 1. Full task / project / time products (compared as references)

| Repository | URL | Licence | Stars | Last push | Latest release (date) | HEAD considered | Fit and decision |
|---|---|---|---|---|---|---|---|
| Plane | https://github.com/makeplane/plane | AGPL‑3.0 | 60,195 | 2026‑09‑30 | v1.4.2 (2026‑08‑23) | `e72bf10fa529` | Strong issue/cycle/board UX. AGPL would impose source disclosure on a hosted commercial product, and its Django/Next stack differs. **Reference only**: list/board/command-palette interaction patterns. No code copied. |
| Super Productivity | https://github.com/johannesjo/super-productivity | MIT | 22,417 | 2026‑10‑01 | v19.1.0 (2026‑09‑19) | `3d4c9417ebd1` | Personal day planning, timers, time correction. Single-user Angular/Electron app with no multi-tenant server. **Reference only**: "today" list, optional timer, manual correction UX. No code copied. |
| WeKan | https://github.com/wekan/wekan | MIT | 21,099 | 2026‑09‑30 | v12.12 (2026‑09‑30) | `a888aa216cb6` | Kanban boards, Meteor stack. **Rejected** (stack mismatch; no analytics/recap model). |
| Kanboard | https://github.com/kanboard/kanboard | MIT | 9,893 | 2026‑09‑23 | v1.2.54 (2026‑08‑29) | `cf53b54597b6` | Minimal Kanban, PHP. **Reference only**: lean column/swimlane semantics. |
| Focalboard | https://github.com/mattermost-community/focalboard | NOASSERTION (mixed) | 26,497 | 2026‑05‑18 | v8.0.0 (2024‑06‑13) | `a84bbb65e32e` | Latest release is over two years old and the licence is unclear at repository level. **Rejected.** |
| Huly platform | https://github.com/hcengineering/platform | EPL‑2.0 | 27,821 | 2026‑09‑30 | v0.7.426 (2026‑07‑05) | `e4fd72b36a03` | Broad all-in-one suite; heavy operational footprint. **Rejected.** |
| OpenProject | https://github.com/opf/openproject | GPL‑3.0 | 16,276 | 2026‑10‑01 | v17.9.0 (2026‑09‑30) | `8265b7e8051a` | Mature PM, time and cost reporting, Rails. GPL. **Reference only**: cost-rate × time reporting concept. |
| Leantime | https://github.com/Leantime/leantime | AGPL‑3.0 | 11,685 | 2026‑10‑01 | v3.10.0 (2026‑09‑24) | `d147c3a3ce30` | Neurodiversity-friendly "my work" views, PHP, AGPL. **Reference only** for low-friction daily focus framing. |
| Vikunja | https://github.com/go-vikunja/vikunja | AGPL‑3.0 | 5,564 | 2026‑10‑01 | v2.6.0 (2026‑08‑31) | `5f24402290ad` | Go + Vue task manager, AGPL. **Reference only**: quick-add magic syntax (`*label`, `+project`). Our parser is an independent implementation with different tokens. |
| Kimai | https://github.com/kimai/kimai | AGPL‑3.0 | 5,054 | 2026‑09‑30 | 2.67.0 (2026‑09‑13) | `8528bb174469` | Time tracking and invoicing, PHP, AGPL. **Reference only**: timesheet correction/approval concepts. |
| Taiga (backend) | https://github.com/taigaio/taiga-back | MPL‑2.0 | 854 | 2026‑09‑28 | — | `c8264ac67751` | Agile PM, Django. **Rejected** (stack and maintenance velocity). |

**Conclusion:** no candidate fits the specific combination required here: individual explainable analytics, an admin daily-routine drill-down, confirmed recaps with versioned reports, multi-tenant RLS and metadata-only cross-module contracts. The strongest products are AGPL/GPL, which conflicts with a commercial hosted offering unless the whole product is released under the same terms. The product was therefore built on vetted libraries, and these repositories were used only as UX references. **No code was copied from any of them.**

## 2. Libraries considered and selected

Ranked within each concern by licence fit, stack fit, maintenance and reuse cost.

| Concern | Candidates (URL · licence · stars · last push) | Decision | Pinned version (npm) | Where used |
|---|---|---|---|---|
| HTTP server | **fastify/fastify** (https://github.com/fastify/fastify · MIT · 37,214 · 2026‑09‑29) | **Use as library**. Fast, schema-friendly, first-party cookie/multipart/rate-limit/static plugins | fastify 5.12.5 (gitHead `ba235fdcd9a8`); @fastify/cookie 11.1.2, multipart 10.1.2, rate-limit 11.2.0, static 10.1.5 | `server/src/app.ts`, `server/src/routes/*` |
| Postgres driver | **brianc/node-postgres** (MIT · 13,217 · 2026‑09‑30) | **Use**. Plain SQL with explicit RLS context per transaction | pg 8.23.1 (`0980cefebe0a`) | `server/src/lib/db.ts` |
| Durable job queue | timgit/pg-boss (MIT · 4,010 · 2026‑10‑01); graphile/worker (MIT · 2,403 · 2026‑09‑13) | **Rejected both; implemented a small outbox queue** (`jobs` table with `FOR UPDATE SKIP LOCKED`, retries with exponential backoff, dead-letter, idempotency keys). Reason: jobs must be inserted in the *same transaction* as the business change (true outbox), be tenant-scoped, and be visible and retryable from the admin UI with ~120 lines. pg-boss 12 was installed, its API inspected (`send`/`work`/`createQueue`), then removed. | — | `server/src/lib/jobs.ts`, `server/src/jobs/index.ts` |
| Dates / time zones | **moment/luxon** (MIT · 16,460 · 2026‑08‑09) | **Use**. IANA zones, DST-safe local-day bounds | luxon 3.7.2 (`4262a38ded77`) | calendar/analytics services, seed |
| Validation | **colinhacks/zod** (MIT · 44,049 · 2026‑09‑30) | **Use** for every request body/query | zod 4.6.5 | all routes; AI structured output schema |
| PDF reports | **foliojs/pdfkit** (MIT · 10,710 · 2026‑09‑30); diegomura/react-pdf (MIT · 16,817 · 2026‑09‑23) | **pdfkit used**: server-side, streaming, no React renderer on the server. react-pdf rejected (heavier, JSX layout not needed) | pdfkit 0.20.2 (`8d72a71c3e2b`) | `server/src/services/exports.ts` |
| ICS parsing | **jens-maus/node-ical** (Apache‑2.0 · 172 · 2026‑10‑01); kewisch/ical.js (MPL‑2.0 · 1,179 · 2026‑09‑28) | **node-ical used** (permissive Apache-2.0; has `expandRecurringEvent`). ical.js rejected only to avoid MPL file-level obligations in a runtime dependency | node-ical 0.27.2 (`517e9722d511`) | `server/src/services/integrations.ts` (import keeps title/time only) |
| QR for MFA | soldair/node-qrcode (MIT) | **Use** | qrcode 1.5.4 | `/api/me/mfa/setup` |
| Server state in UI | **TanStack/query** (MIT · 50,386 · 2026‑10‑01) | **Use**. Caching, retries, invalidation, optimistic board moves | @tanstack/react-query 5.104.0 | all pages |
| Kanban drag and drop | **clauderic/dnd-kit** (MIT · 17,683 · 2026‑09‑12); hello-pangea/dnd (Apache‑2.0 on npm · 4,030); atlassian/pragmatic-drag-and-drop (Apache‑2.0 on npm · 12,780) | **dnd-kit used**: built-in keyboard sensor and screen-reader announcements; we added a whole-column keyboard coordinate getter. Others are viable; pragmatic-dnd needs more custom a11y wiring | @dnd-kit/core 6.3.1, sortable 10.0.0, utilities 3.2.2 | `web/src/pages/Tasks.tsx` |
| Command palette | **pacocoursey/cmdk** (MIT · 12,998 · last push 2025‑10‑29) | **Use**. Small, accessible; slower maintenance noted (no push in ~11 months) but stable API | cmdk 1.1.1 | `web/src/components/Shell.tsx` |
| Charts | recharts/recharts (MIT · 27,607); apache/echarts (Apache‑2.0 · 67,424) | **Rejected for now**. The few charts (stacked allocation bars, load bars) are plain accessible HTML/CSS with a table view and validated palette. A chart library would add 100–300 KB for no extra decision value | — | `web/src/components/time.tsx`, `pages/Analytics.tsx` |
| Calendar UI | fullcalendar/fullcalendar (MIT · 20,658); jquense/react-big-calendar (MIT · 8,760) | **Rejected**. Product needs schedules, leave and holidays, not a calendar grid. Simple forms are faster to use | — | — |
| UI primitives | radix-ui/primitives (MIT · 19,348) | **Not used**. Modal, drawer, focus trap and segmented controls implemented in `ui.tsx`, verified with axe | — | `web/src/components/ui.tsx` |
| Icons | lucide-icons/lucide (ISC) | **Use** | lucide-react 1.49.0 | UI |
| Router / React | remix-run/react-router (MIT), facebook/react (MIT) | **Use** | react-router 8.4.0; react 19.3.0 | `web/src/main.tsx` |
| Styling / build | tailwindlabs/tailwindcss (MIT), vitejs/vite (MIT) | **Use** (build-time). Tailwind's lightningcss engine is MPL‑2.0 and runs only at build time; it is not shipped in the bundle | tailwindcss 4.3.3, vite 8.3.1 | `web/` |
| AI provider | anthropics/anthropic-sdk-typescript (MIT) | **Use only when configured**. Structured output via `messages.parse` + zod schema | @anthropic-ai/sdk 0.131.0 | `server/src/services/ai.ts` |
| Browser testing | **microsoft/playwright** (Apache‑2.0 · 96,935 · 2026‑10‑01) + dequelabs/axe-core (MPL‑2.0, dev only) | **Use** (dev only) | @playwright/test 1.63.0 (`1b025d7e20a0`), @axe-core/playwright 4.13.0 | `e2e/` |
| Unit/integration tests | vitest-dev/vitest (MIT) | **Use** (dev only) | vitest 5.0.3 | `tests/` |

**Modifications to reused components:** none. All libraries are consumed unmodified from npm at the versions pinned in `package-lock.json`.

**Update strategy:** run `npm outdated` and `npm audit` monthly, or on any advisory. Upgrade minor/patch versions after `npm test && npm run test:e2e` pass. Major upgrades (fastify, react-router, zod, pdfkit) get a dedicated branch with the full suite plus a manual visual check of the PDF export.

## 3. Licence summary of the installed tree

At research time `node_modules` held 279 packages: MIT 230, ISC 19, Apache‑2.0 11, BSD‑3‑Clause 5, BlueOak‑1.0.0 5 (glob/minimatch family via `@fastify/static`), MPL‑2.0 6 (axe-core and lightningcss: dev/build only), Unlicense 1 (fast-sha256 via the Anthropic SDK), 0BSD 1, plus 1 without a `license` field (png-js via pdfkit, which ships an MIT `LICENSE` file).

**Obligations:** keep copyright and licence notices for redistributed runtime packages (see `THIRD_PARTY_NOTICES.md`). Apache‑2.0 packages (node-ical and transitive dependencies) require keeping their NOTICE files if present. No copyleft licence applies to the shipped runtime bundle or server.

## 4. Addendum: premium extensions (2026‑10‑01)

The 13 premium extension areas added **no new dependencies**. `package.json` and `package-lock.json` are unchanged since the core build, so the licence summary in §3 still applies and `THIRD_PARTY_NOTICES.md` needs no update. Existing libraries and browser platform features were reused:

| Need | Reused | Where |
|---|---|---|
| New PDFs (team week, profitability, client updates) and the branded header on all PDFs | pdfkit | `server/src/services/ext/{teamreview,profitability,clientbrand,clientbrand-brand}.ts` |
| Calendar subscriptions by address and holiday import | node-ical (parsing); Node's own `https` and `dns` for the SSRF-guarded fetch | `server/src/services/ext/{calendar,calendar-fetch}.ts` |
| Personal calendar feed | Hand-written RFC 5545 output (escaping and line folding), no library | `server/src/services/ext/calendar-feed.ts` |
| Working days, time zones, ISO weeks | luxon, with the core `dayCapacity`/`loadCalendar` | planning, templates, escalation, objectives, what-if, Insights, trends |
| Request validation | zod | every new route |
| Server state, caching and optimistic updates in the UI | TanStack Query | `web/src/pages/ext/`, `web/src/components/ext/` |
| Charts (Insights, trends, what-if, objectives) | Plain accessible HTML/SVG with table views, as in the core | `web/src/components/ext/{OrgdashCharts,TrendsView,WhatIfCharts,ObjectivesUI}.tsx` |
| Voice dictation | The browser's Web Speech API (no audio stored by this product) | `web/src/components/QuickCapture.tsx` |
| Offline capture and installable app | IndexedDB (outbox) and a hand-written service worker and web manifest | `web/src/pwa.ts`, `web/public/{sw.js,manifest.webmanifest,offline.html}` |
| App icons | Generated by a small script using Node's built-in `zlib` (PNG encoding) | `server/src/services/ext/pwa-icons.ts` |
| Logo checks | Content sniffing and an allowlist SVG validator written in the project | `server/src/services/ext/clientbrand-brand.ts` |
| Icons in the UI | lucide-react | new pages and components |

Not added, on purpose: a rules-engine library (the automation engine is a small in-house evaluator on the task event bus), a chart library, an SVG rasteriser (so SVG logos are not drawn in PDFs), a Background Sync or Workbox layer, and an iCalendar writer.
