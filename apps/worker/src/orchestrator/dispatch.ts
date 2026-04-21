import type { Issue } from '@symphony/shared';
import type { Logger } from 'pino';
import { CodexRunner, TurnTimeoutError } from '../agent/codex.js';
import { mapTurnEvent } from '../agent/events.js';
import { AlreadyRunningError, type Repo, type RunAttemptRow } from '../db/repo.js';
import { runHook, type HookResult } from '../workspace/hooks.js';
import { WorkspaceManager } from '../workspace/manager.js';
import { renderPrompt, appendRetryContext } from '../prompt/render.js';
import type { ResolvedConfig } from '../config/resolve.js';

export interface DispatchHandle {
  /** Issue this dispatch is for (so the loop can match it during reconciliation). */
  issueId: string;
  attemptId: string;
  /** Cooperative cancellation; called when reconciliation invalidates the attempt. */
  cancel(reason: string): Promise<void>;
  /** Resolves when dispatch finishes (success, failure, timeout, cancelled). */
  done: Promise<void>;
}

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
 *   6. spawn CodexRunner; stream events to agent_events + live_sessions
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
  let runner: CodexRunner | null = null;
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

      runner = new CodexRunner({
        command: config.codexCommand(),
        cwd: ws.path,
        approvalPolicy: config.workflow().frontMatter.codex.approval_policy,
        threadSandbox: config.workflow().frontMatter.codex.thread_sandbox,
        turnSandboxPolicy: config.workflow().frontMatter.codex.turn_sandbox_policy,
        turnTimeoutMs: config.turnTimeoutMs(),
        log: (msg, ctx) => log.debug({ ...ctx, attemptId: attempt.id }, msg),
        onEvent: async (ev) => {
          const mapped = mapTurnEvent(ev);
          await repo.appendEvent(attempt.id, mapped.kind, mapped.payload);
          if (mapped.tokens) {
            await repo.upsertLiveSession({
              run_attempt_id: attempt.id,
              session_id: `pending-${attempt.id}`, // overwritten when thread/turn known; see below
              thread_id: '',
              turn_id: '',
              ...mapped.tokens,
            });
            await repo.updateTokens(attempt.id, mapped.tokens);
          }
          if (mapped.humanized) {
            await repo.appendEvent(attempt.id, 'humanized', { summary: mapped.humanized });
          }
        },
      });

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
      log.error(
        { attemptId: attempt.id, err: err instanceof Error ? err.message : String(err) },
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
          errorMessage: (err as Error).message,
        });
        await scheduleRetry(
          deps,
          issue.id,
          attempt.attempt_number,
          'turn_timeout',
          (err as Error).message,
        );
      } else {
        await fail(
          deps,
          attempt.id,
          issue,
          attempt.attempt_number,
          'dispatch_error',
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  })();

  return {
    issueId: issue.id,
    attemptId: attempt.id,
    async cancel(reason) {
      cancelled = true;
      cancelReason = reason;
      if (runner) {
        await runner.interrupt();
        // If the agent doesn't honor interrupt within turnTimeoutMs, the timeout
        // path above will kill it. We don't force-kill here to give graceful
        // shutdown a chance.
      }
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
