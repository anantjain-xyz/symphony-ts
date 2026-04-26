import type { Issue } from '@symphony/shared';
import type { Repo } from '../db/repo.js';

/**
 * Filter `eligible` down to issues that fit within the global cap and any
 * per-state caps. The orchestrator should call this with the candidate set in
 * priority order; this function preserves the input order so the highest-
 * priority eligible issues win the available slots.
 *
 * @param activeByState  Currently-active count grouped by state name.
 *                       Includes both `running` and `pending` reservations.
 * @param globalActive   Total active across all states.
 * @param globalCap      agent.max_concurrent_agents.
 * @param perStateCap    agent.max_concurrent_agents_by_state (lowercased keys).
 */
export function selectDispatchable(
  eligible: Issue[],
  activeByState: Map<string, number>,
  globalActive: number,
  globalCap: number,
  perStateCap: Record<string, number>,
): Issue[] {
  const out: Issue[] = [];
  const counts = new Map(activeByState);
  let total = globalActive;
  for (const issue of eligible) {
    if (total >= globalCap) break;
    const stateCount = counts.get(issue.state) ?? 0;
    const stateCap = perStateCap[issue.state];
    if (stateCap !== undefined && stateCount >= stateCap) continue;
    out.push(issue);
    counts.set(issue.state, stateCount + 1);
    total += 1;
  }
  return out;
}

/**
 * Pull the active-run counts grouped by issue state from the DB. "Active"
 * = pending OR running. We join `runs` to `issues` so we can group by the
 * issue's state at dispatch time.
 */
export async function fetchActiveCounts(repo: Repo): Promise<{
  byState: Map<string, number>;
  total: number;
}> {
  const running = await repo.listRunning();
  const total = running.length;
  const byState = new Map<string, number>();
  if (total === 0) return { byState, total: 0 };
  // Looking up the issue state per run is cheap because the set is small
  // (bounded by max_concurrent_agents). But we avoid the join here by leaning
  // on the orchestrator: it will pass `byState` derived from the current
  // dispatch tick's issue set. For now, return the running count by id and let
  // the caller annotate.
  return { byState, total };
}
