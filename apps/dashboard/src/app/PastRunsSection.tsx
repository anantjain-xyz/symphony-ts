'use client';

import { useEffect, useState } from 'react';
import { getSupabaseBrowserClient } from '@/lib/supabase-browser';
import type { Tables } from '@symphony/shared';
import { RunRow, relativeTime } from './RunRow';

type IssueSummary = Pick<Tables<'issues'>, 'identifier' | 'title' | 'state'>;
type RunAttemptWithIssue = Tables<'run_attempts'> & { issues: IssueSummary | null };

const PAGE_SIZE = 100;

export function PastRunsSection({ initialRows }: { initialRows: RunAttemptWithIssue[] }) {
  const [rows, setRows] = useState<RunAttemptWithIssue[]>(initialRows);
  const [hasMore, setHasMore] = useState(initialRows.length >= PAGE_SIZE);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // RealtimeRefresh re-runs the RSC and produces a fresh initialRows snapshot
  // when run_attempts changes. Merge it over our local state so newly ended
  // runs appear at the top while preserving any pages the user has loaded
  // beyond the initial window.
  useEffect(() => {
    setRows((prev) => {
      if (prev.length <= initialRows.length) return initialRows;
      const headIds = new Set(initialRows.map((r) => r.id));
      const tail = prev.filter((r) => !headIds.has(r.id));
      return [...initialRows, ...tail];
    });
  }, [initialRows]);

  const loadMore = async () => {
    if (loading || !hasMore) return;
    const cursor = rows[rows.length - 1];
    if (!cursor?.ended_at) {
      setHasMore(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const supabase = getSupabaseBrowserClient();
      // Keyset pagination on (ended_at desc, id desc): the same total order
      // the server uses for the initial fetch, so we never duplicate or skip
      // rows when ties or new inserts shift offset-based windows.
      const { data, error: queryError } = await supabase
        .from('run_attempts')
        .select('*, issues(identifier, title, state)')
        .in('status', ['success', 'cancelled'])
        .or(`ended_at.lt.${cursor.ended_at},and(ended_at.eq.${cursor.ended_at},id.lt.${cursor.id})`)
        .order('ended_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(PAGE_SIZE);
      if (queryError) throw queryError;
      const next = (data ?? []) as unknown as RunAttemptWithIssue[];
      setRows((prev) => [...prev, ...next]);
      setHasMore(next.length >= PAGE_SIZE);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load more runs.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <section>
      <div className="flex items-baseline gap-3 mb-3">
        <span className="h-1.5 w-1.5 rounded-full bg-ink-4" aria-hidden />
        <h2 className="smallcaps text-[11px] text-ink-2">Past runs</h2>
        <span className="text-ink-4">·</span>
        <span className="font-mono text-[12px] text-ink-2 tabular">{rows.length}</span>
      </div>
      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-hairline px-4 py-6 text-[13px] text-ink-3 italic font-display">
          No past runs yet.
        </div>
      ) : (
        <div className="border-t border-hairline">
          {rows.map((r) => (
            <RunRow
              key={r.id}
              href={`/sessions/${r.id}`}
              identifier={r.issues?.identifier ?? r.issue_id}
              title={r.issues?.title ?? '—'}
              attemptNumber={r.attempt_number}
              status={r.status}
              when={relativeTime(r.ended_at)}
              whenLabel="ended"
            />
          ))}
        </div>
      )}
      {hasMore && rows.length > 0 ? (
        <div className="mt-4 flex flex-col items-center gap-2">
          <button
            type="button"
            onClick={loadMore}
            disabled={loading}
            className="smallcaps text-[10px] text-ink-2 hover:text-ink-0 border border-hairline rounded px-3 py-1.5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? 'loading…' : `Load ${PAGE_SIZE} more`}
          </button>
          {error ? <span className="text-[11px] text-danger font-mono">{error}</span> : null}
        </div>
      ) : null}
    </section>
  );
}
