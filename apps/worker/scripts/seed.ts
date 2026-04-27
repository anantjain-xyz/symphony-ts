#!/usr/bin/env tsx
/**
 * Seed the local Postgres with a small fixture so the dashboard has something
 * to render. Useful for manual smoke testing.
 *
 *   DATABASE_URL=... pnpm --filter @symphony/worker exec tsx scripts/seed.ts
 */

import { createDb, type Issue } from '@symphony/shared';
import { Repo } from '../src/db/repo.js';

const URL = process.env.DATABASE_URL;
if (!URL) {
  console.error('DATABASE_URL required');
  process.exit(1);
}

const ISSUES: Issue[] = [
  {
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    identifier: 'SEED-1',
    title: 'Wire up the foo widget',
    description: 'Add foo to the widget panel.',
    priority: 1,
    state: 'in progress',
    branch: 'feat/foo-widget',
    labels: ['frontend'],
    blockers: [],
    pr_urls: [],
  },
  {
    id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    identifier: 'SEED-2',
    title: 'Investigate flaky test',
    description: null,
    priority: 2,
    state: 'todo',
    branch: null,
    labels: ['flake', 'tests'],
    blockers: ['SEED-1'],
    pr_urls: [],
  },
];

async function main() {
  const db = createDb(URL!, { max: 1 });
  const repo = new Repo(db);
  await repo.upsertIssues(ISSUES);

  // A finished, successful run for SEED-1 with a few events.
  const run = await repo.tryReserveRun({
    issueId: ISSUES[0]!.id,
    runNumber: 1,
    workspacePath: '/tmp/symphony-seed/SEED-1',
  });
  if (run) {
    await repo.markRunning(run.id);
    await repo.appendEvent(run.id, 'status', { message: 'Reading repository' });
    await repo.appendEvent(run.id, 'humanized', { summary: 'Reading repository' });
    await repo.appendEvent(run.id, 'tool_call', {
      tool: 'bash',
      args: { cmd: 'pnpm test' },
      result_summary: '40 tests passed',
    });
    await repo.appendEvent(run.id, 'humanized', { summary: 'bash: 40 tests passed' });
    await repo.appendEvent(run.id, 'token_count', {
      input_tokens: 1024,
      output_tokens: 256,
      total_tokens: 1280,
    });
    await repo.finishRun({ runId: run.id, status: 'success' });
  }

  // A failed run for SEED-2 + a retry queued.
  const failed = await repo.tryReserveRun({
    issueId: ISSUES[1]!.id,
    runNumber: 1,
    workspacePath: '/tmp/symphony-seed/SEED-2',
  });
  if (failed) {
    await repo.markRunning(failed.id);
    await repo.appendEvent(failed.id, 'error', {
      class: 'tool_failure',
      message: 'tests failed',
    });
    await repo.finishRun({
      runId: failed.id,
      status: 'failure',
      errorClass: 'tool_failure',
      errorMessage: 'tests failed',
    });
    await repo.scheduleRetry({
      issueId: ISSUES[1]!.id,
      runNumber: 2,
      dueAt: new Date(Date.now() + 60_000),
      errorClass: 'tool_failure',
      errorMessage: 'tests failed',
    });
  }

  console.log('Seeded. Visit http://localhost:3000');
  console.log(`  /issues/${ISSUES[0]!.id}`);
  console.log(`  /issues/${ISSUES[1]!.id}`);
  if (run) console.log(`  /runs/${run.id}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
