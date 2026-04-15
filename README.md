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
supabase start
pnpm db:types
pnpm -r build
```

See [SPEC.md](https://github.com/openai/symphony/blob/main/SPEC.md) for the source spec; `WORKFLOW.md` is the per-repo policy file.
