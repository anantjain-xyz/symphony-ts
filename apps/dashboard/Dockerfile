# syntax=docker/dockerfile:1.7
# Multi-stage build for the Symphony dashboard (Next.js 15 standalone).
#
# Build context: repo root (so the workspace lockfile + sibling packages are
# available). Run from repo root with `-f apps/dashboard/Dockerfile`, or via
# the top-level docker-compose.yml.

ARG NODE_VERSION=22
ARG PNPM_VERSION=10.15.0

# ---------- deps: install the dashboard's pnpm subgraph ----------
FROM node:${NODE_VERSION}-alpine AS deps
ARG PNPM_VERSION
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /repo

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/dashboard/package.json apps/dashboard/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @symphony/dashboard... --filter @symphony/shared

# ---------- builder: produce the standalone server bundle ----------
FROM node:${NODE_VERSION}-alpine AS builder
ARG PNPM_VERSION
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /repo

COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/dashboard/node_modules ./apps/dashboard/node_modules
COPY --from=deps /repo/packages/shared/node_modules ./packages/shared/node_modules
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY apps/dashboard ./apps/dashboard

# Public env vars must be present at build time — Next inlines them into the
# client bundle. The values shipped here are the well-known dev defaults the
# compose stack issues; an external NEXT_PUBLIC_SUPABASE_URL replaces them at
# `docker compose build --build-arg NEXT_PUBLIC_SUPABASE_URL=...`.
ARG NEXT_PUBLIC_SUPABASE_URL=http://localhost:54421
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlLWRlbW8iLCJpYXQiOjE2NDE3NjkyMDAsImV4cCI6MTc5OTUzNTYwMH0.F_rDxRTPE8OU83L_CNgEGXfmirMXmMMugT29Cvc8ygQ
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_TELEMETRY_DISABLED=1

WORKDIR /repo/apps/dashboard
RUN pnpm exec next build

# ---------- runtime: minimal server.js + traced node_modules ----------
FROM node:${NODE_VERSION}-alpine AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
RUN apk add --no-cache tini \
    && addgroup -g 1001 -S nodejs \
    && adduser -u 1001 -S nextjs -G nodejs
WORKDIR /app

# `output: 'standalone'` writes the traced server bundle to .next/standalone.
# Layout when traced from the monorepo root:
#   .next/standalone/apps/dashboard/server.js
#   .next/standalone/apps/dashboard/.next/...
#   .next/standalone/node_modules/...
COPY --from=builder --chown=nextjs:nodejs /repo/apps/dashboard/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /repo/apps/dashboard/.next/static ./apps/dashboard/.next/static

USER nextjs
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/dashboard/server.js"]
