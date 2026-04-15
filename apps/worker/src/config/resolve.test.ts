import { describe, it, expect } from 'vitest';
import { resolveConfig } from './resolve.js';
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
});
