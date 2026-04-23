import type { AgentEventKind } from '@symphony/shared';
import type { TurnEventParams } from './protocol.js';

export interface MappedEvent {
  kind: AgentEventKind;
  payload: Record<string, unknown>;
  /** Optional human-readable summary; emitted as a separate `humanized` event. */
  humanized?: string;
  /** When present, the live_session token counters should be set to this. */
  tokens?: { input_tokens: number; output_tokens: number; total_tokens: number };
  /** When present, upsert into rate_limit_state so the dashboard header can render it. */
  rateLimit?: { source: string; remaining: number | null; resetAt: Date | null };
}

/**
 * Map a Codex turn/event notification onto:
 *   - the row we'll insert into agent_events (kind + payload)
 *   - an optional `humanized` summary line (rendered separately as its own
 *     event so the dashboard can show a clean operator-readable feed)
 *   - an optional token count snapshot to overwrite live_sessions counters
 */
export function mapTurnEvent(ev: TurnEventParams): MappedEvent {
  switch (ev.kind) {
    case 'status':
      return {
        kind: 'status',
        payload: { message: ev.message },
        humanized: ev.message,
      };
    case 'tool_call':
      return {
        kind: 'tool_call',
        payload: {
          tool: ev.tool,
          args: ev.args,
          call_id: ev.call_id,
          result_summary: ev.result_summary,
        },
        humanized: humanizeToolCall(ev.tool, ev.result_summary),
      };
    case 'approval':
      return {
        kind: 'approval',
        payload: { reason: ev.reason, call_id: ev.call_id },
        humanized: `Approval requested: ${ev.reason}`,
      };
    case 'token_count':
      return {
        kind: 'token_count',
        payload: {
          input_tokens: ev.input_tokens,
          output_tokens: ev.output_tokens,
          total_tokens: ev.total_tokens,
        },
        tokens: {
          input_tokens: ev.input_tokens,
          output_tokens: ev.output_tokens,
          total_tokens: ev.total_tokens,
        },
      };
    case 'error':
      return {
        kind: 'error',
        payload: { class: ev.class, message: ev.message, recoverable: ev.recoverable },
        humanized: `Error (${ev.class}): ${ev.message}`,
      };
    case 'user_input':
      return {
        kind: 'user_input',
        payload: { text: ev.text },
      };
    case 'rate_limit': {
      const remaining = typeof ev.remaining === 'number' ? ev.remaining : null;
      // Adapters may forward `reset_at` verbatim from upstream responses, so
      // the shape varies. Parse defensively — an unparseable string would
      // otherwise propagate `Invalid Date` to repo.upsertRateLimit, where
      // `.toISOString()` throws and drops the event entirely.
      const resetAt = parseIsoDate(ev.reset_at);
      return {
        kind: 'rate_limit',
        payload: {
          source: ev.source,
          remaining,
          reset_at: resetAt ? resetAt.toISOString() : null,
        },
        rateLimit: { source: ev.source, remaining, resetAt },
      };
    }
  }
}

function humanizeToolCall(tool: string, resultSummary?: string): string {
  if (resultSummary) return `${tool}: ${resultSummary}`;
  return `Calling ${tool}`;
}

function parseIsoDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}
