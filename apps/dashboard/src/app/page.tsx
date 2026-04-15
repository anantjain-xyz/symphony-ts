import Link from 'next/link';
import { createSupabaseServerClient } from '@/lib/supabase-server';
import type { Tables } from '@symphony/shared';

export const dynamic = 'force-dynamic';

type IssueSummary = Pick<Tables<'issues'>, 'identifier' | 'title' | 'state'>;
type RunAttemptWithIssue = Tables<'run_attempts'> & { issues: IssueSummary | null };
type RetryWithIssue = Tables<'retry_queue'> & {
  issues: Pick<Tables<'issues'>, 'identifier' | 'title'> | null;
};

export default async function FleetPage() {
  const supabase = await createSupabaseServerClient();

  const [running, retries, recentFails, sessions] = await Promise.all([
    supabase
      .from('run_attempts')
      .select('*, issues(identifier, title, state)')
      .eq('status', 'running')
      .order('started_at', { ascending: false }),
    supabase
      .from('retry_queue')
      .select('*, issues(identifier, title)')
      .order('due_at', { ascending: true })
      .limit(20),
    supabase
      .from('run_attempts')
      .select('*, issues(identifier, title)')
      .in('status', ['failure', 'timeout'])
      .order('ended_at', { ascending: false })
      .limit(10),
    supabase.from('live_sessions').select('*'),
  ]);

  const runningRows = (running.data ?? []) as unknown as RunAttemptWithIssue[];
  const retryRows = (retries.data ?? []) as unknown as RetryWithIssue[];
  const failedRows = (recentFails.data ?? []) as unknown as RunAttemptWithIssue[];
  const sessionRows = sessions.data ?? [];

  const tokensByAttempt = new Map<string, number>(
    sessionRows.map((s) => [s.run_attempt_id, s.total_tokens]),
  );

  return (
    <div className="space-y-8">
      <Section title="Active runs" empty="Nothing running." rows={runningRows}>
        {runningRows.map((r) => (
          <Row key={r.id}>
            <Cell>
              <Link href={`/sessions/${r.id}`} className="text-zinc-100 hover:underline">
                {r.issues?.identifier ?? r.issue_id}
              </Link>
            </Cell>
            <Cell className="text-zinc-300">{r.issues?.title ?? '—'}</Cell>
            <Cell className="text-zinc-400">attempt {r.attempt_number}</Cell>
            <Cell className="text-zinc-400">
              {tokensByAttempt.get(r.id)?.toLocaleString() ?? 0} tok
            </Cell>
            <Cell className="text-zinc-500">{relativeTime(r.started_at)}</Cell>
          </Row>
        ))}
      </Section>

      <Section title="Retry queue" empty="No retries pending." rows={retryRows}>
        {retryRows.map((r) => (
          <Row key={r.issue_id}>
            <Cell>
              <Link href={`/issues/${r.issue_id}`} className="text-zinc-100 hover:underline">
                {r.issues?.identifier ?? r.issue_id}
              </Link>
            </Cell>
            <Cell className="text-zinc-300">{r.issues?.title ?? '—'}</Cell>
            <Cell className="text-zinc-400">attempt {r.attempt_number}</Cell>
            <Cell className="text-zinc-400">{r.error_class ?? '—'}</Cell>
            <Cell className="text-zinc-500">due {relativeTime(r.due_at)}</Cell>
          </Row>
        ))}
      </Section>

      <Section title="Recent failures" empty="No recent failures." rows={failedRows}>
        {failedRows.map((r) => (
          <Row key={r.id}>
            <Cell>
              <Link href={`/issues/${r.issue_id}`} className="text-zinc-100 hover:underline">
                {r.issues?.identifier ?? r.issue_id}
              </Link>
            </Cell>
            <Cell className="text-zinc-300">{r.issues?.title ?? '—'}</Cell>
            <Cell className="text-red-400">{r.status}</Cell>
            <Cell className="text-zinc-400">{r.error_class ?? '—'}</Cell>
            <Cell className="text-zinc-500">{relativeTime(r.ended_at)}</Cell>
          </Row>
        ))}
      </Section>
    </div>
  );
}

function Section({
  title,
  empty,
  rows,
  children,
}: {
  title: string;
  empty: string;
  rows: unknown[];
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2 className="text-sm uppercase tracking-wider text-zinc-500 mb-2">{title}</h2>
      <div className="rounded border border-zinc-800 divide-y divide-zinc-800">
        {rows.length === 0 ? (
          <div className="px-4 py-6 text-zinc-500 text-sm">{empty}</div>
        ) : (
          children
        )}
      </div>
    </section>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[140px_1fr_120px_140px_140px] gap-4 px-4 py-2 items-center text-sm">
      {children}
    </div>
  );
}

function Cell({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={className}>{children}</div>;
}

function relativeTime(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  const abs = Math.abs(ms);
  const sign = ms >= 0 ? 'ago' : 'from now';
  if (abs < 60_000) return `${Math.round(abs / 1000)}s ${sign}`;
  if (abs < 3_600_000) return `${Math.round(abs / 60_000)}m ${sign}`;
  if (abs < 86_400_000) return `${Math.round(abs / 3_600_000)}h ${sign}`;
  return `${Math.round(abs / 86_400_000)}d ${sign}`;
}
