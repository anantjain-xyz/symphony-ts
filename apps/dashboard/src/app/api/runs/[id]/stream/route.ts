import { createListener } from '@symphony/shared';
import { env } from '@/lib/env';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const KEEPALIVE_MS = 25_000;
const RUN_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Per-run live event stream. Holds a LISTEN on `agent_events:<run_id>` and
 * forwards each NOTIFY (containing the full row JSON, or a truncated stub
 * when the row exceeds pg_notify's 8000-byte payload limit) as an SSE
 * message. The browser appends each message to its event list.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!RUN_ID_RE.test(id)) {
    return new Response('invalid run id', { status: 400 });
  }
  const channel = `agent_events:${id}`;

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

      try {
        const { unlisten: u } = await sql.listen(channel, (payload) => {
          if (closed) return;
          try {
            controller.enqueue(enc.encode(`data: ${payload}\n\n`));
          } catch {
            close();
          }
        });
        unlisten = u;
      } catch (err) {
        close();
        throw err;
      }

      controller.enqueue(enc.encode(': open\n\n'));
      req.signal.addEventListener('abort', close);
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
