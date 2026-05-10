import { streamPgChannel } from '@/lib/sse';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Coarse fanout for the fleet dashboard. Forwards every NOTIFY on
 * `symphony_changes` as an SSE message; the browser debounces these into a
 * router.refresh() in RealtimeRefresh.tsx, so we don't filter by table here —
 * every change is a hint to refetch.
 */
export function GET(req: Request) {
  return streamPgChannel('symphony_changes', req.signal);
}
