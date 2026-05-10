import { randomUUID } from 'node:crypto';
import { type Issue, formatError } from '@symphony/shared';
import type { Logger } from 'pino';
import { mapTurnEvent } from '../agent/events.js';
import { AgentRunner, TurnTimeoutError } from '../agent/runner.js';
import type { ResolvedConfig } from '../config/resolve.js';
import { AlreadyRunningError, type Repo, type RunRow } from '../db/repo.js';
import { appendRetryContext, buildRetryContext, renderPrompt } from '../prompt/render.js';
import { type HookResult, runHook } from '../workspace/hooks.js';
import { WorkspaceManager } from '../workspace/manager.js';

export interface DispatchHandle {
  /** Issue this dispatch is for (so the loop can match it during reconciliation). */
  issueId: string;
  runId: string;
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
 * Execute a single Run end-to-end:
 *   1. ensure workspace
 *   2. after_create hook (fatal if first creation)
 *   3. mark running
 *   4. before_run hook
 *   5. build prompt (with retry context if run > 1)
 *   6. spawn AgentRunner against the selected backend (codex or claude);
 *      stream events to agent_events + live_sessions
 *   7. after_run hook (warning only)
 *   8. finalize run status; on failure, schedule retry
 *
 * Returns a handle so the orchestrator can cancel mid-flight if the underlying
 * issue's state changes.
 */
export function dispatchRun(deps: DispatchDeps, issue: Issue, run: RunRow): DispatchHandle {
  const { repo, workspaces, config, log } = deps;
  let runner: AgentRunner | null = null;
  let cancelled = false;
  let cancelReason: string | null = null;

  const done = (async () => {
    try {
      const ws = await workspaces.createOrReuse(issue.identifier);
      log.info(
        { runId: run.id, ws: ws.path, createdNow: ws.createdNow, needsInit: ws.needsInit },
        'workspace ready',
      );

      if (ws.needsInit) {
        const hookScript = config.workflow().frontMatter.hooks.after_create;
        if (hookScript) {
          const r = await runHook(
            'after_create',
            hookScript,
            { issue, workspacePath: ws.path, runNumber: run.run_number },
            { timeoutMs: config.hookTimeoutMs() },
          );
          await recordHook(deps, run.id, 'after_create', r);
          if (r.exitCode !== 0) {
            await fail(
              deps,
              run.id,
              issue,
              run.run_number,
              'after_create_failed',
              r.stderrTail ?? 'after_create non-zero',
            );
            return;
          }
        }
        await workspaces.markReady(issue.identifier);
      }

      try {
        await repo.markRunning(run.id);
      } catch (err) {
        if (err instanceof AlreadyRunningError) {
          log.warn(
            { runId: run.id, issueId: issue.id },
            'another run for this issue is already running; cancelling this one',
          );
          await repo.finishRun({
            runId: run.id,
            status: 'cancelled',
            errorClass: 'reconciled',
            errorMessage: 'lost race to a concurrent run for the same issue',
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
          { issue, workspacePath: ws.path, runNumber: run.run_number },
          { timeoutMs: config.hookTimeoutMs() },
        );
        await recordHook(deps, run.id, 'before_run', r);
        if (r.exitCode !== 0) {
          log.warn({ runId: run.id, stderr: r.stderrTail }, 'before_run hook failed (non-fatal)');
        }
      }

      let prompt = renderPrompt(config.promptTemplate(), issue);
      const retryCtx = await buildRetryContext(repo, issue.id, run);
      if (retryCtx) prompt = appendRetryContext(prompt, retryCtx);

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
        log: (msg, ctx) => log.debug({ ...ctx, runId: run.id }, msg),
        onSpawn: (pid) => repo.setWorkerPid(run.id, pid),
        onEvent: async (ev) => {
          const mapped = mapTurnEvent(ev);
          await repo.appendEvent(run.id, mapped.kind, mapped.payload);
          if (mapped.tokens) {
            // Codex doesn't know thread/turn ids until turn/start returns, so
            // it inserts a placeholder row on first token event. Claude
            // already has its row from the eager upsert below; just refresh
            // the counters.
            if (!preSessionId) {
              await repo.upsertLiveSession({
                run_id: run.id,
                session_id: `pending-${run.id}`,
                thread_id: '',
                turn_id: '',
                ...mapped.tokens,
              });
            }
            await repo.updateTokens(run.id, mapped.tokens);
          }
          if (mapped.rateLimit) {
            await repo.upsertRateLimit(mapped.rateLimit);
          }
          if (mapped.humanized) {
            await repo.appendEvent(run.id, 'humanized', { summary: mapped.humanized });
          }
        },
      });

      // Claude emits its token counts only at turn end, so without an eager
      // upsert a stuck run would have no live_sessions row for `attach` to
      // discover the resumable session id. Insert it as soon as the id is
      // pinned (we generated it above) — well before run() resolves.
      if (preSessionId) {
        await repo.upsertLiveSession({
          run_id: run.id,
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
        run_id: run.id,
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
          { issue, workspacePath: ws.path, runNumber: run.run_number },
          { timeoutMs: config.hookTimeoutMs() },
        );
        await recordHook(deps, run.id, 'after_run', r);
        if (r.exitCode !== 0) {
          log.warn({ runId: run.id, stderr: r.stderrTail }, 'after_run hook failed (non-fatal)');
        }
      }

      if (cancelled) {
        await repo.finishRun({
          runId: run.id,
          status: 'cancelled',
          errorClass: 'reconciled',
          errorMessage: cancelReason ?? 'cancelled',
        });
        // A prior run may have scheduled a retry that cancellation just
        // superseded — the issue has moved on (state change), so its next
        // action comes from the tracker, not the retry queue.
        await repo.clearRetry(issue.id);
      } else if (result.outcome === 'success') {
        await repo.finishRun({ runId: run.id, status: 'success' });
        await repo.clearRetry(issue.id);
      } else {
        await fail(
          deps,
          run.id,
          issue,
          run.run_number,
          result.errorClass ?? 'unknown',
          result.errorMessage ?? 'agent reported failure',
        );
      }
      await repo.deleteLiveSession(run.id);
    } catch (err) {
      const isTimeout = err instanceof TurnTimeoutError;
      const formatted = formatError(err);
      log.error(
        { runId: run.id, err: formatted },
        isTimeout ? 'turn timed out' : 'dispatch failed',
      );
      try {
        if (runner) await runner.kill();
      } catch {
        /* ignore */
      }
      await repo.deleteLiveSession(run.id).catch(() => {});
      if (isTimeout) {
        await repo.finishRun({
          runId: run.id,
          status: 'timeout',
          errorClass: 'turn_timeout',
          errorMessage: formatted,
        });
        await scheduleRetry(deps, issue.id, run.run_number, 'turn_timeout', formatted);
      } else {
        await fail(deps, run.id, issue, run.run_number, 'dispatch_error', formatted);
      }
    }
  })();

  return {
    issueId: issue.id,
    runId: run.id,
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
            { runId: run.id, reason },
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
  runId: string,
  hook: 'after_create' | 'before_run' | 'after_run' | 'before_remove',
  r: HookResult,
): Promise<void> {
  await deps.repo.recordHook({
    runId,
    hook,
    exitCode: r.exitCode,
    durationMs: r.durationMs,
    stderrTail: r.stderrTail,
  });
}

async function fail(
  deps: DispatchDeps,
  runId: string,
  issue: Issue,
  runNumber: number,
  errorClass: string,
  errorMessage: string,
): Promise<void> {
  await deps.repo.finishRun({
    runId,
    status: 'failure',
    errorClass,
    errorMessage,
  });
  await scheduleRetry(deps, issue.id, runNumber, errorClass, errorMessage);
}

async function scheduleRetry(
  deps: DispatchDeps,
  issueId: string,
  runNumber: number,
  errorClass: string,
  errorMessage: string,
): Promise<void> {
  const { backoffMs } = await import('./backoff.js');
  const ms = backoffMs(runNumber, deps.config.maxRetryBackoffMs());
  await deps.repo.scheduleRetry({
    issueId,
    runNumber: runNumber + 1,
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
