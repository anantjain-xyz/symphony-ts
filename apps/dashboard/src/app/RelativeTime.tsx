'use client';

import { useEffect, useState } from 'react';

export function formatRelative(iso: string | null, now: number = Date.now()): string {
  if (!iso) return '—';
  const ms = now - new Date(iso).getTime();
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
    const target = new Date(iso).getTime();
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
