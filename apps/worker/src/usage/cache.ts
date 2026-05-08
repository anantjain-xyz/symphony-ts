import type { AgentBackend } from '@symphony/shared';
import type { UsageProbe, UsageSnapshot } from './probe.js';

const DEFAULT_TTL_MS = 60_000;

interface Entry {
  snapshot: UsageSnapshot | null;
  expiresAt: number;
}

// Failure (`null`) snapshots are cached too — a broken probe shouldn't
// re-spawn the CLI on every 30s tick.
export function cachingUsageProbe(inner: UsageProbe, ttlMs: number = DEFAULT_TTL_MS): UsageProbe {
  const cache = new Map<AgentBackend, Entry>();
  return {
    probe: async (backend) => {
      const hit = cache.get(backend);
      if (hit && hit.expiresAt > Date.now()) return hit.snapshot;
      const snapshot = await inner.probe(backend);
      cache.set(backend, { snapshot, expiresAt: Date.now() + ttlMs });
      return snapshot;
    },
  };
}
