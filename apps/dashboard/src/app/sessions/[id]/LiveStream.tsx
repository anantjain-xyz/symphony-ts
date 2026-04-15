'use client';

import { useEffect, useRef, useState } from 'react';
import { getSupabaseBrowserClient } from '@/lib/supabase-browser';
import type { Tables } from '@symphony/shared';

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
      <div className="rounded border border-zinc-800 bg-zinc-950 font-mono text-xs divide-y divide-zinc-900 max-h-[70vh] overflow-y-auto">
        {events.length === 0 ? (
          <div className="px-3 py-6 text-zinc-500">No events yet.</div>
        ) : (
          events.map((e) => <EventLine key={e.id} ev={e} />)
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

function EventLine({ ev }: { ev: EventRow }) {
  const time = new Date(ev.created_at).toLocaleTimeString();
  const payload = ev.payload as Record<string, unknown>;
  const summary = renderSummary(ev.kind, payload);
  return (
    <div className="px-3 py-1 flex gap-3">
      <span className="text-zinc-600 shrink-0 w-20">{time}</span>
      <span className={`shrink-0 w-24 ${kindColor(ev.kind)}`}>{ev.kind}</span>
      <span className="text-zinc-200 break-words">{summary}</span>
    </div>
  );
}

function renderSummary(kind: string, payload: Record<string, unknown>): string {
  switch (kind) {
    case 'humanized':
      return String(payload.summary ?? '');
    case 'status':
      return String(payload.message ?? '');
    case 'tool_call':
      return `${String(payload.tool ?? '?')}${payload.result_summary ? `: ${String(payload.result_summary)}` : ''}`;
    case 'token_count':
      return `in ${payload.input_tokens} · out ${payload.output_tokens} · total ${payload.total_tokens}`;
    case 'approval':
      return `approval requested: ${String(payload.reason ?? '')}`;
    case 'error':
      return `${String(payload.class ?? 'error')}: ${String(payload.message ?? '')}`;
    case 'user_input':
      return String(payload.text ?? '');
    default:
      return JSON.stringify(payload);
  }
}

function kindColor(kind: string): string {
  switch (kind) {
    case 'error':
      return 'text-red-400';
    case 'approval':
      return 'text-amber-400';
    case 'tool_call':
      return 'text-blue-400';
    case 'token_count':
      return 'text-zinc-500';
    case 'humanized':
      return 'text-emerald-400';
    default:
      return 'text-zinc-400';
  }
}
