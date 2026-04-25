import type { NextRequest } from 'next/server';
import { startSseStream } from '@/lib/sse';
import { createSupabaseServerClient } from '@/lib/supabase-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return new Response(JSON.stringify({ error: 'invalid attempt id' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  const supabase = createSupabaseServerClient();
  const channel = supabase.channel(`session-sse-${id}-${Math.random().toString(36).slice(2, 8)}`);

  return startSseStream({
    signal: req.signal,
    setup: (port) => {
      channel
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'agent_events',
            filter: `run_attempt_id=eq.${id}`,
          },
          (payload) => {
            port.send('event', payload.new);
          },
        )
        .subscribe();
    },
    teardown: async () => {
      await supabase.removeChannel(channel).catch(() => undefined);
    },
  });
}
