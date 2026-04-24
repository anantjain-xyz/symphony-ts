import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServiceClient, type Issue } from '@symphony/shared';
import pino from 'pino';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resolveConfig } from '../config/resolve.js';
import type { TrackerClient } from '../tracker/linear.js';
import { sanitizeKey, WorkspaceManager } from '../workspace/manager.js';
import { recover } from './recovery.js';
import { Repo } from './repo.js';
import { makeTestIssue, makeTestWorkflow } from './test-helpers.js';
import { TestScope } from './test-scope.js';

const SUPA_URL = process.env.TEST_SUPABASE_URL ?? 'http://127.0.0.1:54421';
const SERVICE_ROLE = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY;
const skip = !SERVICE_ROLE;
const d = skip ? describe.skip : describe;

if (skip) {
  console.warn('recovery integration tests skipped (set TEST_SUPABASE_SERVICE_ROLE_KEY to enable)');
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
    wsRoot = await mkdtemp(path.join(tmpdir(), 'symphony-rec-'));
  });

  afterEach(async () => {
    await scope.cleanup(db);
    await rm(wsRoot, { recursive: true, force: true });
  });

  it('marks orphan running attempts as failure and schedules retry', async () => {
    const active = makeTestIssue({
      id: scope.newIssueId(),
      identifier: scope.newIdentifier(),
      state: 'todo',
    });
    await repo.upsertIssues([active]);

    const reserved = await repo.tryReserveAttempt({
      issueId: active.id,
      attemptNumber: 1,
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
    const { data: row } = await db.from('run_attempts').select('*').eq('id', reserved!.id).single();
    expect(row!.status).toBe('failure');
    expect(row!.error_class).toBe('process_crashed');
    const { data: q } = await db.from('retry_queue').select('*').eq('issue_id', active.id);
    expect(q!.length).toBe(1);
    expect(q![0]!.attempt_number).toBe(2);
  });

  it('removes workspaces of terminal-state issues with no active attempts', async () => {
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
});
