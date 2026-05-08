import type { Issue } from '@symphony/shared';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { resolveConfig } from '../config/resolve.js';
import type { RateLimitStateRow, Repo, RetryQueueRow } from '../db/repo.js';
import { makeTestIssue, makeTestWorkflow } from '../db/test-helpers.js';
import type { TrackerClient } from '../tracker/linear.js';
import type { UsageProbe } from '../usage/probe.js';
import { WorkspaceManager } from '../workspace/manager.js';
import type { DispatchHandle } from './dispatch.js';
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
    // applyUsageGate upserts on every tick, so even non-gate tests need this.
    upsertRateLimit: vi.fn(async () => {}),
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

describe('OrchestratorLoop usage gate', () => {
  function makeProbe(snapshot: Awaited<ReturnType<UsageProbe['probe']>>): {
    probe: UsageProbe;
    calls: ReturnType<typeof vi.fn<UsageProbe['probe']>>;
  } {
    const calls = vi.fn<UsageProbe['probe']>(async () => snapshot);
    return { probe: { probe: calls }, calls };
  }
  function makeRateLimitMock() {
    return vi.fn<Repo['upsertRateLimit']>(async () => {});
  }

  it('writes a usage_gate row with reset_at when remaining drops below threshold', async () => {
    const issue = makeIssue();
    const upsertRateLimit = makeRateLimitMock();
    const reserve = vi.fn(async () => null);
    const repo = fakeRepo({ tryReserveRun: reserve, upsertRateLimit });

    const wf = makeTestWorkflow({ sourceHash: 'usage-gate-below' });
    wf.frontMatter.agent.min_remaining_usage_pct = 20;
    // codex backend by default → source must be `codex_usage_gate`.
    const futureReset = new Date(Date.now() + 60 * 60_000);
    const { probe, calls } = makeProbe({ remainingPct: 5, resetAt: futureReset });

    const loop = new OrchestratorLoop({
      tracker: stubTracker([issue]),
      repo,
      workspaces: new WorkspaceManager('/tmp/symphony-loop-test'),
      config: resolveConfig(wf),
      log: pino({ level: 'silent' }),
      usageProbe: probe,
    });

    await loop.tick();

    expect(calls).toHaveBeenCalledWith('codex');
    expect(upsertRateLimit).toHaveBeenCalledWith({
      source: 'codex_usage_gate',
      remaining: 5,
      resetAt: futureReset,
    });
    // The new row didn't make it into activeRateLimits() (mock returned []),
    // so dispatch wasn't gated by *this* tick — but the next tick will see
    // the row and pause. We only verify the write happened here.
    expect(reserve).toHaveBeenCalled();
  });

  it('falls back to a near-future reset when probe omits resetAt', async () => {
    const issue = makeIssue();
    const upsertRateLimit = makeRateLimitMock();
    const repo = fakeRepo({ tryReserveRun: vi.fn(async () => null), upsertRateLimit });

    const wf = makeTestWorkflow({ sourceHash: 'usage-gate-no-reset' });
    wf.frontMatter.agent.min_remaining_usage_pct = 20;
    const { probe } = makeProbe({ remainingPct: 5, resetAt: null });

    const before = Date.now();
    const loop = new OrchestratorLoop({
      tracker: stubTracker([issue]),
      repo,
      workspaces: new WorkspaceManager('/tmp/symphony-loop-test'),
      config: resolveConfig(wf),
      log: pino({ level: 'silent' }),
      usageProbe: probe,
    });
    await loop.tick();
    const after = Date.now();

    expect(upsertRateLimit).toHaveBeenCalledTimes(1);
    const arg = upsertRateLimit.mock.calls[0]![0];
    expect(arg.resetAt).not.toBeNull();
    // 5min default.
    expect(arg.resetAt!.getTime()).toBeGreaterThanOrEqual(before + 5 * 60_000);
    expect(arg.resetAt!.getTime()).toBeLessThanOrEqual(after + 5 * 60_000 + 100);
  });

  it('clears the gate (reset_at: null) when remaining recovers above threshold', async () => {
    const issue = makeIssue();
    const upsertRateLimit = makeRateLimitMock();
    const repo = fakeRepo({ tryReserveRun: vi.fn(async () => null), upsertRateLimit });

    const wf = makeTestWorkflow({ sourceHash: 'usage-gate-above' });
    wf.frontMatter.agent.min_remaining_usage_pct = 20;
    const { probe } = makeProbe({
      remainingPct: 80,
      resetAt: new Date(Date.now() + 60 * 60_000),
    });

    const loop = new OrchestratorLoop({
      tracker: stubTracker([issue]),
      repo,
      workspaces: new WorkspaceManager('/tmp/symphony-loop-test'),
      config: resolveConfig(wf),
      log: pino({ level: 'silent' }),
      usageProbe: probe,
    });
    await loop.tick();

    // resetAt: null excludes the row from `activeRateLimits()` — i.e. lifts
    // any prior pause this same gate had set.
    expect(upsertRateLimit).toHaveBeenCalledWith({
      source: 'codex_usage_gate',
      remaining: 80,
      resetAt: null,
    });
  });

  it('clears stale gate row when probe fails (fail open)', async () => {
    // Codex review (PR #97) called this out: returning early on probe failure
    // would strand a prior `<backend>_usage_gate` row's `reset_at`, which
    // would keep dispatch paused for hours despite the probe being broken —
    // the opposite of "fail open". Now we always upsert null on failure so
    // any prior pause lifts.
    const issue = makeIssue();
    const upsertRateLimit = makeRateLimitMock();
    const reserve = vi.fn(async () => null);
    const repo = fakeRepo({ tryReserveRun: reserve, upsertRateLimit });

    const wf = makeTestWorkflow({ sourceHash: 'usage-gate-fail-open' });
    wf.frontMatter.agent.min_remaining_usage_pct = 20;
    const { probe, calls } = makeProbe(null);

    const loop = new OrchestratorLoop({
      tracker: stubTracker([issue]),
      repo,
      workspaces: new WorkspaceManager('/tmp/symphony-loop-test'),
      config: resolveConfig(wf),
      log: pino({ level: 'silent' }),
      usageProbe: probe,
    });
    await loop.tick();

    expect(calls).toHaveBeenCalledTimes(1);
    expect(upsertRateLimit).toHaveBeenCalledWith({
      source: 'codex_usage_gate',
      remaining: null,
      resetAt: null,
    });
    // Dispatch proceeds normally (reserve was attempted).
    expect(reserve).toHaveBeenCalled();
  });

  it('clears stale gate row when threshold is 0 (gate disabled)', async () => {
    // Same Codex-review concern: if a prior tick set `<backend>_usage_gate`
    // with a future `reset_at` and the user then sets the env var to 0 to
    // disable the feature, we must lift that pause — not leave it stranded.
    const issue = makeIssue();
    const upsertRateLimit = makeRateLimitMock();
    const repo = fakeRepo({ tryReserveRun: vi.fn(async () => null), upsertRateLimit });

    const wf = makeTestWorkflow({ sourceHash: 'usage-gate-disabled' });
    wf.frontMatter.agent.min_remaining_usage_pct = 0;
    const { probe, calls } = makeProbe({ remainingPct: 1, resetAt: null });

    const loop = new OrchestratorLoop({
      tracker: stubTracker([issue]),
      repo,
      workspaces: new WorkspaceManager('/tmp/symphony-loop-test'),
      config: resolveConfig(wf),
      log: pino({ level: 'silent' }),
      usageProbe: probe,
    });
    await loop.tick();

    // Probe is never consulted when the gate is disabled, but we still clear
    // any stale row.
    expect(calls).not.toHaveBeenCalled();
    expect(upsertRateLimit).toHaveBeenCalledWith({
      source: 'codex_usage_gate',
      remaining: null,
      resetAt: null,
    });
  });

  it('clears stale gate row when no probe is wired into the loop', async () => {
    // The DI-omitted path in tests, but symmetrically the fix applies in
    // production too: if probe construction fails at boot and we restart
    // without one, any prior gate must lift.
    const issue = makeIssue();
    const upsertRateLimit = makeRateLimitMock();
    const repo = fakeRepo({ tryReserveRun: vi.fn(async () => null), upsertRateLimit });

    const wf = makeTestWorkflow({ sourceHash: 'usage-gate-no-probe' });
    wf.frontMatter.agent.min_remaining_usage_pct = 20;

    const loop = new OrchestratorLoop({
      tracker: stubTracker([issue]),
      repo,
      workspaces: new WorkspaceManager('/tmp/symphony-loop-test'),
      config: resolveConfig(wf),
      log: pino({ level: 'silent' }),
      // usageProbe intentionally omitted
    });
    await loop.tick();

    expect(upsertRateLimit).toHaveBeenCalledWith({
      source: 'codex_usage_gate',
      remaining: null,
      resetAt: null,
    });
  });

  it('uses the claude_ source key when backend is claude', async () => {
    const issue = makeIssue();
    const upsertRateLimit = makeRateLimitMock();
    const repo = fakeRepo({ tryReserveRun: vi.fn(async () => null), upsertRateLimit });

    const wf = makeTestWorkflow({ sourceHash: 'usage-gate-claude' });
    wf.frontMatter.agent.backend = 'claude';
    wf.frontMatter.agent.min_remaining_usage_pct = 20;
    const { probe } = makeProbe({ remainingPct: 8, resetAt: null });

    const loop = new OrchestratorLoop({
      tracker: stubTracker([issue]),
      repo,
      workspaces: new WorkspaceManager('/tmp/symphony-loop-test'),
      config: resolveConfig(wf),
      log: pino({ level: 'silent' }),
      usageProbe: probe,
    });
    await loop.tick();

    const arg = upsertRateLimit.mock.calls[0]![0];
    expect(arg.source).toBe('claude_usage_gate');
  });
});

describe('OrchestratorLoop retry concurrency gate', () => {
  function fakeHandle(issueId: string): DispatchHandle {
    return {
      issueId,
      runId: `run-${issueId}`,
      cancel: async () => {},
      killNow: () => {},
      // Never resolves so the loop keeps the entry in `this.active` for the
      // duration of the test tick.
      done: new Promise<void>(() => {}),
    };
  }

  function dueRetryRow(issueId: string, runNumber = 2): RetryQueueRow {
    return {
      issue_id: issueId,
      run_number: runNumber,
      due_at: new Date(Date.now() - 1_000).toISOString(),
      error_class: 'transient',
      error_message: 'simulated',
      created_at: new Date(Date.now() - 60_000).toISOString(),
    };
  }

  it('does not fire a due retry when the global cap is already saturated', async () => {
    // Cap = 1, active = 1 (synthetic blocking handle). A retry becoming due in
    // the same tick must NOT be dispatched, and must remain in retry_queue
    // (no clearRetry).
    const blocking = makeIssue({
      id: '00000000-0000-0000-0000-0000000000a1',
      identifier: 'BLOCK-1',
    });
    const retrying = makeIssue({
      id: '00000000-0000-0000-0000-0000000000a2',
      identifier: 'RETRY-1',
    });

    const reserve = vi.fn(async () => null);
    const clearRetry = vi.fn(async () => {});
    const dueRetries = vi.fn(async () => [dueRetryRow(retrying.id)]);

    const repo = fakeRepo({
      tryReserveRun: reserve,
      dueRetries,
      clearRetry,
    });

    const wf = makeTestWorkflow({ sourceHash: 'retry-cap-global' });
    wf.frontMatter.agent.max_concurrent_agents = 1;

    const loop = new OrchestratorLoop({
      tracker: stubTracker([blocking, retrying]),
      repo,
      workspaces: new WorkspaceManager('/tmp/symphony-loop-test'),
      config: resolveConfig(wf),
      log: pino({ level: 'silent' }),
    });
    loop.registerActive(fakeHandle(blocking.id));

    await loop.tick();

    expect(reserve).not.toHaveBeenCalled();
    expect(clearRetry).not.toHaveBeenCalled();
    expect(dueRetries).toHaveBeenCalledTimes(1);
  });

  it('fires a due retry through the retry path when the global cap has a free slot', async () => {
    // Cap = 2, active = 1. Issue is blocker-marked so the slate filters it
    // out (`blockers.length === 0` is false), forcing dispatch to come from
    // step 7 — this lets us assert the retry path's `forceRunNumber` propagates
    // to `tryReserveRun`.
    const blocking = makeIssue({
      id: '00000000-0000-0000-0000-0000000000b1',
      identifier: 'BLOCK-2',
    });
    const retrying = makeIssue({
      id: '00000000-0000-0000-0000-0000000000b2',
      identifier: 'RETRY-2',
      blockers: ['some-other-issue'],
    });

    const reserve: Repo['tryReserveRun'] = vi.fn(async () => null);
    const clearRetry = vi.fn(async () => {});
    const dueRetries = vi.fn(async () => [dueRetryRow(retrying.id, 3)]);

    const repo = fakeRepo({
      tryReserveRun: reserve,
      dueRetries,
      clearRetry,
    });

    const wf = makeTestWorkflow({ sourceHash: 'retry-cap-global-ok' });
    wf.frontMatter.agent.max_concurrent_agents = 2;

    const loop = new OrchestratorLoop({
      tracker: stubTracker([blocking, retrying]),
      repo,
      workspaces: new WorkspaceManager('/tmp/symphony-loop-test'),
      config: resolveConfig(wf),
      log: pino({ level: 'silent' }),
    });
    loop.registerActive(fakeHandle(blocking.id));

    await loop.tick();

    expect(clearRetry).toHaveBeenCalledWith(retrying.id);
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(reserve).toHaveBeenCalledWith(
      expect.objectContaining({ issueId: retrying.id, runNumber: 3 }),
    );
  });

  it('does not fire a due retry when the per-state cap for that state is full', async () => {
    // Global cap is generous (10); the per-state cap for "in progress" is 1
    // and is already consumed by the blocking handle. The due retry is also
    // in "in progress", so it must defer.
    const blocking = makeIssue({
      id: '00000000-0000-0000-0000-0000000000c1',
      identifier: 'BLOCK-3',
      state: 'in progress',
    });
    const retrying = makeIssue({
      id: '00000000-0000-0000-0000-0000000000c2',
      identifier: 'RETRY-3',
      state: 'in progress',
    });

    const reserve = vi.fn(async () => null);
    const clearRetry = vi.fn(async () => {});
    const dueRetries = vi.fn(async () => [dueRetryRow(retrying.id)]);

    const repo = fakeRepo({
      tryReserveRun: reserve,
      dueRetries,
      clearRetry,
    });

    const wf = makeTestWorkflow({ sourceHash: 'retry-cap-state' });
    wf.frontMatter.agent.max_concurrent_agents = 10;
    wf.frontMatter.agent.max_concurrent_agents_by_state = { 'in progress': 1 };
    // active_states must include 'in progress' so eligibility/state lookup works.
    wf.frontMatter.tracker.active_states = ['todo', 'in progress'];

    const loop = new OrchestratorLoop({
      tracker: stubTracker([blocking, retrying]),
      repo,
      workspaces: new WorkspaceManager('/tmp/symphony-loop-test'),
      config: resolveConfig(wf),
      log: pino({ level: 'silent' }),
    });
    loop.registerActive(fakeHandle(blocking.id));

    await loop.tick();

    expect(reserve).not.toHaveBeenCalled();
    expect(clearRetry).not.toHaveBeenCalled();
  });
});
