/**
 * Exponential backoff with a configurable ceiling and a small jitter band so
 * that simultaneous failures don't all re-dispatch on the same tick.
 *
 * Run 1 -> base, run 2 -> base*2, run 3 -> base*4, ... capped at `maxMs`.
 * ±20% jitter applied to the result.
 */
export function backoffMs(
  runNumber: number,
  maxMs: number,
  baseMs = 5_000,
  rng: () => number = Math.random,
): number {
  if (runNumber < 1) return 0;
  const exp = Math.min(maxMs, baseMs * 2 ** (runNumber - 1));
  const jitter = 1 + (rng() * 0.4 - 0.2);
  return Math.max(0, Math.round(exp * jitter));
}
