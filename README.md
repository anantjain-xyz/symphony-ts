# symphony-ts

[![CI](https://github.com/anantjain-xyz/symphony-ts/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/anantjain-xyz/symphony-ts/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/anantjain-xyz/symphony-ts/branch/main/graph/badge.svg)](https://codecov.io/gh/anantjain-xyz/symphony-ts)

TypeScript port of [Symphony](https://github.com/openai/symphony), backed by Supabase for persistence and realtime.

A long-running daemon that polls Linear for active issues, provisions isolated workspaces per issue, and runs Claude Code (or Codex) coding-agent sessions against them with retries, concurrency caps, and live operator observability.

## The big picture

```
   Linear (issues)                Supabase Postgres                  Operator
        │                          ┌──────────────┐                     │
        │ GraphQL                  │  issues      │                     │ browser
        │                          │  run_attempts│                     │
        ▼                          │  agent_events│                     ▼
 ┌──────────────┐   service key    │  live_sess.  │         ┌───────────────────┐
 │   WORKER     │ ───────────────▶ │  retry_queue │ service │  DASHBOARD        │
 │   (daemon)   │ ◀─────────────── │  hook_runs   │ ◀──key──│  (Next.js 15)     │
 │              │                  │  workflows   │         │  server proxy +   │
 │ poll → plan  │                  └──────────────┘         │  SSE realtime     │
 │ → dispatch   │                                           │                   │
 └──────┬───────┘                                           │  fleet / sessions │
        │ spawn                                             └───────────────────┘
        ▼
 ┌──────────────┐    NDJSON     ┌──────────────┐
 │ agent adapter│ ◀───JSON-RPC─▶│claude / codex│   ← the actual LLM agent
 │    (.mjs)    │               │  (subproc)   │
 └──────────────┘               └──────────────┘
        │
        ▼
 /tmp/symphony-workspaces/<issue>/   ← isolated filesystem per issue
```

Worker control loop: **poll Linear → upsert issues → apply concurrency caps → dispatch → stream events → retry with backoff on failure**.

## Layout

```
symphony-ts/
├── README.md              overview + local dev commands
├── WORKFLOW.md            ⭐ single source of truth: YAML + prompt template
├── package.json           monorepo root scripts
├── tsconfig.base.json     ES2022, strict
├── pnpm-workspace.yaml    apps/* + packages/*
├── biome.json             lint/format (no console, no debugger)
├── .env.example           env template
├── .github/workflows/ci.yml    format · lint · typecheck · test
│
├── supabase/              DB schema + local dev config
├── packages/shared/       zod schemas, DB types, client factory
└── apps/
    ├── worker/            Node.js orchestrator daemon
    └── dashboard/         Next.js 15 operator console
```

- `apps/worker/` — Node daemon (poll loop, orchestrator, workspace manager, agent runner)
- `apps/dashboard/` — Next.js operator console (live session view)
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
# fill in SUPABASE_SERVICE_ROLE_KEY     (from `supabase status` -> Secret)
#         LINEAR_API_KEY
#         ALLOWED_OPERATOR_EMAILS       (who is allowed to sign into the dashboard)
#         DASHBOARD_SESSION_SECRET      (HMAC secret for cookie signing; see .env.example)
```

The worker loads it via `dotenv` in `apps/worker/src/index.ts`; the dashboard
loads it via `loadEnvConfig` in `apps/dashboard/next.config.mjs`. The dashboard
no longer publishes any `NEXT_PUBLIC_SUPABASE_*` keys — all Supabase access is
server-side.

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

All Supabase reads happen on the server with the service-role key; the browser
never receives a database key. Access is gated by an operator allowlist
(`ALLOWED_OPERATOR_EMAILS`). To sign in, enter your email on `/login` — the
dashboard server prints a magic link to its stdout. Open that link to set a
signed session cookie. The link is valid for 15 minutes; the resulting session
lives 7 days. For a deployed instance, replace the stdout sink with email or
chat delivery (the magic link emit point is the only thing to change).

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
pnpm typecheck
pnpm test
```

`.github/workflows/ci.yml` runs the same format, lint, typecheck, and test gates on pull requests and pushes to `main`.

## Code walkthrough

### `packages/shared` — the contract layer

One package, re-exported from `index.ts`. Everything else depends on this.

```
packages/shared/src/
├── index.ts        barrel re-exports
├── schema.ts       ⭐ zod schemas → runtime validation + TS types
├── supabase.ts     createServiceClient() factory
└── db-types.ts     generated from Supabase (pnpm db:types)
```

| File | Key exports |
|---|---|
| `schema.ts` | `WorkflowFrontMatter`, `TrackerConfig`, `Issue`, `RunAttemptStatus`, `AgentEventKind`, `LiveSession`, event payload schemas |
| `supabase.ts` | `SymphonyClient` type, `createServiceClient()` |
| `db-types.ts` | `Database`, `Tables<'...'>`, `Enums<...>` — auto-generated, don't edit |

`schema.ts` defines *application* shapes (what the worker thinks an Issue is); `db-types.ts` defines *database* shapes. They overlap but aren't identical.

### `apps/worker` — the orchestrator daemon

```
apps/worker/src/
├── index.ts              entrypoint: load env, boot loop, handle signals
├── logging.ts            Pino + secret redaction
│
├── config/
│   ├── workflow.ts       parse WORKFLOW.md (gray-matter + env interpolation)
│   └── resolve.ts        merge workflow + env into ResolvedConfig
│
├── orchestrator/         ⭐ the control plane
│   ├── loop.ts           30s poll tick, reconcile, plan, dispatch
│   ├── dispatch.ts       single-attempt lifecycle (8 steps)
│   ├── concurrency.ts    global cap + per-state caps
│   └── backoff.ts        exponential + jitter
│
├── agent/                ⭐ the data plane
│   ├── runner.ts         AgentRunner: spawn adapter (codex | claude), stream events
│   ├── protocol.ts       NDJSON JSON-RPC wire types
│   └── events.ts         map agent events → DB rows
│
├── db/
│   ├── repo.ts           typed CRUD, AlreadyRunningError for races
│   └── recovery.ts       boot-time orphan/workspace reconciliation
│
├── workspace/
│   ├── manager.ts        per-issue dir lifecycle, ready-sentinel
│   └── hooks.ts          bash -lc hook runner with env filtering
│
├── tracker/
│   └── linear.ts         Linear GraphQL: fetchActive, fetchTerminal
│
└── prompt/
    └── render.ts         Mustache render + retry-context appending
```

Plus `agents/codex-adapter.mjs` and `agents/claude-adapter.mjs` — standalone Node scripts that bridge Symphony's NDJSON protocol to `codex exec --json` or `claude` respectively. `WORKFLOW.md`'s `agent.backend` (`codex` | `claude`; schema default `codex`, shipped `WORKFLOW.md` sets `claude`) picks which one. And `scripts/seed.ts` for seeding test data.

#### The hot path (`orchestrator/`)

**`loop.ts`** — one `tick()` does:

```
1. tracker.fetchActive()      ← Linear GraphQL
2. repo.upsertIssues()        ← refresh DB cache
3. reconcile in-flight        ← cancel attempts for no-longer-active issues
4. filter eligible            ← drop blocked / already-running / pending-retry
5. selectDispatchable()       ← apply concurrency caps
6. dispatchAttempt() × N      ← spawn in-flight
7. fire due retries           ← from retry_queue
8. sleep polling.interval_ms
```

**`dispatch.ts`** — one attempt does:

```
  ┌─ workspace.createOrReuse()
  │     └─ after_create hook (FATAL)   ← git clone, checkout
  ├─ repo.markRunning()                ← race-detected via partial unique index
  │     └─ before_run hook (non-fatal)
  ├─ prompt.render() + retry context
  ├─ AgentRunner.run()
  │     └─ for each turn event:
  │         ├─ agent_events INSERT     ← append-only firehose
  │         └─ live_sessions UPSERT    ← token counts, status
  │     └─ after_run hook (non-fatal)
  └─ finalize:
        success → repo.clearRetry()
        fail    → repo.scheduleRetry(backoffMs(attempt))
        timeout → interrupt, then SIGKILL after grace
```

**`concurrency.ts`** — `selectDispatchable(issues, active, caps)` returns the slate for this tick.
**`backoff.ts`** — `base * 2^(n-1)`, capped, ±20% jitter.

#### The agent bridge (`agent/`)

| File | Purpose |
|---|---|
| `protocol.ts` | Wire types: `initialize`, `thread/start`, `turn/start`, `turn/event`, `turn/complete`. Pure types, no logic. |
| `runner.ts` | `AgentRunner` class: spawns the selected adapter via execa, pipes NDJSON, emits events, handles interrupt/kill/timeout. |
| `events.ts` | `mapTurnEvent()` → `{ kind, payload }` that matches the `AgentEventKind` zod schema. |

#### Everything else

- **`db/repo.ts`** — typed wrappers around Supabase. `markRunning()` throws `AlreadyRunningError` if two dispatches race.
- **`db/recovery.ts`** — at boot: Linear preflight → snapshot WORKFLOW → rescue orphans (`status='running'` left over from a crash → mark `failed/process_crashed`, schedule retry, delete live_session) → wipe workspaces for terminal-state issues.
- **`workspace/manager.ts`** — creates `/tmp/symphony-workspaces/<sanitized-id>/`, uses a `.ready` sentinel to know if `after_create` succeeded.
- **`workspace/hooks.ts`** — runs hooks via `bash -lc`, filters env vars, records every invocation in `hook_runs`.
- **`tracker/linear.ts`** — GraphQL client. Typed errors (`LinearAuthError`, `LinearRateLimitError`). Sorts by priority P0→P4.
- **`prompt/render.ts`** — Mustache render + on retry prepends "previous attempt failed with …" context.
- **`logging.ts`** — Pino with `maskSecret()` for API keys.
- **`index.ts`** — loads env → builds config → inits repo/tracker/loop → `recover()` → `loop.start()` → SIGTERM graceful drain (30s), SIGHUP re-reads WORKFLOW.md.

Test files (`*.test.ts`) live next to sources. Integration tests (`*.integration.test.ts`) hit a local Supabase.

### `apps/dashboard` — the operator console

Next.js 15 + React 19 + Tailwind. Magic-link auth gates the whole UI; all
Supabase access runs server-side with the service-role key.

```
apps/dashboard/src/
├── middleware.ts                 ⭐ auth gate — redirects to /login if no session
├── app/
│   ├── layout.tsx                shell + header (operator email + log out)
│   ├── globals.css               Tailwind + dark theme
│   ├── login/page.tsx            magic-link request form
│   ├── page.tsx                  ⭐ fleet view: KPIs + active / retries / failures / past
│   ├── KpiBlock.tsx              KPI metric card
│   ├── LiveRuntime.tsx           worker heartbeat / uptime KPI
│   ├── RealtimeRefresh.tsx       EventSource → router.refresh
│   ├── issues/[id]/page.tsx      one issue, all its attempts
│   ├── sessions/[id]/
│   │   ├── page.tsx              attempt metadata (SSR)
│   │   ├── LiveStream.tsx        ⭐ client component, EventSource for live events
│   │   └── EventBlock.tsx        agent-event renderer
│   └── api/
│       ├── auth/login,callback,logout/route.ts   magic-link issue/verify/clear
│       └── realtime/
│           ├── fleet/route.ts                    SSE: fleet refresh ticks
│           └── sessions/[id]/route.ts            SSE: per-attempt agent_events
│
└── lib/
    ├── env.ts                    env validation (server-only secrets)
    ├── auth.ts                   operator allowlist + getCurrentSession()
    ├── session.ts                HMAC sign/verify (cookie + magic-link tokens)
    ├── sse.ts                    SSE ReadableStream helper
    └── supabase-server.ts        service-role client (server-only)
```

| Route | File | What you see |
|---|---|---|
| `/login` | `app/login/page.tsx` | Email form → magic link printed to dashboard server stdout |
| `/` | `app/page.tsx` | KPI header + four sections: Active runs, Retry queue, Recent failures, Past runs |
| `/issues/[id]` | `app/issues/[id]/page.tsx` | Issue header + attempts list w/ status colors |
| `/sessions/[id]` | `app/sessions/[id]/page.tsx` + `LiveStream.tsx` | Live event firehose — subscribes via `/api/realtime/sessions/[id]` SSE |

Worker and dashboard server both use the service-role key. The browser holds
only an HMAC-signed session cookie; it has no Supabase credentials and
subscribes to live updates exclusively through the auth-gated SSE proxy.

### `supabase/` — the schema

```
supabase/
├── config.toml                   local dev ports 54421-54427
└── migrations/
    ├── 20260415005242_init.sql                            ⭐ 7 tables, 3 enums, RLS, Realtime
    ├── 20260420220000_run_attempts_running_invariant.sql  partial unique index
    ├── 20260423000000_fix_realtime_publication.sql        target supabase_realtime publication
    ├── 20260423120000_dashboard_terminal_status.sql       rate_limit_state, worker_heartbeat, agent_events_latest view
    ├── 20260423120001_agent_event_kind_rate_limit.sql     adds 'rate_limit' enum value
    ├── 20260423230000_disable_auth_rls.sql                RLS off + anon SELECT grants (superseded)
    └── 20260425000000_revoke_anon_dashboard_grants.sql    revoke anon grants, re-enable RLS
```

The nine tables (+ one view):

```
 workflows             ← WORKFLOW.md snapshots (content-addressed)
 issues                ← normalized from Linear; upserted each tick
 run_attempts          ← one row per dispatch; status: pending/running/succeeded/failed/cancelled
 agent_events          ← append-only event firehose (the LLM's activity)
 live_sessions         ← ephemeral in-flight state; deleted on completion
 retry_queue           ← scheduled retries with due_at
 hook_runs             ← every before_/after_ hook invocation
 rate_limit_state      ← per-source rate-limit buckets
 worker_heartbeat      ← single-row liveness ping
 agent_events_latest   ← (view) latest event per run_attempt
```

The second migration adds a **partial unique index** on `run_attempts` where `status='running'` per `issue_id` — this is what makes `AlreadyRunningError` possible and prevents duplicate dispatch.

## Tracing a full lifecycle

```
 ① Linear issue goes active
           │
           ▼
 ② Worker tick picks it up → upsert → eligible → within caps
           │
           ▼
 ③ dispatchAttempt():
       workspace exists? → reuse, else create + git clone (after_create)
       markRunning (wins race)
       before_run hook
       AgentRunner spawns the configured adapter (codex or claude)
           │
           ▼
 ④ adapter streams turn/event → events.ts → agent_events INSERT
                                live_sessions UPSERT (tokens, status)
           │
           ▼
 ⑤ Dashboard LiveStream.tsx sees Realtime INSERTs → UI updates live
           │
           ▼
 ⑥ adapter returns turn/complete:
       success → clearRetry, finalize run_attempt='succeeded'
       failure → scheduleRetry(backoffMs), run_attempt='failed'
           │
           ▼
 ⑦ Next tick: if due retry → dispatch again (attempt #2 with retry context)
           │
           ▼
 ⑧ Linear issue becomes terminal → worker sweeps workspace dir
```

## Key design decisions

1. **WORKFLOW.md is configuration-as-content.** YAML for knobs, Mustache body for the prompt. One file to rewire behavior.
2. **Workspaces are per-issue, reusable across retries.** A `.ready` sentinel means `after_create` succeeded once; retries skip the expensive clone.
3. **Races are caught by a DB invariant, not an in-memory lock.** The partial unique index is the only thing you trust.
4. **Events are append-only; live_sessions is ephemeral.** History is immutable; "what's happening now" is a projection that dies on completion.
5. **Server-side proxy + magic-link auth for the dashboard.** Worker and dashboard server both use the service-role key; the browser holds only a signed session cookie. Operators sign in via a magic link printed to the dashboard server's stdout and gated by `ALLOWED_OPERATOR_EMAILS`. Live events reach the browser through auth-gated SSE endpoints — no Supabase credentials ever ship to the client.
6. **Graceful shutdown drains in-flight.** SIGTERM waits 30s, then SIGKILL.
7. **Boot recovery assumes crash-unsafe state.** Any row stuck `running` at startup is an orphan → fail + retry.

## Where to start reading

To understand the system, read in this order:

1. `WORKFLOW.md` — the config language
2. `packages/shared/src/schema.ts` — the types
3. `apps/worker/src/orchestrator/loop.ts` — the tick
4. `apps/worker/src/orchestrator/dispatch.ts` — one attempt
5. `apps/worker/src/agent/runner.ts` — the subprocess bridge
6. `supabase/migrations/20260415005242_init.sql` — the data model
7. `apps/dashboard/src/app/sessions/[id]/LiveStream.tsx` — how the UI stays live

That's the critical path. Everything else is support.

See [SPEC.md](https://github.com/openai/symphony/blob/main/SPEC.md) for the source spec; `WORKFLOW.md` is the per-repo policy file.
