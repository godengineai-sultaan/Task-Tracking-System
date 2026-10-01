# Third-party notices

This product uses the open-source packages below, unmodified, from the npm registry at the versions pinned in `package-lock.json`. Their copyright and licence notices ship inside each package under `node_modules/<package>/` and must be kept when the software is redistributed.

## Runtime (server and shipped web bundle)

| Package | Version | Licence |
|---|---|---|
| fastify | 5.12.5 | MIT |
| @fastify/cookie | 11.1.2 | MIT |
| @fastify/multipart | 10.1.2 | MIT |
| @fastify/rate-limit | 11.2.0 | MIT |
| @fastify/static | 10.1.5 | MIT (depends on glob/minimatch family under BlueOak-1.0.0) |
| pg | 8.23.1 | MIT |
| luxon | 3.7.2 | MIT |
| zod | 4.6.5 | MIT |
| pdfkit | 0.20.2 | MIT (png-js dependency: MIT licence file) |
| node-ical | 0.27.2 | Apache-2.0 |
| qrcode | 1.5.4 | MIT |
| @anthropic-ai/sdk | 0.131.0 | MIT (fast-sha256 dependency: Unlicense) |
| react, react-dom | 19.3.0 | MIT |
| react-router | 8.4.0 | MIT |
| @tanstack/react-query | 5.104.0 | MIT |
| @dnd-kit/core, sortable, utilities | 6.3.1 / 10.0.0 / 3.2.2 | MIT |
| cmdk | 1.1.1 | MIT |
| lucide-react | 1.49.0 | ISC |

## Development / build only (not shipped)

TypeScript (Apache-2.0), Vite (MIT), Tailwind CSS (MIT; its lightningcss engine is MPL-2.0), Vitest (MIT), Playwright (Apache-2.0), @axe-core/playwright and axe-core (MPL-2.0), tsx (MIT), concurrently (MIT), @vitejs/plugin-react (MIT), and @types packages (MIT).

## Design references (no code used)

Interaction ideas were studied, not copied, from Plane (AGPL-3.0), Super Productivity (MIT), Vikunja (AGPL-3.0), Kimai (AGPL-3.0), Leantime (AGPL-3.0), OpenProject (GPL-3.0) and Kanboard (MIT). See `REPOSITORY_RESEARCH.md`.

The chart colour palette follows a validated reference palette (categorical slots blue/orange/aqua/yellow/magenta) that was checked with a colour-vision-deficiency validator.
