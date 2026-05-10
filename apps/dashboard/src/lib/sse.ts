import { createListener } from '@symphony/shared';
import { env } from './env';

const KEEPALIVE_MS = 25_000;

/**
 * Forwards every NOTIFY on `channel` to the response as an SSE `data:` event,
 * with periodic keepalive comments and proper cleanup on client abort. Holds a
 * dedicated postgres-js LISTEN connection for the lifetime of the response.
 */
export function streamPgChannel(channel: string, signal: AbortSignal): Response {
  const sql = createListener(env.DATABASE_URL);
  const enc = new TextEncoder();

  const log = (where: string, err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    // biome-ignore lint/suspicious/noConsole: dashboard has no logger; surface via Next.js server logs
    console.error(`[sse:${channel}] ${where}: ${msg}`);
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let unlisten: (() => Promise<void>) | null = null;

      // Best-effort cleanup. unlisten / sql.end / controller.close all race
      // with abort and routinely throw "connection destroyed" / "already
      // closed" — that's expected on disconnect, not an error to log.
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

      const enqueue = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(chunk));
        } catch (err) {
          log('enqueue', err);
          close();
        }
      };

      const keepalive = setInterval(() => enqueue(': keepalive\n\n'), KEEPALIVE_MS);

      // Wire abort *before* awaiting listen() so a disconnect while the
      // initial LISTEN is in flight is observed and we don't leak the
      // postgres connection.
      if (signal.aborted) {
        close();
        return;
      }
      signal.addEventListener('abort', close);

      try {
        const { unlisten: u } = await sql.listen(channel, (payload) => {
          enqueue(`data: ${payload}\n\n`);
        });
        if (closed) {
          u().catch(() => {});
          return;
        }
        unlisten = u;
      } catch (err) {
        log('listen', err);
        close();
        return;
      }

      enqueue(': open\n\n');
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
