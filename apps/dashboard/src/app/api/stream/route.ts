import { createListener } from '@symphony/shared';
import { env } from '@/lib/env';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const KEEPALIVE_MS = 25_000;

/**
 * Coarse fanout for the fleet dashboard. Holds a single LISTEN connection on
 * `symphony_changes` and forwards every NOTIFY payload as an SSE message.
 * The browser debounces these into a router.refresh() in RealtimeRefresh.tsx,
 * so we don't filter by table here — every change is a hint to refetch.
 */
export async function GET(req: Request) {
  const sql = createListener(env.DATABASE_URL);
  const enc = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let unlisten: (() => Promise<void>) | null = null;
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(keepalive);
        unlisten?.().catch(() => {});
        sql.end({ timeout: 1 }).catch(() => {});
        try {
          controller.close();
        } catch {}
      };

      const keepalive = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(': keepalive\n\n'));
        } catch {
          close();
        }
      }, KEEPALIVE_MS);

      // Wire abort *before* awaiting listen() so a disconnect while the
      // initial LISTEN is in flight is observed and we don't leak the
      // postgres connection.
      if (req.signal.aborted) {
        close();
        return;
      }
      req.signal.addEventListener('abort', close);

      try {
        const { unlisten: u } = await sql.listen('symphony_changes', (payload) => {
          if (closed) return;
          try {
            controller.enqueue(enc.encode(`data: ${payload}\n\n`));
          } catch {
            close();
          }
        });
        if (closed) {
          u().catch(() => {});
          return;
        }
        unlisten = u;
      } catch {
        close();
        return;
      }

      try {
        controller.enqueue(enc.encode(': open\n\n'));
      } catch {
        close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
