# syntax=docker/dockerfile:1
# Production image for the API and the job worker (same image; APP_ROLE selects the role).
# Build: docker build --build-arg GIT_SHA=$(git rev-parse --short=12 HEAD) -t taskapp:<sha> .
ARG NODE_IMAGE=node:24-trixie-slim

# 1. Full, lockfile-exact dependency install (needed to build the web app).
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# 2. Build the React SPA into dist/ (served by the API in production).
FROM deps AS build
COPY tsconfig.json ./
COPY web ./web
RUN npm run build

# 3. Production dependencies only. The server is TypeScript run by tsx (a devDependency), so copy exactly the
#    locked tsx + esbuild (and esbuild's platform binary) from the full install instead of shipping all dev tooling.
FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=deps /app/node_modules/tsx ./node_modules/tsx
COPY --from=deps /app/node_modules/esbuild ./node_modules/esbuild
COPY --from=deps /app/node_modules/@esbuild ./node_modules/@esbuild
RUN ln -s ../tsx/dist/cli.mjs node_modules/.bin/tsx

# 4. Runtime: no build tools, no dev server, read-only code owned by root, runs as the unprivileged "node" user.
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production APP_ROLE=api HOST=0.0.0.0 PORT=4300 STORAGE_DIR=/data/storage \
    WORKER_HEARTBEAT_FILE=/tmp/worker.heartbeat
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json ./
COPY server ./server
COPY deploy/healthcheck.mjs ./deploy/healthcheck.mjs
COPY --from=build /app/dist ./dist
# Fail the build if the TypeScript runtime cannot load the server code; create the storage mountpoint for "node".
RUN node --import tsx -e "import('./server/src/lib/errors.ts').catch(() => process.exit(1))" \
 && mkdir -p /data/storage && chown node:node /data/storage && chmod 700 /data/storage
ARG GIT_SHA=unknown
ENV GIT_SHA=${GIT_SHA}
LABEL org.opencontainers.image.title="taskapp" org.opencontainers.image.revision="${GIT_SHA}"
USER node
EXPOSE 4300
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD ["node", "deploy/healthcheck.mjs"]
CMD ["node", "--import", "tsx", "server/src/main.ts"]
