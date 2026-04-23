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

  const [running, retries, recentFails, sessions, issuesCount] = await Promise.all([
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
    supabase.from('issues').select('id', { count: 'exact', head: true }),
  ]);

  const runningRows = (running.data ?? []) as unknown as RunAttemptWithIssue[];
  const retryRows = (retries.data ?? []) as unknown as RetryWithIssue[];
  const failedRows = (recentFails.data ?? []) as unknown as RunAttemptWithIssue[];
  const sessionRows = sessions.data ?? [];

  const tokensByAttempt = new Map<string, number>(
    sessionRows.map((s) => [s.run_attempt_id, s.total_tokens]),
  );
  const liveTokens = sessionRows.reduce((sum, s) => sum + s.total_tokens, 0);
  const trackedIssues = issuesCount.count ?? 0;
  const allQuiet = runningRows.length === 0 && retryRows.length === 0;

  return (
    <>
      <header className="mb-10">
        <div className="flex items-baseline gap-3 mb-2">
          <span className="smallcaps text-[10px] text-ink-3">fleet</span>
          <span className="text-ink-4">/</span>
          <FleetStateBadge allQuiet={allQuiet} runningCount={runningRows.length} />
        </div>
        <h1 className="font-display text-[34px] leading-[1.08] text-ink-0 tracking-[-0.01em] font-medium italic">
          Command Center
        </h1>
        <div className="mt-5 grid grid-cols-2 sm:grid-cols-4 gap-x-10 gap-y-4 max-w-3xl">
          <KpiBlock
            label="active"
            value={runningRows.length.toLocaleString()}
            live={runningRows.length > 0}
          />
          <KpiBlock
            label="pending retry"
            value={retryRows.length.toLocaleString()}
            valueClass={retryRows.length > 0 ? 'text-signal' : undefined}
          />
          <KpiBlock
            label="recent fails"
            value={failedRows.length.toLocaleString()}
            valueClass={failedRows.length > 0 ? 'text-danger' : undefined}
          />
          <KpiBlock label="issues" value={trackedIssues.toLocaleString()} />
        </div>
        {liveTokens > 0 && (
          <div className="mt-3 smallcaps text-[10px] text-ink-3 inline-flex items-baseline gap-1.5">
            tokens in flight
            <span className="font-mono normal-case tracking-normal text-ink-1 tabular">
              {liveTokens.toLocaleString()}
            </span>
          </div>
        )}
      </header>

      <div className="space-y-10">
        <Section
          title="Active runs"
          count={runningRows.length}
          tone={runningRows.length > 0 ? 'live' : 'idle'}
          empty="Nothing running."
        >
          {runningRows.map((r) => (
            <RunRow
              key={r.id}
              href={`/sessions/${r.id}`}
              identifier={r.issues?.identifier ?? r.issue_id}
              title={r.issues?.title ?? '—'}
              attemptNumber={r.attempt_number}
              status={r.status}
              tokens={tokensByAttempt.get(r.id) ?? 0}
              when={relativeTime(r.started_at)}
              whenLabel="started"
            />
          ))}
        </Section>

        <Section
          title="Retry queue"
          count={retryRows.length}
          tone={retryRows.length > 0 ? 'pending' : 'idle'}
          empty="No retries pending."
        >
          {retryRows.map((r) => (
            <RetryRow
              key={r.issue_id}
              href={`/issues/${r.issue_id}`}
              identifier={r.issues?.identifier ?? r.issue_id}
              title={r.issues?.title ?? '—'}
              attemptNumber={r.attempt_number}
              errorClass={r.error_class}
              due={r.due_at}
            />
          ))}
        </Section>

        <Section
          title="Recent failures"
          count={failedRows.length}
          tone={failedRows.length > 0 ? 'fail' : 'idle'}
          empty="No recent failures."
        >
          {failedRows.map((r) => (
            <RunRow
              key={r.id}
              href={`/issues/${r.issue_id}`}
              identifier={r.issues?.identifier ?? r.issue_id}
              title={r.issues?.title ?? '—'}
              attemptNumber={r.attempt_number}
              status={r.status}
              errorClass={r.error_class}
              when={relativeTime(r.ended_at)}
              whenLabel="ended"
            />
          ))}
        </Section>
      </div>
    </>
  );
}

/* ---------- sections / rows ---------- */

function Section({
  title,
  count,
  tone,
  empty,
  children,
}: {
  title: string;
  count: number;
  tone: 'live' | 'pending' | 'fail' | 'idle';
  empty: string;
  children: React.ReactNode;
}) {
  const dot: Record<typeof tone, string> = {
    live: 'bg-success dot-live',
    pending: 'bg-signal',
    fail: 'bg-danger',
    idle: 'bg-ink-4',
  };
  return (
    <section>
      <div className="flex items-baseline gap-3 mb-3">
        <span className={`h-1.5 w-1.5 rounded-full ${dot[tone]}`} aria-hidden />
        <h2 className="smallcaps text-[11px] text-ink-2">{title}</h2>
        <span className="text-ink-4">·</span>
        <span className="font-mono text-[12px] text-ink-2 tabular">{count}</span>
      </div>
      {count === 0 ? (
        <div className="rounded border border-dashed border-hairline px-4 py-6 text-[13px] text-ink-3 italic font-display">
          {empty}
        </div>
      ) : (
        <div className="border-t border-hairline">{children}</div>
      )}
    </section>
  );
}

function RunRow({
  href,
  identifier,
  title,
  attemptNumber,
  status,
  tokens,
  errorClass,
  when,
  whenLabel,
}: {
  href: string;
  identifier: string;
  title: string;
  attemptNumber: number;
  status: string;
  tokens?: number;
  errorClass?: string | null;
  when: string;
  whenLabel: string;
}) {
  return (
    <Link
      href={href}
      className="grid grid-cols-[140px_minmax(0,1fr)_140px_140px_180px_120px] gap-4 items-center px-1 py-3 border-b border-hairline group hover:bg-surface-1 transition-colors"
    >
      <span className="font-mono text-[12px] text-ink-1 group-hover:text-ink-0 truncate">
        {identifier}
      </span>
      <span className="text-[13px] text-ink-0 truncate">{title}</span>
      <AttemptCounter n={attemptNumber} />
      <StatusBadge status={status} />
      <div className="font-mono text-[11px] text-ink-3 tabular truncate">
        {errorClass ? (
          <span className="text-danger">{errorClass}</span>
        ) : tokens !== undefined ? (
          <>
            <span className="text-ink-4">tok</span> {tokens.toLocaleString()}
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

function RetryRow({
  href,
  identifier,
  title,
  attemptNumber,
  errorClass,
  due,
}: {
  href: string;
  identifier: string;
  title: string;
  attemptNumber: number;
  errorClass: string | null;
  due: string;
}) {
  const dueMs = new Date(due).getTime() - Date.now();
  const dueSoon = dueMs < 5 * 60 * 1000;
  return (
    <Link
      href={href}
      className="grid grid-cols-[140px_minmax(0,1fr)_140px_180px_180px_120px] gap-4 items-center px-1 py-3 border-b border-hairline group hover:bg-surface-1 transition-colors"
    >
      <span className="font-mono text-[12px] text-ink-1 group-hover:text-ink-0 truncate">
        {identifier}
      </span>
      <span className="text-[13px] text-ink-0 truncate">{title}</span>
      <AttemptCounter n={attemptNumber} label="next attempt" />
      <span className="font-mono text-[11.5px] text-danger truncate">{errorClass ?? '—'}</span>
      <div className="font-mono text-[11px] tabular truncate">
        <span className="text-ink-4">due</span>{' '}
        <span className={dueSoon ? 'text-signal' : 'text-ink-2'}>{relativeTime(due)}</span>
      </div>
      <div className="text-right text-ink-4 group-hover:text-signal smallcaps text-[10px]">
        issue →
      </div>
    </Link>
  );
}

function AttemptCounter({ n, label = 'attempt' }: { n: number; label?: string }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="font-display text-[18px] tabular text-ink-0 leading-none">{n}</span>
      <span className="smallcaps text-[9px] text-ink-3">{label}</span>
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const conf: Record<string, { color: string; dot: string; label?: string }> = {
    running: { color: 'text-success', dot: 'bg-success dot-live' },
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

function FleetStateBadge({ allQuiet, runningCount }: { allQuiet: boolean; runningCount: number }) {
  if (allQuiet) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-ink-3" aria-hidden />
        <span className="smallcaps text-[10px] text-ink-2">all quiet</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="h-1.5 w-1.5 rounded-full bg-success dot-live" aria-hidden />
      <span className="smallcaps text-[10px] text-success">{runningCount} active</span>
    </span>
  );
}

function KpiBlock({
  label,
  value,
  live,
  valueClass,
}: {
  label: string;
  value: string;
  live?: boolean;
  valueClass?: string;
}) {
  return (
    <div>
      <div className="smallcaps text-[10px] text-ink-3 flex items-center gap-1.5">
        {label}
        {live && <span className="h-1 w-1 rounded-full bg-success dot-live" aria-hidden />}
      </div>
      <div
        className={`font-display text-[32px] tabular leading-none mt-1 tracking-tight ${valueClass ?? 'text-ink-0'}`}
      >
        {value}
      </div>
    </div>
  );
}

/* ---------- helpers ---------- */

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
