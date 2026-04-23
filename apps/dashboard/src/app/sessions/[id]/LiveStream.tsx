'use client';

import { useEffect, useRef, useState } from 'react';
import { getSupabaseBrowserClient } from '@/lib/supabase-browser';
import type { Tables } from '@symphony/shared';
import { EventBlock } from './EventBlock';

type EventRow = Tables<'agent_events'>;

interface Props {
  attemptId: string;
  initialEvents: EventRow[];
  initialTokens: number;
  attemptIsTerminal: boolean;
}

export function LiveStream({ attemptId, initialEvents, initialTokens, attemptIsTerminal }: Props) {
  const [events, setEvents] = useState<EventRow[]>(initialEvents);
  const [tokens, setTokens] = useState(initialTokens);
  const [connected, setConnected] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (attemptIsTerminal) return;
    const supabase = getSupabaseBrowserClient();
    const channel = supabase
      .channel(`session:${attemptId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'agent_events',
          filter: `run_attempt_id=eq.${attemptId}`,
        },
        (payload) => {
          setEvents((prev) => [...prev, payload.new as EventRow]);
        },
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'live_sessions',
          filter: `run_attempt_id=eq.${attemptId}`,
        },
        (payload) => {
          const row = payload.new as { total_tokens?: number } | null;
          if (row?.total_tokens !== undefined) setTokens(row.total_tokens);
        },
      )
      .subscribe((status) => {
        setConnected(status === 'SUBSCRIBED');
      });

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [attemptId, attemptIsTerminal]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 text-xs text-zinc-500">
        <span>{tokens.toLocaleString()} tokens</span>
        <span>·</span>
        {attemptIsTerminal ? (
          <span>terminal</span>
        ) : (
          <span className={connected ? 'text-emerald-400' : 'text-amber-400'}>
            {connected ? '● live' : '○ connecting'}
          </span>
        )}
      </div>
      <div className="rounded-lg border border-zinc-800 bg-zinc-950 max-h-[70vh] overflow-y-auto">
        {events.length === 0 ? (
          <div className="px-4 py-8 text-zinc-500 text-sm">No events yet.</div>
        ) : (
          <div className="space-y-3 px-4 py-4">
            {events.map((e, i) => (
              <EventBlock key={e.id} ev={e} prev={events[i - 1]} />
            ))}
          </div>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
