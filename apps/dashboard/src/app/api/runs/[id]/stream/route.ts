import { streamPgChannel } from '@/lib/sse';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const RUN_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Per-run live event stream. Forwards each NOTIFY on `agent_events:<run_id>`
 * (the full row JSON, or a truncated stub when the row exceeds pg_notify's
 * 8000-byte payload limit) as an SSE message.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!RUN_ID_RE.test(id)) {
    return new Response('invalid run id', { status: 400 });
  }
  return streamPgChannel(`agent_events:${id}`, req.signal);
}
