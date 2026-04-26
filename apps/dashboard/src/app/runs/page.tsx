import type { Tables } from '@symphony/shared';
import { createSupabaseServerClient } from '@/lib/supabase-server';
import { ListFilters } from '../_filters/ListFilters';
import { asString, parseCsv } from '../_filters/params';
import { RunRow, relativeTime } from '../RunRow';

export const dynamic = 'force-dynamic';

type IssueSummary = Pick<Tables<'issues'>, 'identifier' | 'title' | 'state'>;
type RunWithIssue = Tables<'runs'> & { issues: IssueSummary | null };

const STATUS_OPTIONS = [
  { value: 'running', label: 'running' },
  { value: 'pending', label: 'pending' },
  { value: 'success', label: 'success' },
  { value: 'failure', label: 'failure' },
  { value: 'timeout', label: 'timeout' },
  { value: 'cancelled', label: 'cancelled' },
] as const;
type Status = (typeof STATUS_OPTIONS)[number]['value'];

const PAGE_SIZE = 200;

export default async function RunsListPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const statusFilter = parseCsv(asString(sp.status)).filter((s): s is Status =>
    STATUS_OPTIONS.some((o) => o.value === s),
  );
  const search = (asString(sp.q) ?? '').trim();

  const supabase = createSupabaseServerClient();

  // PostgREST can't `.or` across joined tables, so when the user searches
  // we first resolve matching issue IDs and then constrain runs.
  let issueIdFilter: string[] | null = null;
  if (search) {
    const escaped = search.replace(/[%,]/g, '');
    const { data: matching } = await supabase
      .from('issues')
      .select('id')
      .or(`identifier.ilike.%${escaped}%,title.ilike.%${escaped}%`);
    issueIdFilter = (matching ?? []).map((r) => r.id);
  }

  let rows: RunWithIssue[] = [];
  if (!issueIdFilter || issueIdFilter.length > 0) {
    let query = supabase
      .from('runs')
      .select('*, issues(identifier, title, state)')
      .order('started_at', { ascending: false, nullsFirst: false })
      .limit(PAGE_SIZE);

    if (statusFilter.length > 0) query = query.in('status', statusFilter);
    if (issueIdFilter) query = query.in('issue_id', issueIdFilter);

    const { data } = await query;
    rows = (data ?? []) as unknown as RunWithIssue[];
  }

  return (
    <>
      <header className="mb-8">
        <div className="flex items-baseline gap-3 mb-2">
          <span className="smallcaps text-[10px] text-ink-3">runs</span>
          <span className="text-ink-4">/</span>
          <span className="smallcaps text-[10px] text-ink-2">all runs</span>
        </div>
        <h1 className="font-display text-[34px] leading-[1.08] text-ink-0 tracking-[-0.01em] font-medium">
          Runs
        </h1>
      </header>

      <ListFilters
        filterParam="status"
        options={[...STATUS_OPTIONS]}
        selected={statusFilter}
        searchValue={search}
        searchPlaceholder="Search by issue identifier or title…"
        resultCount={rows.length}
      />

      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-hairline px-4 py-8 text-[13px] text-ink-3 italic font-display">
          No runs match the current filters.
        </div>
      ) : (
        <div className="border-t border-hairline">
          {rows.map((r) => (
            <RunRow
              key={r.id}
              href={`/runs/${r.id}`}
              identifier={r.issues?.identifier ?? r.issue_id}
              title={r.issues?.title ?? '—'}
              runNumber={r.run_number}
              status={r.status}
              pid={r.worker_pid}
              errorClass={r.error_class}
              when={relativeTime(r.ended_at ?? r.started_at)}
              whenLabel={r.ended_at ? 'ended' : 'started'}
            />
          ))}
        </div>
      )}
      {rows.length === PAGE_SIZE && (
        <p className="mt-4 smallcaps text-[10px] text-ink-3">
          showing first {PAGE_SIZE} — narrow filters to see more
        </p>
      )}
    </>
  );
}
