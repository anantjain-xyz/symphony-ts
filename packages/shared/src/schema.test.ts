import { describe, it, expect } from 'vitest';
import {
  WorkflowFrontMatter,
  Issue,
  RunAttemptStatus,
  AgentEventKind,
  TokenCountPayload,
} from './schema.js';

describe('WorkflowFrontMatter', () => {
  it('applies all defaults when only tracker is provided', () => {
    const parsed = WorkflowFrontMatter.parse({
      tracker: {
        kind: 'linear',
        api_key: 'lin_api_xxx',
        active_states: ['todo', 'in progress'],
        terminal_states: ['done', 'cancelled'],
      },
    });
    expect(parsed.polling.interval_ms).toBe(30_000);
    expect(parsed.workspace.root).toBe('${TMPDIR}/symphony-workspaces');
    expect(parsed.hooks.timeout_ms).toBe(60_000);
    expect(parsed.agent.max_concurrent_agents).toBe(10);
    expect(parsed.agent.max_retry_backoff_ms).toBe(300_000);
    expect(parsed.codex.command).toBe('codex');
    expect(parsed.codex.turn_timeout_ms).toBe(3_600_000);
  });

  it('passes through unknown top-level keys (forward compat)', () => {
    const parsed = WorkflowFrontMatter.parse({
      tracker: {
        kind: 'linear',
        api_key: 'k',
        active_states: ['a'],
        terminal_states: ['b'],
      },
      future_extension: { hello: 'world' },
    });
    expect((parsed as Record<string, unknown>).future_extension).toEqual({ hello: 'world' });
  });

  it('rejects missing required tracker fields', () => {
    expect(() =>
      WorkflowFrontMatter.parse({ tracker: { kind: 'linear' } }),
    ).toThrow();
  });
});

describe('Issue', () => {
  it('parses a normalized issue', () => {
    const issue = Issue.parse({
      id: 'abc-123',
      identifier: 'ENG-42',
      title: 'Fix bug',
      description: null,
      priority: 2,
      state: 'in progress',
      branch: null,
      labels: ['backend'],
      blockers: [],
    });
    expect(issue.identifier).toBe('ENG-42');
  });
});

describe('Enums match Postgres', () => {
  it('RunAttemptStatus has the seven expected values', () => {
    expect(RunAttemptStatus.options).toEqual([
      'pending',
      'running',
      'success',
      'failure',
      'timeout',
      'cancelled',
    ]);
  });

  it('AgentEventKind has the seven expected values', () => {
    expect(AgentEventKind.options).toEqual([
      'status',
      'tool_call',
      'approval',
      'token_count',
      'error',
      'user_input',
      'humanized',
    ]);
  });
});

describe('Event payloads', () => {
  it('TokenCountPayload requires non-negative integers', () => {
    expect(() =>
      TokenCountPayload.parse({ input_tokens: -1, output_tokens: 0, total_tokens: 0 }),
    ).toThrow();
    expect(
      TokenCountPayload.parse({ input_tokens: 10, output_tokens: 5, total_tokens: 15 }),
    ).toEqual({ input_tokens: 10, output_tokens: 5, total_tokens: 15 });
  });
});
