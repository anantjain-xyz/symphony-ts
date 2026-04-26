import Link from 'next/link';

export function RunRow({
  href,
  identifier,
  title,
  runNumber,
  status,
  pid,
  latestEvent,
  errorClass,
  when,
  whenLabel,
}: {
  href: string;
  identifier: string;
  title: string;
  runNumber: number;
  status: string;
  pid?: number | null;
  latestEvent?: string;
  errorClass?: string | null;
  when: string;
  whenLabel: string;
}) {
  return (
    <Link
      href={href}
      className="grid grid-cols-[140px_minmax(0,1fr)_120px_130px_180px_130px] gap-4 items-center px-1 py-3 border-b border-hairline group hover:bg-surface-1 transition-colors"
    >
      <span className="font-mono text-[12px] text-ink-1 group-hover:text-ink-0 truncate">
        {identifier}
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] text-ink-0 truncate">{title}</span>
        {latestEvent ? (
          <span className="block font-mono text-[10.5px] text-ink-3 tabular truncate">
            {latestEvent}
          </span>
        ) : null}
      </span>
      <RunCounter n={runNumber} />
      <StatusBadge status={status} />
      <div className="font-mono text-[11px] text-ink-3 tabular truncate">
        {errorClass ? (
          <ErrorClassBadge value={errorClass} />
        ) : pid != null ? (
          <>
            <span className="text-ink-4">pid</span> {pid}
          </>
        ) : (
          '—'
        )}
      </div>
      <div className="font-mono text-[11px] text-ink-3 tabular text-right">
        <span className="text-ink-4">{whenLabel}</span> {when}
        <span className="ml-2 text-ink-4 group-hover:text-signal">→</span>
      </div>
    </Link>
  );
}

function RunCounter({ n }: { n: number }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="font-display text-[18px] tabular text-ink-0 leading-none">#{n}</span>
      <span className="smallcaps text-[9px] text-ink-3">run</span>
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const conf: Record<string, { color: string; dot: string; label?: string }> = {
    running: { color: 'text-success', dot: 'bg-success dot-live' },
    queued: { color: 'text-signal', dot: 'bg-signal' },
    pending: { color: 'text-signal', dot: 'bg-signal' },
    success: { color: 'text-success', dot: 'bg-success' },
    failure: { color: 'text-danger', dot: 'bg-danger' },
    timeout: { color: 'text-danger', dot: 'bg-danger' },
    cancelled: { color: 'text-ink-2', dot: 'bg-ink-3' },
  };
  const c = conf[status] ?? { color: 'text-ink-2', dot: 'bg-ink-3' };
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`h-1.5 w-1.5 rounded-full ${c.dot}`} aria-hidden />
      <span className={`smallcaps text-[10px] ${c.color}`}>{c.label ?? status}</span>
    </span>
  );
}

function ErrorClassBadge({ value }: { value: string }) {
  return (
    <span className="smallcaps text-[10px] text-danger truncate">{value.replace(/_/g, ' ')}</span>
  );
}

export function relativeTime(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  const abs = Math.abs(ms);
  const sign = ms >= 0 ? 'ago' : 'from now';
  if (abs < 60_000) return `${Math.round(abs / 1000)}s ${sign}`;
  if (abs < 3_600_000) return `${Math.round(abs / 60_000)}m ${sign}`;
  if (abs < 86_400_000) return `${Math.round(abs / 3_600_000)}h ${sign}`;
  return `${Math.round(abs / 86_400_000)}d ${sign}`;
}
