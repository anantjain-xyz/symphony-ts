import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { parseWorkflowSource } from './workflow.js';

const MINIMAL = `---
tracker:
  kind: linear
  api_key: \${LINEAR_API_KEY}
  active_states: [todo, in progress]
  terminal_states: [done, cancelled]
---
You are working on issue {{identifier}}: {{title}}.
`;

describe('parseWorkflowSource', () => {
  const orig = process.env.LINEAR_API_KEY;
  beforeEach(() => {
    process.env.LINEAR_API_KEY = 'lin_api_test';
  });
  afterEach(() => {
    if (orig === undefined) delete process.env.LINEAR_API_KEY;
    else process.env.LINEAR_API_KEY = orig;
  });

  it('parses minimal front matter and applies defaults', () => {
    const w = parseWorkflowSource(MINIMAL);
    expect(w.frontMatter.tracker.api_key).toBe('lin_api_test');
    expect(w.frontMatter.polling.interval_ms).toBe(30_000);
    expect(w.frontMatter.agent.max_concurrent_agents).toBe(10);
    expect(w.frontMatter.codex.command).toBe('codex');
    expect(w.promptTemplate).toContain('You are working on issue');
  });

  it('expands ${TMPDIR} in workspace.root even when env var is unset', () => {
    const origTmp = process.env.TMPDIR;
    delete process.env.TMPDIR;
    try {
      const w = parseWorkflowSource(MINIMAL);
      expect(w.frontMatter.workspace.root.startsWith(tmpdir())).toBe(true);
    } finally {
      if (origTmp !== undefined) process.env.TMPDIR = origTmp;
    }
  });

  it('expands ~ in workspace.root', () => {
    const src = `---
tracker:
  kind: linear
  api_key: k
  active_states: [a]
  terminal_states: [b]
workspace:
  root: ~/symphony-test
---
prompt`;
    const w = parseWorkflowSource(src);
    expect(w.frontMatter.workspace.root).toMatch(/symphony-test$/);
    expect(w.frontMatter.workspace.root.startsWith('~')).toBe(false);
  });

  it('produces a stable sourceHash', () => {
    const a = parseWorkflowSource(MINIMAL);
    const b = parseWorkflowSource(MINIMAL);
    expect(a.sourceHash).toBe(b.sourceHash);
    expect(a.sourceHash).toHaveLength(64);
  });

  it('throws on invalid front matter', () => {
    const bad = `---
tracker:
  kind: linear
---
prompt`;
    expect(() => parseWorkflowSource(bad)).toThrow();
  });

  it('preserves unknown top-level keys', () => {
    const src = MINIMAL.replace('---\n', '---\nfuture_thing:\n  enabled: true\n');
    const w = parseWorkflowSource(src);
    expect((w.frontMatter as Record<string, unknown>).future_thing).toEqual({ enabled: true });
  });
});
