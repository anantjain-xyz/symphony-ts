import { describe, expect, it } from 'vitest';
// @ts-expect-error - sibling .mjs consumed by the adapter; vitest loads ESM fine.
import { createClaudeStream } from '../../agents/claude-stream.mjs';
import type { TurnCompleteParams, TurnEventParams } from './protocol.js';

function harness(sessionId: string = 'sess-1') {
  const events: TurnEventParams[] = [];
  const completions: TurnCompleteParams[] = [];
  const warns: string[] = [];
  const stream = createClaudeStream({
    turnId: sessionId,
    threadId: sessionId,
    sessionId,
    emitEvent: (p: TurnEventParams) => events.push(p),
    emitComplete: (p: TurnCompleteParams) => completions.push(p),
    logWarn: (m: string) => warns.push(m),
  });
  return { stream, events, completions, warns };
}

describe('createClaudeStream', () => {
  it('maps a happy-path success trajectory', () => {
    const { stream, events, completions } = harness();
    stream.push({ type: 'system', subtype: 'init', session_id: 'sess-1' });
    stream.push({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Reading the repo layout.' },
          { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    });
    stream.push({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'tu_1', content: '12 files', is_error: false },
        ],
      },
    });
    stream.push({
      type: 'result',
      subtype: 'success',
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 25 },
    });

    expect(events.map((e) => e.kind)).toEqual([
      'status', // session started
      'status', // assistant text
      'tool_call', // tool_use
      'tool_call', // tool_result enriched
      'token_count', // from result.usage
    ]);
    const tokenEv = events.find((e) => e.kind === 'token_count');
    expect(tokenEv).toMatchObject({
      input_tokens: 125, // 100 input + 25 cache_read + 0 cache_creation
      output_tokens: 50,
      total_tokens: 175,
    });
    expect(completions).toEqual([{ thread_id: 'sess-1', turn_id: 'sess-1', outcome: 'success' }]);
  });

  it('emits multiple tool_call events when a message carries multiple tool_use blocks', () => {
    const { stream, events } = harness();
    stream.push({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'pwd' } },
          { type: 'tool_use', id: 'b', name: 'Read', input: { path: 'x' } },
        ],
      },
    });
    const calls = events.filter((e) => e.kind === 'tool_call');
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => (c as { tool: string }).tool)).toEqual(['Bash', 'Read']);
  });

  it('prefixes result_summary with "error: " when tool_result.is_error is true', () => {
    const { stream, events } = harness();
    stream.push({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: {} }],
      },
    });
    stream.push({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'x', content: 'exit 1', is_error: true }],
      },
    });
    const result = events.filter((e) => e.kind === 'tool_call').at(-1);
    expect(result).toMatchObject({
      tool: 'Bash',
      call_id: 'x',
      result_summary: 'error: exit 1',
    });
  });

  it('raises an approval event when a tool_result is a permission denial', () => {
    const { stream, events } = harness();
    stream.push({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'y', name: 'Bash', input: {} }],
      },
    });
    stream.push({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'y',
            content: 'permission denied by user',
            is_error: true,
          },
        ],
      },
    });
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('approval');
    const approval = events.find((e) => e.kind === 'approval');
    expect(approval).toMatchObject({ call_id: 'y' });
  });

  it('maps a failure result to a failed turn/complete with error_class', () => {
    const { stream, completions } = harness();
    stream.push({
      type: 'result',
      subtype: 'error_max_turns',
      error: 'hit max turns',
      usage: { input_tokens: 10, output_tokens: 0 },
    });
    expect(completions).toEqual([
      {
        thread_id: 'sess-1',
        turn_id: 'sess-1',
        outcome: 'failure',
        error_class: 'error_max_turns',
        error_message: 'hit max turns',
      },
    ]);
  });

  it('warns on unknown event types without throwing', () => {
    const { stream, warns } = harness();
    stream.push({ type: 'something_new' });
    expect(warns.some((w) => w.includes('something_new'))).toBe(true);
  });

  it('skips empty assistant text blocks', () => {
    const { stream, events } = harness();
    stream.push({
      type: 'assistant',
      message: { content: [{ type: 'text', text: '   ' }] },
    });
    expect(events).toEqual([]);
  });

  it('forceComplete is idempotent after a natural completion', () => {
    const { stream, completions } = harness();
    stream.push({ type: 'result', subtype: 'success' });
    stream.forceComplete({ outcome: 'failure', error_class: 'x', error_message: 'x' });
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({ outcome: 'success' });
  });
});
