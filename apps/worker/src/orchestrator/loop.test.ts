import type { Issue } from '@symphony/shared';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { resolveConfig } from '../config/resolve.js';
import type { RateLimitStateRow, Repo } from '../db/repo.js';
import { makeTestIssue, makeTestWorkflow } from '../db/test-helpers.js';
import type { TrackerClient } from '../tracker/linear.js';
import { WorkspaceManager } from '../workspace/manager.js';
import { OrchestratorLoop } from './loop.js';

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return makeTestIssue({
    id: '00000000-0000-0000-0000-000000000001',
    identifier: 'TEST-1',
    ...overrides,
  });
}

function stubTracker(issues: Issue[]): TrackerClient {
  return {
    preflight: async () => {},
    fetchActive: async () => [...issues],
    fetchById: async (id) => issues.find((i) => i.id === id) ?? null,
    fetchTerminal: async () => [],
  };
}

function fakeRepo(overrides: Partial<Repo>): Repo {
  // The tick path invoked here only touches a handful of Repo methods. Anything
  // not listed should never be called by `tick()` when the gate trips; vitest
  // surfaces unexpected access via the proxy throw below.
  const base = {
    upsertIssues: vi.fn(async () => {}),
    allRetryIssueIds: vi.fn(async () => [] as string[]),
    pendingRetryIssueIds: vi.fn(async () => new Set<string>()),
    dueRetries: vi.fn(async () => []),
    activeRateLimits: vi.fn(async () => [] as RateLimitStateRow[]),
    lastRunNumber: vi.fn(async () => 0),
    tryReserveRun: vi.fn(async () => null),
    ...overrides,
  };
  return new Proxy(base as unknown as Repo, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (v !== undefined) return v;
      throw new Error(`fakeRepo: unexpected access to repo.${String(prop)}`);
    },
  });
}

describe('OrchestratorLoop rate-limit gate', () => {
  it('skips dispatch and retry firing when the active backend has a future reset_at', async () => {
    const issue = makeIssue();
    const futureReset = new Date(Date.now() + 60_000).toISOString();

    const reserve = vi.fn(async () => null);
    const dueRetries = vi.fn(async () => []);
    const pendingRetries = vi.fn(async () => new Set<string>());
    const activeRateLimits = vi.fn(async () => [
      {
        source: 'codex_primary',
        remaining: 0,
        reset_at: futureReset,
        updated_at: new Date().toISOString(),
      } satisfies RateLimitStateRow,
    ]);

    const repo = fakeRepo({
      activeRateLimits,
      pendingRetryIssueIds: pendingRetries,
      dueRetries,
      tryReserveRun: reserve,
    });

    const loop = new OrchestratorLoop({
      tracker: stubTracker([issue]),
      repo,
      workspaces: new WorkspaceManager('/tmp/symphony-loop-test'),
      config: resolveConfig(makeTestWorkflow({ sourceHash: 'unit-test-hash' })),
      log: pino({ level: 'silent' }),
    });

    await loop.tick();

    expect(activeRateLimits).toHaveBeenCalledTimes(1);
    expect(reserve).not.toHaveBeenCalled();
    // The gate short-circuits before either of these reads — confirm so a
    // future refactor that reorders steps still trips this assertion.
    expect(pendingRetries).not.toHaveBeenCalled();
    expect(dueRetries).not.toHaveBeenCalled();
  });

  it('only matches sources for the configured backend', async () => {
    // A claude_* pause must not gate the codex backend, even though both rows
    // live in the same `rate_limit_state` table. Dispatch should proceed.
    const issue = makeIssue();
    const reserve = vi.fn(async () => null); // returning null aborts dispatch cleanly
    const repo = fakeRepo({
      activeRateLimits: vi.fn(async () => [
        {
          source: 'claude_primary',
          remaining: 0,
          reset_at: new Date(Date.now() + 60_000).toISOString(),
          updated_at: new Date().toISOString(),
        } satisfies RateLimitStateRow,
      ]),
      tryReserveRun: reserve,
    });

    const loop = new OrchestratorLoop({
      tracker: stubTracker([issue]),
      repo,
      workspaces: new WorkspaceManager('/tmp/symphony-loop-test'),
      config: resolveConfig(makeTestWorkflow({ sourceHash: 'unit-test-hash-2' })), // codex by default
      log: pino({ level: 'silent' }),
    });

    await loop.tick();
    expect(reserve).toHaveBeenCalledTimes(1);
  });
});
