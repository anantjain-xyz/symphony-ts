# syntax=docker/dockerfile:1.7
# Multi-stage build for the Symphony worker.
#
# Build context: repo root (so the workspace lockfile + sibling packages are
# available). Run from repo root with `-f apps/worker/Dockerfile`, or via the
# top-level docker-compose.yml.

ARG NODE_VERSION=22
ARG PNPM_VERSION=10.15.0

# ---------- deps: install the worker's pnpm subgraph ----------
FROM node:${NODE_VERSION}-alpine AS deps
ARG PNPM_VERSION
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /repo

# Copy only manifests + lockfile first so dep installs cache cleanly.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/worker/package.json apps/worker/package.json
COPY apps/dashboard/package.json apps/dashboard/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @symphony/worker... --filter @symphony/shared

# ---------- runtime: tsx executes TypeScript directly, no compile step ----------
FROM node:${NODE_VERSION}-alpine AS runtime
ARG PNPM_VERSION
ENV NODE_ENV=production \
    LOG_LEVEL=info \
    WORKFLOW_PATH=/repo/WORKFLOW.md
RUN apk add --no-cache bash git tini \
    && corepack enable \
    && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /repo

COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=deps /repo/packages/shared/node_modules ./packages/shared/node_modules
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY WORKFLOW.md ./
COPY packages/shared ./packages/shared
COPY apps/worker ./apps/worker

WORKDIR /repo/apps/worker

# tini reaps zombies — the worker spawns agent adapter subprocesses.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["pnpm", "exec", "tsx", "src/index.ts"]
