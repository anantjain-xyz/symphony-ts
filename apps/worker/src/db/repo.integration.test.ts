import type { Issue, ParsedWorkflow } from '@symphony/shared';
import { createServiceClient } from '@symphony/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Repo } from './repo.js';

const URL = process.env.TEST_SUPABASE_URL ?? 'http://127.0.0.1:54421';
const SERVICE_ROLE = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY;

const skip = !SERVICE_ROLE;
const d = skip ? describe.skip : describe;

if (skip) {
  // eslint-disable-next-line no-console
  console.warn('repo integration tests skipped (set TEST_SUPABASE_SERVICE_ROLE_KEY to enable)');
}

const ISSUE_A: Issue = {
  id: '11111111-1111-1111-1111-111111111111',
  identifier: 'TEST-1',
  title: 'first',
  description: 'desc',
  priority: 1,
  state: 'todo',
  branch: null,
  labels: ['x'],
  blockers: [],
};

const ISSUE_B: Issue = {
  id: '22222222-2222-2222-2222-222222222222',
  identifier: 'TEST-2',
  title: 'second',
  description: null,
  priority: 2,
  state: 'in progress',
  branch: 'feat/test-2',
  labels: [],
  blockers: ['TEST-1'],
};

const WORKFLOW: ParsedWorkflow = {
  sourceHash: 'a'.repeat(64),
  promptTemplate: 'do work on {{identifier}}',
  frontMatter: {
    tracker: {
      kind: 'linear',
      endpoint: 'https://api.linear.app/graphql',
      api_key: 'k',
      active_states: ['todo'],
      terminal_states: ['done'],
    },
    polling: { interval_ms: 30000 },
    workspace: { root: '/tmp/symphony-tests' },
    hooks: { timeout_ms: 60000 },
    agent: {
      backend: 'codex',
      max_concurrent_agents: 4,
      max_retry_backoff_ms: 300000,
      max_concurrent_agents_by_state: {},
    },
    codex: {
      command: 'codex',
      approval_policy: 'never',
      thread_sandbox: 'workspace-write',
      turn_sandbox_policy: 'inherit',
      turn_timeout_ms: 3600000,
      network_access: false,
    },
    claude: {
      command: 'claude',
      permission_mode: 'acceptEdits',
      allowed_tools: [],
      disallowed_tools: [],
      add_dirs: [],
      turn_timeout_ms: 3600000,
    },
  },
};

d('Repo integration', () => {
  let db: ReturnType<typeof createServiceClient>;
  let repo: Repo;

  async function clean() {
    if (!db) {
      return;
    }

    // Cascading FKs handle the children; explicit deletes keep things obvious.
    await db.from('agent_events').delete().neq('id', 0);
    await db
      .from('live_sessions')
      .delete()
      .neq('run_attempt_id', '00000000-0000-0000-0000-000000000000');
    await db.from('hook_runs').delete().neq('id', 0);
    await db.from('retry_queue').delete().neq('issue_id', '');
    await db.from('run_attempts').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await db.from('issues').delete().neq('id', '');
    await db.from('workflows').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  }

  beforeAll(async () => {
    db = createServiceClient({ url: URL, serviceRoleKey: SERVICE_ROLE! });
    repo = new Repo(db);
    await clean();
  });

  beforeEach(async () => {
    await clean();
    await repo.upsertIssues([ISSUE_A, ISSUE_B]);
  });

  afterAll(clean);

  it('upsertWorkflow + latestWorkflow round trip', async () => {
    await repo.upsertWorkflow(WORKFLOW);
    const latest = await repo.latestWorkflow();
    expect(latest?.source_hash).toBe(WORKFLOW.sourceHash);
    expect(latest?.prompt_template).toBe(WORKFLOW.promptTemplate);
  });

  it('tryReserveAttempt is idempotent across concurrent reservations', async () => {
    const first = await repo.tryReserveAttempt({
      issueId: ISSUE_A.id,
      attemptNumber: 1,
      workspacePath: '/tmp/symphony-tests/TEST_1',
    });
    expect(first).not.toBeNull();
    const second = await repo.tryReserveAttempt({
      issueId: ISSUE_A.id,
      attemptNumber: 1,
      workspacePath: '/tmp/symphony-tests/TEST_1',
    });
    expect(second).toBeNull();
  });

  it('attempt lifecycle: reserve -> running -> success', async () => {
    const reserved = await repo.tryReserveAttempt({
      issueId: ISSUE_B.id,
      attemptNumber: 1,
      workspacePath: '/tmp/symphony-tests/TEST_2',
    });
    expect(reserved).not.toBeNull();
    await repo.markRunning(reserved!.id);
    expect(await repo.countRunning()).toBe(1);
    await repo.finishAttempt({ attemptId: reserved!.id, status: 'success' });
    expect(await repo.countRunning()).toBe(0);
    expect(await repo.lastAttemptNumber(ISSUE_B.id)).toBe(1);
  });

  it('agent_events append and recentEvents in chronological order', async () => {
    const reserved = await repo.tryReserveAttempt({
      issueId: ISSUE_A.id,
      attemptNumber: 1,
      workspacePath: '/tmp/symphony-tests/TEST_1',
    });
    await repo.appendEvent(reserved!.id, 'status', { message: 'first' });
    await repo.appendEvent(reserved!.id, 'status', { message: 'second' });
    await repo.appendEvent(reserved!.id, 'humanized', { summary: 'wrapping up' });
    const events = await repo.recentEvents(reserved!.id);
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.kind)).toEqual(['status', 'status', 'humanized']);
  });

  it('retry_queue: schedule, dueRetries filters by due_at, clear', async () => {
    await repo.scheduleRetry({
      issueId: ISSUE_A.id,
      attemptNumber: 2,
      dueAt: new Date(Date.now() - 1000),
      errorClass: 'transient',
      errorMessage: 'flaky',
    });
    await repo.scheduleRetry({
      issueId: ISSUE_B.id,
      attemptNumber: 2,
      dueAt: new Date(Date.now() + 60_000),
      errorClass: null,
      errorMessage: null,
    });
    const due = await repo.dueRetries();
    expect(due.map((r) => r.issue_id)).toEqual([ISSUE_A.id]);
    await repo.clearRetry(ISSUE_A.id);
    expect((await repo.dueRetries()).length).toBe(0);
  });

  it('live_sessions upsert + token update + delete', async () => {
    const reserved = await repo.tryReserveAttempt({
      issueId: ISSUE_B.id,
      attemptNumber: 1,
      workspacePath: '/tmp/symphony-tests/TEST_2',
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
