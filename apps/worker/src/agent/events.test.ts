import { describe, expect, it } from 'vitest';
import { mapTurnEvent } from './events.js';

describe('mapTurnEvent', () => {
  it('status -> status with humanized = message', () => {
    const m = mapTurnEvent({ kind: 'status', turn_id: 't', message: 'Reading repo' });
    expect(m.kind).toBe('status');
    expect(m.payload).toEqual({ message: 'Reading repo' });
    expect(m.humanized).toBe('Reading repo');
  });

  it('tool_call humanizes with result_summary when present', () => {
    const m = mapTurnEvent({
      kind: 'tool_call',
      turn_id: 't',
      tool: 'bash',
      args: { cmd: 'pnpm test' },
      result_summary: '40 tests passed',
    });
    expect(m.humanized).toBe('bash: 40 tests passed');
  });

  it('tool_call humanizes without result_summary', () => {
    const m = mapTurnEvent({ kind: 'tool_call', turn_id: 't', tool: 'edit_file' });
    expect(m.humanized).toBe('Calling edit_file');
  });

  it('approval includes reason in payload and humanized line', () => {
    const m = mapTurnEvent({
      kind: 'approval',
      turn_id: 't',
      reason: 'destructive command',
      call_id: 'c1',
    });
    expect(m.kind).toBe('approval');
    expect(m.humanized).toBe('Approval requested: destructive command');
  });

  it('token_count carries token snapshot for live_sessions update', () => {
    const m = mapTurnEvent({
      kind: 'token_count',
      turn_id: 't',
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
    });
    expect(m.tokens).toEqual({ input_tokens: 10, output_tokens: 5, total_tokens: 15 });
    expect(m.humanized).toBeUndefined();
  });

  it('error humanized as Error (class): message', () => {
    const m = mapTurnEvent({
      kind: 'error',
      turn_id: 't',
      class: 'tool_failure',
      message: 'tests failed',
    });
    expect(m.humanized).toBe('Error (tool_failure): tests failed');
  });

  it('user_input does not produce a humanized line', () => {
    const m = mapTurnEvent({ kind: 'user_input', turn_id: 't', text: 'hi' });
    expect(m.humanized).toBeUndefined();
  });
});
