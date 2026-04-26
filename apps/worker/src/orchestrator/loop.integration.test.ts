import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServiceClient, type Issue } from '@symphony/shared';
import pino from 'pino';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resolveConfig } from '../config/resolve.js';
import { Repo } from '../db/repo.js';
import { makeTestIssue, makeTestWorkflow } from '../db/test-helpers.js';
import { TestScope } from '../db/test-scope.js';
import type { TrackerClient } from '../tracker/linear.js';
import { WorkspaceManager } from '../workspace/manager.js';
import { dispatchRun } from './dispatch.js';
import { OrchestratorLoop } from './loop.js';

const SUPA_URL = process.env.TEST_SUPABASE_URL ?? 'http://127.0.0.1:54421';
const SERVICE_ROLE = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY;
const skip = !SERVICE_ROLE;
const d = skip ? describe.skip : describe;

if (skip) {
  console.warn(
    'orchestrator integration tests skipped (set TEST_SUPABASE_SERVICE_ROLE_KEY to enable)',
  );
}

const STUB = path.resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../agent/__fixtures__/stub-codex.mjs',
);

function stubTracker(issues: Issue[]): TrackerClient {
  return {
    preflight: async () => {},
    fetchActive: async () => [...issues],
    fetchById: async (id) => issues.find((i) => i.id === id) ?? null,
    fetchTerminal: async () => [],
  };
}

d('OrchestratorLoop integration', () => {
  let db: ReturnType<typeof createServiceClient>;
  let repo: Repo;
  let wsRoot: string;
  let scope: TestScope;

  beforeAll(() => {
    db = createServiceClient({ url: SUPA_URL, serviceRoleKey: SERVICE_ROLE! });
    repo = new Repo(db);
  });

  beforeEach(async () => {
    scope = new TestScope();
    wsRoot = await mkdtemp(path.join(tmpdir(), 'symphony-loop-'));
  });

  afterEach(async () => {
    await scope.cleanup(db);
    await rm(wsRoot, { recursive: true, force: true });
  });

  it('one tick: dispatches, succeeds, persists events and finishes run', async () => {
    const issue = makeTestIssue({ id: scope.newIssueId(), identifier: scope.newIdentifier() });
    const codexCommand = `STUB_SCENARIO=happy node ${STUB}`;
    const config = resolveConfig(
      makeTestWorkflow({ sourceHash: scope.newWorkflowHash(), wsRoot, codexCommand }),
    );
    const loop = new OrchestratorLoop({
      tracker: stubTracker([issue]),
      repo,
      workspaces: new WorkspaceManager(wsRoot),
      config,
      log: pino({ level: 'silent' }),
      scopedIssueIds: [...scope.issueIds],
    });
    await loop.tick();
    const handles = (loop as unknown as { active: Map<string, { done: Promise<void> }> }).active;
    await Promise.all([...handles.values()].map((h) => h.done));

    const { data: run } = await db
      .from('runs')
      .select('*')
      .eq('issue_id', issue.id)
      .single();
    expect(run!.status).toBe('success');

    const { data: events } = await db
      .from('agent_events')
      .select('*')
      .eq('run_id', run!.id)
      .order('id', { ascending: true });
    const kinds = events!.map((e) => e.kind);
    expect(kinds).toContain('status');
    expect(kinds).toContain('tool_call');
    expect(kinds).toContain('token_count');
    expect(kinds).toContain('humanized');
  });

  it('respects max_concurrent_agents=2 with 3 eligible issues', async () => {
    const issues = [
      makeTestIssue({ id: scope.newIssueId(), identifier: scope.newIdentifier() }),
      makeTestIssue({ id: scope.newIssueId(), identifier: scope.newIdentifier(), priority: 2 }),
      makeTestIssue({ id: scope.newIssueId(), identifier: scope.newIdentifier(), priority: 2 }),
    ];
    const codexCommand = `STUB_SCENARIO=happy node ${STUB}`;
    const wf = makeTestWorkflow({ sourceHash: scope.newWorkflowHash(), wsRoot, codexCommand });
    wf.frontMatter.agent.max_concurrent_agents = 2;
    const loop = new OrchestratorLoop({
      tracker: stubTracker(issues),
      repo,
      workspaces: new WorkspaceManager(wsRoot),
      config: resolveConfig(wf),
      log: pino({ level: 'silent' }),
      scopedIssueIds: [...scope.issueIds],
    });
    await loop.tick();
    const active = (loop as unknown as { active: Map<string, unknown> }).active;
    expect(active.size).toBe(2);
    await Promise.all(
      [...(active as Map<string, { done: Promise<void> }>).values()].map((h) => h.done),
    );
  });

  it('failure schedules a retry in retry_queue', async () => {
    const issue = makeTestIssue({ id: scope.newIssueId(), identifier: scope.newIdentifier() });
    const codexCommand = `STUB_SCENARIO=error node ${STUB}`;
    const config = resolveConfig(
      makeTestWorkflow({ sourceHash: scope.newWorkflowHash(), wsRoot, codexCommand }),
    );
    const loop = new OrchestratorLoop({
      tracker: stubTracker([issue]),
      repo,
      workspaces: new WorkspaceManager(wsRoot),
      config,
      log: pino({ level: 'silent' }),
      scopedIssueIds: [...scope.issueIds],
    });
    await loop.tick();
    const active = (loop as unknown as { active: Map<string, { done: Promise<void> }> }).active;
    await Promise.all([...active.values()].map((h) => h.done));
    const { data: q } = await db.from('retry_queue').select('*').eq('issue_id', issue.id);
    expect(q!.length).toBe(1);
    expect(q![0]!.run_number).toBe(2);
  });

  it('cancelling a mid-run clears the pre-existing retry_queue row', async () => {
    // Regression for SYM-7: a prior failed run scheduled a retry; the
    // next run starts, is cancelled mid-flight (issue state changed
    // externally, triggering reconcile), and must not leave the stale
    // retry row behind — the issue has moved on.
    const issue = makeTestIssue({ id: scope.newIssueId(), identifier: scope.newIdentifier() });
    await repo.upsertIssues([issue]);
    await repo.scheduleRetry({
      issueId: issue.id,
      runNumber: 2,
      dueAt: new Date(Date.now() + 60_000),
      errorClass: 'turn_failed',
      errorMessage: 'prior run failed',
    });

    const codexCommand = `STUB_SCENARIO=interrupt node ${STUB}`;
    const config = resolveConfig(
      makeTestWorkflow({ sourceHash: scope.newWorkflowHash(), wsRoot, codexCommand }),
    );
    const workspaces = new WorkspaceManager(wsRoot);
    const reserved = await repo.tryReserveRun({
      issueId: issue.id,
      runNumber: 2,
      workspacePath: workspaces.pathFor(issue.identifier),
    });
    expect(reserved).not.toBeNull();

    const handle = dispatchRun(
      { repo, workspaces, config, log: pino({ level: 'silent' }) },
      issue,
      reserved!,
    );

    // Wait for markRunning to land before cancelling so we exercise the
    // mid-run cancel branch rather than the AlreadyRunningError path.
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const { data } = await db
        .from('runs')
        .select('status')
        .eq('id', reserved!.id)
        .single();
      if (data?.status === 'running') break;
      await new Promise((r) => setTimeout(r, 25));
    }

    await handle.cancel('issue state changed');
    await handle.done;

    const { data: finished } = await db
      .from('runs')
      .select('*')
      .eq('id', reserved!.id)
      .single();
    expect(finished!.status).toBe('cancelled');
    expect(finished!.error_class).toBe('reconciled');

    const { data: q } = await db.from('retry_queue').select('*').eq('issue_id', issue.id);
    expect(q!.length).toBe(0);
  });

  it('skips dispatch while rate_limit_state has a future reset_at for the backend', async () => {
    // SYM-14 regression: before the rate-limit gate, every tick would launch
    // a fresh run and immediately hammer the upstream that just told us
    // to back off. With the gate in place, a future `reset_at` for any
    // `codex_*` source pauses the entire tick.
    const issue = makeTestIssue({ id: scope.newIssueId(), identifier: scope.newIdentifier() });
    const codexCommand = `STUB_SCENARIO=happy node ${STUB}`;
    const config = resolveConfig(
      makeTestWorkflow({ sourceHash: scope.newWorkflowHash(), wsRoot, codexCommand }),
    );
    const source = scope.newRateLimitSource('codex');
    await repo.upsertRateLimit({
      source,
      remaining: 0,
      resetAt: new Date(Date.now() + 60_000),
    });

    const loop = new OrchestratorLoop({
      tracker: stubTracker([issue]),
      repo,
      workspaces: new WorkspaceManager(wsRoot),
      config,
      log: pino({ level: 'silent' }),
      scopedIssueIds: [...scope.issueIds],
    });
    await loop.tick();

    // No runs should have been reserved during a paused tick.
    const active = (loop as unknown as { active: Map<string, unknown> }).active;
    expect(active.size).toBe(0);
    const { data: runs } = await db.from('runs').select('*').eq('issue_id', issue.id);
    expect(runs ?? []).toHaveLength(0);
  });

  it('resumes dispatch once reset_at passes', async () => {
    // Companion to the previous test: ensures the gate is time-bound, not
    // sticky. Once the upstream `reset_at` lapses, the very next tick must
    // dispatch normally — no extra signal required.
    const issue = makeTestIssue({ id: scope.newIssueId(), identifier: scope.newIdentifier() });
    const codexCommand = `STUB_SCENARIO=happy node ${STUB}`;
    const config = resolveConfig(
      makeTestWorkflow({ sourceHash: scope.newWorkflowHash(), wsRoot, codexCommand }),
    );
    const source = scope.newRateLimitSource('codex');
    await repo.upsertRateLimit({
      source,
      remaining: 0,
      resetAt: new Date(Date.now() + 250),
    });

    const loop = new OrchestratorLoop({
      tracker: stubTracker([issue]),
      repo,
      workspaces: new WorkspaceManager(wsRoot),
      config,
      log: pino({ level: 'silent' }),
      scopedIssueIds: [...scope.issueIds],
    });
    await loop.tick();
    {
      const { data: runs } = await db.from('runs').select('*').eq('issue_id', issue.id);
      expect(runs ?? []).toHaveLength(0);
    }

    await new Promise((r) => setTimeout(r, 400));
    await loop.tick();
    const active = (loop as unknown as { active: Map<string, { done: Promise<void> }> }).active;
    await Promise.all([...active.values()].map((h) => h.done));
    const { data: runs } = await db.from('runs').select('*').eq('issue_id', issue.id);
    expect(runs ?? []).toHaveLength(1);
  });

  it('does not redispatch while retry_queue.due_at is still in the future', async () => {
    // Regression for the SYM-1 infinite-loop bug: a fast-failing issue was
    // redispatched every pollIntervalMs because tick() eligibility only
    // checked blockers + in-flight map, never the retry_queue's due_at.
    const issue = makeTestIssue({ id: scope.newIssueId(), identifier: scope.newIdentifier() });
    const codexCommand = `STUB_SCENARIO=error node ${STUB}`;
    // maxRetryBackoffMs=60s ensures run-1's backoff lands ~4-6s out, far
    // beyond the sub-second window this test completes in.
    const wf = makeTestWorkflow({ sourceHash: scope.newWorkflowHash(), wsRoot, codexCommand });
    wf.frontMatter.agent.max_retry_backoff_ms = 60_000;
    const config = resolveConfig(wf);
    const loop = new OrchestratorLoop({
      tracker: stubTracker([issue]),
      repo,
      workspaces: new WorkspaceManager(wsRoot),
      config,
      log: pino({ level: 'silent' }),
      scopedIssueIds: [...scope.issueIds],
    });

    // First tick: dispatch + fail + schedule retry.
    await loop.tick();
    const active = (loop as unknown as { active: Map<string, { done: Promise<void> }> }).active;
    await Promise.all([...active.values()].map((h) => h.done));

    const { data: afterFirst } = await db.from('runs').select('*').eq('issue_id', issue.id);
    expect(afterFirst!.length).toBe(1);
    const { data: q } = await db.from('retry_queue').select('*').eq('issue_id', issue.id);
    expect(q!.length).toBe(1);
    const dueAtMs = new Date(q![0]!.due_at).getTime();
    expect(dueAtMs).toBeGreaterThan(Date.now() + 1_000); // clearly in the future

    // Second tick while the retry is still pending: no new run should fire.
    await loop.tick();
    await Promise.all([...active.values()].map((h) => h.done));
    const { data: afterSecond } = await db
      .from('runs')
      .select('*')
      .eq('issue_id', issue.id);
    expect(afterSecond!.length).toBe(1); // still exactly one — no redispatch
  });
});
