import type { Logger } from 'pino';
import { type LiveResolvedConfig, resolveConfig } from './resolve.js';
import { loadWorkflowFile } from './workflow.js';

export type ReloadOutcome = 'unchanged' | 'swapped' | 'invalid';

export interface ReloadDeps {
  workflowPath: string;
  live: LiveResolvedConfig;
  log: Logger;
}

/**
 * Re-read WORKFLOW.md, validate (zod runs inside `loadWorkflowFile`), and
 * atomically swap the live config when the source hash changed. On failure
 * (read error, parse error, schema rejection) the previous config is kept and
 * the error is logged — the worker stays up under the last known-good config.
 *
 * Extracted from the SIGHUP handler in `index.ts` so it can be tested without
 * spinning up a real signal listener.
 */
export async function reloadWorkflowConfig(deps: ReloadDeps): Promise<ReloadOutcome> {
  const { workflowPath, live, log } = deps;
  let next: Awaited<ReturnType<typeof loadWorkflowFile>>;
  try {
    next = await loadWorkflowFile(workflowPath);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? (err.stack ?? err.message) : String(err) },
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
