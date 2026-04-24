import { randomUUID } from 'node:crypto';
import type { Issue } from '@symphony/shared';
import type { Logger } from 'pino';
import { mapTurnEvent } from '../agent/events.js';
import { AgentRunner, TurnTimeoutError } from '../agent/runner.js';
import type { ResolvedConfig } from '../config/resolve.js';
import { AlreadyRunningError, type Repo, type RunAttemptRow } from '../db/repo.js';
import { appendRetryContext, renderPrompt } from '../prompt/render.js';
import { type HookResult, runHook } from '../workspace/hooks.js';
import { WorkspaceManager } from '../workspace/manager.js';

export interface DispatchHandle {
  /** Issue this dispatch is for (so the loop can match it during reconciliation). */
  issueId: string;
  attemptId: string;
  /**
   * Cooperative cancellation. Sends turn/interrupt to codex, waits a bounded
   * grace for clean shutdown, then force-kills the process group. Resolves
   * once the underlying runner is dead (or was already gone).
   */
  cancel(reason: string): Promise<void>;
  /**
   * Synchronous best-effort SIGKILL of the runner's process group. For use
   * from contexts that cannot await — notably process.on('exit').
   */
  killNow(): void;
  /** Resolves when dispatch finishes (success, failure, timeout, cancelled). */
  done: Promise<void>;
}

/** How long cancel() waits for codex to honor turn/interrupt before force-killing. */
const CANCEL_INTERRUPT_GRACE_MS = 5_000;

export interface DispatchDeps {
  repo: Repo;
  workspaces: WorkspaceManager;
  config: ResolvedConfig;
  log: Logger;
}

/**
 * Run one attempt end-to-end:
 *   1. ensure workspace
 *   2. after_create hook (fatal if first creation)
 *   3. mark running
 *   4. before_run hook
 *   5. build prompt (with retry context if attempt > 1)
 *   6. spawn AgentRunner against the selected backend (codex or claude);
 *      stream events to agent_events + live_sessions
 *   7. after_run hook (warning only)
 *   8. finalize attempt status; on failure, schedule retry
 *
 * Returns a handle so the orchestrator can cancel mid-flight if the underlying
 * issue's state changes.
 */
export function dispatchAttempt(
  deps: DispatchDeps,
  issue: Issue,
  attempt: RunAttemptRow,
): DispatchHandle {
  const { repo, workspaces, config, log } = deps;
  let runner: AgentRunner | null = null;
  let cancelled = false;
  let cancelReason: string | null = null;

  const done = (async () => {
    try {
      const ws = await workspaces.createOrReuse(issue.identifier);
      log.info(
        { attemptId: attempt.id, ws: ws.path, createdNow: ws.createdNow, needsInit: ws.needsInit },
        'workspace ready',
      );

      if (ws.needsInit) {
        const hookScript = config.workflow().frontMatter.hooks.after_create;
        if (hookScript) {
          const r = await runHook(
            'after_create',
            hookScript,
            { issue, workspacePath: ws.path, attemptNumber: attempt.attempt_number },
            { timeoutMs: config.hookTimeoutMs() },
          );
          await recordHook(deps, attempt.id, 'after_create', r);
          if (r.exitCode !== 0) {
            await fail(
              deps,
              attempt.id,
              issue,
              attempt.attempt_number,
              'after_create_failed',
              r.stderrTail ?? 'after_create non-zero',
            );
            return;
          }
        }
        await workspaces.markReady(issue.identifier);
      }

      try {
        await repo.markRunning(attempt.id);
      } catch (err) {
        if (err instanceof AlreadyRunningError) {
          log.warn(
            { attemptId: attempt.id, issueId: issue.id },
            'another attempt for this issue is already running; cancelling this one',
          );
          await repo.finishAttempt({
            attemptId: attempt.id,
            status: 'cancelled',
            errorClass: 'reconciled',
            errorMessage: 'lost race to another running attempt for the same issue',
          });
          return;
        }
        throw err;
      }

      const beforeRun = config.workflow().frontMatter.hooks.before_run;
      if (beforeRun) {
        const r = await runHook(
          'before_run',
          beforeRun,
          { issue, workspacePath: ws.path, attemptNumber: attempt.attempt_number },
          { timeoutMs: config.hookTimeoutMs() },
        );
        await recordHook(deps, attempt.id, 'before_run', r);
        if (r.exitCode !== 0) {
          log.warn(
            { attemptId: attempt.id, stderr: r.stderrTail },
            'before_run hook failed (non-fatal)',
          );
        }
      }

      let prompt = renderPrompt(config.promptTemplate(), issue);
      if (attempt.attempt_number > 1) {
        const recent = await repo.recentEvents(attempt.id, 10);
        prompt = appendRetryContext(prompt, {
          attemptNumber: attempt.attempt_number,
          priorErrorClass: attempt.error_class,
          priorErrorMessage: attempt.error_message,
          recentEvents: recent.map((r) => ({
            kind: r.kind,
            payload: r.payload,
            created_at: r.created_at,
          })),
        });
      }

      const backend = config.agentBackend();
      // Claude supports session pinning via --session-id; pre-generate a uuid
      // so live_sessions.thread_id is known before any events land and
      // `attach` can resume the same session.
      const preSessionId = backend === 'claude' ? randomUUID() : undefined;

      runner = new AgentRunner({
        command: config.agentCommand(),
        cwd: ws.path,
        approvalPolicy: config.workflow().frontMatter.codex.approval_policy,
        threadSandbox: config.workflow().frontMatter.codex.thread_sandbox,
        turnSandboxPolicy: config.workflow().frontMatter.codex.turn_sandbox_policy,
        networkAccess: config.workflow().frontMatter.codex.network_access,
        turnTimeoutMs: config.turnTimeoutMs(),
        sessionId: preSessionId,
        adapterEnv: backend === 'claude' ? buildClaudeEnv(config) : undefined,
        log: (msg, ctx) => log.debug({ ...ctx, attemptId: attempt.id }, msg),
        onSpawn: (pid) => repo.setWorkerPid(attempt.id, pid),
        onEvent: async (ev) => {
          const mapped = mapTurnEvent(ev);
          await repo.appendEvent(attempt.id, mapped.kind, mapped.payload);
          if (mapped.tokens) {
            // Codex doesn't know thread/turn ids until turn/start returns, so
            // it inserts a placeholder row on first token event. Claude
            // already has its row from the eager upsert below; just refresh
            // the counters.
            if (!preSessionId) {
              await repo.upsertLiveSession({
                run_attempt_id: attempt.id,
                session_id: `pending-${attempt.id}`,
                thread_id: '',
                turn_id: '',
                ...mapped.tokens,
              });
            }
            await repo.updateTokens(attempt.id, mapped.tokens);
          }
          if (mapped.rateLimit) {
            await repo.upsertRateLimit(mapped.rateLimit);
          }
          if (mapped.humanized) {
            await repo.appendEvent(attempt.id, 'humanized', { summary: mapped.humanized });
          }
        },
      });

      // Claude emits its token counts only at turn end, so without an eager
      // upsert a stuck run would have no live_sessions row for `attach` to
      // discover the resumable session id. Insert it as soon as the id is
      // pinned (we generated it above) — well before run() resolves.
      if (preSessionId) {
        await repo.upsertLiveSession({
          run_attempt_id: attempt.id,
          session_id: `${preSessionId}-${preSessionId}`,
          thread_id: preSessionId,
          turn_id: preSessionId,
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0,
        });
      }

      const result = await runner.run(prompt);

      await repo.upsertLiveSession({
        run_attempt_id: attempt.id,
        session_id: `${result.threadId}-${result.turnId}`,
        thread_id: result.threadId,
        turn_id: result.turnId,
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
      });

      const afterRun = config.workflow().frontMatter.hooks.after_run;
      if (afterRun) {
        const r = await runHook(
          'after_run',
          afterRun,
          { issue, workspacePath: ws.path, attemptNumber: attempt.attempt_number },
          { timeoutMs: config.hookTimeoutMs() },
        );
        await recordHook(deps, attempt.id, 'after_run', r);
        if (r.exitCode !== 0) {
          log.warn(
            { attemptId: attempt.id, stderr: r.stderrTail },
            'after_run hook failed (non-fatal)',
          );
        }
      }

      if (cancelled) {
        await repo.finishAttempt({
          attemptId: attempt.id,
          status: 'cancelled',
          errorClass: 'reconciled',
          errorMessage: cancelReason ?? 'cancelled',
        });
        // A prior attempt may have scheduled a retry that cancellation just
        // superseded — the issue has moved on (state change), so its next
        // action comes from the tracker, not the retry queue.
        await repo.clearRetry(issue.id);
      } else if (result.outcome === 'success') {
        await repo.finishAttempt({ attemptId: attempt.id, status: 'success' });
        await repo.clearRetry(issue.id);
      } else {
        await fail(
          deps,
          attempt.id,
          issue,
          attempt.attempt_number,
          result.errorClass ?? 'unknown',
          result.errorMessage ?? 'agent reported failure',
        );
      }
      await repo.deleteLiveSession(attempt.id);
    } catch (err) {
      const isTimeout = err instanceof TurnTimeoutError;
      const formatted = formatError(err);
      log.error(
        { attemptId: attempt.id, err: formatted },
        isTimeout ? 'turn timed out' : 'dispatch failed',
      );
      try {
        if (runner) await runner.kill();
      } catch {
        /* ignore */
      }
      await repo.deleteLiveSession(attempt.id).catch(() => {});
      if (isTimeout) {
        await repo.finishAttempt({
          attemptId: attempt.id,
          status: 'timeout',
          errorClass: 'turn_timeout',
          errorMessage: formatted,
        });
        await scheduleRetry(deps, issue.id, attempt.attempt_number, 'turn_timeout', formatted);
      } else {
        await fail(deps, attempt.id, issue, attempt.attempt_number, 'dispatch_error', formatted);
      }
    }
  })();

  return {
    issueId: issue.id,
    attemptId: attempt.id,
    async cancel(reason) {
      cancelled = true;
      cancelReason = reason;
      const r = runner;
      if (!r) return;
      try {
        await r.interrupt();
      } catch {
        // interrupt failing is not fatal; we'll escalate to kill below.
      }
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), CANCEL_INTERRUPT_GRACE_MS);
      });
      // done may reject (IIFE catch does DB writes); we only care that it settled.
      const doneSettled = done.then(
        () => 'done' as const,
        () => 'done' as const,
      );
      try {
        const winner = await Promise.race([doneSettled, timeout]);
        if (winner === 'timeout') {
          log.warn(
            { attemptId: attempt.id, reason },
            'cancel: interrupt grace expired; force-killing runner',
          );
          await r.kill();
        }
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    killNow() {
      runner?.killNow();
    },
    done,
  };
}

async function recordHook(
  deps: DispatchDeps,
  attemptId: string,
  hook: 'after_create' | 'before_run' | 'after_run' | 'before_remove',
  r: HookResult,
): Promise<void> {
  await deps.repo.recordHook({
    runAttemptId: attemptId,
    hook,
    exitCode: r.exitCode,
    durationMs: r.durationMs,
    stderrTail: r.stderrTail,
  });
}

async function fail(
  deps: DispatchDeps,
  attemptId: string,
  issue: Issue,
  attemptNumber: number,
  errorClass: string,
  errorMessage: string,
): Promise<void> {
  await deps.repo.finishAttempt({
    attemptId,
    status: 'failure',
    errorClass,
    errorMessage,
  });
  await scheduleRetry(deps, issue.id, attemptNumber, errorClass, errorMessage);
}

async function scheduleRetry(
  deps: DispatchDeps,
  issueId: string,
  attemptNumber: number,
  errorClass: string,
  errorMessage: string,
): Promise<void> {
  const { backoffMs } = await import('./backoff.js');
  const ms = backoffMs(attemptNumber, deps.config.maxRetryBackoffMs());
  await deps.repo.scheduleRetry({
    issueId,
    attemptNumber: attemptNumber + 1,
    dueAt: new Date(Date.now() + ms),
    errorClass,
    errorMessage,
  });
}

/**
 * Build env vars the claude-adapter reads to configure the `claude` CLI.
 * Kept out of the JSON-RPC protocol to avoid leaking backend-specific fields.
 */
function buildClaudeEnv(config: ResolvedConfig): Record<string, string> {
  const c = config.claude();
  const env: Record<string, string> = {
    SYMPHONY_CLAUDE_PERMISSION_MODE: c.permission_mode,
  };
  if (c.allowed_tools.length > 0) {
    env.SYMPHONY_CLAUDE_ALLOWED_TOOLS = c.allowed_tools.join(',');
  }
  if (c.disallowed_tools.length > 0) {
    env.SYMPHONY_CLAUDE_DISALLOWED_TOOLS = c.disallowed_tools.join(',');
  }
  if (c.add_dirs.length > 0) {
    env.SYMPHONY_CLAUDE_ADD_DIRS = c.add_dirs.join(':');
  }
  return env;
}

// Prior implementation fell through to `String(err)` for non-Error throws,
// which renders plain objects as the useless literal "[object Object]" in
// run_attempts.error_message. Handle the common non-Error shapes explicitly.
function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const maybeMsg = (err as { message?: unknown }).message;
    if (typeof maybeMsg === 'string' && maybeMsg.length > 0) return maybeMsg;
    try {
      return JSON.stringify(err);
    } catch {
      return Object.prototype.toString.call(err);
    }
  }
  return String(err);
}
