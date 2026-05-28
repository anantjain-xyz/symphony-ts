import { formatError } from '@symphony/shared';
import type { Logger } from 'pino';
import { loadReposFile } from './repos.js';
import { type LiveResolvedConfig, resolveConfig } from './resolve.js';
import { loadWorkflowFile } from './workflow.js';

export type ReloadOutcome = 'unchanged' | 'swapped' | 'invalid';

export interface ReloadDeps {
  workflowPath: string;
  reposPath: string;
  live: LiveResolvedConfig;
  log: Logger;
}

// Per-`live` mutex. Without this, two SIGHUPs in quick succession can race:
// reload A reads file (hash X), file changes to Y, reload B reads + swaps to Y,
// then reload A's read returns and `next.sourceHash !== live.sourceHash()` is
// still true (X ≠ Y), so it `swap()`s the process back to the stale X. A
// WeakMap keyed by `live` chains reloads so each one re-reads after the
// previous swap completes.
const inflight = new WeakMap<LiveResolvedConfig, Promise<ReloadOutcome>>();

/**
 * Re-read WORKFLOW.md (and repos.md if configured), validate (zod runs inside
 * the loaders), and atomically swap the live config when any source hash
 * changed. On failure (read error, parse error, schema rejection) the previous
 * config is kept and the error is logged — the worker stays up under the last
 * known-good config.
 *
 * Concurrent calls against the same `live` ref are serialized so an older
 * file read can never roll back a newer swap.
 *
 * Extracted from the SIGHUP handler in `index.ts` so it can be tested without
 * spinning up a real signal listener.
 */
export function reloadWorkflowConfig(deps: ReloadDeps): Promise<ReloadOutcome> {
  const prev = inflight.get(deps.live);
  const next: Promise<ReloadOutcome> = (
    prev ? prev.catch(() => undefined) : Promise.resolve()
  ).then(() => doReload(deps));
  inflight.set(deps.live, next);
  return next;
}

async function doReload({
  workflowPath,
  reposPath,
  live,
  log,
}: ReloadDeps): Promise<ReloadOutcome> {
  let nextWorkflow: Awaited<ReturnType<typeof loadWorkflowFile>>;
  let nextRepos: Awaited<ReturnType<typeof loadReposFile>>;
  try {
    nextWorkflow = await loadWorkflowFile(workflowPath);
    nextRepos = await loadReposFile(reposPath);
  } catch (err) {
    log.error(
      { err: formatError(err, { includeStack: true }) },
      'reload: failed to load/validate config; keeping previous config',
    );
    return 'invalid';
  }
  const workflowUnchanged = nextWorkflow.sourceHash === live.sourceHash();
  const reposUnchanged = nextRepos.sourceHash === live.reposHash();
  if (workflowUnchanged && reposUnchanged) {
    log.info(
      { sourceHash: nextWorkflow.sourceHash.slice(0, 12) },
      'reload: WORKFLOW.md and repos.md unchanged',
    );
    return 'unchanged';
  }
  const prevHash = live.sourceHash();
  const prevReposHash = live.reposHash();
  live.swap(resolveConfig(nextWorkflow, {}, nextRepos));
  log.info(
    {
      prevHash: prevHash.slice(0, 12),
      newHash: nextWorkflow.sourceHash.slice(0, 12),
      prevReposHash: prevReposHash.slice(0, 12),
      newReposHash: nextRepos.sourceHash.slice(0, 12),
    },
    'reload: config swapped',
  );
  return 'swapped';
}
