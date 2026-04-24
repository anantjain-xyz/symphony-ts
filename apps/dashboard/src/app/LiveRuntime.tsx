'use client';

import { useEffect, useState } from 'react';
import { KpiBlock } from './KpiBlock';

// Keep aligned with HEARTBEAT_STALE_MS in page.tsx.
const HEARTBEAT_STALE_MS = 15_000;

interface Props {
  startedAt: string | null;
  lastBeatAt: string | null;
}

export function LiveRuntime({ startedAt, lastBeatAt }: Props) {
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    if (!startedAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  if (!startedAt) {
    return <KpiBlock label="runtime" value="—" />;
  }

  const runtimeMs = now - new Date(startedAt).getTime();
  const stale = lastBeatAt === null || now - new Date(lastBeatAt).getTime() > HEARTBEAT_STALE_MS;

  return (
    <KpiBlock
      label="runtime"
      value={formatDuration(runtimeMs)}
      live={!stale}
      valueClass={stale ? 'text-danger' : undefined}
    />
  );
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  const days = Math.floor(s / 86_400);
  const hours = Math.floor((s % 86_400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  if (days > 0) return `${days}d ${pad2(hours)}h`;
  if (hours > 0) return `${hours}h ${pad2(mins)}m`;
  if (mins > 0) return `${mins}m ${pad2(secs)}s`;
  return `${secs}s`;
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}
