import { issues as issuesT, type Tables } from '@symphony/shared';
import { and, desc, ilike, inArray, or } from 'drizzle-orm';
import { db } from '@/lib/db';
import { ListFilters } from '../_filters/ListFilters';
import { asString, parseCsv } from '../_filters/params';
import { IssueListRow } from './IssueListRow';

export const dynamic = 'force-dynamic';

type Issue = Pick<
  Tables<'issues'>,
  'id' | 'identifier' | 'title' | 'state' | 'labels' | 'last_seen_at'
>;

const PAGE_SIZE = 200;

export default async function IssuesListPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const stateFilter = parseCsv(asString(sp.state));
  const search = (asString(sp.q) ?? '').trim();

  // Pull the full universe of states so the filter chips reflect what's
  // actually in the DB rather than a hardcoded set. Cheap because issues
  // is small.
  const allStates = await db.select({ state: issuesT.state }).from(issuesT);
  const stateOptions = uniqueSorted(allStates.map((r) => r.state)).map((s) => ({
    value: s,
    label: s,
  }));

  const conds = [
    stateFilter.length > 0 ? inArray(issuesT.state, stateFilter) : undefined,
    search
      ? (() => {
          const escaped = search.replace(/[%,]/g, '');
          return or(
            ilike(issuesT.identifier, `%${escaped}%`),
            ilike(issuesT.title, `%${escaped}%`),
          );
        })()
      : undefined,
  ].filter((c): c is NonNullable<typeof c> => c !== undefined);

  const issues = (await db
    .select({
      id: issuesT.id,
      identifier: issuesT.identifier,
      title: issuesT.title,
      state: issuesT.state,
      labels: issuesT.labels,
      last_seen_at: issuesT.last_seen_at,
    })
    .from(issuesT)
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(desc(issuesT.last_seen_at))
    .limit(PAGE_SIZE)) as Issue[];

  return (
    <>
      <header className="mb-8">
        <div className="flex items-baseline gap-3 mb-2">
          <span className="smallcaps text-[10px] text-ink-3">tracker</span>
          <span className="text-ink-4">/</span>
          <span className="smallcaps text-[10px] text-ink-2">all issues</span>
        </div>
        <h1 className="font-display text-[34px] leading-[1.08] text-ink-0 tracking-[-0.01em] font-medium">
          Issues
        </h1>
      </header>

      <ListFilters
        filterParam="state"
        options={stateOptions}
        selected={stateFilter}
        searchValue={search}
        searchPlaceholder="Search identifier or title…"
        resultCount={issues.length}
      />

      {issues.length === 0 ? (
        <div className="rounded border border-dashed border-hairline px-4 py-8 text-[13px] text-ink-3 italic font-display">
          No issues match the current filters.
        </div>
      ) : (
        <div className="border-t border-hairline">
          {issues.map((i) => (
            <IssueListRow
              key={i.id}
              id={i.id}
              identifier={i.identifier}
              title={i.title}
              state={i.state}
              labels={i.labels}
              lastSeenAt={i.last_seen_at}
            />
          ))}
        </div>
      )}
      {issues.length === PAGE_SIZE && (
        <p className="mt-4 smallcaps text-[10px] text-ink-3">
          showing first {PAGE_SIZE} — narrow filters to see more
        </p>
      )}
    </>
  );
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}
