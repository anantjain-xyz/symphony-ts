'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

interface Props {
  source: string;
  resetAt: string | null;
}

/**
 * Renders the "paused — rate-limited" KPI block when the worker has detected
 * a future `reset_at` for a known backend source. Ticks once a second so the
 * countdown stays current without a server roundtrip; the row itself is
 * refreshed via `RealtimeRefresh` when `rate_limit_state` changes, plus one
 * scheduled refresh when the current pause expires.
 */
export function RateLimitPauseKpi({ source, resetAt }: Props) {
  const router = useRouter();
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const resetMs = resetAt ? new Date(resetAt).getTime() : null;
  const remainingMs = resetMs !== null ? resetMs - now : null;

  useEffect(() => {
    if (resetMs === null || Number.isNaN(resetMs)) return;

    const msUntilRefresh = resetMs - Date.now();
    if (msUntilRefresh <= 0) {
      router.refresh();
      return;
    }

    const id = setTimeout(() => {
      setNow(Date.now());
      router.refresh();
    }, msUntilRefresh);
    return () => clearTimeout(id);
  }, [resetMs, router]);

  // Show source on hover via `title` so the narrow 5-col KPI strip can prefer
  // the operationally-critical "until HH:MM:SS" without source-name truncation
  // hiding the wall-clock target.
  const captionTitle = resetAt
    ? `Rate-limited by ${source} until ${new Date(resetAt).toLocaleString()}`
    : `Rate-limited by ${source}`;

  return (
    <div>
      <div className="smallcaps text-[10px] text-danger flex items-center gap-1.5">
        paused
        <span className="h-1 w-1 rounded-full bg-danger dot-live" aria-hidden />
      </div>
      <div className="font-display text-[32px] tabular leading-none mt-1 tracking-tight text-danger">
        {remainingMs !== null && remainingMs > 0 ? formatRemaining(remainingMs) : 'now'}
      </div>
      <div
        className="mt-1 font-mono text-[10.5px] text-ink-3 tabular truncate"
        title={captionTitle}
      >
        {resetAt ? <>until {formatClock(resetAt)}</> : 'rate-limited'}
      </div>
    </div>
  );
}

function formatRemaining(ms: number): string {
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m ${rem.toString().padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h}h ${mm.toString().padStart(2, '0')}m`;
}

function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
