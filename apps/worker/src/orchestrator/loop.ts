import type { Issue } from '@symphony/shared';
import type { Logger } from 'pino';
import type { ResolvedConfig } from '../config/resolve.js';
import type { RateLimitStateRow, Repo } from '../db/repo.js';
import type { TrackerClient } from '../tracker/linear.js';
import { WorkspaceManager } from '../workspace/manager.js';
import { selectDispatchable } from './concurrency.js';
import { type DispatchHandle, dispatchAttempt } from './dispatch.js';

export interface LoopDeps {
  tracker: TrackerClient;
  repo: Repo;
  workspaces: WorkspaceManager;
  config: ResolvedConfig;
  log: Logger;
  /**
   * Integration-test only. When set, `retry_queue` reads in `tick()` are
   * restricted to these issue ids — so tests running against a shared Supabase
   * cannot sweep the live worker's backoff state when the stub tracker's
   * `fetchById` returns `null` for unknown ids.
   */
  scopedIssueIds?: string[];
}

/**
 * Long-running orchestrator. Holds an in-memory map of currently-dispatched
 * attempts so we can:
 *  - skip re-dispatching an issue that's already in flight
 *  - request cancellation when the underlying issue's state changes
 *
 * The map is reconstructed from `run_attempts` rows on startup (see
 * recovery.ts); during normal operation, dispatch() registers handles and
 * the dispatch promise unregisters on completion.
 */
export class OrchestratorLoop {
  private active = new Map<string, DispatchHandle>(); // issue_id -> handle
  private stopping = false;
  private currentTick: Promise<void> = Promise.resolve();

  constructor(private readonly deps: LoopDeps) {}

  /** Adopt an existing in-flight handle (used by recovery to track orphans). */
  registerActive(handle: DispatchHandle): void {
    this.active.set(handle.issueId, handle);
    handle.done.finally(() => {
      const cur = this.active.get(handle.issueId);
      if (cur === handle) this.active.delete(handle.issueId);
    });
  }

  /** True if an attempt for this issue is currently in flight. */
  isActive(issueId: string): boolean {
    return this.active.has(issueId);
  }

  /** Run forever until stop() is called. */
  async run(): Promise<void> {
    while (!this.stopping) {
      this.currentTick = this.tick().catch((err) => {
        this.deps.log.error(
          { err: err instanceof Error ? err.message : String(err) },
          'tick failed',
        );
      });
      await this.currentTick;
      if (this.stopping) break;
      await sleep(this.deps.config.pollIntervalMs(), () => this.stopping);
    }
  }

  /** Signal stop and wait for in-flight dispatches to drain (up to graceMs). */
  async stop(graceMs = 30_000): Promise<void> {
    this.stopping = true;
    await this.currentTick;
    const handles = [...this.active.values()];
    if (handles.length === 0) return;
    this.deps.log.info({ count: handles.length }, 'draining dispatches');
    const drainAll = Promise.all(handles.map((h) => h.done));
    let timedOut = false;
    await Promise.race([
      drainAll,
      new Promise<void>((resolve) =>
        setTimeout(() => {
          timedOut = true;
          resolve();
        }, graceMs),
      ),
    ]);
    if (!timedOut) return;
    const remaining = [...this.active.values()];
    this.deps.log.warn({ remaining: remaining.length }, 'drain deadline; cancelling remainder');
    // cancel() internally escalates to force-kill after its own bounded grace,
    // so awaiting here guarantees the children are dead before stop() returns.
    await Promise.all(remaining.map((h) => h.cancel('worker shutdown')));
  }

  /**
   * Synchronously SIGKILL every active runner's process group. Callable from
   * process.on('exit'), which cannot await. Last line of defense for paths
   * that skip stop() — uncaughtException, unhandledRejection, second signal.
   */
  killAllNow(): void {
    for (const h of this.active.values()) {
      try {
        h.killNow();
      } catch {
        // Best effort.
      }
    }
  }

  /** Single tick: poll, upsert, reconcile, dispatch eligible, run retries. */
  async tick(): Promise<void> {
    const { tracker, repo, config, log } = this.deps;

    // 1. Poll active issues from the tracker, upsert local cache.
    const active = await tracker.fetchActive();
    log.debug({ count: active.length }, 'fetched active issues');
    await repo.upsertIssues(active);

    // 2. Reconcile in-flight handles: cancel those whose issue state no longer
    //    qualifies as active.
    const activeIds = new Set(active.map((i) => i.id));
    for (const [issueId, handle] of this.active) {
      if (!activeIds.has(issueId)) {
        log.info(
          { issueId, attemptId: handle.attemptId },
          'reconciling: issue no longer active, cancelling',
        );
        void handle.cancel('issue state changed');
      }
    }

    // 2a. Sweep stale retry_queue rows: any queued retry whose issue is no
    //     longer active (most commonly because it moved to a terminal state
    //     like Done/Canceled) is dead work — the tracker is the source of
    //     truth for what runs next. Two gotchas to defend against before we
    //     delete scheduled backoff state:
    //       - `fetchActive()` uses `first: 100` under the hood, so a busy
    //         workspace with >100 active issues has a silently truncated
    //         snapshot — absent-from-activeIds does NOT prove terminal.
    //       - A transient tracker blip returning `[]` would make every
    //         queued retry look stale.
    //     Fast-path the empty-snapshot case (skip entirely) and otherwise
    //     confirm each candidate with a direct `fetchById` before clearing.
    if (active.length > 0) {
      const retryIds = await repo.allRetryIssueIds(
        this.deps.scopedIssueIds ? { issueIds: this.deps.scopedIssueIds } : undefined,
      );
      for (const issueId of retryIds) {
        if (activeIds.has(issueId)) continue;
        if (!(await this.confirmNotActive(issueId))) continue;
        log.info({ issueId }, 'clearing retry: issue confirmed no longer active');
        await repo.clearRetry(issueId);
      }
    }

    // 2b. Rate-limit gate. If the active backend has any `rate_limit_state`
    //     row with `reset_at` in the future, suppress new dispatches and
    //     due-retry firing for this tick — otherwise we'd keep launching
    //     attempts that immediately fail upstream, hammering the provider
    //     and wasting quota (the original SYM-14 motivation). Reconcile and
    //     stale-retry sweep above intentionally still run: cancellations
    //     and tracker-driven cleanup are unrelated to upstream throttling.
    const pause = await this.rateLimitPause();
    if (pause) {
      log.info(
        {
          backend: config.agentBackend(),
          source: pause.source,
          resetAt: pause.reset_at,
        },
        'rate-limited; skipping dispatch and due retries',
      );
      return;
    }

    // 3. Compute eligible: not blocked, not already in flight, and not
    //    currently holding a future retry-queue slot. The last check is what
    //    makes exponential backoff actually take effect — without it, a
    //    fast-failing issue is still "active, unblocked, not in-flight" at
    //    the next poll and gets redispatched regardless of due_at. Tick step
    //    7 (dueRetries) remains the one-and-only path that fires retries
    //    once their due_at passes. Issues are already in priority order from
    //    the tracker.
    const pendingRetries = await repo.pendingRetryIssueIds();
    const eligible = active.filter(
      (i) => i.blockers.length === 0 && !this.active.has(i.id) && !pendingRetries.has(i.id),
    );

    // 4. Compute current per-state load from the in-flight handles.
    const byState = new Map<string, number>();
    for (const [issueId] of this.active) {
      const issue = active.find((i) => i.id === issueId);
      if (!issue) continue;
      byState.set(issue.state, (byState.get(issue.state) ?? 0) + 1);
    }

    // 5. Apply concurrency caps to pick a dispatch slate.
    const slate = selectDispatchable(
      eligible,
      byState,
      this.active.size,
      config.maxConcurrentAgents(),
      config.maxConcurrentByState(),
    );
    log.debug(
      { active: this.active.size, eligible: eligible.length, slate: slate.length },
      'tick slate',
    );

    // 6. Reserve and dispatch each.
    for (const issue of slate) {
      const handle = await this.dispatch(issue);
      if (handle) this.registerActive(handle);
    }

    // 7. Run any due retries that aren't already in flight.
    const due = await repo.dueRetries(
      this.deps.scopedIssueIds ? { issueIds: this.deps.scopedIssueIds } : undefined,
    );
    for (const r of due) {
      if (this.active.has(r.issue_id)) continue;
      const issue = active.find((i) => i.id === r.issue_id);
      if (!issue) {
        // Absent from the active snapshot could mean (a) genuinely terminal,
        // (b) truncated out of the paginated `fetchActive()` result, or
        // (c) hidden by a transient tracker blip. Confirm terminal-ness via
        // a direct `fetchById` before clearing — same guard as step 2a.
        if (await this.confirmNotActive(r.issue_id)) {
          log.info(
            { issueId: r.issue_id, attemptNumber: r.attempt_number },
            'clearing due retry: issue confirmed no longer active',
          );
          await repo.clearRetry(r.issue_id);
        }
        continue;
      }
      log.info({ issueId: r.issue_id, attemptNumber: r.attempt_number }, 'firing retry');
      await repo.clearRetry(r.issue_id);
      const handle = await this.dispatch(issue, r.attempt_number);
      if (handle) this.registerActive(handle);
    }
  }

  /**
   * Find the live rate-limit row for the configured backend, if any. Returns
   * the row with the latest `reset_at` whose `source` matches the backend
   * prefix (`codex_*` / `claude_*`); otherwise null. The adapter-emitted
   * `source` values follow `<backend>_<bucket>` — see `agents/codex-adapter.mjs`.
   */
  private async rateLimitPause(): Promise<RateLimitStateRow | null> {
    const backend = this.deps.config.agentBackend();
    const prefix = `${backend}_`;
    const rows = await this.deps.repo.activeRateLimits();
    for (const row of rows) {
      if (row.source.startsWith(prefix)) return row;
    }
    return null;
  }

  /**
   * Confirm — via a direct `fetchById` — that an issue is genuinely no longer
   * active before we discard its scheduled retry. Guards two failure modes of
   * trusting the `fetchActive()` snapshot alone: pagination truncation
   * (`first: 100`) and transient tracker blips. Returns true only on positive
   * confirmation (issue is gone, or its current state is outside the
   * configured `active_states`). On fetch error, returns false so we defer
   * cleanup rather than delete valid backoff state.
   */
  private async confirmNotActive(issueId: string): Promise<boolean> {
    const { tracker, config, log } = this.deps;
    try {
      const current = await tracker.fetchById(issueId);
      if (!current) return true;
      return !config.activeStates().includes(current.state);
    } catch (err) {
      log.warn(
        { issueId, err: err instanceof Error ? err.message : String(err) },
        'retry cleanup: fetchById failed; deferring',
      );
      return false;
    }
  }

  private async dispatch(
    issue: Issue,
    forceAttemptNumber?: number,
  ): Promise<DispatchHandle | null> {
    const { repo, workspaces, config, log } = this.deps;
    const attemptNumber = forceAttemptNumber ?? (await repo.lastAttemptNumber(issue.id)) + 1;
    const ws = workspaces.pathFor(issue.identifier);
    const reserved = await repo.tryReserveAttempt({
      issueId: issue.id,
      attemptNumber,
      workspacePath: ws,
    });
    if (!reserved) {
      log.debug({ issueId: issue.id, attemptNumber }, 'reservation lost (race); skipping');
      return null;
    }
    return dispatchAttempt({ repo, workspaces, config, log }, issue, reserved);
  }
}

async function sleep(ms: number, shouldAbort: () => boolean): Promise<void> {
  // Wake every 250ms so stop() takes effect promptly mid-sleep.
  const step = Math.min(250, ms);
  let elapsed = 0;
  while (elapsed < ms) {
    if (shouldAbort()) return;
    await new Promise((r) => setTimeout(r, step));
    elapsed += step;
  }
}
