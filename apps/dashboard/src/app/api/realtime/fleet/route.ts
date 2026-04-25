import type { NextRequest } from 'next/server';
import { startSseStream } from '@/lib/sse';
import { createSupabaseServerClient } from '@/lib/supabase-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TABLES = ['run_attempts', 'retry_queue', 'live_sessions', 'rate_limit_state'] as const;

export async function GET(req: NextRequest) {
  const supabase = createSupabaseServerClient();
  const channel = supabase.channel(`fleet-sse-${Math.random().toString(36).slice(2, 10)}`);

  return startSseStream({
    signal: req.signal,
    setup: (port) => {
      for (const table of TABLES) {
        channel.on('postgres_changes', { event: '*', schema: 'public', table }, () => {
          port.send('refresh', { table });
        });
      }
      channel.subscribe();
    },
    teardown: async () => {
      await supabase.removeChannel(channel).catch(() => undefined);
    },
  });
}
