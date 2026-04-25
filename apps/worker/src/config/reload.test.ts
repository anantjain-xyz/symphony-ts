import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reloadWorkflowConfig } from './reload.js';
import { liveConfig, resolveConfig } from './resolve.js';
import { parseWorkflowSource } from './workflow.js';

const SRC_INITIAL = `---
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
prompt-initial`;

const SRC_UPDATED = `---
tracker:
  kind: linear
  api_key: k
  active_states: [Todo, In Progress]
  terminal_states: [Done]
polling:
  interval_ms: 5000
agent:
  max_concurrent_agents: 9
---
prompt-updated`;

// Missing required tracker fields → zod rejects in parseWorkflowSource.
const SRC_INVALID = `---
tracker:
  kind: linear
---
prompt`;

const log = pino({ level: 'silent' });

describe('reloadWorkflowConfig', () => {
  let dir: string;
  let workflowPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'symphony-reload-'));
    workflowPath = path.join(dir, 'WORKFLOW.md');
    await writeFile(workflowPath, SRC_INITIAL, 'utf8');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns "unchanged" and leaves the live config untouched when sourceHash matches', async () => {
    const live = liveConfig(resolveConfig(parseWorkflowSource(SRC_INITIAL)));
    const before = live.snapshot();
    const outcome = await reloadWorkflowConfig({ workflowPath, live, log });
    expect(outcome).toBe('unchanged');
    expect(live.snapshot()).toBe(before); // same inner ref
    expect(live.pollIntervalMs()).toBe(1000);
  });

  it('returns "swapped" and updates the live config when the file changes', async () => {
    const live = liveConfig(resolveConfig(parseWorkflowSource(SRC_INITIAL)));
    const inflight = live.snapshot();
    await writeFile(workflowPath, SRC_UPDATED, 'utf8');

    const outcome = await reloadWorkflowConfig({ workflowPath, live, log });
    expect(outcome).toBe('swapped');
    expect(live.pollIntervalMs()).toBe(5000);
    expect(live.maxConcurrentAgents()).toBe(9);
    expect(live.activeStates()).toEqual(['todo', 'in progress']);
    expect(live.promptTemplate()).toBe('prompt-updated');

    // The pre-swap snapshot mimics an in-flight attempt's frozen view —
    // it must not observe the swap.
    expect(inflight.pollIntervalMs()).toBe(1000);
    expect(inflight.maxConcurrentAgents()).toBe(2);
    expect(inflight.promptTemplate()).toBe('prompt-initial');
  });

  it('returns "invalid" and keeps the previous config when the new file fails validation', async () => {
    const live = liveConfig(resolveConfig(parseWorkflowSource(SRC_INITIAL)));
    await writeFile(workflowPath, SRC_INVALID, 'utf8');
    const outcome = await reloadWorkflowConfig({ workflowPath, live, log });
    expect(outcome).toBe('invalid');
    expect(live.pollIntervalMs()).toBe(1000);
    expect(live.maxConcurrentAgents()).toBe(2);
    expect(live.promptTemplate()).toBe('prompt-initial');
  });

  it('returns "invalid" and keeps the previous config when the file is missing', async () => {
    const live = liveConfig(resolveConfig(parseWorkflowSource(SRC_INITIAL)));
    await rm(workflowPath, { force: true });
    const outcome = await reloadWorkflowConfig({ workflowPath, live, log });
    expect(outcome).toBe('invalid');
    expect(live.pollIntervalMs()).toBe(1000);
  });

  it('serializes overlapping reloads so an older read cannot roll back a newer swap', async () => {
    // Race covered: SIGHUP A starts read (file = initial). File is rewritten.
    // SIGHUP B starts read (file = updated). If reloads ran concurrently, A's
    // late-completing read could swap initial back over B's already-applied
    // updated config. Serialization makes A re-read after B finishes — at
    // that point its read sees `updated` too, so the second outcome is
    // 'unchanged' and live config stays on `updated`.
    const live = liveConfig(resolveConfig(parseWorkflowSource(SRC_INITIAL)));
    const a = reloadWorkflowConfig({ workflowPath, live, log });
    await writeFile(workflowPath, SRC_UPDATED, 'utf8');
    const b = reloadWorkflowConfig({ workflowPath, live, log });
    const outcomes = await Promise.all([a, b]);
    expect(outcomes).toContain('swapped');
    // Whichever runs first picks up `updated`; the second sees no further
    // change. The worker must end up on `updated` either way.
    expect(live.pollIntervalMs()).toBe(5000);
    expect(live.maxConcurrentAgents()).toBe(9);
    expect(live.activeStates()).toEqual(['todo', 'in progress']);
  });
});
