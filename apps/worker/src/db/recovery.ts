import type { Logger } from 'pino';
import type { ResolvedConfig } from '../config/resolve.js';
import { backoffMs } from '../orchestrator/backoff.js';
import type { TrackerClient } from '../tracker/linear.js';
import type { WorkspaceManager } from '../workspace/manager.js';
import type { Repo } from './repo.js';

export interface RecoveryDeps {
  repo: Repo;
  tracker: TrackerClient;
  workspaces: WorkspaceManager;
  config: ResolvedConfig;
  log: Logger;
  /**
   * Integration-test only. When set, orphan adoption is restricted to
   * `runs` whose `issue_id` is in this list — so tests running against a
   * shared database don't mark the live worker's in-flight runs as crashed.
   */
  scopedIssueIds?: string[];
}

export interface RecoveryOutcome {
  orphansAdopted: number; // runs that were 'running' at startup
  pendingOrphansAdopted: number; // runs that were 'pending' at startup (reserved but never claimed)
  workspacesRemoved: number; // terminal-state issue workspaces cleaned
  partialWorkspacesCleaned: number; // orphan workspaces wiped because after_create never finished
  placeholderSessionsCleaned: number; // pending-* live_sessions for terminal runs
}

/**
 * Boot-time reconciliation. Spec: "Restart survives without persistent
 * database; in-memory state reconstructed from workspace and tracker queries."
 * With Postgres as source of truth we do better: explicitly mark crashed runs
 * as failed, schedule their retries, and clean up workspaces for issues that
 * have transitioned to a terminal state while we were down.
 *
 * 1. Tracker preflight (auth + connectivity).
 * 2. Persist current workflow snapshot.
 * 3. Mark `running` runs as failure(process_crashed), schedule retries, and
 *    proactively wipe their workspaces if they're missing the ready sentinel
 *    (so the retry doesn't inherit a half-finished after_create).
 * 4. Mark `pending` runs the same way: a row reserved by `tryReserveRun` but
 *    never flipped to `running` means the previous worker died between
 *    reservation and `markRunning`. Without this sweep the row sits forever,
 *    invisible to the in-memory `active` map and to the eligibility filter
 *    (which only consults `active` and `retry_queue`), so the next tick
 *    happily reserves a fresh run number for the same issue and pendings
 *    pile up across crashes.
 * 5. Sweep stale `pending-<run-id>` live_sessions whose run is now in a
 *    terminal state (Codex placeholder rows that outlived their run).
 * 6. Sweep workspaces for terminal-state issues.
 *
 * Returns metrics for logging.
 */
export async function recover(deps: RecoveryDeps): Promise<RecoveryOutcome> {
  const { repo, tracker, workspaces, config, log } = deps;

  await tracker.preflight();
  log.info('tracker preflight ok');

  await repo.upsertWorkflow(config.workflow());

  const orphans = await repo.listRunning(
    deps.scopedIssueIds ? { issueIds: deps.scopedIssueIds } : undefined,
  );
  let partialWorkspacesCleaned = 0;
  for (const o of orphans) {
    log.warn(
      { runId: o.id, issueId: o.issue_id },
      'orphan run; marking as crashed and scheduling retry',
    );
    await repo.deleteLiveSession(o.id).catch(() => {});
    await repo.finishRun({
      runId: o.id,
      status: 'failure',
      errorClass: 'process_crashed',
      errorMessage: 'worker restarted while run was in-flight',
    });
    try {
      const removed = await workspaces.removeIfStale(o.workspace_path);
      if (removed) {
        partialWorkspacesCleaned += 1;
        log.warn(
          { runId: o.id, issueId: o.issue_id, workspacePath: o.workspace_path },
          'partial workspace (no ready sentinel) wiped; retry will re-run after_create',
        );
      }
    } catch (err) {
      log.warn(
        {
          runId: o.id,
          workspacePath: o.workspace_path,
          err: err instanceof Error ? err.message : String(err),
        },
        'partial workspace cleanup failed',
      );
    }
    const ms = backoffMs(o.run_number, config.maxRetryBackoffMs());
    await repo.scheduleRetry({
      issueId: o.issue_id,
      runNumber: o.run_number + 1,
      dueAt: new Date(Date.now() + ms),
      errorClass: 'process_crashed',
      errorMessage: 'worker restart',
    });
  }

  const pendingOrphans = await repo.listPending(
    deps.scopedIssueIds ? { issueIds: deps.scopedIssueIds } : undefined,
  );
  for (const o of pendingOrphans) {
    log.warn(
      { runId: o.id, issueId: o.issue_id, runNumber: o.run_number },
      'pending orphan run; marking as crashed and scheduling retry',
    );
    await repo.finishRun({
      runId: o.id,
      status: 'failure',
      errorClass: 'process_crashed',
      errorMessage: 'worker restarted before run was claimed',
    });
    // No workspace cleanup: a pending row predates after_create, so the
    // workspace either doesn't exist or is whatever a previous run left.
    // The retry will re-enter createOrReuse and removeIfStale will handle it.
    const ms = backoffMs(o.run_number, config.maxRetryBackoffMs());
    await repo.scheduleRetry({
      issueId: o.issue_id,
      runNumber: o.run_number + 1,
      dueAt: new Date(Date.now() + ms),
      errorClass: 'process_crashed',
      errorMessage: 'worker restart',
    });
  }

  let placeholderSessionsCleaned = 0;
  try {
    placeholderSessionsCleaned = await repo.deleteOrphanedPendingSessions(
      deps.scopedIssueIds ? { issueIds: deps.scopedIssueIds } : undefined,
    );
    if (placeholderSessionsCleaned > 0) {
      log.warn(
        { count: placeholderSessionsCleaned },
        'cleaned placeholder live_sessions for terminal runs',
      );
    }
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'placeholder live_sessions sweep failed',
    );
  }

  let workspacesRemoved = 0;
  try {
    const terminal = await tracker.fetchTerminal();
    for (const issue of terminal) {
      if (await repo.hasActiveRun(issue.id)) continue;
      try {
        await workspaces.remove(issue.identifier);
        workspacesRemoved += 1;
      } catch (err) {
        log.warn(
          { identifier: issue.identifier, err: err instanceof Error ? err.message : String(err) },
          'workspace removal failed',
        );
      }
    }
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'terminal sweep failed');
  }

  return {
    orphansAdopted: orphans.length,
    pendingOrphansAdopted: pendingOrphans.length,
    workspacesRemoved,
    partialWorkspacesCleaned,
    placeholderSessionsCleaned,
  };
}
