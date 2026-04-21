import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createServiceClient, type Issue, type ParsedWorkflow } from '@symphony/shared';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { Repo } from '../db/repo.js';
import { resolveConfig } from '../config/resolve.js';
import { WorkspaceManager } from '../workspace/manager.js';
import { OrchestratorLoop } from './loop.js';
import type { TrackerClient } from '../tracker/linear.js';

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

function makeWorkflow(wsRoot: string, scenario: string, codexCommand: string): ParsedWorkflow {
  return {
    sourceHash: 'b'.repeat(64),
    promptTemplate: 'work on {{identifier}}',
    frontMatter: {
      tracker: {
        kind: 'linear',
        endpoint: 'http://stub',
        api_key: 'k',
        active_states: ['todo'],
        terminal_states: ['done'],
      },
      polling: { interval_ms: 50 },
      workspace: { root: wsRoot },
      hooks: { timeout_ms: 5000 },
      agent: {
        max_concurrent_agents: 2,
        max_retry_backoff_ms: 1000,
        max_concurrent_agents_by_state: {},
      },
      codex: {
        command: codexCommand,
        approval_policy: 'never',
        thread_sandbox: 'workspace-write',
        turn_sandbox_policy: 'inherit',
        turn_timeout_ms: 5000,
        network_access: false,
      },
    },
  };
}

function stubTracker(issues: Issue[]): TrackerClient {
  return {
    preflight: async () => {},
    fetchActive: async () => [...issues],
    fetchById: async (id) => issues.find((i) => i.id === id) ?? null,
    fetchTerminal: async () => [],
  };
}

const ISSUE_1: Issue = {
  id: '33333333-3333-3333-3333-333333333333',
  identifier: 'LOOP-1',
  title: 'first',
  description: null,
  priority: 1,
  state: 'todo',
  branch: null,
  labels: [],
  blockers: [],
};

const ISSUE_2: Issue = {
  id: '44444444-4444-4444-4444-444444444444',
  identifier: 'LOOP-2',
  title: 'second',
  description: null,
  priority: 2,
  state: 'todo',
  branch: null,
  labels: [],
  blockers: [],
};

d('OrchestratorLoop integration', () => {
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
  }

  beforeAll(async () => {
    db = createServiceClient({ url: SUPA_URL, serviceRoleKey: SERVICE_ROLE! });
    repo = new Repo(db);
    await clean();
  });

  beforeEach(async () => {
    await clean();
    wsRoot = await mkdtemp(path.join(tmpdir(), 'symphony-loop-'));
  });

  afterAll(async () => {
    await clean();
  });

  it('one tick: dispatches, succeeds, persists events and finishes attempt', async () => {
    const codexCmd = `STUB_SCENARIO=happy node ${STUB}`;
    const config = resolveConfig(makeWorkflow(wsRoot, 'happy', codexCmd));
    const loop = new OrchestratorLoop({
      tracker: stubTracker([ISSUE_1]),
      repo,
      workspaces: new WorkspaceManager(wsRoot),
      config,
      log: pino({ level: 'silent' }),
    });
    await loop.tick();
    // Wait for dispatch promise to resolve (single attempt).
    const handles = (loop as unknown as { active: Map<string, { done: Promise<void> }> }).active;
    await Promise.all([...handles.values()].map((h) => h.done));

    const [{ data: attempt }] = await Promise.all([
      db.from('run_attempts').select('*').eq('issue_id', ISSUE_1.id).single(),
    ]);
    expect(attempt!.status).toBe('success');

    const { data: events } = await db
      .from('agent_events')
      .select('*')
      .eq('run_attempt_id', attempt!.id)
      .order('id', { ascending: true });
    const kinds = events!.map((e) => e.kind);
    expect(kinds).toContain('status');
    expect(kinds).toContain('tool_call');
    expect(kinds).toContain('token_count');
    expect(kinds).toContain('humanized');

    await rm(wsRoot, { recursive: true, force: true });
  });

  it('respects max_concurrent_agents=2 with 3 eligible issues', async () => {
    const ISSUE_3: Issue = {
      ...ISSUE_2,
      id: '55555555-5555-5555-5555-555555555555',
      identifier: 'LOOP-3',
    };
    const codexCmd = `STUB_SCENARIO=happy node ${STUB}`;
    const config = resolveConfig(makeWorkflow(wsRoot, 'happy', codexCmd));
    const loop = new OrchestratorLoop({
      tracker: stubTracker([ISSUE_1, ISSUE_2, ISSUE_3]),
      repo,
      workspaces: new WorkspaceManager(wsRoot),
      config,
      log: pino({ level: 'silent' }),
    });
    await loop.tick();
    const active = (loop as unknown as { active: Map<string, unknown> }).active;
    expect(active.size).toBe(2);
    await Promise.all(
      [...(active as Map<string, { done: Promise<void> }>).values()].map((h) => h.done),
    );
    await rm(wsRoot, { recursive: true, force: true });
  });

  it('failure schedules a retry in retry_queue', async () => {
    const codexCmd = `STUB_SCENARIO=error node ${STUB}`;
    const config = resolveConfig(makeWorkflow(wsRoot, 'error', codexCmd));
    const loop = new OrchestratorLoop({
      tracker: stubTracker([ISSUE_1]),
      repo,
      workspaces: new WorkspaceManager(wsRoot),
      config,
      log: pino({ level: 'silent' }),
    });
    await loop.tick();
    const active = (loop as unknown as { active: Map<string, { done: Promise<void> }> }).active;
    await Promise.all([...active.values()].map((h) => h.done));
    const { data: q } = await db.from('retry_queue').select('*').eq('issue_id', ISSUE_1.id);
    expect(q!.length).toBe(1);
    expect(q![0]!.attempt_number).toBe(2);
    await rm(wsRoot, { recursive: true, force: true });
  });
});
