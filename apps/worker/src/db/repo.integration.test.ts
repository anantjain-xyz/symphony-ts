import { createServiceClient } from '@symphony/shared';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Repo } from './repo.js';
import { makeTestIssue, makeTestWorkflow } from './test-helpers.js';
import { TestScope } from './test-scope.js';

const URL = process.env.TEST_SUPABASE_URL ?? 'http://127.0.0.1:54421';
const SERVICE_ROLE = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY;

const skip = !SERVICE_ROLE;
const d = skip ? describe.skip : describe;

if (skip) {
  // eslint-disable-next-line no-console
  console.warn('repo integration tests skipped (set TEST_SUPABASE_SERVICE_ROLE_KEY to enable)');
}

d('Repo integration', () => {
  let db: ReturnType<typeof createServiceClient>;
  let repo: Repo;
  let scope: TestScope;

  beforeAll(() => {
    db = createServiceClient({ url: URL, serviceRoleKey: SERVICE_ROLE! });
    repo = new Repo(db);
  });

  beforeEach(() => {
    scope = new TestScope();
  });

  afterEach(async () => {
    await scope.cleanup(db);
  });

  it('upsertWorkflow + latestWorkflow round trip', async () => {
    const workflow = makeTestWorkflow({ sourceHash: scope.newWorkflowHash() });
    await repo.upsertWorkflow(workflow);
    const row = await repo.getWorkflowBySourceHash(workflow.sourceHash);
    expect(row?.source_hash).toBe(workflow.sourceHash);
    expect(row?.prompt_template).toBe(workflow.promptTemplate);
  });

  it('tryReserveAttempt is idempotent across concurrent reservations', async () => {
    const issueId = scope.newIssueId();
    await repo.upsertIssues([makeTestIssue({ id: issueId, identifier: scope.newIdentifier() })]);

    const first = await repo.tryReserveAttempt({
      issueId,
      attemptNumber: 1,
      workspacePath: '/tmp/symphony-tests/reserve',
    });
    expect(first).not.toBeNull();
    const second = await repo.tryReserveAttempt({
      issueId,
      attemptNumber: 1,
      workspacePath: '/tmp/symphony-tests/reserve',
    });
    expect(second).toBeNull();
  });

  it('attempt lifecycle: reserve -> running -> success', async () => {
    const issueId = scope.newIssueId();
    await repo.upsertIssues([makeTestIssue({ id: issueId, identifier: scope.newIdentifier() })]);

    const reserved = await repo.tryReserveAttempt({
      issueId,
      attemptNumber: 1,
      workspacePath: '/tmp/symphony-tests/lifecycle',
    });
    expect(reserved).not.toBeNull();
    await repo.markRunning(reserved!.id);
    expect(await repo.countRunning({ issueIds: [issueId] })).toBe(1);
    await repo.finishAttempt({ attemptId: reserved!.id, status: 'success' });
    expect(await repo.countRunning({ issueIds: [issueId] })).toBe(0);
    expect(await repo.lastAttemptNumber(issueId)).toBe(1);
  });

  it('agent_events append and recentEvents in chronological order', async () => {
    const issueId = scope.newIssueId();
    await repo.upsertIssues([makeTestIssue({ id: issueId, identifier: scope.newIdentifier() })]);

    const reserved = await repo.tryReserveAttempt({
      issueId,
      attemptNumber: 1,
      workspacePath: '/tmp/symphony-tests/events',
    });
    await repo.appendEvent(reserved!.id, 'status', { message: 'first' });
    await repo.appendEvent(reserved!.id, 'status', { message: 'second' });
    await repo.appendEvent(reserved!.id, 'humanized', { summary: 'wrapping up' });
    const events = await repo.recentEvents(reserved!.id);
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.kind)).toEqual(['status', 'status', 'humanized']);
  });

  it('retry_queue: schedule, dueRetries filters by due_at, clear', async () => {
    const pastId = scope.newIssueId();
    const futureId = scope.newIssueId();
    await repo.upsertIssues([
      makeTestIssue({ id: pastId, identifier: scope.newIdentifier() }),
      makeTestIssue({ id: futureId, identifier: scope.newIdentifier() }),
    ]);

    await repo.scheduleRetry({
      issueId: pastId,
      attemptNumber: 2,
      dueAt: new Date(Date.now() - 1000),
      errorClass: 'transient',
      errorMessage: 'flaky',
    });
    await repo.scheduleRetry({
      issueId: futureId,
      attemptNumber: 2,
      dueAt: new Date(Date.now() + 60_000),
      errorClass: null,
      errorMessage: null,
    });

    const mine = scope.issueIds;
    const due = (await repo.dueRetries()).filter((r) => mine.has(r.issue_id));
    expect(due.map((r) => r.issue_id)).toEqual([pastId]);

    await repo.clearRetry(pastId);
    const dueAfter = (await repo.dueRetries()).filter((r) => mine.has(r.issue_id));
    expect(dueAfter.length).toBe(0);
  });

  it('live_sessions upsert + token update + delete', async () => {
    const issueId = scope.newIssueId();
    await repo.upsertIssues([makeTestIssue({ id: issueId, identifier: scope.newIdentifier() })]);

    const reserved = await repo.tryReserveAttempt({
      issueId,
      attemptNumber: 1,
      workspacePath: '/tmp/symphony-tests/live',
    });
    await repo.upsertLiveSession({
      run_attempt_id: reserved!.id,
      session_id: 'thread-1-turn-1',
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    });
    await repo.updateTokens(reserved!.id, {
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
    });
    await repo.deleteLiveSession(reserved!.id);
  });
});
