import { describe, expect, it } from 'vitest';
import {
  AgentEventKind,
  Issue,
  RunStatus,
  TokenCountPayload,
  WorkflowFrontMatter,
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
    expect(parsed.agent.backend).toBe('codex');
    expect(parsed.codex.command).toBe('codex');
    expect(parsed.codex.turn_timeout_ms).toBe(3_600_000);
    expect(parsed.claude.command).toBe('node ${SYMPHONY_CLAUDE_ADAPTER}');
    expect(parsed.claude.permission_mode).toBe('acceptEdits');
    expect(parsed.claude.allowed_tools).toEqual([]);
    expect(parsed.claude.turn_timeout_ms).toBe(3_600_000);
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
    expect(() => WorkflowFrontMatter.parse({ tracker: { kind: 'linear' } })).toThrow();
  });

  it('parses optional identifier_prefix when set, and leaves it undefined when omitted', () => {
    const withPrefix = WorkflowFrontMatter.parse({
      tracker: {
        kind: 'linear',
        api_key: 'k',
        active_states: ['todo'],
        terminal_states: ['done'],
        identifier_prefix: 'PB-',
      },
    });
    expect(withPrefix.tracker.identifier_prefix).toBe('PB-');

    const withoutPrefix = WorkflowFrontMatter.parse({
      tracker: {
        kind: 'linear',
        api_key: 'k',
        active_states: ['todo'],
        terminal_states: ['done'],
      },
    });
    expect(withoutPrefix.tracker.identifier_prefix).toBeUndefined();
  });

  it('normalizes project_id to a string[] from single UUID, CSV string, or YAML array', () => {
    const projectId = '11111111-1111-4111-8111-111111111111';
    const second = '22222222-2222-4222-8222-222222222222';

    // Legacy single-UUID string normalizes to a one-element array.
    const single = WorkflowFrontMatter.parse({
      tracker: {
        kind: 'linear',
        api_key: 'k',
        active_states: ['todo'],
        terminal_states: ['done'],
        project_id: projectId,
      },
    });
    expect(single.tracker.project_id).toEqual([projectId]);

    // CSV string (env-var interpolation form) splits into an array.
    const csv = WorkflowFrontMatter.parse({
      tracker: {
        kind: 'linear',
        api_key: 'k',
        active_states: ['todo'],
        terminal_states: ['done'],
        project_id: `${projectId}, ${second}`,
      },
    });
    expect(csv.tracker.project_id).toEqual([projectId, second]);

    // YAML array passes through.
    const arr = WorkflowFrontMatter.parse({
      tracker: {
        kind: 'linear',
        api_key: 'k',
        active_states: ['todo'],
        terminal_states: ['done'],
        project_id: [projectId, second],
      },
    });
    expect(arr.tracker.project_id).toEqual([projectId, second]);

    const without = WorkflowFrontMatter.parse({
      tracker: {
        kind: 'linear',
        api_key: 'k',
        active_states: ['todo'],
        terminal_states: ['done'],
      },
    });
    expect(without.tracker.project_id).toBeUndefined();

    expect(() =>
      WorkflowFrontMatter.parse({
        tracker: {
          kind: 'linear',
          api_key: 'k',
          active_states: ['todo'],
          terminal_states: ['done'],
          project_id: 'not-a-uuid',
        },
      }),
    ).toThrow();

    // One bad UUID in a CSV string fails the whole array.
    expect(() =>
      WorkflowFrontMatter.parse({
        tracker: {
          kind: 'linear',
          api_key: 'k',
          active_states: ['todo'],
          terminal_states: ['done'],
          project_id: `${projectId},not-a-uuid`,
        },
      }),
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
      pr_urls: [],
    });
    expect(issue.identifier).toBe('ENG-42');
  });
});

describe('Enums match Postgres', () => {
  it('RunStatus has the seven expected values', () => {
    expect(RunStatus.options).toEqual([
      'pending',
      'running',
      'success',
      'failure',
      'timeout',
      'cancelled',
    ]);
  });

  it('AgentEventKind covers every agent_event_kind enum value', () => {
    expect(AgentEventKind.options).toEqual([
      'status',
      'tool_call',
      'approval',
      'token_count',
      'error',
      'user_input',
      'humanized',
      'rate_limit',
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
