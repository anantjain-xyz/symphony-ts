import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDb, type Issue, liveSessions, retryQueue, runs } from '@symphony/shared';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resolveConfig } from '../config/resolve.js';
import type { TrackerClient } from '../tracker/linear.js';
import { sanitizeKey, WORKSPACE_READY_SENTINEL, WorkspaceManager } from '../workspace/manager.js';
import { recover } from './recovery.js';
import { Repo } from './repo.js';
import { makeTestIssue, makeTestWorkflow } from './test-helpers.js';
import { TestScope } from './test-scope.js';

const DB_URL = process.env.TEST_DATABASE_URL;
const skip = !DB_URL;
const d = skip ? describe.skip : describe;

if (skip) {
  console.warn('recovery integration tests skipped (set TEST_DATABASE_URL to enable)');
}

function stubTracker(active: Issue[], terminal: Issue[]): TrackerClient {
  return {
    preflight: async () => {},
    fetchActive: async () => active,
    fetchById: async (id) =>
      active.find((i) => i.id === id) ?? terminal.find((i) => i.id === id) ?? null,
    fetchTerminal: async () => terminal,
  };
}

d('recover', () => {
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
    wsRoot = await mkdtemp(path.join(tmpdir(), 'symphony-rec-'));
  });

  afterEach(async () => {
    await scope.cleanup(db);
    await rm(wsRoot, { recursive: true, force: true });
  });

  it('marks orphan running runs as failure and schedules retry', async () => {
    const active = makeTestIssue({
      id: scope.newIssueId(),
      identifier: scope.newIdentifier(),
      state: 'todo',
    });
    await repo.upsertIssues([active]);

    const reserved = await repo.tryReserveRun({
      issueId: active.id,
      runNumber: 1,
      workspacePath: '/tmp/orphan',
    });
    await repo.markRunning(reserved!.id);

    const config = resolveConfig(makeTestWorkflow({ sourceHash: scope.newWorkflowHash(), wsRoot }));
    const out = await recover({
      repo,
      tracker: stubTracker([active], []),
      workspaces: new WorkspaceManager(wsRoot),
      config,
      log: pino({ level: 'silent' }),
      scopedIssueIds: [...scope.issueIds],
    });

    expect(out.orphansAdopted).toBe(1);
    const [row] = await db.select().from(runs).where(eq(runs.id, reserved!.id));
    expect(row!.status).toBe('failure');
    expect(row!.error_class).toBe('process_crashed');
    const q = await db.select().from(retryQueue).where(eq(retryQueue.issue_id, active.id));
    expect(q.length).toBe(1);
    expect(q[0]!.run_number).toBe(2);
  });

  it('marks pending-orphan runs as failure and schedules retry', async () => {
    const active = makeTestIssue({
      id: scope.newIssueId(),
      identifier: scope.newIdentifier(),
      state: 'todo',
    });
    await repo.upsertIssues([active]);

    // Reserve a run but never call markRunning — simulates the prior worker
    // dying between tryReserveRun and markRunning.
    const reserved = await repo.tryReserveRun({
      issueId: active.id,
      runNumber: 3,
      workspacePath: '/tmp/pending-orphan',
    });

    const config = resolveConfig(makeTestWorkflow({ sourceHash: scope.newWorkflowHash(), wsRoot }));
    const out = await recover({
      repo,
      tracker: stubTracker([active], []),
      workspaces: new WorkspaceManager(wsRoot),
      config,
      log: pino({ level: 'silent' }),
      scopedIssueIds: [...scope.issueIds],
    });

    expect(out.pendingOrphansAdopted).toBe(1);
    const [row] = await db.select().from(runs).where(eq(runs.id, reserved!.id));
    expect(row!.status).toBe('failure');
    expect(row!.error_class).toBe('process_crashed');
    const q = await db.select().from(retryQueue).where(eq(retryQueue.issue_id, active.id));
    expect(q.length).toBe(1);
    expect(q[0]!.run_number).toBe(4);
  });

  it('removes workspaces of terminal-state issues with no active runs', async () => {
    const active = makeTestIssue({
      id: scope.newIssueId(),
      identifier: scope.newIdentifier(),
      state: 'todo',
    });
    const terminal = makeTestIssue({
      id: scope.newIssueId(),
      identifier: scope.newIdentifier(),
      state: 'done',
    });
    await repo.upsertIssues([active, terminal]);

    const wsForTerminal = path.join(wsRoot, sanitizeKey(terminal.identifier));
    await mkdir(wsForTerminal, { recursive: true });
    const wsForActive = path.join(wsRoot, sanitizeKey(active.identifier));
    await mkdir(wsForActive, { recursive: true });

    const out = await recover({
      repo,
      tracker: stubTracker([active], [terminal]),
      workspaces: new WorkspaceManager(wsRoot),
      config: resolveConfig(makeTestWorkflow({ sourceHash: scope.newWorkflowHash(), wsRoot })),
      log: pino({ level: 'silent' }),
      scopedIssueIds: [...scope.issueIds],
    });

    expect(out.workspacesRemoved).toBe(1);
    await expect(stat(wsForTerminal)).rejects.toThrow();
    await expect(stat(wsForActive)).resolves.toBeDefined();
  });

  it('persists workflow snapshot during recover', async () => {
    const wf = makeTestWorkflow({ sourceHash: scope.newWorkflowHash(), wsRoot });
    await recover({
      repo,
      tracker: stubTracker([], []),
      workspaces: new WorkspaceManager(wsRoot),
      config: resolveConfig(wf),
      log: pino({ level: 'silent' }),
      scopedIssueIds: [...scope.issueIds],
    });
    const row = await repo.getWorkflowBySourceHash(wf.sourceHash);
    expect(row?.source_hash).toBe(wf.sourceHash);
  });

  it('wipes orphan workspaces missing the ready sentinel', async () => {
    const issue = makeTestIssue({
      id: scope.newIssueId(),
      identifier: scope.newIdentifier(),
      state: 'todo',
    });
    await repo.upsertIssues([issue]);

    const wsPath = path.join(wsRoot, sanitizeKey(issue.identifier));
    await mkdir(wsPath, { recursive: true });
    await writeFile(path.join(wsPath, 'half-clone'), 'partial');

    const reserved = await repo.tryReserveRun({
      issueId: issue.id,
      runNumber: 1,
      workspacePath: wsPath,
    });
    await repo.markRunning(reserved!.id);

    const out = await recover({
      repo,
      tracker: stubTracker([issue], []),
      workspaces: new WorkspaceManager(wsRoot),
      config: resolveConfig(makeTestWorkflow({ sourceHash: scope.newWorkflowHash(), wsRoot })),
      log: pino({ level: 'silent' }),
      scopedIssueIds: [...scope.issueIds],
    });

    expect(out.partialWorkspacesCleaned).toBe(1);
    await expect(stat(wsPath)).rejects.toThrow();
  });

  it('preserves orphan workspaces that already have the ready sentinel', async () => {
    const issue = makeTestIssue({
      id: scope.newIssueId(),
      identifier: scope.newIdentifier(),
      state: 'todo',
    });
    await repo.upsertIssues([issue]);

    const wsPath = path.join(wsRoot, sanitizeKey(issue.identifier));
    await mkdir(wsPath, { recursive: true });
    await writeFile(path.join(wsPath, 'state.txt'), 'preserved');
    await writeFile(path.join(wsPath, WORKSPACE_READY_SENTINEL), '');

    const reserved = await repo.tryReserveRun({
      issueId: issue.id,
      runNumber: 1,
      workspacePath: wsPath,
    });
    await repo.markRunning(reserved!.id);

    const out = await recover({
      repo,
      tracker: stubTracker([issue], []),
      workspaces: new WorkspaceManager(wsRoot),
      config: resolveConfig(makeTestWorkflow({ sourceHash: scope.newWorkflowHash(), wsRoot })),
      log: pino({ level: 'silent' }),
      scopedIssueIds: [...scope.issueIds],
    });

    expect(out.partialWorkspacesCleaned).toBe(0);
    await expect(stat(wsPath)).resolves.toBeDefined();
    await expect(stat(path.join(wsPath, 'state.txt'))).resolves.toBeDefined();
  });

  it('cleans placeholder live_sessions whose run is in a terminal state', async () => {
    const issue = makeTestIssue({
      id: scope.newIssueId(),
      identifier: scope.newIdentifier(),
      state: 'done',
    });
    await repo.upsertIssues([issue]);

    const reserved = await repo.tryReserveRun({
      issueId: issue.id,
      runNumber: 1,
      workspacePath: path.join(wsRoot, sanitizeKey(issue.identifier)),
    });
    await repo.markRunning(reserved!.id);
    await repo.upsertLiveSession({
      run_id: reserved!.id,
      session_id: `pending-${reserved!.id}`,
      thread_id: '',
      turn_id: '',
      input_tokens: 12,
      output_tokens: 0,
      total_tokens: 12,
    });
    await repo.finishRun({
      runId: reserved!.id,
      status: 'failure',
      errorClass: 'dispatch_error',
      errorMessage: 'simulated crash',
    });

    const out = await recover({
      repo,
      tracker: stubTracker([], [issue]),
      workspaces: new WorkspaceManager(wsRoot),
      config: resolveConfig(makeTestWorkflow({ sourceHash: scope.newWorkflowHash(), wsRoot })),
      log: pino({ level: 'silent' }),
      scopedIssueIds: [...scope.issueIds],
    });

    expect(out.placeholderSessionsCleaned).toBe(1);
    const rows = await db.select().from(liveSessions).where(eq(liveSessions.run_id, reserved!.id));
    expect(rows).toHaveLength(0);
  });

  it('orphan adoption deletes placeholder live_sessions via deleteLiveSession, not the sweep', async () => {
    const issue = makeTestIssue({
      id: scope.newIssueId(),
      identifier: scope.newIdentifier(),
      state: 'todo',
    });
    await repo.upsertIssues([issue]);

    const reserved = await repo.tryReserveRun({
      issueId: issue.id,
      runNumber: 1,
      workspacePath: path.join(wsRoot, sanitizeKey(issue.identifier)),
    });
    await repo.markRunning(reserved!.id);
    await repo.upsertLiveSession({
      run_id: reserved!.id,
      session_id: `pending-${reserved!.id}`,
      thread_id: '',
      turn_id: '',
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    });

    const out = await recover({
      repo,
      tracker: stubTracker([issue], []),
      workspaces: new WorkspaceManager(wsRoot),
      config: resolveConfig(makeTestWorkflow({ sourceHash: scope.newWorkflowHash(), wsRoot })),
      log: pino({ level: 'silent' }),
      scopedIssueIds: [...scope.issueIds],
    });

    // The running-orphan loop calls deleteLiveSession directly on the orphan
    // before scheduling its retry, so by the time the placeholder sweep runs
    // there is nothing left for it to clean.
    expect(out.placeholderSessionsCleaned).toBe(0);
    const rows = await db.select().from(liveSessions).where(eq(liveSessions.run_id, reserved!.id));
    expect(rows).toHaveLength(0);
  });
});
