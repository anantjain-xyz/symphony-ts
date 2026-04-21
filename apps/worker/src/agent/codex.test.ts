import { describe, it, expect } from 'vitest';
import { execa } from 'execa';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexRunner, TurnTimeoutError } from './codex.js';
import type { TurnEventParams } from './protocol.js';

const STUB = path.resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '__fixtures__/stub-codex.mjs',
);

function spawnStub(scenario: string) {
  return execa('node', [STUB], {
    cwd: process.cwd(),
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    reject: false,
    env: { ...process.env, STUB_SCENARIO: scenario },
  });
}

function makeRunner(scenario: string, timeoutMs = 5000) {
  const events: TurnEventParams[] = [];
  const runner = new CodexRunner({
    command: 'unused',
    cwd: process.cwd(),
    approvalPolicy: 'never',
    threadSandbox: 'workspace-write',
    turnSandboxPolicy: 'inherit',
    networkAccess: false,
    turnTimeoutMs: timeoutMs,
    onEvent: (ev) => {
      events.push(ev);
    },
    spawnOverride: () => spawnStub(scenario),
  });
  return { runner, events };
}

describe('CodexRunner', () => {
  it('happy path: handshake, events stream, success', async () => {
    const { runner, events } = makeRunner('happy');
    const result = await runner.run('do the thing');
    expect(result.outcome).toBe('success');
    expect(result.threadId).toBe('thread-stub-1');
    expect(result.turnId).toBe('turn-stub-1');
    expect(events.map((e) => e.kind)).toEqual(['status', 'tool_call', 'token_count']);
  });

  it('error scenario: failure outcome with error fields', async () => {
    const { runner } = makeRunner('error');
    const result = await runner.run('p');
    expect(result.outcome).toBe('failure');
    expect(result.errorClass).toBe('tool_failure');
    expect(result.errorMessage).toBe('tests failed');
  });

  it('crash scenario: process exits non-zero -> failure with nonzero_exit', async () => {
    const { runner } = makeRunner('crash');
    const result = await runner.run('p');
    expect(result.outcome).toBe('failure');
    expect(result.errorClass).toBe('nonzero_exit');
    expect(result.errorMessage).toContain('exit 7');
  });

  it('slow scenario hits turn timeout', async () => {
    const { runner } = makeRunner('slow', 200);
    await expect(runner.run('p')).rejects.toBeInstanceOf(TurnTimeoutError);
    await runner.kill();
  });

  it('exits before handshake: rejects without unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const runner = new CodexRunner({
        command: 'unused',
        cwd: process.cwd(),
        approvalPolicy: 'never',
        threadSandbox: 'workspace-write',
        turnSandboxPolicy: 'inherit',
        networkAccess: false,
        turnTimeoutMs: 5000,
        onEvent: () => {},
        spawnOverride: () =>
          execa('node', ['-e', 'process.exit(1)'], {
            stdin: 'pipe',
            stdout: 'pipe',
            stderr: 'pipe',
            reject: false,
          }),
      });
      await expect(runner.run('p')).rejects.toThrow();
      // Let any microtasks / unhandledRejection events drain.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('interrupt: cancels the turn cleanly', async () => {
    const { runner } = makeRunner('interrupt');
    const p = runner.run('p');
    // Give the turn a moment to start before interrupting.
    await new Promise((r) => setTimeout(r, 50));
    await runner.interrupt();
    const result = await p;
    expect(result.outcome).toBe('cancelled');
  });
});
