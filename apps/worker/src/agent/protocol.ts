/**
 * Wire protocol for the coding-agent subprocess.
 *
 * Newline-delimited JSON (NDJSON) frames over stdio. Every line is a single
 * JSON object following a JSON-RPC 2.0 shape: requests carry an `id` and
 * receive a matching `id` in the response, notifications carry a `method` but
 * no `id`.
 *
 * Methods (worker -> agent):
 *   - initialize           handshake; agent returns capabilities
 *   - thread/start         create a conversation thread; returns thread_id
 *   - turn/start           run a single turn against the thread; returns turn_id
 *   - turn/interrupt       request graceful cancellation of the current turn
 *
 * Notifications (agent -> worker):
 *   - turn/event           runtime event (status, tool_call, approval,
 *                          token_count, error, user_input, humanized)
 *   - turn/complete        final result; turn ends, no more events for this id
 */

export interface RpcRequest<P = unknown> {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: P;
}

export interface RpcResult<R = unknown> {
  jsonrpc: '2.0';
  id: number;
  result: R;
}

export interface RpcError {
  jsonrpc: '2.0';
  id: number;
  error: { code: number; message: string; data?: unknown };
}

export interface RpcNotification<P = unknown> {
  jsonrpc: '2.0';
  method: string;
  params: P;
}

export type RpcMessage = RpcResult | RpcError | RpcNotification;

// ---- params ----

export interface InitializeParams {
  version: '1';
}
export interface InitializeResult {
  capabilities: { thread: boolean; turn: boolean };
}

export interface ThreadStartParams {
  approval_policy: 'never' | 'on-request' | 'on-failure' | 'always';
  thread_sandbox: 'none' | 'workspace-write' | 'read-only';
  cwd: string;
  network_access?: boolean;
  /**
   * Optional pre-generated session id. Claude Code adapter uses it to pin the
   * Claude session via `--session-id <uuid>` so the worker can pre-populate
   * live_sessions.thread_id before the turn produces any events. Codex adapter
   * ignores it.
   */
  session_id?: string;
}
export interface ThreadStartResult {
  thread_id: string;
}

export interface TurnStartParams {
  thread_id: string;
  prompt: string;
  turn_sandbox_policy: 'inherit' | 'workspace-write' | 'read-only' | 'danger-full-access';
}
export interface TurnStartResult {
  turn_id: string;
}

// ---- notifications ----

export type TurnEventParams =
  | { kind: 'status'; turn_id: string; message: string }
  | {
      kind: 'tool_call';
      turn_id: string;
      tool: string;
      args?: unknown;
      call_id?: string;
      result_summary?: string;
    }
  | { kind: 'approval'; turn_id: string; reason: string; call_id?: string }
  | {
      kind: 'token_count';
      turn_id: string;
      input_tokens: number;
      output_tokens: number;
      total_tokens: number;
    }
  | { kind: 'error'; turn_id: string; class: string; message: string; recoverable?: boolean }
  | { kind: 'user_input'; turn_id: string; text: string };

export interface TurnCompleteParams {
  thread_id: string;
  turn_id: string;
  outcome: 'success' | 'failure' | 'cancelled';
  error_class?: string;
  error_message?: string;
}

// =========================================================================
// NDJSON parser: chunked input -> complete JSON values
// =========================================================================

/**
 * Stateful line buffer that accepts arbitrary chunks and emits parsed JSON
 * values one at a time. Tolerates split UTF-8 boundaries and final line
 * without a trailing newline.
 */
export class NdjsonParser {
  private buffer = '';

  push(chunk: string): RpcMessage[] {
    this.buffer += chunk;
    const out: RpcMessage[] = [];
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      out.push(JSON.parse(line) as RpcMessage);
    }
    return out;
  }

  /** Drain anything left in the buffer (no trailing newline). */
  flush(): RpcMessage[] {
    const tail = this.buffer.trim();
    this.buffer = '';
    if (!tail) return [];
    return [JSON.parse(tail) as RpcMessage];
  }
}

export function encodeRequest<P>(id: number, method: string, params?: P): string {
  const req: RpcRequest<P> = { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) };
  return JSON.stringify(req) + '\n';
}

export function isResult(m: RpcMessage): m is RpcResult {
  return 'result' in m;
}
export function isError(m: RpcMessage): m is RpcError {
  return 'error' in m;
}
export function isNotification(m: RpcMessage): m is RpcNotification {
  return 'method' in m && !('id' in m);
}
