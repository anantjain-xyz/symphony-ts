'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { getSupabaseBrowserClient } from '@/lib/supabase-browser';

// Trailing debounce so a burst of token_count updates on live_sessions collapses
// into a single server refetch instead of hammering the RSC endpoint.
const REFRESH_DEBOUNCE_MS = 600;

export function RealtimeRefresh() {
  const router = useRouter();

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    let timer: ReturnType<typeof setTimeout> | null = null;

    const scheduleRefresh = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        router.refresh();
      }, REFRESH_DEBOUNCE_MS);
    };

    const channel = supabase
      .channel('fleet-dashboard')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'runs' },
        scheduleRefresh,
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'retry_queue' },
        scheduleRefresh,
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'live_sessions' },
        scheduleRefresh,
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'rate_limit_state' },
        scheduleRefresh,
      )
      .subscribe();

    return () => {
      if (timer) clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [router]);

  return null;
}
