# symphony-ts

TypeScript port of [Symphony](https://github.com/openai/symphony), backed by Supabase for persistence, realtime, and operator auth.

A long-running daemon that polls Linear for issues, provisions isolated workspaces per issue, and runs Codex coding-agent sessions against them with retries, concurrency caps, and live operator observability.

## Layout

- `apps/worker/` — Node daemon (poll loop, orchestrator, workspace manager, Codex runner)
- `apps/dashboard/` — Next.js operator console (Supabase Auth, live session view)
- `packages/shared/` — zod schemas, generated DB types, Supabase client factory
- `supabase/` — local Supabase config + SQL migrations

## Local dev

```sh
pnpm install
supabase start                 # ports bumped to 54421+ to avoid collisions
pnpm db:types                  # regenerate packages/shared/src/db-types.ts
pnpm -r build                  # build everything
```

Local Supabase URLs and keys: `supabase status`. Studio is at http://127.0.0.1:54423.

### Env

Both apps read from a single `.env.local` at the repo root:

```sh
cp .env.example .env.local
# fill in SUPABASE_SERVICE_ROLE_KEY (from `supabase status` -> Secret)
#         NEXT_PUBLIC_SUPABASE_ANON_KEY (from `supabase status` -> Publishable)
#         LINEAR_API_KEY
```

The worker loads it via `dotenv` in `apps/worker/src/index.ts`; the dashboard
loads it via `loadEnvConfig` in `apps/dashboard/next.config.mjs`.

### Worker

```sh
pnpm --filter @symphony/worker dev
```

Hit `Ctrl-C` to drain (loop.stop runs with a 30 s grace deadline).

### Dashboard

```sh
pnpm --filter @symphony/dashboard dev
# open http://localhost:3000
```

Sign in with a magic link via Supabase Auth (Mailpit captures emails locally at http://127.0.0.1:54424).

### Smoke test the dashboard with seeded data

```sh
SUPABASE_SERVICE_ROLE_KEY=... pnpm --filter @symphony/worker exec tsx scripts/seed.ts
```

Inserts two issues, a successful attempt with events, a failed attempt, and a queued retry — enough to render every dashboard surface.

### Tests

```sh
TEST_SUPABASE_URL=http://127.0.0.1:54421 \
TEST_SUPABASE_SERVICE_ROLE_KEY=... \
pnpm test
```

Integration tests (Repo, OrchestratorLoop, recovery) run against local Supabase. Without `TEST_SUPABASE_SERVICE_ROLE_KEY` they're skipped automatically.

### Quality checks

```sh
pnpm format:check
pnpm lint
pnpm test
```

See [SPEC.md](https://github.com/openai/symphony/blob/main/SPEC.md) for the source spec; `WORKFLOW.md` is the per-repo policy file.
