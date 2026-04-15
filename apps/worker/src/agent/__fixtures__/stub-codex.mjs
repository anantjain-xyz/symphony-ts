#!/usr/bin/env node
/**
 * Stub Codex binary for tests. Speaks the NDJSON JSON-RPC protocol defined
 * in apps/worker/src/agent/protocol.ts. Behavior is controlled by the
 * STUB_SCENARIO env var:
 *
 *   "happy"     - normal handshake, emits a few events, completes success
 *   "error"     - emits an error event, then completes failure
 *   "slow"      - never completes (used to test turn timeout)
 *   "interrupt" - waits for turn/interrupt, then completes cancelled
 *   "crash"     - exits 7 mid-turn
 */

import readline from 'node:readline';

const scenario = process.env.STUB_SCENARIO || 'happy';
const rl = readline.createInterface({ input: process.stdin, terminal: false });

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

let threadId = null;
let turnId = null;
let interrupted = false;

rl.on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  switch (msg.method) {
    case 'initialize':
      send({ jsonrpc: '2.0', id: msg.id, result: { capabilities: { thread: true, turn: true } } });
      return;
    case 'thread/start':
      threadId = 'thread-stub-1';
      send({ jsonrpc: '2.0', id: msg.id, result: { thread_id: threadId } });
      return;
    case 'turn/start':
      turnId = 'turn-stub-1';
      send({ jsonrpc: '2.0', id: msg.id, result: { turn_id: turnId } });
      runScenario();
      return;
    case 'turn/interrupt':
      interrupted = true;
      return;
  }
});

async function runScenario() {
  switch (scenario) {
    case 'happy': {
      send(notif('turn/event', { kind: 'status', turn_id: turnId, message: 'Reading repository' }));
      send(
        notif('turn/event', {
          kind: 'tool_call',
          turn_id: turnId,
          tool: 'bash',
          args: { cmd: 'ls' },
          result_summary: '12 files',
        }),
      );
      send(
        notif('turn/event', {
          kind: 'token_count',
          turn_id: turnId,
          input_tokens: 100,
          output_tokens: 50,
          total_tokens: 150,
        }),
      );
      await delay(20);
      send(notif('turn/complete', { thread_id: threadId, turn_id: turnId, outcome: 'success' }));
      process.exit(0);
    }
    case 'error': {
      send(
        notif('turn/event', {
          kind: 'error',
          turn_id: turnId,
          class: 'tool_failure',
          message: 'tests failed',
          recoverable: true,
        }),
      );
      send(
        notif('turn/complete', {
          thread_id: threadId,
          turn_id: turnId,
          outcome: 'failure',
          error_class: 'tool_failure',
          error_message: 'tests failed',
        }),
      );
      process.exit(0);
    }
    case 'slow': {
      // Do nothing; let the worker hit the turn timeout.
      return;
    }
    case 'interrupt': {
      while (!interrupted) await delay(50);
      send(
        notif('turn/complete', {
          thread_id: threadId,
          turn_id: turnId,
          outcome: 'cancelled',
        }),
      );
      process.exit(0);
    }
    case 'crash': {
      send(notif('turn/event', { kind: 'status', turn_id: turnId, message: 'about to crash' }));
      await delay(20);
      process.exit(7);
    }
  }
}

function notif(method, params) {
  return { jsonrpc: '2.0', method, params };
}
function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
