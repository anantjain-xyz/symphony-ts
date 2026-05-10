#!/usr/bin/env tsx
/**
 * Populate the local Postgres with rich mock data so every dashboard surface
 * (active runs, retry queue, recent failures, KPIs, live tokens, rate-limit
 * pause) has something to render. Idempotent — re-running upserts existing
 * rows by deterministic id.
 *
 *   DATABASE_URL=... pnpm --filter @symphony/worker exec tsx scripts/seed-mock.ts
 */

import {
  agentEvents,
  type AgentEventKind,
  createDb,
  type Db,
  type Issue,
  liveSessions,
  type RunStatus,
  runs,
  type TablesInsert,
  workerHeartbeat,
} from '@symphony/shared';
import { eq, sql } from 'drizzle-orm';
import { Repo } from '../src/db/repo.js';

const URL = process.env.DATABASE_URL;
if (!URL) {
  console.error('DATABASE_URL required');
  process.exit(1);
}

// `issues.id` is `text`, not `uuid` — any stable string works. We use a
// uuid-shaped string keyed by `slot` so reruns upsert deterministically.
const issueId = (slot: string) => `mock-${slot}-0000-4000-8000-deadbeef0000`;

const NOW = Date.now();
const minutesAgo = (m: number) => new Date(NOW - m * 60_000);
const minutesFromNow = (m: number) => new Date(NOW + m * 60_000);

const ISSUES: Issue[] = [
  {
    id: issueId('iss01'),
    identifier: 'MOCK-101',
    title: 'Migrate billing webhook to idempotency keys',
    description:
      'Stripe retries can double-charge if our handler isn’t idempotent. Adopt a keyed dedupe table.',
    priority: 3,
    state: 'in progress',
    branch: 'feat/billing-idempotency',
    labels: ['backend', 'billing'],
    blockers: [],
    pr_urls: ['https://github.com/example/symphony/pull/421'],
  },
  {
    id: issueId('iss02'),
    identifier: 'MOCK-102',
    title: 'Hydration mismatch on /pricing in Safari 17',
    description: 'SSR vs client renders disagree on currency formatting.',
    priority: 2,
    state: 'in progress',
    branch: 'fix/pricing-hydration',
    labels: ['frontend', 'bug'],
    blockers: [],
    pr_urls: [],
  },
  {
    id: issueId('iss03'),
    identifier: 'MOCK-103',
    title: 'Add Postgres pgvector index for embeddings table',
    description: null,
    priority: 2,
    state: 'in progress',
    branch: 'perf/embeddings-ivfflat',
    labels: ['backend', 'perf'],
    blockers: [],
    pr_urls: [],
  },
  {
    id: issueId('iss04'),
    identifier: 'MOCK-104',
    title: 'Flaky e2e: checkout-cart-abandonment',
    description: 'Fails ~5% of the time on CI; passes locally.',
    priority: 2,
    state: 'todo',
    branch: null,
    labels: ['flake', 'tests'],
    blockers: ['MOCK-101'],
    pr_urls: [],
  },
  {
    id: issueId('iss05'),
    identifier: 'MOCK-105',
    title: 'Sentry alert: NullPointer in OrderRouter',
    description: 'Spike since the 4.2 release; correlates with promo-code path.',
    priority: 4,
    state: 'in progress',
    branch: 'fix/order-router-npe',
    labels: ['backend', 'incident'],
    blockers: [],
    pr_urls: [],
  },
  {
    id: issueId('iss06'),
    identifier: 'MOCK-106',
    title: 'Drop legacy /v1/users endpoint',
    description: 'Last caller migrated last quarter; safe to remove.',
    priority: 1,
    state: 'todo',
    branch: null,
    labels: ['backend', 'cleanup'],
    blockers: [],
    pr_urls: [],
  },
  {
    id: issueId('iss07'),
    identifier: 'MOCK-107',
    title: 'Document SSE reconnection semantics',
    description: 'Operators keep asking what happens on a 5xx mid-stream.',
    priority: 1,
    state: 'todo',
    branch: null,
    labels: ['docs'],
    blockers: [],
    pr_urls: [],
  },
  {
    id: issueId('iss08'),
    identifier: 'MOCK-108',
    title: 'Onboarding: empty-state copy for first-run dashboard',
    description: 'Currently it says "Nothing running." which feels accusatory.',
    priority: 1,
    state: 'done',
    branch: 'chore/onboarding-empty-state',
    labels: ['frontend', 'design'],
    blockers: [],
    pr_urls: ['https://github.com/example/symphony/pull/418'],
  },
  {
    id: issueId('iss09'),
    identifier: 'MOCK-109',
    title: 'Bump pnpm to 9.x and re-pin lockfile',
    description: null,
    priority: 1,
    state: 'todo',
    branch: null,
    labels: ['infra'],
    blockers: [],
    pr_urls: [],
  },
  {
    id: issueId('iss10'),
    identifier: 'MOCK-110',
    title: 'Audit log table is missing index on (actor_id, created_at)',
    description: 'Compliance dashboards do a seq-scan; slow above ~10M rows.',
    priority: 3,
    state: 'in progress',
    branch: 'perf/audit-log-index',
    labels: ['backend', 'perf'],
    blockers: [],
    pr_urls: [],
  },
];

async function main() {
  const db = createDb(URL!, { max: 1 });
  const repo = new Repo(db);

  await repo.upsertIssues(ISSUES);

  // Worker heartbeat — alive, ~2h23m of "uptime"
  await repo.upsertWorkerHeartbeat({
    startedAt: minutesAgo(143),
    workerPid: 24601,
  });
  await db
    .update(workerHeartbeat)
    .set({ last_beat_at: new Date().toISOString() })
    .where(eq(workerHeartbeat.id, 'worker'));

  // Rate-limit pause — source must match the configured backend prefix
  // (`<backend>_*`) for the dashboard's KPI-strip filter to pick it up.
  await repo.upsertRateLimit({
    source: 'claude_primary',
    remaining: 0,
    resetAt: minutesFromNow(7),
  });

  // ---- 4 active running runs with diverse latest events ----

  const r1 = await reserveAndStart(
    db,
    repo,
    ISSUES[0]!.id,
    1,
    '/tmp/symphony-mock/MOCK-101',
    24611,
    6,
  );
  if (r1) {
    await emit(db, r1, 'status', { message: 'Reading repository' }, 5.5);
    await emit(db, r1, 'humanized', { summary: 'Reading repository' }, 5.4);
    await emit(db, r1, 'tool_call', { tool: 'grep', args: { pattern: 'stripe' } }, 5.0);
    await emit(db, r1, 'humanized', { summary: 'grep: 14 matches across 8 files' }, 4.9);
    await emit(
      db,
      r1,
      'tool_call',
      {
        tool: 'bash',
        args: { cmd: 'pnpm vitest run billing/' },
        result_summary: '12 tests passed in 2.3s',
      },
      1.2,
    );
    await emit(db, r1, 'humanized', { summary: 'bash: 12 tests passed in 2.3s' }, 1.1);
    await emit(
      db,
      r1,
      'token_count',
      {
        input_tokens: 18420,
        output_tokens: 3210,
        total_tokens: 21630,
      },
      0.4,
    );
    await upsertLive(db, r1, 18420, 3210, 21630);
  }

  const r2 = await reserveAndStart(
    db,
    repo,
    ISSUES[1]!.id,
    1,
    '/tmp/symphony-mock/MOCK-102',
    24612,
    12,
  );
  if (r2) {
    await emit(db, r2, 'status', { message: 'Reproducing on Safari 17' }, 11);
    await emit(db, r2, 'humanized', { summary: 'Reproducing on Safari 17' }, 10.9);
    await emit(
      db,
      r2,
      'tool_call',
      {
        tool: 'edit',
        args: { path: 'apps/web/src/pricing/format.ts' },
        result_summary: 'patched 2 lines',
      },
      0.8,
    );
    await emit(
      db,
      r2,
      'humanized',
      { summary: 'edit: patched apps/web/src/pricing/format.ts' },
      0.75,
    );
    await emit(
      db,
      r2,
      'token_count',
      {
        input_tokens: 9120,
        output_tokens: 1840,
        total_tokens: 10960,
      },
      0.2,
    );
    await upsertLive(db, r2, 9120, 1840, 10960);
  }

  const r3 = await reserveAndStart(
    db,
    repo,
    ISSUES[2]!.id,
    1,
    '/tmp/symphony-mock/MOCK-103',
    24613,
    28,
  );
  if (r3) {
    await emit(db, r3, 'status', { message: 'Drafting migration' }, 27);
    await emit(db, r3, 'humanized', { summary: 'Drafting migration' }, 26.9);
    await emit(
      db,
      r3,
      'approval',
      {
        reason: 'Approve CREATE INDEX CONCURRENTLY on embeddings (≈40M rows)?',
      },
      0.5,
    );
    await emit(
      db,
      r3,
      'token_count',
      {
        input_tokens: 24100,
        output_tokens: 5430,
        total_tokens: 29530,
      },
      0.4,
    );
    await upsertLive(db, r3, 24100, 5430, 29530);
  }

  const r4 = await reserveAndStart(
    db,
    repo,
    ISSUES[4]!.id,
    2,
    '/tmp/symphony-mock/MOCK-105',
    24614,
    2,
  );
  if (r4) {
    await emit(db, r4, 'status', { message: 'Bisecting against 4.2 release' }, 1.8);
    await emit(db, r4, 'humanized', { summary: 'Bisecting against 4.2 release' }, 1.75);
    await emit(
      db,
      r4,
      'rate_limit',
      {
        source: 'claude_primary',
        remaining: 0,
        reset_at: minutesFromNow(7).toISOString(),
      },
      0.1,
    );
    await emit(
      db,
      r4,
      'token_count',
      {
        input_tokens: 4210,
        output_tokens: 612,
        total_tokens: 4822,
      },
      0.05,
    );
    await upsertLive(db, r4, 4210, 612, 4822);
  }

  // ---- recent failures (terminal) ----

  const r5 = await reserveAndStart(
    db,
    repo,
    ISSUES[3]!.id,
    1,
    '/tmp/symphony-mock/MOCK-104',
    24501,
    35,
  );
  if (r5) {
    await emit(db, r5, 'status', { message: 'Running e2e suite' }, 34);
    await emit(
      db,
      r5,
      'tool_call',
      {
        tool: 'bash',
        args: { cmd: 'pnpm playwright test checkout' },
        result_summary: '1 test failed (timeout)',
      },
      19,
    );
    await emit(
      db,
      r5,
      'error',
      {
        class: 'tool_failure',
        message: 'playwright: checkout-cart-abandonment timed out after 30000ms',
      },
      18.2,
    );
    await finish(
      db,
      r5,
      'failure',
      minutesAgo(18),
      'tool_failure',
      'playwright: checkout-cart-abandonment timed out after 30000ms',
    );
  }

  const r6 = await reserveAndStart(
    db,
    repo,
    ISSUES[5]!.id,
    1,
    '/tmp/symphony-mock/MOCK-106',
    24502,
    75,
  );
  if (r6) {
    await emit(db, r6, 'status', { message: 'Searching for callers' }, 74);
    await emit(db, r6, 'tool_call', { tool: 'bash', args: { cmd: 'rg "/v1/users" -n' } }, 73);
    await emit(
      db,
      r6,
      'error',
      {
        class: 'agent_timeout',
        message: 'agent exceeded 1800s wall-clock budget',
      },
      43,
    );
    await finish(
      db,
      r6,
      'timeout',
      minutesAgo(42),
      'agent_timeout',
      'agent exceeded 1800s wall-clock budget',
    );
  }

  const r7 = await reserveAndStart(
    db,
    repo,
    ISSUES[8]!.id,
    1,
    '/tmp/symphony-mock/MOCK-109',
    24503,
    130,
  );
  if (r7) {
    await emit(db, r7, 'status', { message: 'Updating lockfile' }, 129);
    await emit(
      db,
      r7,
      'error',
      {
        class: 'lockfile_conflict',
        message: 'pnpm-lock.yaml has merge markers; aborting',
      },
      122,
    );
    await finish(
      db,
      r7,
      'failure',
      minutesAgo(121),
      'lockfile_conflict',
      'pnpm-lock.yaml has merge markers; aborting',
    );
  }

  const r8 = await reserveAndStart(
    db,
    repo,
    ISSUES[9]!.id,
    1,
    '/tmp/symphony-mock/MOCK-110',
    24504,
    245,
  );
  if (r8) {
    await emit(
      db,
      r8,
      'tool_call',
      {
        tool: 'bash',
        args: { cmd: 'psql -c "create index ..."' },
        result_summary: 'ERROR: lock timeout',
      },
      241,
    );
    await emit(
      db,
      r8,
      'error',
      {
        class: 'tool_failure',
        message: 'psql: ERROR canceling statement due to lock timeout',
      },
      240.5,
    );
    await finish(
      db,
      r8,
      'failure',
      minutesAgo(240),
      'tool_failure',
      'psql: ERROR canceling statement due to lock timeout',
    );
  }

  // ---- retry queue ----
  await repo.scheduleRetry({
    issueId: ISSUES[3]!.id,
    runNumber: 2,
    dueAt: minutesFromNow(2),
    errorClass: 'tool_failure',
    errorMessage: 'playwright: checkout-cart-abandonment timed out after 30000ms',
  });
  await repo.scheduleRetry({
    issueId: ISSUES[5]!.id,
    runNumber: 2,
    dueAt: minutesFromNow(15),
    errorClass: 'agent_timeout',
    errorMessage: 'agent exceeded 1800s wall-clock budget',
  });
  await repo.scheduleRetry({
    issueId: ISSUES[8]!.id,
    runNumber: 2,
    dueAt: minutesFromNow(45),
    errorClass: 'lockfile_conflict',
    errorMessage: 'pnpm-lock.yaml has merge markers; aborting',
  });

  console.log('Mock fixtures inserted.');
  console.log('  Active runs:    4');
  console.log('  Pending retry:  3');
  console.log('  Recent fails:   4');
  console.log('  Issues:         10 mock + existing');
  console.log('  Visit http://localhost:3000');

  // Close the postgres-js pool so the process exits promptly instead of
  // sitting on idle connections.
  await db.close({ timeout: 5 });
}

// ---- helpers ----

async function reserveAndStart(
  db: Db,
  repo: Repo,
  issueIdValue: string,
  runNumber: number,
  workspacePath: string,
  pid: number,
  startedMinutesAgo: number,
): Promise<string | null> {
  const row = await repo.tryReserveRun({ issueId: issueIdValue, runNumber, workspacePath });
  if (!row) return null;
  // We bypass markRunning() because it stamps started_at = now(); for the
  // dashboard's relative-time labels we want a backdated timestamp.
  const startedAt = new Date(NOW - startedMinutesAgo * 60_000).toISOString();
  await db
    .update(runs)
    .set({ status: 'running', started_at: startedAt, worker_pid: pid })
    .where(eq(runs.id, row.id));
  return row.id;
}

async function emit(
  db: Db,
  runId: string,
  kind: AgentEventKind,
  payload: unknown,
  minutesAgoForCreatedAt: number,
) {
  await db.insert(agentEvents).values({
    run_id: runId,
    kind,
    payload: payload as TablesInsert<'agent_events'>['payload'],
    created_at: new Date(NOW - minutesAgoForCreatedAt * 60_000).toISOString(),
  });
}

async function finish(
  db: Db,
  runId: string,
  status: Exclude<RunStatus, 'pending' | 'running'>,
  endedAt: Date,
  errorClass: string | null,
  errorMessage: string | null,
) {
  await db
    .update(runs)
    .set({
      status,
      ended_at: endedAt.toISOString(),
      error_class: errorClass,
      error_message: errorMessage,
    })
    .where(eq(runs.id, runId));
}

async function upsertLive(db: Db, runId: string, inTok: number, outTok: number, totTok: number) {
  await db
    .insert(liveSessions)
    .values({
      run_id: runId,
      session_id: `mock-session-${runId.slice(0, 8)}`,
      thread_id: `mock-thread-${runId.slice(0, 8)}`,
      turn_id: `turn-${Math.floor(Math.random() * 1000)}`,
      input_tokens: inTok,
      output_tokens: outTok,
      total_tokens: totTok,
    })
    .onConflictDoUpdate({
      target: liveSessions.run_id,
      set: {
        input_tokens: sql`excluded.input_tokens`,
        output_tokens: sql`excluded.output_tokens`,
        total_tokens: sql`excluded.total_tokens`,
        last_event_at: sql`excluded.last_event_at`,
      },
    });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
