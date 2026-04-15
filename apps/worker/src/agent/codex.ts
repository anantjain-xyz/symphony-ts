import { execa, type ResultPromise } from 'execa';
import {
  NdjsonParser,
  encodeRequest,
  isError,
  isNotification,
  isResult,
  type InitializeResult,
  type RpcMessage,
  type ThreadStartParams,
  type ThreadStartResult,
  type TurnCompleteParams,
  type TurnEventParams,
  type TurnStartParams,
  type TurnStartResult,
} from './protocol.js';

export interface CodexRunnerOptions {
  command: string; // e.g. "codex"
  cwd: string;
  approvalPolicy: ThreadStartParams['approval_policy'];
  threadSandbox: ThreadStartParams['thread_sandbox'];
  turnSandboxPolicy: TurnStartParams['turn_sandbox_policy'];
  turnTimeoutMs: number;
  /** Hook subscribed to every turn/event notification. */
  onEvent: (ev: TurnEventParams) => void | Promise<void>;
  /** Optional logger; defaults to no-op. */
  log?: (msg: string, ctx?: Record<string, unknown>) => void;
  /** Override for tests: launch this script instead of `command` via bash -lc. */
  spawnOverride?: () => ResultPromise;
}

export interface CodexRunResult {
  threadId: string;
  turnId: string;
  outcome: TurnCompleteParams['outcome'];
  errorClass?: string;
  errorMessage?: string;
}

/**
 * Owns one Codex subprocess for the duration of a single turn. Lifecycle:
 *
 *   const runner = new CodexRunner(opts);
 *   const result = await runner.run(prompt);   // await turn completion
 *   // or, mid-flight from another async context:
 *   await runner.interrupt();                  // ask agent to cancel cleanly
 *   await runner.kill();                       // SIGTERM (then SIGKILL)
 *
 * Stdin/stdout speak NDJSON-framed JSON-RPC; see protocol.ts.
 */
export class CodexRunner {
  private child: ResultPromise | null = null;
  private nextId = 1;
  private parser = new NdjsonParser();
  private pending = new Map<number, { resolve: (m: RpcMessage) => void; reject: (e: Error) => void }>();
  private completion: Promise<TurnCompleteParams> | null = null;
  private resolveCompletion!: (p: TurnCompleteParams) => void;
  private rejectCompletion!: (e: Error) => void;
  private threadId: string | null = null;
  private turnId: string | null = null;
  private log: NonNullable<CodexRunnerOptions['log']>;

  constructor(private readonly opts: CodexRunnerOptions) {
    this.log = opts.log ?? (() => {});
  }

  async run(prompt: string): Promise<CodexRunResult> {
    if (this.child) throw new Error('CodexRunner already started');
    this.completion = new Promise<TurnCompleteParams>((resolve, reject) => {
      this.resolveCompletion = resolve;
      this.rejectCompletion = reject;
    });

    this.child = this.spawn();

    this.child.stdout?.setEncoding('utf8');
    this.child.stdout?.on('data', (chunk: string) => this.onStdout(chunk));
    this.child.stderr?.setEncoding('utf8');
    this.child.stderr?.on('data', (chunk: string) =>
      this.log('codex stderr', { chunk: chunk.trimEnd() }),
    );
    this.child
      .then(
        (r) => this.onExit(r.exitCode ?? 0, null),
        (err) => this.onExit((err as { exitCode?: number }).exitCode ?? -1, err as Error),
      )
      .catch(() => {});

    // Handshake
    const init = await this.request<InitializeResult>('initialize', { version: '1' });
    this.log('codex initialized', { capabilities: init.capabilities });

    const thread = await this.request<ThreadStartResult>('thread/start', {
      approval_policy: this.opts.approvalPolicy,
      thread_sandbox: this.opts.threadSandbox,
      cwd: this.opts.cwd,
    } satisfies ThreadStartParams);
    this.threadId = thread.thread_id;

    const turn = await this.request<TurnStartResult>('turn/start', {
      thread_id: this.threadId,
      prompt,
      turn_sandbox_policy: this.opts.turnSandboxPolicy,
    } satisfies TurnStartParams);
    this.turnId = turn.turn_id;

    // Wait for turn/complete or timeout.
    const completed = await this.awaitWithTimeout(this.completion, this.opts.turnTimeoutMs);

    return {
      threadId: this.threadId,
      turnId: this.turnId,
      outcome: completed.outcome,
      errorClass: completed.error_class,
      errorMessage: completed.error_message,
    };
  }

  /** Ask the agent to cancel cleanly. Idempotent. */
  async interrupt(): Promise<void> {
    if (!this.child) return;
    try {
      await this.notify('turn/interrupt', this.turnId ? { turn_id: this.turnId } : {});
    } catch {
      // Ignore; we'll fall back to kill().
    }
  }

  /** Hard terminate. SIGTERM, then SIGKILL after grace period. */
  async kill(signal: NodeJS.Signals = 'SIGTERM', graceMs = 5000): Promise<void> {
    const c = this.child;
    if (!c) return;
    c.kill(signal);
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        c.kill('SIGKILL');
        resolve();
      }, graceMs);
      c.then(
        () => {
          clearTimeout(t);
          resolve();
        },
        () => {
          clearTimeout(t);
          resolve();
        },
      ).catch(() => resolve());
    });
  }

  // ---------- internals ----------

  private spawn(): ResultPromise {
    if (this.opts.spawnOverride) return this.opts.spawnOverride();
    return execa('bash', ['-lc', this.opts.command], {
      cwd: this.opts.cwd,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      reject: false,
      // Inherits parent env intentionally: codex needs PATH, OPENAI_API_KEY, etc.
      // The hooks runner is the spec-defined boundary for env stripping.
    });
  }

  private onStdout(chunk: string): void {
    let messages: RpcMessage[];
    try {
      messages = this.parser.push(chunk);
    } catch (err) {
      this.rejectAllPending(new Error(`Codex emitted invalid JSON: ${(err as Error).message}`));
      return;
    }
    for (const msg of messages) this.dispatch(msg);
  }

  private dispatch(msg: RpcMessage): void {
    if (isResult(msg) || isError(msg)) {
      const waiter = this.pending.get(msg.id);
      if (!waiter) {
        this.log('codex unmatched response', { id: msg.id });
        return;
      }
      this.pending.delete(msg.id);
      waiter.resolve(msg);
      return;
    }
    if (isNotification(msg)) {
      switch (msg.method) {
        case 'turn/event':
          void Promise.resolve(this.opts.onEvent(msg.params as TurnEventParams)).catch((e) =>
            this.log('onEvent threw', { error: (e as Error).message }),
          );
          return;
        case 'turn/complete':
          this.resolveCompletion(msg.params as TurnCompleteParams);
          return;
        default:
          this.log('codex unknown notification', { method: msg.method });
      }
    }
  }

  private async request<R>(method: string, params: unknown): Promise<R> {
    const id = this.nextId++;
    const line = encodeRequest(id, method, params);
    const promise = new Promise<RpcMessage>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.writeStdin(line);
    const msg = await promise;
    if (isError(msg)) throw new Error(`codex ${method} failed: ${msg.error.message}`);
    if (isResult(msg)) return msg.result as R;
    throw new Error('Unexpected codex response shape');
  }

  private async notify(method: string, params: unknown): Promise<void> {
    const line = encodeRequest(0, method, params).replace(/"id":0,/, '');
    this.writeStdin(line);
  }

  private writeStdin(line: string): void {
    if (!this.child?.stdin || this.child.stdin.destroyed) {
      throw new Error('codex stdin closed');
    }
    this.child.stdin.write(line);
  }

  private onExit(exitCode: number, err: Error | null): void {
    if (this.completion && this.resolveCompletion && this.turnId === null) {
      // Process died before we even started a turn.
      this.rejectCompletion(
        err ?? new Error(`codex exited with code ${exitCode} before handshake completed`),
      );
    } else if (this.completion && this.turnId) {
      // If completion is still pending, treat exit as failure.
      this.resolveCompletion({
        thread_id: this.threadId ?? '',
        turn_id: this.turnId,
        outcome: exitCode === 0 ? 'success' : 'failure',
        error_class: err ? 'process_error' : exitCode === 0 ? undefined : 'nonzero_exit',
        error_message: err ? err.message : exitCode === 0 ? undefined : `exit ${exitCode}`,
      });
    }
    this.rejectAllPending(new Error(`codex exited (${exitCode})`));
  }

  private rejectAllPending(err: Error): void {
    for (const [, w] of this.pending) w.reject(err);
    this.pending.clear();
  }

  private async awaitWithTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TurnTimeoutError(ms)), ms);
    });
    try {
      return (await Promise.race([p, timeout])) as T;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export class TurnTimeoutError extends Error {
  override readonly name = 'TurnTimeoutError';
  constructor(public readonly timeoutMs: number) {
    super(`turn exceeded ${timeoutMs}ms`);
  }
}
