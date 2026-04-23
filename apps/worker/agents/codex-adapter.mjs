#!/usr/bin/env node

/**
 * Symphony <-> Codex exec adapter.
 *
 * Speaks Symphony's NDJSON JSON-RPC protocol on stdio (see
 * apps/worker/src/agent/protocol.ts), translating `turn/start` into a
 * `codex exec --json` invocation and streaming Codex's JSONL items back as
 * Symphony `turn/event` + `turn/complete` notifications.
 *
 * One turn per process: Symphony's CodexRunner spawns a fresh adapter per
 * attempt, so we exit when the child exits.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin, terminal: false });

let thread = null; // { id, cwd, approvalPolicy, threadSandbox }
let turn = null; // { id, child, completed }

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}
const notif = (method, params) => ({ jsonrpc: '2.0', method, params });
const reply = (id, result) => ({ jsonrpc: '2.0', id, result });
const errReply = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  switch (msg.method) {
    case 'initialize':
      send(reply(msg.id, { capabilities: { thread: true, turn: true } }));
      return;
    case 'thread/start': {
      const p = msg.params ?? {};
      thread = {
        id: `th_${randomUUID()}`,
        cwd: p.cwd,
        approvalPolicy: p.approval_policy,
        threadSandbox: p.thread_sandbox,
        networkAccess: p.network_access === true,
      };
      send(reply(msg.id, { thread_id: thread.id }));
      return;
    }
    case 'turn/start': {
      if (!thread) {
        send(errReply(msg.id, -32000, 'turn/start before thread/start'));
        return;
      }
      const p = msg.params ?? {};
      turn = { id: `tn_${randomUUID()}`, child: null, completed: false };
      send(reply(msg.id, { turn_id: turn.id }));
      startTurn(p.prompt ?? '', p.turn_sandbox_policy);
      return;
    }
    case 'turn/interrupt':
      if (turn?.child && !turn.completed) turn.child.kill('SIGTERM');
      return;
  }
});

rl.on('close', () => {
  if (turn?.child && !turn.completed) turn.child.kill('SIGTERM');
});

function startTurn(prompt, turnSandboxPolicy) {
  const { args, sandbox } = buildCodexArgs(turnSandboxPolicy);
  logStderr(`spawning: codex ${args.join(' ')} (cwd=${thread.cwd}, sandbox=${sandbox})`);

  const child = spawn('codex', args, {
    cwd: thread.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });
  turn.child = child;

  child.stdin.end(prompt);

  let stdoutBuf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk;
    let nl;
    while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, nl).trim();
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line) continue;
      try {
        handleCodexEvent(JSON.parse(line));
      } catch (err) {
        logStderr(`invalid codex JSON: ${err.message} :: ${line.slice(0, 200)}`);
      }
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));

  child.on('exit', (code, signal) => {
    if (!turn.completed) {
      turn.completed = true;
      const outcome = signal ? 'cancelled' : code === 0 ? 'success' : 'failure';
      send(
        notif('turn/complete', {
          thread_id: thread.id,
          turn_id: turn.id,
          outcome,
          ...(outcome === 'failure'
            ? { error_class: 'nonzero_exit', error_message: `codex exit ${code}` }
            : {}),
        }),
      );
    }
    process.exit(0);
  });

  child.on('error', (err) => {
    if (!turn.completed) {
      turn.completed = true;
      send(
        notif('turn/complete', {
          thread_id: thread.id,
          turn_id: turn.id,
          outcome: 'failure',
          error_class: 'spawn_error',
          error_message: err.message,
        }),
      );
    }
    process.exit(1);
  });
}

function buildCodexArgs(turnSandboxPolicy) {
  const policy = turnSandboxPolicy === 'inherit' ? thread.threadSandbox : turnSandboxPolicy;
  const sandbox = normalizeSandbox(policy);
  const args = ['exec', '--json', '--skip-git-repo-check', '-C', thread.cwd];
  if (sandbox === 'danger-full-access') {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  } else if (sandbox === 'workspace-write') {
    // --full-auto === -s workspace-write with approvals bypassed
    args.push('--full-auto');
    // Codex 0.120.0 gates outbound network under the workspace-write sandbox
    // via a single TOML toggle. Pass it through as a -c override so WORKFLOW.md
    // stays authoritative (vs. mutating ~/.codex/config.toml).
    if (thread.networkAccess) {
      args.push('-c', 'sandbox_workspace_write.network_access=true');
    }
  } else {
    args.push('-s', 'read-only');
  }
  return { args, sandbox };
}

function normalizeSandbox(policy) {
  switch (policy) {
    case 'read-only':
    case 'none':
      return 'read-only';
    case 'danger-full-access':
      return 'danger-full-access';
    case 'workspace-write':
    default:
      return 'workspace-write';
  }
}

function handleCodexEvent(ev) {
  switch (ev.type) {
    case 'thread.started':
      emitStatus(`Codex thread ${ev.thread_id}`);
      return;
    case 'turn.started':
      emitStatus('Turn started');
      return;
    case 'item.started':
    case 'item.updated':
    case 'item.completed':
      mapItem(ev);
      return;
    case 'turn.completed': {
      const usage = ev.usage ?? {};
      const input = usage.input_tokens ?? 0;
      const output = usage.output_tokens ?? 0;
      send(
        notif('turn/event', {
          kind: 'token_count',
          turn_id: turn.id,
          input_tokens: input,
          output_tokens: output,
          total_tokens: input + output,
        }),
      );
      // Newer codex builds attach a `rate_limits` object to turn.completed.
      // Forward it best-effort; shape varies across versions, so we only
      // trust string/number fields we recognize. Unknown shapes drop through.
      if (ev.rate_limits && typeof ev.rate_limits === 'object') {
        for (const [bucket, info] of Object.entries(ev.rate_limits)) {
          if (!info || typeof info !== 'object') continue;
          const remaining =
            typeof info.remaining === 'number'
              ? info.remaining
              : typeof info.remaining_tokens === 'number'
                ? info.remaining_tokens
                : null;
          const resetAt =
            typeof info.reset_at === 'string'
              ? info.reset_at
              : typeof info.reset === 'string'
                ? info.reset
                : null;
          send(
            notif('turn/event', {
              kind: 'rate_limit',
              turn_id: turn.id,
              source: `codex_${bucket}`,
              remaining,
              reset_at: resetAt,
            }),
          );
        }
      }
      if (!turn.completed) {
        turn.completed = true;
        send(
          notif('turn/complete', {
            thread_id: thread.id,
            turn_id: turn.id,
            outcome: 'success',
          }),
        );
      }
      return;
    }
    case 'turn.failed':
      if (!turn.completed) {
        turn.completed = true;
        send(
          notif('turn/complete', {
            thread_id: thread.id,
            turn_id: turn.id,
            outcome: 'failure',
            error_class: ev.error?.type ?? 'turn_failed',
            error_message: ev.error?.message ?? 'Codex turn failed',
          }),
        );
      }
      return;
    case 'error':
      send(
        notif('turn/event', {
          kind: 'error',
          turn_id: turn.id,
          class: ev.class ?? 'codex_error',
          message: ev.message ?? 'Codex error',
          recoverable: true,
        }),
      );
      return;
  }
}

function mapItem(ev) {
  const item = ev.item ?? {};
  switch (item.type) {
    case 'agent_message':
      if (ev.type === 'item.completed' && item.text) emitStatus(item.text);
      return;
    case 'command_execution': {
      if (ev.type !== 'item.started' && ev.type !== 'item.completed') return;
      const summary = ev.type === 'item.completed' ? `exit ${item.exit_code ?? '?'}` : 'running';
      send(
        notif('turn/event', {
          kind: 'tool_call',
          turn_id: turn.id,
          tool: 'bash',
          args: { command: item.command },
          call_id: item.id,
          result_summary: summary,
        }),
      );
      return;
    }
    case 'reasoning':
      return;
    default:
      if (ev.type === 'item.completed') emitStatus(`${item.type ?? 'item'} completed`);
  }
}

function emitStatus(message) {
  send(notif('turn/event', { kind: 'status', turn_id: turn.id, message }));
}

function logStderr(msg) {
  process.stderr.write(`[codex-adapter] ${msg}\n`);
}
