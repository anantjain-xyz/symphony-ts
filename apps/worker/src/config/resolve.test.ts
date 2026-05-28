import { describe, expect, it } from 'vitest';
import { makeTestRepos } from '../db/test-helpers.js';
import { liveConfig, type ResolvedConfig, resolveConfig } from './resolve.js';
import { parseWorkflowSource } from './workflow.js';

const SRC = `---
tracker:
  kind: linear
  api_key: k
  active_states: [Todo, In Progress]
  terminal_states: [Done, Cancelled]
polling:
  interval_ms: 5000
agent:
  max_concurrent_agents: 4
  max_concurrent_agents_by_state:
    todo: 2
---
prompt`;

describe('resolveConfig', () => {
  it('reads workflow values when no overrides', () => {
    const w = parseWorkflowSource(SRC);
    const c = resolveConfig(w, {}, makeTestRepos());
    expect(c.pollIntervalMs()).toBe(5000);
    expect(c.maxConcurrentAgents()).toBe(4);
    expect(c.maxConcurrentByState()).toEqual({ todo: 2 });
  });

  it('lowercases tracker states', () => {
    const w = parseWorkflowSource(SRC);
    const c = resolveConfig(w, {}, makeTestRepos());
    expect(c.activeStates()).toEqual(['todo', 'in progress']);
    expect(c.terminalStates()).toEqual(['done', 'cancelled']);
  });

  it('explicit overrides take precedence over workflow', () => {
    const w = parseWorkflowSource(SRC);
    const c = resolveConfig(w, { pollIntervalMs: 1000, maxConcurrentAgents: 1 }, makeTestRepos());
    expect(c.pollIntervalMs()).toBe(1000);
    expect(c.maxConcurrentAgents()).toBe(1);
  });

  it('snapshot() on a static config returns itself', () => {
    const c = resolveConfig(parseWorkflowSource(SRC), {}, makeTestRepos());
    expect(c.snapshot()).toBe(c);
  });

  it('identifierPrefix() defaults to null and reflects tracker.identifier_prefix when set', () => {
    const cNone = resolveConfig(parseWorkflowSource(SRC), {}, makeTestRepos());
    expect(cNone.identifierPrefix()).toBeNull();

    const SRC_PREFIX = `---
tracker:
  kind: linear
  api_key: k
  active_states: [Todo]
  terminal_states: [Done]
  identifier_prefix: PB-
---
prompt`;
    const cSet = resolveConfig(parseWorkflowSource(SRC_PREFIX), {}, makeTestRepos());
    expect(cSet.identifierPrefix()).toBe('PB-');
  });

  it('projectIds() defaults to [] and reflects tracker.project_id when set', () => {
    const cNone = resolveConfig(parseWorkflowSource(SRC), {}, makeTestRepos());
    expect(cNone.projectIds()).toEqual([]);

    const SRC_PROJECT = `---
tracker:
  kind: linear
  api_key: k
  active_states: [Todo]
  terminal_states: [Done]
  project_id: 11111111-1111-4111-8111-111111111111
---
prompt`;
    const cSet = resolveConfig(parseWorkflowSource(SRC_PROJECT), {}, makeTestRepos());
    expect(cSet.projectIds()).toEqual(['11111111-1111-4111-8111-111111111111']);
  });

  it('projectIds() accepts a CSV string (env-var interpolation form)', () => {
    // SYMPHONY_TRACKER_PROJECT_ID=uuid1,uuid2 expands to a literal CSV in
    // WORKFLOW.md after ${VAR} interpolation. The schema's preprocess splits
    // it into an array — so operators don't need to YAML-escape an array in
    // an env var.
    const SRC_CSV = `---
tracker:
  kind: linear
  api_key: k
  active_states: [Todo]
  terminal_states: [Done]
  project_id: "11111111-1111-4111-8111-111111111111, 22222222-2222-4222-8222-222222222222"
---
prompt`;
    const c = resolveConfig(parseWorkflowSource(SRC_CSV), {}, makeTestRepos());
    expect(c.projectIds()).toEqual([
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ]);
  });

  it('projectIds() accepts a YAML array', () => {
    const SRC_ARR = `---
tracker:
  kind: linear
  api_key: k
  active_states: [Todo]
  terminal_states: [Done]
  project_id:
    - 11111111-1111-4111-8111-111111111111
    - 22222222-2222-4222-8222-222222222222
---
prompt`;
    const c = resolveConfig(parseWorkflowSource(SRC_ARR), {}, makeTestRepos());
    expect(c.projectIds()).toEqual([
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ]);
  });
});

const SRC_A = `---
tracker:
  kind: linear
  api_key: k
  active_states: [Todo]
  terminal_states: [Done]
polling:
  interval_ms: 1000
agent:
  max_concurrent_agents: 2
---
prompt-A`;

const SRC_B = `---
tracker:
  kind: linear
  api_key: k
  active_states: [Backlog]
  terminal_states: [Done, Canceled]
polling:
  interval_ms: 7777
agent:
  max_concurrent_agents: 9
---
prompt-B`;

describe('liveConfig', () => {
  it('reads through to the inner config before swap', () => {
    const live = liveConfig(resolveConfig(parseWorkflowSource(SRC_A), {}, makeTestRepos()));
    expect(live.pollIntervalMs()).toBe(1000);
    expect(live.maxConcurrentAgents()).toBe(2);
    expect(live.activeStates()).toEqual(['todo']);
    expect(live.promptTemplate()).toBe('prompt-A');
  });

  it('swap() replaces all delegated reads on the live wrapper', () => {
    const live = liveConfig(resolveConfig(parseWorkflowSource(SRC_A), {}, makeTestRepos()));
    live.swap(resolveConfig(parseWorkflowSource(SRC_B), {}, makeTestRepos()));
    expect(live.pollIntervalMs()).toBe(7777);
    expect(live.maxConcurrentAgents()).toBe(9);
    expect(live.activeStates()).toEqual(['backlog']);
    expect(live.terminalStates()).toEqual(['done', 'canceled']);
    expect(live.promptTemplate()).toBe('prompt-B');
  });

  it('snapshot() captures values frozen at call time, ignoring later swaps', () => {
    const live = liveConfig(resolveConfig(parseWorkflowSource(SRC_A), {}, makeTestRepos()));
    const snap = live.snapshot();
    live.swap(resolveConfig(parseWorkflowSource(SRC_B), {}, makeTestRepos()));
    expect(snap.pollIntervalMs()).toBe(1000);
    expect(snap.maxConcurrentAgents()).toBe(2);
    expect(snap.promptTemplate()).toBe('prompt-A');
    // The live wrapper itself should reflect the swap, only the snapshot is frozen.
    expect(live.promptTemplate()).toBe('prompt-B');
  });

  it('sourceHash() reflects the currently swapped-in workflow', () => {
    const a = parseWorkflowSource(SRC_A);
    const b = parseWorkflowSource(SRC_B);
    const live = liveConfig(resolveConfig(a, {}, makeTestRepos()));
    expect(live.sourceHash()).toBe(a.sourceHash);
    live.swap(resolveConfig(b, {}, makeTestRepos()));
    expect(live.sourceHash()).toBe(b.sourceHash);
  });

  it('forwards arbitrary methods on the inner config without explicit enumeration', () => {
    // Stand-in for a future `ResolvedConfig` method: liveConfig has never heard
    // of it, but the Proxy must still forward the call through to the inner.
    // This is the test the ticket asks for — the wrapper stays untouched when
    // ResolvedConfig grows.
    const inner = {
      ...resolveConfig(parseWorkflowSource(SRC_A), {}, makeTestRepos()),
      futureField: () => 'future-value',
    } as ResolvedConfig & { futureField(): string };
    const live = liveConfig(inner) as typeof inner & { swap(next: ResolvedConfig): void };
    expect(live.futureField()).toBe('future-value');

    // And after a swap, the new inner's same-named method is reached too.
    const innerB = {
      ...resolveConfig(parseWorkflowSource(SRC_B), {}, makeTestRepos()),
      futureField: () => 'future-value-B',
    } as ResolvedConfig & { futureField(): string };
    live.swap(innerB);
    expect(live.futureField()).toBe('future-value-B');
  });
});
