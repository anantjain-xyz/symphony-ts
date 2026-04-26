#!/usr/bin/env tsx
/**
 * Seed the local Supabase with a small fixture so the dashboard has something
 * to render. Useful for manual smoke testing.
 *
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... pnpm --filter @symphony/worker exec tsx scripts/seed.ts
 */

import { createServiceClient, type Issue } from '@symphony/shared';
import { Repo } from '../src/db/repo.js';

const URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54421';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) {
  console.error('SUPABASE_SERVICE_ROLE_KEY required');
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
  const db = createServiceClient({ url: URL, serviceRoleKey: KEY! });
  const repo = new Repo(db);
  await repo.upsertIssues(ISSUES);

  // A finished, successful attempt for SEED-1 with a few events.
  const attempt = await repo.tryReserveAttempt({
    issueId: ISSUES[0]!.id,
    attemptNumber: 1,
    workspacePath: '/tmp/symphony-seed/SEED-1',
  });
  if (attempt) {
    await repo.markRunning(attempt.id);
    await repo.appendEvent(attempt.id, 'status', { message: 'Reading repository' });
    await repo.appendEvent(attempt.id, 'humanized', { summary: 'Reading repository' });
    await repo.appendEvent(attempt.id, 'tool_call', {
      tool: 'bash',
      args: { cmd: 'pnpm test' },
      result_summary: '40 tests passed',
    });
    await repo.appendEvent(attempt.id, 'humanized', { summary: 'bash: 40 tests passed' });
    await repo.appendEvent(attempt.id, 'token_count', {
      input_tokens: 1024,
      output_tokens: 256,
      total_tokens: 1280,
    });
    await repo.finishAttempt({ attemptId: attempt.id, status: 'success' });
  }

  // A failed attempt for SEED-2 + a retry queued.
  const failed = await repo.tryReserveAttempt({
    issueId: ISSUES[1]!.id,
    attemptNumber: 1,
    workspacePath: '/tmp/symphony-seed/SEED-2',
  });
  if (failed) {
    await repo.markRunning(failed.id);
    await repo.appendEvent(failed.id, 'error', {
      class: 'tool_failure',
      message: 'tests failed',
    });
    await repo.finishAttempt({
      attemptId: failed.id,
      status: 'failure',
      errorClass: 'tool_failure',
      errorMessage: 'tests failed',
    });
    await repo.scheduleRetry({
      issueId: ISSUES[1]!.id,
      attemptNumber: 2,
      dueAt: new Date(Date.now() + 60_000),
      errorClass: 'tool_failure',
      errorMessage: 'tests failed',
    });
  }

  console.log('Seeded. Visit http://localhost:3000');
  console.log(`  /issues/${ISSUES[0]!.id}`);
  console.log(`  /issues/${ISSUES[1]!.id}`);
  if (attempt) console.log(`  /runs/${attempt.id}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
