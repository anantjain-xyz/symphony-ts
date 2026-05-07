#!/usr/bin/env node

/**
 * Symphony <-> Claude Code exec adapter.
 *
 * Speaks Symphony's NDJSON JSON-RPC protocol on stdio (see
 * apps/worker/src/agent/protocol.ts), translating `turn/start` into a
 * `cbcode --agent claude -p --output-format stream-json --verbose --session-id <uuid>`
 * invocation and streaming Claude's stream-json events back as Symphony
 * `turn/event` + `turn/complete` notifications.
 *
 * One turn per process: Symphony's AgentRunner spawns a fresh adapter per
 * attempt, so we exit when the child exits.
 *
 * Claude-specific config is read from env vars the worker sets when spawning:
 *   SYMPHONY_CLAUDE_PERMISSION_MODE   default | acceptEdits | auto | bypassPermissions | dontAsk | plan
 *   SYMPHONY_CLAUDE_ALLOWED_TOOLS     comma-joined list (omit for default allow)
 *   SYMPHONY_CLAUDE_DISALLOWED_TOOLS  comma-joined list
 *   SYMPHONY_CLAUDE_ADD_DIRS          `:` separated extra --add-dir scopes
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import readline from 'node:readline';
import { createClaudeStream } from './claude-stream.mjs';

const rl = readline.createInterface({ input: process.stdin, terminal: false });

/** @type {{ id: string, cwd: string, sessionId: string } | null} */
let thread = null;
/** @type {{ id: string, child: import('node:child_process').ChildProcess | null, completed: boolean, stream: ReturnType<typeof createClaudeStream> | null } | null} */
let turn = null;

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
      // Worker pre-generates a uuid so live_sessions.thread_id lines up with
      // Claude's session id before any events are emitted. Fall back to a
      // fresh uuid for stand-alone testing.
      const sessionId = p.session_id ?? randomUUID();
      thread = { id: sessionId, cwd: p.cwd, sessionId };
      send(reply(msg.id, { thread_id: sessionId }));
      return;
    }
    case 'turn/start': {
      if (!thread) {
        send(errReply(msg.id, -32000, 'turn/start before thread/start'));
        return;
      }
      const p = msg.params ?? {};
      // Keep turn_id aligned with session/thread so the dashboard's compound
      // session key is stable and `attach` needs only one uuid to resume.
      turn = { id: thread.sessionId, child: null, completed: false, stream: null };
      send(reply(msg.id, { turn_id: turn.id }));
      startTurn(p.prompt ?? '');
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

function startTurn(prompt) {
  const args = ['--agent', 'claude', ...buildClaudeArgs()];
  logStderr(`spawning: cbcode ${args.join(' ')} (cwd=${thread.cwd})`);

  const child = spawn('cbcode', args, {
    cwd: thread.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });
  turn.child = child;
  turn.stream = createClaudeStream({
    turnId: turn.id,
    threadId: thread.id,
    sessionId: thread.sessionId,
    emitEvent: (params) => send(notif('turn/event', params)),
    emitComplete: (params) => {
      turn.completed = true;
      send(notif('turn/complete', params));
    },
    logWarn: (m) => logStderr(m),
  });

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
        turn.stream.push(JSON.parse(line));
      } catch (err) {
        logStderr(`invalid claude JSON: ${err.message} :: ${line.slice(0, 200)}`);
      }
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));

  child.on('exit', (code, signal) => {
    if (!turn.completed) {
      const outcome = signal ? 'cancelled' : code === 0 ? 'success' : 'failure';
      turn.stream?.forceComplete(
        outcome === 'failure'
          ? { outcome, error_class: 'nonzero_exit', error_message: `claude exit ${code}` }
          : { outcome },
      );
    }
    process.exit(0);
  });

  child.on('error', (err) => {
    if (!turn.completed) {
      turn.stream?.forceComplete({
        outcome: 'failure',
        error_class: 'spawn_error',
        error_message: err.message,
      });
    }
    process.exit(1);
  });
}

function buildClaudeArgs() {
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--session-id',
    thread.sessionId,
    '--model',
    'claude-opus-4-7[1m]',
  ];

  const mode = process.env.SYMPHONY_CLAUDE_PERMISSION_MODE;
  if (mode) args.push('--permission-mode', mode);

  const allowed = process.env.SYMPHONY_CLAUDE_ALLOWED_TOOLS;
  if (allowed && allowed.length > 0) args.push('--allowedTools', allowed);

  const disallowed = process.env.SYMPHONY_CLAUDE_DISALLOWED_TOOLS;
  if (disallowed && disallowed.length > 0) args.push('--disallowedTools', disallowed);

  // The default sandbox denies writes under CWD's .git/ even when git bash
  // commands are allow-listed, which breaks fetch/commit/push/switch. Explicitly
  // re-add it so normal local git flows work in the workspace.
  args.push('--add-dir', join(thread.cwd, '.git'));

  const addDirs = process.env.SYMPHONY_CLAUDE_ADD_DIRS;
  if (addDirs && addDirs.length > 0) {
    for (const d of addDirs.split(':').filter(Boolean)) args.push('--add-dir', d);
  }

  return args;
}

function logStderr(msg) {
  process.stderr.write(`[claude-adapter] ${msg}\n`);
}
