import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { createServiceClient, type Issue, type ParsedWorkflow } from '@symphony/shared';
import { Repo } from './repo.js';
import { recover } from './recovery.js';
import { resolveConfig } from '../config/resolve.js';
import { WorkspaceManager, sanitizeKey } from '../workspace/manager.js';
import type { TrackerClient } from '../tracker/linear.js';

const SUPA_URL = process.env.TEST_SUPABASE_URL ?? 'http://127.0.0.1:54421';
const SERVICE_ROLE = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY;
const skip = !SERVICE_ROLE;
const d = skip ? describe.skip : describe;

if (skip) {
  console.warn('recovery integration tests skipped (set TEST_SUPABASE_SERVICE_ROLE_KEY to enable)');
}

const ACTIVE: Issue = {
  id: '66666666-6666-6666-6666-666666666666',
  identifier: 'REC-1',
  title: 'active issue',
  description: null,
  priority: 1,
  state: 'todo',
  branch: null,
  labels: [],
  blockers: [],
};

const TERMINAL: Issue = {
  id: '77777777-7777-7777-7777-777777777777',
  identifier: 'REC-2',
  title: 'terminal issue',
  description: null,
  priority: 2,
  state: 'done',
  branch: null,
  labels: [],
  blockers: [],
};

function workflow(wsRoot: string): ParsedWorkflow {
  return {
    sourceHash: 'c'.repeat(64),
    promptTemplate: 'p',
    frontMatter: {
      tracker: {
        kind: 'linear',
        endpoint: 'http://stub',
        api_key: 'k',
        active_states: ['todo'],
        terminal_states: ['done'],
      },
      polling: { interval_ms: 30000 },
      workspace: { root: wsRoot },
      hooks: { timeout_ms: 60000 },
      agent: {
        max_concurrent_agents: 4,
        max_retry_backoff_ms: 1000,
        max_concurrent_agents_by_state: {},
      },
      codex: {
        command: 'codex',
        approval_policy: 'never',
        thread_sandbox: 'workspace-write',
        turn_sandbox_policy: 'inherit',
        turn_timeout_ms: 3600000,
      },
    },
  };
}

function tracker(active: Issue[], terminal: Issue[]): TrackerClient {
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

  async function clean() {
    if (!db) {
      return;
    }

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
    db = createServiceClient({ url: SUPA_URL, serviceRoleKey: SERVICE_ROLE! });
    repo = new Repo(db);
    await clean();
  });
  afterAll(clean);
  beforeEach(async () => {
    await clean();
    wsRoot = await mkdtemp(path.join(tmpdir(), 'symphony-rec-'));
    await repo.upsertIssues([ACTIVE, TERMINAL]);
  });

  it('marks orphan running attempts as failure and schedules retry', async () => {
    const reserved = await repo.tryReserveAttempt({
      issueId: ACTIVE.id,
      attemptNumber: 1,
      workspacePath: '/tmp/orphan',
    });
    await repo.markRunning(reserved!.id);

    const config = resolveConfig(workflow(wsRoot));
    const out = await recover({
      repo,
      tracker: tracker([ACTIVE], []),
      workspaces: new WorkspaceManager(wsRoot),
      config,
      log: pino({ level: 'silent' }),
    });

    expect(out.orphansAdopted).toBe(1);
    const { data: row } = await db.from('run_attempts').select('*').eq('id', reserved!.id).single();
    expect(row!.status).toBe('failure');
    expect(row!.error_class).toBe('process_crashed');
    const { data: q } = await db.from('retry_queue').select('*').eq('issue_id', ACTIVE.id);
    expect(q!.length).toBe(1);
    expect(q![0]!.attempt_number).toBe(2);
  });

  it('removes workspaces of terminal-state issues with no active attempts', async () => {
    const wsForTerminal = path.join(wsRoot, sanitizeKey(TERMINAL.identifier));
    await mkdir(wsForTerminal, { recursive: true });
    const wsForActive = path.join(wsRoot, sanitizeKey(ACTIVE.identifier));
    await mkdir(wsForActive, { recursive: true });

    const out = await recover({
      repo,
      tracker: tracker([ACTIVE], [TERMINAL]),
      workspaces: new WorkspaceManager(wsRoot),
      config: resolveConfig(workflow(wsRoot)),
      log: pino({ level: 'silent' }),
    });

    expect(out.workspacesRemoved).toBe(1);
    await expect(stat(wsForTerminal)).rejects.toThrow();
    await expect(stat(wsForActive)).resolves.toBeDefined();
    await rm(wsRoot, { recursive: true, force: true });
  });

  it('persists workflow snapshot during recover', async () => {
    const wf = workflow(wsRoot);
    await recover({
      repo,
      tracker: tracker([], []),
      workspaces: new WorkspaceManager(wsRoot),
      config: resolveConfig(wf),
      log: pino({ level: 'silent' }),
    });
    const latest = await repo.latestWorkflow();
    expect(latest?.source_hash).toBe(wf.sourceHash);
  });
});
