# symphony-ts

> **Coinbase fork** — this is a fork of [anantjain-xyz/symphony-ts](https://github.com/anantjain-xyz/symphony-ts), adapted for internal Coinbase use. Upstream changes are pulled in periodically; Coinbase-specific adaptations live on this fork.

TypeScript port of [Symphony](https://github.com/openai/symphony), backed by a local Postgres for persistence and `LISTEN/NOTIFY` for live updates, with support for Claude Code in addition to Codex.

A long-running daemon that polls Linear for active issues, provisions isolated workspaces per issue, and runs Claude Code (or Codex) coding-agent sessions against them with retries, concurrency caps, and live operator observability.

<img width="1512" height="801" alt="Screenshot 2026-04-27 at 12 19 02 PM" src="https://github.com/user-attachments/assets/7c193679-edaf-4056-b6a4-f3ae6f311cde" />

## Quickstart

**Prereqs:** Node 20+, pnpm 9+, Docker. A Linear API key for live runs — or skip it and use seeded data (see below).

```sh
pnpm install
pnpm db:up && pnpm db:migrate
cp .env.example .env.local            # fill in LINEAR_API_KEY
pnpm -r build
pnpm --filter @symphony/worker dev    # terminal 1
pnpm --filter @symphony/dashboard dev # terminal 2 → http://localhost:3333
```

No Linear key handy? Skip the worker and seed mock fixtures into Postgres to render every dashboard surface:

```sh
pnpm --filter @symphony/worker exec tsx scripts/seed-mock.ts
pnpm --filter @symphony/dashboard dev
```

See **Local dev** below for env details, retargeting, and tests.

## The big picture

```
   Linear (issues)                  Postgres (docker)                    Operator
        │                          ┌──────────────┐                       │
        │ GraphQL                  │  issues      │                       │ browser
        │                          │  runs        │                       │
        ▼                          │  agent_events│                       ▼
 ┌──────────────┐    DATABASE_URL  │  live_sess.  │            ┌────────────────────┐
 │   WORKER     │ ───────────────▶ │  retry_queue │◀── SSE ────│  DASHBOARD         │
 │   (daemon)   │ ◀─────────────── │  hook_runs   │  /api/stream│  (Next.js 15)     │
 │              │                  │  workflows   │            │                    │
 │ poll → plan  │                  └──────┬───────┘            │  fleet / runs      │
 │ → dispatch   │                         │                    └────────────────────┘
 └──────┬───────┘                         │ pg_notify (triggers)
        │ spawn                           │
        ▼                                 ▼
 ┌──────────────┐    NDJSON        symphony_changes  ──── coarse fanout
 │ agent adapter│ ◀───JSON-RPC─▶  agent_events:<run_id> ── per-run live stream
 │    (.mjs)    │
 └──────────────┘
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
├── db/                    docker-compose Postgres + SQL migrations + tiny migrate runner
├── packages/shared/       zod schemas, Drizzle schema, DB client factory
└── apps/
    ├── worker/            Node.js orchestrator daemon
    └── dashboard/         Next.js 15 operator console
```

- `apps/worker/` — Node daemon (poll loop, orchestrator, workspace manager, agent runner)
- `apps/dashboard/` — Next.js operator console (live session view)
- `packages/shared/` — zod schemas, Drizzle schema, `createDb()` / `createListener()` factories
- `db/` — `docker-compose.yml` (postgres:16), raw SQL migrations, `migrate.ts`

## Local dev

```sh
pnpm install
pnpm db:up                     # start postgres on :54422 via docker
pnpm db:migrate                # apply ./db/migrations
pnpm -r build                  # build everything
```

`pnpm db:reset` wipes the volume and re-applies migrations from scratch. `pnpm db:down` stops the container.

### Env

Both apps read from a single `.env.local` at the repo root:

```sh
cp .env.example .env.local
# fill in DATABASE_URL    (default: postgres://symphony:symphony@127.0.0.1:54422/symphony)
#         LINEAR_API_KEY
```

The worker loads it via `dotenv` in `apps/worker/src/index.ts`; the dashboard
loads it via `loadEnvConfig` in `apps/dashboard/next.config.mjs`. The dashboard
uses `DATABASE_URL` server-side only — it never lands in the browser bundle.

### Retargeting at a different repo / Linear team

Symphony is repo-agnostic. The common case (new repo + new Linear team in the same shape as the old one) is an `.env.local` edit only — `WORKFLOW.md` reads the values via `${VAR}` interpolation.

**`.env.local`**

| Field | Change to |
|---|---|
| `REPO_URL` | The new repo's git URL — `after_create` clones from this. |
| `LINEAR_API_KEY` | Only if the new team is in a different Linear workspace than the previous one. |
| `SYMPHONY_LINEAR_WORKSPACE` | The new Linear workspace slug (`linear.app/<slug>/...`). Used by the dashboard to render "linear ↗" links. Leave blank to hide the link. |
| `SYMPHONY_TRACKER_PREFIX` | The new team's issue prefix (e.g. `PB-`). **Required when the API key has access to multiple teams in one workspace** — otherwise the worker picks up every team's issues. Leave blank when the workspace has only one team. |
| `SYMPHONY_INSTALL_CMD` | Install command run by `after_create` (e.g. `npm ci`, `pnpm install --frozen-lockfile`, `yarn install --frozen-lockfile`). Leave blank to default to `npm ci`. Set to `:` (bash no-op) if the repo isn't a Node project. |

Edit **`WORKFLOW.md`** only when the new team's shape differs from the defaults:

| Field | Change to |
|---|---|
| `tracker.active_states` / `tracker.terminal_states` | Only if the new team's Linear states differ. The `Status routing` table in the prompt body assumes `Todo`, `In Progress`, `Rework`, `Merging`, `In Review`, `Done` exist — if any are missing, either add them to the team in Linear or trim the routing table. |
| `hooks.after_create` | Only if the install step needs more than swapping the command (e.g. extra setup steps); for a plain package-manager swap, set `SYMPHONY_INSTALL_CMD` instead. |
| `claude.allowed_tools` | Match the package-manager / language tooling the agent will need (`Bash(npm *)` vs `Bash(pnpm *)`, `Bash(cargo *)`, `Bash(uv *)`, etc.). |

The Mustache-templated prompt body below the frontmatter is repo-neutral and usually doesn't need editing.

### Worker

```sh
pnpm --filter @symphony/worker dev
```

Hit `Ctrl-C` to drain (loop.stop runs with a 30 s grace deadline).

### Dashboard

```sh
pnpm --filter @symphony/dashboard dev
# open http://localhost:3333
```

The dashboard is open to anyone who can reach the port — auth is disabled because this stack is intended to run on a local machine.

### Smoke test the dashboard with seeded data

```sh
DATABASE_URL=... pnpm --filter @symphony/worker exec tsx scripts/seed.ts
```

Inserts two issues, a successful attempt with events, a failed attempt, and a queued retry — enough to render every dashboard surface.

### Tests

```sh
TEST_DATABASE_URL=postgres://symphony:symphony@127.0.0.1:54422/symphony \
pnpm test
```

Integration tests (Repo, OrchestratorLoop, recovery) run against the local Postgres. Without `TEST_DATABASE_URL` they're skipped automatically.

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
└── db/
    ├── schema.ts    Drizzle table/enum/view definitions (mirror of db/migrations)
    ├── client.ts    createDb() + createListener() factories
    └── types.ts     Tables<>/TablesInsert<>/TablesUpdate<> shim over Drizzle's $infer
```

| File | Key exports |
|---|---|
| `schema.ts` | `WorkflowFrontMatter`, `TrackerConfig`, `Issue`, `RunStatus`, `AgentEventKind`, `LiveSession`, event payload schemas |
| `db/schema.ts` | `runs`, `issues`, `agentEvents`, `liveSessions`, `retryQueue`, `workflows`, `hookRuns`, `rateLimitState`, `workerHeartbeat`, `agentEventsLatest` view, plus `runStatusEnum` / `agentEventKindEnum` / `hookNameEnum` and the `Json` type |
| `db/client.ts` | `Db` type, `createDb(url, opts)` (Drizzle + postgres-js pool), `createListener(url)` (dedicated postgres-js client for `LISTEN`) |
| `db/types.ts` | `Tables<'runs'>` / `TablesInsert<'runs'>` / `TablesUpdate<'runs'>` — backed by Drizzle's column inference |

`schema.ts` defines *application* shapes (what the worker thinks an Issue is); `db/schema.ts` defines *database* shapes. They overlap but aren't identical.

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
│   ├── repo.ts           typed Drizzle CRUD, AlreadyRunningError for races
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
3. reconcile in-flight        ← cancel runs for no-longer-active issues
4. filter eligible            ← drop blocked / already-running / pending-retry
5. selectDispatchable()       ← apply concurrency caps
6. dispatchRun() × N          ← spawn in-flight
7. fire due retries           ← from retry_queue
8. sleep polling.interval_ms
```

**`dispatch.ts`** — one run does:

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
        fail    → repo.scheduleRetry(backoffMs(runNumber))
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

- **`db/repo.ts`** — typed Drizzle wrappers. `markRunning()` throws `AlreadyRunningError` if two dispatches race (postgres returns `code: '23505'` on the partial unique index).
- **`db/recovery.ts`** — at boot: Linear preflight → snapshot WORKFLOW → rescue orphans (`status='running'` left over from a crash → mark `failed/process_crashed`, schedule retry, delete live_session) → wipe workspaces for terminal-state issues.
- **`workspace/manager.ts`** — creates `/tmp/symphony-workspaces/<sanitized-id>/`, uses a `.ready` sentinel to know if `after_create` succeeded.
- **`workspace/hooks.ts`** — runs hooks via `bash -lc`, filters env vars, records every invocation in `hook_runs`.
- **`tracker/linear.ts`** — GraphQL client. Typed errors (`LinearAuthError`, `LinearRateLimitError`). Sorts by priority P0→P4.
- **`prompt/render.ts`** — Mustache render + on retry prepends "previous attempt failed with …" context.
- **`logging.ts`** — Pino with `maskSecret()` for API keys.
- **`index.ts`** — loads env → builds config → inits repo/tracker/loop → `recover()` → `loop.start()` → SIGTERM graceful drain (30s), SIGHUP re-reads WORKFLOW.md.

Test files (`*.test.ts`) live next to sources. Integration tests (`*.integration.test.ts`) hit the local Postgres.

### `apps/dashboard` — the operator console

Next.js 15 + React 19 + Tailwind. No auth — the app is local-only.

```
apps/dashboard/src/
├── app/
│   ├── layout.tsx                shell + header
│   ├── globals.css               Tailwind + dark theme
│   ├── page.tsx                  ⭐ fleet view: KPIs + active / retries / failures / past
│   ├── KpiBlock.tsx              KPI metric card
│   ├── LiveRuntime.tsx           worker heartbeat / uptime KPI
│   ├── RealtimeRefresh.tsx       /api/stream EventSource → router.refresh
│   ├── api/stream/route.ts       SSE bridge: LISTEN symphony_changes
│   ├── api/runs/[id]/stream/     SSE bridge: LISTEN agent_events:<run_id>
│   ├── issues/[id]/page.tsx      one issue, all its runs
│   └── runs/[id]/
│       ├── page.tsx              run metadata (SSR)
│       ├── LiveStream.tsx        ⭐ client component, EventSource
│       └── EventBlock.tsx        agent-event renderer
│
└── lib/
    ├── env.ts                    env validation
    └── db.ts                     server-side Drizzle singleton
```

| Route | File | What you see |
|---|---|---|
| `/` | `app/page.tsx` | KPI header + three sections: Active runs, Retry queue, Recent failures |
| `/issues` / `/issues/[id]` | `app/issues/page.tsx` + `app/issues/[id]/page.tsx` | Issue list and issue detail with the runs list w/ status colors |
| `/runs` / `/runs/[id]` | `app/runs/page.tsx` + `app/runs/[id]/page.tsx` + `LiveStream.tsx` | All runs list, plus per-run live event firehose — subscribes to `/api/runs/<id>/stream` |

The dashboard never connects to Postgres from the browser. Server Components read via the Drizzle singleton; the browser receives realtime updates over Server-Sent Events from the two route handlers above.

### `db/` — the schema

```
db/
├── docker-compose.yml      postgres:16-alpine on :54422
├── migrate.ts              tiny migration runner: advisory lock + _migrations table
└── migrations/
    └── 20260415005242_init.sql  complete fresh-start schema
```

The nine tables (+ one view):

```
 workflows             ← WORKFLOW.md snapshots (content-addressed)
 issues                ← normalized from Linear; upserted each tick
 runs                  ← one row per dispatch; status: pending/running/success/failure/timeout/cancelled
 agent_events          ← append-only event firehose (the LLM's activity)
 live_sessions         ← ephemeral in-flight Claude SDK session state; deleted on completion
 retry_queue           ← scheduled retries with due_at
 hook_runs             ← every before_/after_ hook invocation
 rate_limit_state      ← per-source rate-limit buckets
 worker_heartbeat      ← single-row liveness ping
 agent_events_latest   ← (view) latest event per run
```

The init migration adds a **partial unique index** on `runs` where `status='running'` per `issue_id` — this is what makes `AlreadyRunningError` possible and prevents duplicate dispatch.

The init migration also installs two trigger functions:
- `notify_table_change()` fires on every INSERT/UPDATE/DELETE of `runs`, `retry_queue`, `live_sessions`, `rate_limit_state` and emits `pg_notify('symphony_changes', '{"table":"…","op":"…"}')`. The dashboard's `/api/stream` SSE route forwards each NOTIFY to the browser, where `RealtimeRefresh.tsx` calls `router.refresh()` (debounced 600 ms).
- `notify_agent_event()` fires on `agent_events` INSERT, emitting the full row JSON on `agent_events:<run_id>` (or a slim `{id, run_id, kind, created_at, truncated: true}` payload when the row exceeds pg_notify's 8 KB ceiling). The per-run `/api/runs/[id]/stream` route forwards these; `LiveStream.tsx` appends each payload to its event list.

## Tracing a full lifecycle

```
 ① Linear issue goes active
           │
           ▼
 ② Worker tick picks it up → upsert → eligible → within caps
           │
           ▼
 ③ dispatchRun():
       workspace exists? → reuse, else create + git clone (after_create)
       markRunning (wins race)
       before_run hook
       AgentRunner spawns the configured adapter (codex or claude)
           │
           ▼
 ④ adapter streams turn/event → events.ts → agent_events INSERT
                                live_sessions UPSERT (tokens, status)
           │                       │
           │                       ▼
           │                  pg_notify trigger ─── agent_events:<run_id>
           │                                       symphony_changes
           ▼                                              │
 ⑤ Dashboard /api/stream + /api/runs/[id]/stream SSE ◀───┘ → UI updates live
           │
           ▼
 ⑥ adapter returns turn/complete:
       success → clearRetry, finalize runs.status='success'
       failure → scheduleRetry(backoffMs), runs.status='failure'
           │
           ▼
 ⑦ Next tick: if due retry → dispatch again (run #2 with retry context)
           │
           ▼
 ⑧ Linear issue becomes terminal → worker sweeps workspace dir
```

## Key design decisions

1. **WORKFLOW.md is configuration-as-content.** YAML for knobs, Mustache body for the prompt. One file to rewire behavior.
2. **Workspaces are per-issue, reusable across retries.** A `.ready` sentinel means `after_create` succeeded once; retries skip the expensive clone.
3. **Races are caught by a DB invariant, not an in-memory lock.** The partial unique index is the only thing you trust.
4. **Events are append-only; live_sessions is ephemeral.** History is immutable; "what's happening now" is a projection that dies on completion.
5. **Local-only, no auth.** The DB owner role is implicit through `DATABASE_URL`; the dashboard never exposes Postgres credentials to the browser. Don't expose the dashboard to an untrusted network.
6. **Realtime is plain Postgres.** `pg_notify` triggers + a Next.js SSE route handler holding a `LISTEN` connection. No extra services, no message broker, no WebSocket library.
7. **Graceful shutdown drains in-flight.** SIGTERM waits 30s, then SIGKILL.
8. **Boot recovery assumes crash-unsafe state.** Any row stuck `running` at startup is an orphan → fail + retry.

## Where to start reading

To understand the system, read in this order:

1. `WORKFLOW.md` — the config language
2. `packages/shared/src/schema.ts` — the types
3. `apps/worker/src/orchestrator/loop.ts` — the tick
4. `apps/worker/src/orchestrator/dispatch.ts` — one attempt
5. `apps/worker/src/agent/runner.ts` — the subprocess bridge
6. `db/migrations/20260415005242_init.sql` — the data model + the realtime fanout
7. `apps/dashboard/src/app/runs/[id]/LiveStream.tsx` + `apps/dashboard/src/app/api/runs/[id]/stream/route.ts` — how the UI stays live

That's the critical path. Everything else is support.

See [SPEC.md](https://github.com/openai/symphony/blob/main/SPEC.md) for the source spec; `WORKFLOW.md` is the per-repo policy file.

## License & publishing

Licensed under [MIT](./LICENSE).

All workspaces are `private: true`: since this is an app, not a library, and we don't publish to npm. The name `symphony-ts` already exists on npm under a different maintainer, so if we ever flip publishing on we'll need to rename (e.g. `@anantjain/symphony` or scoped per workspace). Until then, the collision is harmless.

Versioning is managed by [Changesets](https://github.com/changesets/changesets): run `pnpm changeset` to record a change, `pnpm version` to bump packages and update `CHANGELOG.md`, and `pnpm release` to tag the release commit on `main`.
