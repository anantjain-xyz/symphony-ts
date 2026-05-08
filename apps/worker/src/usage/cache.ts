import type { AgentBackend } from '@symphony/shared';
import type { UsageProbe, UsageSnapshot } from './probe.js';

const DEFAULT_TTL_MS = 60_000;

interface Entry {
  snapshot: UsageSnapshot | null;
  expiresAt: number;
}

/**
 * Wraps a `UsageProbe` so the underlying `/status` shell-out only fires once
 * per TTL window per backend. The orchestrator ticks every 30s but probing
 * spawns a CLI under a PTY (heavy + visible to the user as a brief subprocess);
 * caching keeps that off the hot path while still letting the gate respond
 * within a minute when usage actually crosses the threshold.
 *
 * Failure results are cached too — a `null` snapshot means "couldn't probe;
 * fail open". We DON'T retry on every tick when the probe is broken.
 */
export function cachingUsageProbe(
  inner: UsageProbe,
  ttlMs: number = DEFAULT_TTL_MS,
  now: () => number = () => Date.now(),
): UsageProbe {
  const cache = new Map<AgentBackend, Entry>();
  return {
    probe: async (backend) => {
      const hit = cache.get(backend);
      if (hit && hit.expiresAt > now()) return hit.snapshot;
      const snapshot = await inner.probe(backend);
      cache.set(backend, { snapshot, expiresAt: now() + ttlMs });
      return snapshot;
    },
  };
}
