'use client';

import { useEffect, useState } from 'react';

function parseTimestamp(iso: string): number {
  // Postgres timestamptz columns are configured with mode: 'string' and come
  // back like "2026-05-08 05:00:53+00". Safari refuses to parse that — it
  // requires the 'T' separator and a "+HH:MM" offset.
  let s = iso.includes('T') ? iso : iso.replace(' ', 'T');
  s = s.replace(/([+-]\d{2})$/, '$1:00');
  return new Date(s).getTime();
}

export function formatRelative(iso: string | null, now: number = Date.now()): string {
  if (!iso) return '—';
  const t = parseTimestamp(iso);
  if (!Number.isFinite(t)) return '—';
  const ms = now - t;
  const abs = Math.abs(ms);
  const sign = ms >= 0 ? 'ago' : 'from now';
  if (abs < 60_000) return `${Math.round(abs / 1000)}s ${sign}`;
  if (abs < 3_600_000) return `${Math.round(abs / 60_000)}m ${sign}`;
  if (abs < 86_400_000) return `${Math.round(abs / 3_600_000)}h ${sign}`;
  return `${Math.round(abs / 86_400_000)}d ${sign}`;
}

function nextDelay(absMs: number): number {
  if (absMs < 60_000) return 1_000;
  if (absMs < 3_600_000) return 30_000;
  if (absMs < 86_400_000) return 60_000;
  return 300_000;
}

export function RelativeTime({ iso, className }: { iso: string | null; className?: string }) {
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    if (!iso) return;
    const target = parseTimestamp(iso);
    if (!Number.isFinite(target)) return;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const current = Date.now();
      timer = setTimeout(
        () => {
          setNow(Date.now());
          schedule();
        },
        nextDelay(Math.abs(current - target)),
      );
    };
    schedule();
    return () => clearTimeout(timer);
  }, [iso]);

  return (
    <span className={className} suppressHydrationWarning>
      {formatRelative(iso, now)}
    </span>
  );
}
