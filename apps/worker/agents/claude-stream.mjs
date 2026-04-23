/**
 * Pure translator from Claude Code `--output-format stream-json --verbose`
 * events to Symphony `turn/event` + `turn/complete` notification params (see
 * apps/worker/src/agent/protocol.ts).
 *
 * Stateful because tool_result blocks arrive in a later message than their
 * corresponding tool_use blocks, and we want to emit a single enriched
 * tool_call event with `result_summary` when the result lands.
 *
 * Consumed by `claude-adapter.mjs` and unit-tested via
 * `apps/worker/src/agent/claude-stream.test.ts`.
 */

const TEXT_TRUNCATE = 2000;
const RESULT_TRUNCATE = 1000;

/**
 * @param {object} opts
 * @param {string} opts.turnId          Symphony turn id to stamp on events
 * @param {string} opts.threadId        Symphony thread id; used for turn/complete
 * @param {string} [opts.sessionId]     Expected Claude session id (sanity-check)
 * @param {(params: object) => void} opts.emitEvent     Called with TurnEventParams
 * @param {(params: object) => void} opts.emitComplete  Called once with TurnCompleteParams
 * @param {(msg: string) => void} [opts.logWarn]        Optional warn sink (stderr)
 */
export function createClaudeStream({
  turnId,
  threadId,
  sessionId,
  emitEvent,
  emitComplete,
  logWarn = () => {},
}) {
  /** tool_use_id -> tool name (for prettier result_summary emission) */
  const pendingTools = new Map();
  let completed = false;

  function complete(params) {
    if (completed) return;
    completed = true;
    emitComplete({ thread_id: threadId, turn_id: turnId, ...params });
  }

  function truncate(s, max) {
    if (typeof s !== 'string') s = safeStringify(s);
    if (s.length <= max) return s;
    return s.slice(0, max) + '…';
  }

  return {
    /** Feed one parsed Claude stream-json line. */
    push(ev) {
      if (!ev || typeof ev !== 'object') return;
      switch (ev.type) {
        case 'system':
          if (ev.subtype === 'init') {
            if (sessionId && ev.session_id && ev.session_id !== sessionId) {
              logWarn(`claude session_id mismatch: expected ${sessionId}, got ${ev.session_id}`);
            }
            emitEvent({
              kind: 'status',
              turn_id: turnId,
              message: `Claude session ${ev.session_id ?? sessionId ?? 'unknown'} started`,
            });
          }
          return;

        case 'assistant': {
          const content = ev.message?.content ?? [];
          for (const block of content) {
            if (block.type === 'text') {
              const text = (block.text ?? '').trim();
              if (!text) continue;
              emitEvent({
                kind: 'status',
                turn_id: turnId,
                message: truncate(text, TEXT_TRUNCATE),
              });
            } else if (block.type === 'tool_use') {
              if (block.id) pendingTools.set(block.id, block.name ?? 'tool');
              emitEvent({
                kind: 'tool_call',
                turn_id: turnId,
                tool: block.name ?? 'tool',
                args: block.input,
                call_id: block.id,
              });
            }
          }
          return;
        }

        case 'user': {
          const content = ev.message?.content ?? [];
          for (const block of content) {
            if (block.type !== 'tool_result') continue;
            const toolName = pendingTools.get(block.tool_use_id) ?? 'tool';
            if (block.tool_use_id) pendingTools.delete(block.tool_use_id);
            const rawContent = extractToolResult(block.content);
            const prefix = block.is_error ? 'error: ' : '';
            const summary = truncate(prefix + rawContent, RESULT_TRUNCATE);
            emitEvent({
              kind: 'tool_call',
              turn_id: turnId,
              tool: toolName,
              call_id: block.tool_use_id,
              result_summary: summary,
            });
            // Claude surfaces permission denials inside tool_result; raise a
            // distinct approval event so operators can see why a run stalled.
            if (block.is_error && /permission/i.test(String(rawContent))) {
              emitEvent({
                kind: 'approval',
                turn_id: turnId,
                reason: truncate(rawContent, RESULT_TRUNCATE),
                call_id: block.tool_use_id,
              });
            }
          }
          return;
        }

        case 'result': {
          const usage = ev.usage ?? {};
          const input =
            (usage.input_tokens ?? 0) +
            (usage.cache_creation_input_tokens ?? 0) +
            (usage.cache_read_input_tokens ?? 0);
          const output = usage.output_tokens ?? 0;
          if (input > 0 || output > 0) {
            emitEvent({
              kind: 'token_count',
              turn_id: turnId,
              input_tokens: input,
              output_tokens: output,
              total_tokens: input + output,
            });
          }
          if (ev.subtype === 'success') {
            complete({ outcome: 'success' });
          } else {
            complete({
              outcome: 'failure',
              error_class: ev.subtype ?? 'claude_error',
              error_message: ev.error ?? ev.result ?? ev.subtype ?? 'Claude run failed',
            });
          }
          return;
        }

        default:
          logWarn(`unknown claude stream-json type: ${ev.type}`);
      }
    },

    /** Force-complete (used when the child process exits unexpectedly). */
    forceComplete(params) {
      complete(params);
    },

    get isComplete() {
      return completed;
    },
  };
}

function extractToolResult(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (typeof c === 'string' ? c : (c?.text ?? safeStringify(c)))).join('');
  }
  return safeStringify(content);
}

function safeStringify(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
