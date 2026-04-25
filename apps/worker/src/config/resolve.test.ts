import { describe, expect, it } from 'vitest';
import { liveConfig, resolveConfig } from './resolve.js';
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
    const c = resolveConfig(w);
    expect(c.pollIntervalMs()).toBe(5000);
    expect(c.maxConcurrentAgents()).toBe(4);
    expect(c.maxConcurrentByState()).toEqual({ todo: 2 });
  });

  it('lowercases tracker states', () => {
    const w = parseWorkflowSource(SRC);
    const c = resolveConfig(w);
    expect(c.activeStates()).toEqual(['todo', 'in progress']);
    expect(c.terminalStates()).toEqual(['done', 'cancelled']);
  });

  it('explicit overrides take precedence over workflow', () => {
    const w = parseWorkflowSource(SRC);
    const c = resolveConfig(w, { pollIntervalMs: 1000, maxConcurrentAgents: 1 });
    expect(c.pollIntervalMs()).toBe(1000);
    expect(c.maxConcurrentAgents()).toBe(1);
  });

  it('snapshot() on a static config returns itself', () => {
    const c = resolveConfig(parseWorkflowSource(SRC));
    expect(c.snapshot()).toBe(c);
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
    const live = liveConfig(resolveConfig(parseWorkflowSource(SRC_A)));
    expect(live.pollIntervalMs()).toBe(1000);
    expect(live.maxConcurrentAgents()).toBe(2);
    expect(live.activeStates()).toEqual(['todo']);
    expect(live.promptTemplate()).toBe('prompt-A');
  });

  it('swap() replaces all delegated reads on the live wrapper', () => {
    const live = liveConfig(resolveConfig(parseWorkflowSource(SRC_A)));
    live.swap(resolveConfig(parseWorkflowSource(SRC_B)));
    expect(live.pollIntervalMs()).toBe(7777);
    expect(live.maxConcurrentAgents()).toBe(9);
    expect(live.activeStates()).toEqual(['backlog']);
    expect(live.terminalStates()).toEqual(['done', 'canceled']);
    expect(live.promptTemplate()).toBe('prompt-B');
  });

  it('snapshot() captures values frozen at call time, ignoring later swaps', () => {
    const live = liveConfig(resolveConfig(parseWorkflowSource(SRC_A)));
    const snap = live.snapshot();
    live.swap(resolveConfig(parseWorkflowSource(SRC_B)));
    expect(snap.pollIntervalMs()).toBe(1000);
    expect(snap.maxConcurrentAgents()).toBe(2);
    expect(snap.promptTemplate()).toBe('prompt-A');
    // The live wrapper itself should reflect the swap, only the snapshot is frozen.
    expect(live.promptTemplate()).toBe('prompt-B');
  });

  it('sourceHash() reflects the currently swapped-in workflow', () => {
    const a = parseWorkflowSource(SRC_A);
    const b = parseWorkflowSource(SRC_B);
    const live = liveConfig(resolveConfig(a));
    expect(live.sourceHash()).toBe(a.sourceHash);
    live.swap(resolveConfig(b));
    expect(live.sourceHash()).toBe(b.sourceHash);
  });
});
