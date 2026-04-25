const encoder = new TextEncoder();
const HEARTBEAT_MS = 25_000;

interface SsePort {
  send(event: string, data: unknown): void;
  comment(text: string): void;
  close(): void;
}

/**
 * Wires a route handler's request signal to a ReadableStream and returns a
 * port + Response. The setup callback can subscribe to whatever it likes; the
 * teardown callback runs on client disconnect or stream close. A 25s comment
 * heartbeat keeps intermediaries from idling the connection.
 */
export function startSseStream(args: {
  signal: AbortSignal;
  setup: (port: SsePort) => void | Promise<void>;
  teardown: () => void | Promise<void>;
}): Response {
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start: async (controller) => {
      const safeEnqueue = (chunk: Uint8Array) => {
        if (closed) return;
        try {
          controller.enqueue(chunk);
        } catch {
          // ignore: stream already torn down
        }
      };

      const port: SsePort = {
        send(event, data) {
          const payload = typeof data === 'string' ? data : JSON.stringify(data);
          safeEnqueue(encoder.encode(`event: ${event}\ndata: ${payload}\n\n`));
        },
        comment(text) {
          safeEnqueue(encoder.encode(`: ${text}\n\n`));
        },
        close() {
          closeStream();
        },
      };

      const closeStream = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) {
          clearInterval(heartbeat);
          heartbeat = null;
        }
        void Promise.resolve(args.teardown()).catch(() => undefined);
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      args.signal.addEventListener('abort', closeStream, { once: true });

      // Open the stream with a comment so the client receives headers immediately.
      port.comment('open');
      heartbeat = setInterval(() => port.comment('keepalive'), HEARTBEAT_MS);

      try {
        await args.setup(port);
      } catch {
        closeStream();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
      connection: 'keep-alive',
    },
  });
}
