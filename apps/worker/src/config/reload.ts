import { formatError } from '@symphony/shared';
import type { Logger } from 'pino';
import { type LiveResolvedConfig, resolveConfig } from './resolve.js';
import { loadWorkflowFile } from './workflow.js';

export type ReloadOutcome = 'unchanged' | 'swapped' | 'invalid';

export interface ReloadDeps {
  workflowPath: string;
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
 * Re-read WORKFLOW.md, validate (zod runs inside `loadWorkflowFile`), and
 * atomically swap the live config when the source hash changed. On failure
 * (read error, parse error, schema rejection) the previous config is kept and
 * the error is logged — the worker stays up under the last known-good config.
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

async function doReload({ workflowPath, live, log }: ReloadDeps): Promise<ReloadOutcome> {
  let next: Awaited<ReturnType<typeof loadWorkflowFile>>;
  try {
    next = await loadWorkflowFile(workflowPath);
  } catch (err) {
    log.error(
      { err: formatError(err, { includeStack: true }) },
      'reload: failed to load/validate WORKFLOW.md; keeping previous config',
    );
    return 'invalid';
  }
  if (next.sourceHash === live.sourceHash()) {
    log.info({ sourceHash: next.sourceHash.slice(0, 12) }, 'reload: WORKFLOW.md unchanged');
    return 'unchanged';
  }
  const prevHash = live.sourceHash();
  live.swap(resolveConfig(next));
  log.info(
    {
      prevHash: prevHash.slice(0, 12),
      newHash: next.sourceHash.slice(0, 12),
    },
    'reload: WORKFLOW.md swapped',
  );
  return 'swapped';
}
