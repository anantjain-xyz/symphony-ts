'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

// Trailing debounce so a burst of token_count updates on live_sessions collapses
// into a single server refetch instead of hammering the RSC endpoint.
const REFRESH_DEBOUNCE_MS = 600;

export function RealtimeRefresh() {
  const router = useRouter();

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefresh = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        router.refresh();
      }, REFRESH_DEBOUNCE_MS);
    };

    const es = new EventSource('/api/stream');
    es.onmessage = scheduleRefresh;
    // EventSource auto-reconnects on its own; nothing to do on error beyond
    // letting the browser retry.

    return () => {
      if (timer) clearTimeout(timer);
      es.close();
    };
  }, [router]);

  return null;
}
