import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentEvents, createDb, type Issue, retryQueue, runs as runsT } from '@symphony/shared';
import { asc, eq } from 'drizzle-orm';
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

const DB_URL = process.env.TEST_DATABASE_URL;
const skip = !DB_URL;
const d = skip ? describe.skip : describe;

if (skip) {
  console.warn('orchestrator integration tests skipped (set TEST_DATABASE_URL to enable)');
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
  let db: ReturnType<typeof createDb>;
  let repo: Repo;
  let wsRoot: string;
  let scope: TestScope;

  beforeAll(() => {
    db = createDb(DB_URL!);
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

    const [run] = await db.select().from(runsT).where(eq(runsT.issue_id, issue.id));
    expect(run!.status).toBe('success');

    const events = await db
      .select()
      .from(agentEvents)
      .where(eq(agentEvents.run_id, run!.id))
      .orderBy(asc(agentEvents.id));
    const kinds = events.map((e) => e.kind);
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
    const q = await db.select().from(retryQueue).where(eq(retryQueue.issue_id, issue.id));
    expect(q.length).toBe(1);
    expect(q[0]!.run_number).toBe(2);
  });

  it('cancelling a mid-run clears the pre-existing retry_queue row', async () => {
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

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const [row] = await db
        .select({ status: runsT.status })
        .from(runsT)
        .where(eq(runsT.id, reserved!.id));
      if (row?.status === 'running') break;
      await new Promise((r) => setTimeout(r, 25));
    }

    await handle.cancel('issue state changed');
    await handle.done;

    const [finished] = await db.select().from(runsT).where(eq(runsT.id, reserved!.id));
    expect(finished!.status).toBe('cancelled');
    expect(finished!.error_class).toBe('reconciled');

    const q = await db.select().from(retryQueue).where(eq(retryQueue.issue_id, issue.id));
    expect(q.length).toBe(0);
  });

  it('skips dispatch while rate_limit_state has a future reset_at for the backend', async () => {
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

    const active = (loop as unknown as { active: Map<string, unknown> }).active;
    expect(active.size).toBe(0);
    const rows = await db.select().from(runsT).where(eq(runsT.issue_id, issue.id));
    expect(rows).toHaveLength(0);
  });

  it('resumes dispatch once reset_at passes', async () => {
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
      const rows = await db.select().from(runsT).where(eq(runsT.issue_id, issue.id));
      expect(rows).toHaveLength(0);
    }

    await new Promise((r) => setTimeout(r, 400));
    await loop.tick();
    const active = (loop as unknown as { active: Map<string, { done: Promise<void> }> }).active;
    await Promise.all([...active.values()].map((h) => h.done));
    const rows = await db.select().from(runsT).where(eq(runsT.issue_id, issue.id));
    expect(rows).toHaveLength(1);
  });

  it('does not redispatch while retry_queue.due_at is still in the future', async () => {
    const issue = makeTestIssue({ id: scope.newIssueId(), identifier: scope.newIdentifier() });
    const codexCommand = `STUB_SCENARIO=error node ${STUB}`;
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

    await loop.tick();
    const active = (loop as unknown as { active: Map<string, { done: Promise<void> }> }).active;
    await Promise.all([...active.values()].map((h) => h.done));

    const afterFirst = await db.select().from(runsT).where(eq(runsT.issue_id, issue.id));
    expect(afterFirst.length).toBe(1);
    const q = await db.select().from(retryQueue).where(eq(retryQueue.issue_id, issue.id));
    expect(q.length).toBe(1);
    const dueAtMs = new Date(q[0]!.due_at).getTime();
    expect(dueAtMs).toBeGreaterThan(Date.now() + 1_000);

    await loop.tick();
    await Promise.all([...active.values()].map((h) => h.done));
    const afterSecond = await db.select().from(runsT).where(eq(runsT.issue_id, issue.id));
    expect(afterSecond.length).toBe(1);
  });
});
