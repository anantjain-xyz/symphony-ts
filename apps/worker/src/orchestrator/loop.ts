import type { Logger } from 'pino';
import type { Issue } from '@symphony/shared';
import type { TrackerClient } from '../tracker/linear.js';
import type { Repo } from '../db/repo.js';
import type { ResolvedConfig } from '../config/resolve.js';
import { WorkspaceManager } from '../workspace/manager.js';
import { dispatchAttempt, type DispatchHandle } from './dispatch.js';
import { selectDispatchable } from './concurrency.js';

export interface LoopDeps {
  tracker: TrackerClient;
  repo: Repo;
  workspaces: WorkspaceManager;
  config: ResolvedConfig;
  log: Logger;
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

    // 3. Compute eligible (not blocked, not already in flight). Issues are
    //    already in priority order from the tracker.
    const eligible = active.filter((i) => i.blockers.length === 0 && !this.active.has(i.id));

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
    const due = await repo.dueRetries();
    for (const r of due) {
      if (this.active.has(r.issue_id)) continue;
      const issue = active.find((i) => i.id === r.issue_id);
      if (!issue) continue; // issue no longer active; let cleanup remove it
      log.info({ issueId: r.issue_id, attemptNumber: r.attempt_number }, 'firing retry');
      await repo.clearRetry(r.issue_id);
      const handle = await this.dispatch(issue, r.attempt_number);
      if (handle) this.registerActive(handle);
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
