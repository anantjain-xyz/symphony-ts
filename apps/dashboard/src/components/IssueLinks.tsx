import type { TrackerConfig } from '@symphony/shared';
import { linearIssueUrl } from '@symphony/shared/schema';

/**
 * Renders Linear + GitHub PR chips for an issue. Used on both the issue page
 * sidebar and the session page header. Returns null when no chips would render.
 */
export function IssueLinks({
  identifier,
  prUrls,
  tracker,
  className,
}: {
  identifier: string;
  prUrls: string[];
  tracker: TrackerConfig | null | undefined;
  className?: string;
}) {
  const linear = tracker ? linearIssueUrl(tracker, identifier) : null;
  if (!linear && prUrls.length === 0) return null;
  return (
    <div className={className}>
      <div className="smallcaps text-[10px] text-ink-3 mb-1">links</div>
      <div className="flex flex-wrap gap-1">
        {linear && <LinkChip href={linear} label="linear" />}
        {prUrls.map((url) => (
          <LinkChip key={url} href={url} label={prLabel(url)} />
        ))}
      </div>
    </div>
  );
}

function LinkChip({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="font-mono text-[10.5px] text-ink-1 link-hover border border-hairline rounded px-1.5 py-0.5"
      title={href}
    >
      {label} ↗
    </a>
  );
}

function prLabel(url: string): string {
  const m = url.match(/\/pull\/(\d+)/);
  return m ? `PR #${m[1]}` : 'PR';
}
