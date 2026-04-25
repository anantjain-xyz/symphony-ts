# Contributing to symphony-ts

Thanks for helping improve `symphony-ts`. This repository is a TypeScript port of
Symphony with a worker daemon, a Next.js dashboard, shared schema code, and
Supabase-backed persistence.

## Development Setup

Requirements:

- Node.js 22 or newer
- pnpm 10.15.0 or newer
- Supabase CLI

Install dependencies:

```sh
pnpm install
```

Start local Supabase:

```sh
supabase start
```

Generate database types after schema changes:

```sh
pnpm db:types
```

Create a local environment file:

```sh
cp .env.example .env.local
```

Fill in the keys from `supabase status` and add `LINEAR_API_KEY` if you are
running the worker against Linear.

Run the worker:

```sh
pnpm --filter @symphony/worker dev
```

Run the dashboard:

```sh
pnpm --filter @symphony/dashboard dev
```

## Quality Gates

Run the relevant checks before opening a pull request:

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
```

Integration tests that touch Supabase are skipped unless
`TEST_SUPABASE_SERVICE_ROLE_KEY` is set. To run them locally, start Supabase and
provide the test URL and service role key:

```sh
TEST_SUPABASE_URL=http://127.0.0.1:54421 \
TEST_SUPABASE_SERVICE_ROLE_KEY=... \
pnpm test
```

Use Biome for formatting and linting:

```sh
pnpm format
```

## Branches, Commits, and Pull Requests

- Use a focused branch name, preferably tied to the issue identifier, such as
  `symphony/SYM-11`.
- Keep commits scoped to one logical change.
- Prefix issue-driven commit subjects with the Linear issue identifier when one
  exists, for example `SYM-11: Add OSS governance files`.
- Include a short summary, test evidence, and the related issue in every pull
  request.
- Keep generated database types in `packages/shared/src/db-types.ts` in sync
  with migration changes.

## Project Conventions

- Shared runtime contracts live in `packages/shared/src/schema.ts`.
- Generated database types live in `packages/shared/src/db-types.ts` and should
  not be edited by hand.
- Worker orchestration code lives under `apps/worker/src`.
- Dashboard code lives under `apps/dashboard/src`.
- Local workflow configuration and prompt behavior are documented in
  `WORKFLOW.md`.

## Reporting Security Issues

Do not report suspected vulnerabilities in public issues. Follow
`SECURITY.md` instead.
