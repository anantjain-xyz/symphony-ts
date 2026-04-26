import { execa, type ResultPromise } from 'execa';
import {
  encodeRequest,
  type InitializeResult,
  isError,
  isNotification,
  isResult,
  NdjsonParser,
  type RpcMessage,
  type ThreadStartParams,
  type ThreadStartResult,
  type TurnCompleteParams,
  type TurnEventParams,
  type TurnStartParams,
  type TurnStartResult,
} from './protocol.js';

export interface AgentRunnerOptions {
  command: string; // adapter command, e.g. "node path/to/codex-adapter.mjs"
  cwd: string;
  approvalPolicy: ThreadStartParams['approval_policy'];
  threadSandbox: ThreadStartParams['thread_sandbox'];
  turnSandboxPolicy: TurnStartParams['turn_sandbox_policy'];
  networkAccess: boolean;
  turnTimeoutMs: number;
  /**
   * Optional pre-generated session id. Forwarded through `thread/start` so
   * adapters that support session pinning (e.g. Claude Code via
   * `--session-id`) can use it. Adapters that don't support it ignore the
   * field.
   */
  sessionId?: string;
  /**
   * Extra environment variables to layer on top of the inherited env when
   * spawning the adapter. Used to pass backend-specific config (e.g.
   * SYMPHONY_CLAUDE_PERMISSION_MODE) without polluting the JSON-RPC protocol.
   */
  adapterEnv?: Record<string, string>;
  /** Hook subscribed to every turn/event notification. */
  onEvent: (ev: TurnEventParams) => void | Promise<void>;
  /**
   * Fires once with the child's PID immediately after spawn. Used by the
   * orchestrator to persist runs.worker_pid for the dashboard's terminal-style
   * status view. Errors are swallowed so a failing callback never breaks
   * dispatch.
   */
  onSpawn?: (pid: number) => void | Promise<void>;
  /** Optional logger; defaults to no-op. */
  log?: (msg: string, ctx?: Record<string, unknown>) => void;
  /** Override for tests: launch this script instead of `command` via bash -lc. */
  spawnOverride?: () => ResultPromise;
}

export interface AgentRunResult {
  threadId: string;
  turnId: string;
  outcome: TurnCompleteParams['outcome'];
  errorClass?: string;
  errorMessage?: string;
}

/**
 * Owns one agent adapter subprocess for the duration of a single turn. The
 * adapter is backend-agnostic: any program that speaks the JSON-RPC contract
 * in protocol.ts works here (codex-adapter.mjs, claude-adapter.mjs, stubs).
 *
 *   const runner = new AgentRunner(opts);
 *   const result = await runner.run(prompt);   // await turn completion
 *   // or, mid-flight from another async context:
 *   await runner.interrupt();                  // ask agent to cancel cleanly
 *   await runner.kill();                       // SIGTERM (then SIGKILL)
 *
 * Stdin/stdout speak NDJSON-framed JSON-RPC; see protocol.ts.
 */
export class AgentRunner {
  private child: ResultPromise | null = null;
  private nextId = 1;
  private parser = new NdjsonParser();
  private pending = new Map<
    number,
    { resolve: (m: RpcMessage) => void; reject: (e: Error) => void }
  >();
  private completion: Promise<TurnCompleteParams> | null = null;
  private resolveCompletion!: (p: TurnCompleteParams) => void;
  private rejectCompletion!: (e: Error) => void;
  private threadId: string | null = null;
  private turnId: string | null = null;
  private log: NonNullable<AgentRunnerOptions['log']>;

  constructor(private readonly opts: AgentRunnerOptions) {
    this.log = opts.log ?? (() => {});
  }

  async run(prompt: string): Promise<AgentRunResult> {
    if (this.child) throw new Error('AgentRunner already started');
    this.completion = new Promise<TurnCompleteParams>((resolve, reject) => {
      this.resolveCompletion = resolve;
      this.rejectCompletion = reject;
    });
    // If codex exits before handshake, onExit rejects this promise. Nothing
    // awaits it until after turn/start succeeds, so attach a silent handler
    // to prevent an unhandledRejection from crashing the process. The caller
    // still sees the failure via the in-flight request() rejection.
    this.completion.catch(() => {});

    this.child = this.spawn();

    if (this.opts.onSpawn) {
      const pid = this.child.pid;
      if (typeof pid === 'number') {
        void Promise.resolve(this.opts.onSpawn(pid)).catch((e) =>
          this.log('onSpawn threw', { error: (e as Error).message }),
        );
      }
    }

    this.child.stdout?.setEncoding('utf8');
    this.child.stdout?.on('data', (chunk: string) => this.onStdout(chunk));
    this.child.stderr?.setEncoding('utf8');
    this.child.stderr?.on('data', (chunk: string) =>
      this.log('agent stderr', { chunk: chunk.trimEnd() }),
    );
    this.child
      .then(
        (r) => this.onExit(r.exitCode ?? 0, null),
        (err) => this.onExit((err as { exitCode?: number }).exitCode ?? -1, err as Error),
      )
      .catch(() => {});

    // Handshake
    const init = await this.request<InitializeResult>('initialize', { version: '1' });
    this.log('agent initialized', { capabilities: init.capabilities });

    const thread = await this.request<ThreadStartResult>('thread/start', {
      approval_policy: this.opts.approvalPolicy,
      thread_sandbox: this.opts.threadSandbox,
      cwd: this.opts.cwd,
      network_access: this.opts.networkAccess,
      ...(this.opts.sessionId ? { session_id: this.opts.sessionId } : {}),
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

  /** Hard terminate. SIGTERM to the whole process group, then SIGKILL after grace. */
  async kill(signal: NodeJS.Signals = 'SIGTERM', graceMs = 5000): Promise<void> {
    const c = this.child;
    if (!c) return;
    this.signalGroup(signal);
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        this.signalGroup('SIGKILL');
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

  /**
   * Synchronous best-effort SIGKILL for the whole process group. Safe to call
   * from process.on('exit'), which forbids awaiting. Skips the SIGTERM grace
   * period — use only when the worker is already exiting abnormally.
   */
  killNow(): void {
    if (!this.child) return;
    this.signalGroup('SIGKILL');
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
      // Own process group: lets kill() reach grandchildren (e.g. when bash
      // forks rather than execs, or when the agent spawns its own subprocesses)
      // via process.kill(-pid, signal).
      detached: true,
      // Inherit parent env (PATH, OPENAI_API_KEY / ANTHROPIC_API_KEY, ...) and
      // layer per-backend adapter config on top. The hooks runner is the
      // spec-defined boundary for env stripping, not this one.
      env: { ...process.env, ...(this.opts.adapterEnv ?? {}) } as NodeJS.ProcessEnv,
    });
  }

  private signalGroup(signal: NodeJS.Signals): void {
    const pid = this.child?.pid;
    if (typeof pid !== 'number') return;
    for (const target of [-pid, pid]) {
      try {
        process.kill(target, signal);
        return;
      } catch {
        // Try pid fallback, or give up if already dead.
      }
    }
  }

  private onStdout(chunk: string): void {
    let messages: RpcMessage[];
    try {
      messages = this.parser.push(chunk);
    } catch (err) {
      this.rejectAllPending(new Error(`agent emitted invalid JSON: ${(err as Error).message}`));
      return;
    }
    for (const msg of messages) this.dispatch(msg);
  }

  private dispatch(msg: RpcMessage): void {
    if (isResult(msg) || isError(msg)) {
      const waiter = this.pending.get(msg.id);
      if (!waiter) {
        this.log('agent unmatched response', { id: msg.id });
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
          this.log('agent unknown notification', { method: msg.method });
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
    if (isError(msg)) throw new Error(`agent ${method} failed: ${msg.error.message}`);
    if (isResult(msg)) return msg.result as R;
    throw new Error('Unexpected agent response shape');
  }

  private async notify(method: string, params: unknown): Promise<void> {
    const line = encodeRequest(0, method, params).replace(/"id":0,/, '');
    this.writeStdin(line);
  }

  private writeStdin(line: string): void {
    if (!this.child?.stdin || this.child.stdin.destroyed) {
      throw new Error('agent stdin closed');
    }
    this.child.stdin.write(line);
  }

  private onExit(exitCode: number, err: Error | null): void {
    if (this.completion && this.turnId === null) {
      // Process died before we even started a turn.
      this.rejectCompletion(
        err ?? new Error(`agent exited with code ${exitCode} before handshake completed`),
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
    this.rejectAllPending(new Error(`agent exited (${exitCode})`));
    // Release the handle so later signalGroup() calls can't hit a recycled pgid.
    this.child = null;
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
