import type { Logger } from 'pino';
import type { Repo } from './repo.js';
import type { TrackerClient } from '../tracker/linear.js';
import type { ResolvedConfig } from '../config/resolve.js';
import type { WorkspaceManager } from '../workspace/manager.js';
import { backoffMs } from '../orchestrator/backoff.js';

export interface RecoveryDeps {
  repo: Repo;
  tracker: TrackerClient;
  workspaces: WorkspaceManager;
  config: ResolvedConfig;
  log: Logger;
}

export interface RecoveryOutcome {
  orphansAdopted: number;          // run_attempts that were 'running' at startup
  workspacesRemoved: number;       // terminal-state issue workspaces cleaned
}

/**
 * Boot-time reconciliation. Spec: "Restart survives without persistent
 * database; in-memory state reconstructed from workspace and tracker queries."
 * With Postgres as source of truth we do better: explicitly mark crashed
 * attempts as failed, schedule their retries, and clean up workspaces for
 * issues that have transitioned to a terminal state while we were down.
 *
 * 1. Tracker preflight (auth + connectivity).
 * 2. Persist current workflow snapshot.
 * 3. Mark `running` attempts as failure(process_crashed) and schedule retries.
 * 4. Sweep workspaces for terminal-state issues.
 *
 * Returns metrics for logging.
 */
export async function recover(deps: RecoveryDeps): Promise<RecoveryOutcome> {
  const { repo, tracker, workspaces, config, log } = deps;

  await tracker.preflight();
  log.info('tracker preflight ok');

  await repo.upsertWorkflow(config.workflow());

  const orphans = await repo.listRunning();
  for (const o of orphans) {
    log.warn({ attemptId: o.id, issueId: o.issue_id }, 'orphan run_attempt; marking as crashed and scheduling retry');
    await repo.deleteLiveSession(o.id).catch(() => {});
    await repo.finishAttempt({
      attemptId: o.id,
      status: 'failure',
      errorClass: 'process_crashed',
      errorMessage: 'worker restarted while attempt was in-flight',
    });
    const ms = backoffMs(o.attempt_number, config.maxRetryBackoffMs());
    await repo.scheduleRetry({
      issueId: o.issue_id,
      attemptNumber: o.attempt_number + 1,
      dueAt: new Date(Date.now() + ms),
      errorClass: 'process_crashed',
      errorMessage: 'worker restart',
    });
  }

  let workspacesRemoved = 0;
  try {
    const terminal = await tracker.fetchTerminal();
    for (const issue of terminal) {
      if (await repo.hasActiveAttempt(issue.id)) continue;
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

  return { orphansAdopted: orphans.length, workspacesRemoved };
}
