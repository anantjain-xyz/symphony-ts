'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { getSupabaseBrowserClient } from '@/lib/supabase-browser';
import { IssueLinks } from '@/components/IssueLinks';
import type { Tables, TrackerConfig } from '@symphony/shared';
import { EventBlock, ToolRunGroup, previewArgs, type EventRow } from './EventBlock';

type Run = Tables<'runs'>;

interface Props {
  runId: string;
  run: Run;
  initialEvents: EventRow[];
  runIsTerminal: boolean;
  issueIdentifier: string | null;
  prUrls: string[];
  tracker: TrackerConfig | null;
}

const RUN_GROUP_THRESHOLD = 3; // collapse N+ consecutive same-tool calls

type Item = { kind: 'single'; ev: EventRow } | { kind: 'group'; events: EventRow[] };

export function LiveStream({
  runId,
  run,
  initialEvents,
  runIsTerminal,
  issueIdentifier,
  prUrls,
  tracker,
}: Props) {
  const [events, setEvents] = useState<EventRow[]>(initialEvents);
  const [connected, setConnected] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [autoFollow, setAutoFollow] = useState(true);
  const initialIds = useRef(new Set(initialEvents.map((e) => e.id)));
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);

  /* Read selected event from URL hash on mount + listen to changes */
  useEffect(() => {
    const read = () => {
      const m = window.location.hash.match(/event=(\d+)/);
      setSelectedId(m ? Number(m[1]) : null);
    };
    read();
    window.addEventListener('hashchange', read);
    return () => window.removeEventListener('hashchange', read);
  }, []);

  /* Realtime subscription */
  useEffect(() => {
    if (runIsTerminal) return;
    const supabase = getSupabaseBrowserClient();
    const channel = supabase
      .channel(`run:${runId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'agent_events',
          filter: `run_id=eq.${runId}`,
        },
        (payload) => {
          setEvents((prev) => [...prev, payload.new as EventRow]);
        },
      )
      .subscribe((status) => {
        setConnected(status === 'SUBSCRIBED');
      });

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [runId, runIsTerminal]);

  /* Tick clock once a second for live duration */
  useEffect(() => {
    if (runIsTerminal) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [runIsTerminal]);

  /* Auto-follow: only scroll if user is parked near the bottom */
  useEffect(() => {
    if (!autoFollow) return;
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [events.length, autoFollow]);

  function onScroll() {
    const el = scrollerRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    setAutoFollow(distance < 80);
  }

  function selectEvent(id: number | null) {
    if (id === null) {
      history.replaceState(null, '', window.location.pathname + window.location.search);
      setSelectedId(null);
    } else {
      history.replaceState(
        null,
        '',
        `${window.location.pathname}${window.location.search}#event=${id}`,
      );
      setSelectedId(id);
    }
  }

  /* Build grouped item list — collapse runs of same tool */
  const items = useMemo<Item[]>(() => groupEvents(events), [events]);

  /* Aggregate counts for telemetry rail */
  const stats = useMemo(() => computeStats(events), [events]);

  const selectedEvent = selectedId ? (events.find((e) => e.id === selectedId) ?? null) : null;
  const isLive = !runIsTerminal;
  const elapsedMs = useMemo(() => {
    if (!run.started_at) return 0;
    const end = run.ended_at ? new Date(run.ended_at).getTime() : now;
    return Math.max(0, end - new Date(run.started_at).getTime());
  }, [run.started_at, run.ended_at, now]);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[220px_minmax(0,1fr)_320px] gap-6">
      {/* Left telemetry rail */}
      <aside className="lg:sticky lg:top-4 lg:self-start space-y-5">
        <TelemetryBlock label="elapsed" value={formatDuration(elapsedMs)} live={isLive} />
        <TelemetryBlock label="events" value={events.length.toLocaleString()} />
        <TelemetryBlock label="tools" value={stats.toolTotal.toLocaleString()} />
        <ConnectionDot connected={connected} terminal={runIsTerminal} />
        <button
          type="button"
          onClick={() => navigator.clipboard.writeText(runId)}
          className="block w-full text-left smallcaps text-[10px] text-ink-3 hover:text-ink-1 link-hover"
        >
          ⎘ run id
          <div className="font-mono text-[10.5px] text-ink-2 mt-0.5 truncate normal-case tracking-normal">
            {runId}
          </div>
        </button>
        {issueIdentifier && (
          <IssueLinks identifier={issueIdentifier} prUrls={prUrls} tracker={tracker} />
        )}
      </aside>

      {/* Center: timeline */}
      <section data-live={isLive ? 'true' : 'false'} className="min-w-0">
        <div className="flex items-center justify-between mb-2">
          <div className="smallcaps text-[10px] text-ink-3">timeline</div>
          {isLive && !autoFollow && (
            <button
              type="button"
              onClick={() => setAutoFollow(true)}
              className="smallcaps text-[10px] text-signal hover:text-ink-0"
            >
              ↓ jump to live
            </button>
          )}
        </div>
        <div
          ref={scrollerRef}
          onScroll={onScroll}
          className="scroller relative max-h-[calc(100vh-260px)] overflow-y-auto pr-2"
        >
          {events.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="relative">
              {items.map((item) =>
                item.kind === 'single' ? (
                  <EventBlock
                    key={item.ev.id}
                    ev={item.ev}
                    isFresh={!initialIds.current.has(item.ev.id)}
                    selected={selectedId === item.ev.id}
                    onSelect={selectEvent}
                  />
                ) : (
                  <ToolRunGroup
                    key={`g-${item.events[0]?.id ?? 'x'}`}
                    events={item.events}
                    isFreshFn={(id) => !initialIds.current.has(id)}
                    selectedId={selectedId}
                    onSelect={selectEvent}
                  />
                ),
              )}
              <div ref={bottomRef} />
            </div>
          )}
        </div>
      </section>

      {/* Right: inspector */}
      <aside className="lg:sticky lg:top-4 lg:self-start space-y-4">
        <Inspector ev={selectedEvent} onClose={() => selectEvent(null)} />
        {runIsTerminal && (
          <TerminalSummary run={run} stats={stats} elapsedMs={elapsedMs} />
        )}
      </aside>
    </div>
  );
}

function TerminalSummary({
  run,
  stats,
  elapsedMs,
}: {
  run: Run;
  stats: { toolTotal: number };
  elapsedMs: number;
}) {
  return (
    <div className="rounded border border-hairline bg-surface-1 p-3">
      <div className="smallcaps text-[10px] text-ink-3 mb-2">summary</div>
      <div className="grid grid-cols-2 gap-3">
        <Cell label="duration" value={formatDuration(elapsedMs)} />
        <Cell label="tool calls" value={stats.toolTotal.toLocaleString()} />
        <Cell
          label="status"
          value={run.status}
          tone={
            run.status === 'success' ? 'good' : run.status === 'cancelled' ? 'muted' : 'bad'
          }
        />
      </div>
      {run.error_class && (
        <div className="mt-3 pt-3 border-t border-hairline">
          <div className="smallcaps text-[10px] text-danger mb-1">error</div>
          <div className="font-mono text-[12px] text-ink-0">{run.error_class}</div>
          {run.error_message && (
            <div className="text-[12px] text-ink-2 mt-1 break-words">{run.error_message}</div>
          )}
        </div>
      )}
    </div>
  );
}

function Cell({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'good' | 'bad' | 'muted';
}) {
  const color =
    tone === 'good'
      ? 'text-success'
      : tone === 'bad'
        ? 'text-danger'
        : tone === 'muted'
          ? 'text-ink-2'
          : 'text-ink-0';
  return (
    <div>
      <div className="smallcaps text-[10px] text-ink-3">{label}</div>
      <div className={`font-mono text-[14px] tabular ${color} mt-0.5`}>{value}</div>
    </div>
  );
}

/* ---------- inspector ---------- */

function Inspector({ ev, onClose }: { ev: EventRow | null; onClose: () => void }) {
  if (!ev) {
    return (
      <div className="rounded border border-dashed border-hairline p-4 text-[12px] text-ink-3 leading-relaxed">
        <div className="smallcaps text-[10px] text-ink-3 mb-1">inspector</div>
        Select any event to see its full payload here.
      </div>
    );
  }
  const payload = ev.payload as Record<string, unknown>;
  const tool = (payload.tool as string | undefined) ?? '';
  return (
    <div className="rounded border border-hairline bg-surface-1">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-hairline">
        <span className="smallcaps text-[10px] text-ink-3">inspector</span>
        <span className="font-mono text-[11px] text-ink-1 ml-1">{ev.kind}</span>
        {tool && <span className="font-mono text-[11px] text-ink-2">· {tool}</span>}
        <button
          type="button"
          onClick={onClose}
          className="ml-auto text-ink-3 hover:text-ink-0 text-[14px]"
          aria-label="close"
        >
          ×
        </button>
      </div>
      <div className="p-3 space-y-3 max-h-[calc(100vh-260px)] overflow-y-auto scroller">
        {tool && (
          <Field label="command">
            <code className="font-mono text-[11.5px] text-ink-0 whitespace-pre-wrap break-words">
              {previewArgs(payload.args) || '—'}
            </code>
          </Field>
        )}
        {typeof payload.result_summary === 'string' && payload.result_summary.length > 0 && (
          <Field label="result">
            <span className="font-mono text-[11.5px] text-ink-1">{payload.result_summary}</span>
          </Field>
        )}
        <Field label="payload">
          <pre className="font-mono text-[11px] text-ink-1 whitespace-pre-wrap break-words bg-surface-0 border border-hairline rounded p-2 overflow-x-auto">
            {JSON.stringify(payload, null, 2)}
          </pre>
        </Field>
        <Field label="received">
          <span className="font-mono text-[11px] text-ink-2 tabular">
            {new Date(ev.created_at).toISOString()}
          </span>
        </Field>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="smallcaps text-[10px] text-ink-3 mb-1">{label}</div>
      {children}
    </div>
  );
}

/* ---------- telemetry ---------- */

function TelemetryBlock({
  label,
  value,
  live,
  children,
}: {
  label: string;
  value: string;
  live?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div>
      <div className="smallcaps text-[10px] text-ink-3 flex items-center gap-1.5">
        {label}
        {live && <span className="h-1 w-1 rounded-full bg-success dot-live" aria-hidden />}
      </div>
      <div className="font-display text-[26px] tracking-tight tabular text-ink-0 leading-none mt-1">
        {value}
      </div>
      {children}
    </div>
  );
}

function ConnectionDot({ connected, terminal }: { connected: boolean; terminal: boolean }) {
  if (terminal) {
    return (
      <div className="smallcaps text-[10px] text-ink-3 flex items-center gap-2">
        <span className="h-1.5 w-1.5 bg-ink-3" aria-hidden />
        terminal
      </div>
    );
  }
  return (
    <div className="smallcaps text-[10px] text-ink-2 flex items-center gap-2">
      <span
        className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-success dot-live' : 'bg-signal'}`}
        aria-hidden
      />
      {connected ? 'live · subscribed' : 'connecting'}
    </div>
  );
}

/* ---------- empty ---------- */

function EmptyState() {
  return (
    <div className="grid grid-cols-[72px_10px_1fr] gap-3 items-start py-6">
      <div className="text-right tabular text-[11px] text-ink-4 pt-1">--:--:--</div>
      <div className="relative h-full flex justify-center">
        <span className="absolute top-2 h-1.5 w-1.5 rounded-full ring-2 ring-surface-0 bg-ink-4" />
      </div>
      <div className="text-[13px] text-ink-3 italic font-display">
        Awaiting first event from the agent…
      </div>
    </div>
  );
}

/* ---------- helpers ---------- */

function groupEvents(events: EventRow[]): Item[] {
  // 1) Coalesce tool_call rows that share a call_id (started → completed pair).
  //    Prefer the row whose result_summary looks terminal (exit N / ok / error).
  const collapsed: EventRow[] = [];
  const callIndex = new Map<string, number>(); // call_id -> index in `collapsed`
  for (const e of events) {
    if (e.kind === 'tool_call') {
      const p = e.payload as { call_id?: string; result_summary?: string };
      const key = p.call_id;
      if (key) {
        const at = callIndex.get(key);
        if (at !== undefined) {
          // Replace the prior row if the new one is more "final".
          const prev = collapsed[at];
          if (
            isMoreFinal(
              p.result_summary,
              (prev?.payload as { result_summary?: string })?.result_summary,
            )
          ) {
            collapsed[at] = e;
          }
          continue;
        }
        callIndex.set(key, collapsed.length);
      }
    }
    collapsed.push(e);
  }

  // 2) Group N+ consecutive same-tool calls into a single ribbon.
  const items: Item[] = [];
  let buf: EventRow[] = [];
  let bufTool: string | null = null;
  const flush = () => {
    if (buf.length === 0) return;
    if (buf.length >= RUN_GROUP_THRESHOLD) {
      items.push({ kind: 'group', events: buf });
    } else {
      for (const e of buf) items.push({ kind: 'single', ev: e });
    }
    buf = [];
    bufTool = null;
  };
  for (const e of collapsed) {
    if (e.kind === 'tool_call') {
      const t = (e.payload as { tool?: string }).tool ?? '?';
      if (bufTool === null || bufTool === t) {
        bufTool = t;
        buf.push(e);
      } else {
        flush();
        bufTool = t;
        buf.push(e);
      }
    } else {
      flush();
      items.push({ kind: 'single', ev: e });
    }
  }
  flush();
  return items;
}

function isMoreFinal(next: string | undefined, prev: string | undefined): boolean {
  const score = (s?: string) => {
    if (!s) return 0;
    const t = s.toLowerCase();
    if (t.includes('running') || t.includes('pending')) return 1;
    if (/exit\s+-?\d+/.test(t)) return 3;
    if (t.includes('error') || t.includes('fail')) return 3;
    return 2;
  };
  return score(next) >= score(prev);
}

function computeStats(events: EventRow[]): { toolTotal: number } {
  // A single tool invocation often emits two `tool_call` rows (started + completed)
  // that share a `call_id`. Dedupe by call_id so totals match what the timeline shows.
  const seenCallIds = new Set<string>();
  let total = 0;
  for (const e of events) {
    if (e.kind !== 'tool_call') continue;
    const p = e.payload as { call_id?: string };
    if (p.call_id) {
      if (seenCallIds.has(p.call_id)) continue;
      seenCallIds.add(p.call_id);
    }
    total++;
  }
  return { toolTotal: total };
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(ss).padStart(2, '0')}s`;
  return `${ss}s`;
}
