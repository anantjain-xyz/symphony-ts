'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

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

    const source = new EventSource('/api/realtime/fleet');
    source.addEventListener('refresh', scheduleRefresh);

    return () => {
      if (timer) clearTimeout(timer);
      source.close();
    };
  }, [router]);

  return null;
}
