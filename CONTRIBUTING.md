# Contributing to symphony-ts

Thanks for helping improve `symphony-ts`. This repository is a TypeScript port of
Symphony with a worker daemon, a Next.js dashboard, shared schema code, and
Postgres-backed persistence.

## Development Setup

Requirements:

- Node.js 22 or newer
- pnpm 10.15.0 or newer
- Docker (for local Postgres)

Install dependencies:

```sh
pnpm install
```

Start local Postgres and apply migrations:

```sh
pnpm db:up
pnpm db:migrate
```

`pnpm db:reset` wipes the volume and re-applies migrations from scratch.

Create a local environment file:

```sh
cp .env.example .env.local
```

The default `DATABASE_URL` already matches `db/docker-compose.yml`. Add
`LINEAR_API_KEY` if you are running the worker against Linear.

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

Integration tests that touch the database are skipped unless
`TEST_DATABASE_URL` is set. To run them locally, point at the running
container:

```sh
TEST_DATABASE_URL=postgres://symphony:symphony@127.0.0.1:54422/symphony \
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
- When the schema changes, add a new SQL file under `db/migrations/` and update
  the matching Drizzle table in `packages/shared/src/db/schema.ts`. The two
  must stay in sync — there is no codegen step.

## Project Conventions

- Shared runtime contracts live in `packages/shared/src/schema.ts`.
- Drizzle schema definitions live in `packages/shared/src/db/schema.ts`.
- SQL migrations live in `db/migrations/` and are applied by `db/migrate.ts`.
- Worker orchestration code lives under `apps/worker/src`.
- Dashboard code lives under `apps/dashboard/src`.
- Local workflow configuration and prompt behavior are documented in
  `WORKFLOW.md`.
- Error handling and the `bestEffort` helper are documented in
  `docs/error-handling.md`. Bare empty `} catch {}` blocks are blocked by
  Biome's `noEmptyBlockStatements`; every silenced rejection needs an inline
  comment explaining why.

## Reporting Security Issues

Do not report suspected vulnerabilities in public issues. Follow
`SECURITY.md` instead.
