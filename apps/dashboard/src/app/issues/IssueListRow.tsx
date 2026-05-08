import Link from 'next/link';
import { RelativeTime } from '../RelativeTime';

export function IssueListRow({
  id,
  identifier,
  title,
  state,
  labels,
  lastSeenAt,
}: {
  id: string;
  identifier: string;
  title: string;
  state: string;
  labels: string[];
  lastSeenAt: string;
}) {
  return (
    <Link
      href={`/issues/${id}`}
      className="grid grid-cols-[140px_minmax(0,1fr)_160px_minmax(0,260px)_140px] gap-4 items-center px-1 py-3 border-b border-hairline group hover:bg-surface-1 transition-colors"
    >
      <span className="font-mono text-[12px] text-ink-1 group-hover:text-ink-0 truncate">
        {identifier}
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] text-ink-0 truncate">{title}</span>
      </span>
      <IssueStateBadge state={state} />
      <div className="flex flex-wrap gap-1 min-w-0">
        {labels.length === 0 ? (
          <span className="text-[12px] text-ink-4">—</span>
        ) : (
          labels.slice(0, 4).map((l) => (
            <span
              key={l}
              className="font-mono text-[10.5px] text-ink-2 border border-hairline rounded px-1.5 py-0.5 truncate max-w-full"
            >
              {l}
            </span>
          ))
        )}
        {labels.length > 4 && (
          <span className="font-mono text-[10.5px] text-ink-3">+{labels.length - 4}</span>
        )}
      </div>
      <div className="font-mono text-[11px] text-ink-3 tabular text-right">
        <span className="text-ink-4">seen</span> <RelativeTime iso={lastSeenAt} />
        <span className="ml-2 text-ink-4 group-hover:text-signal">→</span>
      </div>
    </Link>
  );
}

function IssueStateBadge({ state }: { state: string }) {
  // Linear states are free-form strings; map common ones.
  const norm = state.toLowerCase();
  const conf = norm.includes('progress')
    ? { color: 'text-info', dot: 'bg-info dot-live' }
    : norm.includes('review')
      ? { color: 'text-think', dot: 'bg-think' }
      : norm.includes('done') || norm.includes('complete') || norm.includes('merg')
        ? { color: 'text-success', dot: 'bg-success' }
        : norm.includes('cancel') || norm.includes('block')
          ? { color: 'text-ink-2', dot: 'bg-ink-3' }
          : { color: 'text-signal', dot: 'bg-signal' };
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`h-1.5 w-1.5 rounded-full ${conf.dot}`} aria-hidden />
      <span className={`smallcaps text-[10px] ${conf.color}`}>{state}</span>
    </span>
  );
}
