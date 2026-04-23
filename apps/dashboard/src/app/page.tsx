import Link from 'next/link';
import { createSupabaseServerClient } from '@/lib/supabase-server';
import type { Tables, WorkflowFrontMatter } from '@symphony/shared';
import { trackerProjectUrl } from '@symphony/shared/schema';
import { RealtimeRefresh } from './RealtimeRefresh';

export const dynamic = 'force-dynamic';

type IssueSummary = Pick<Tables<'issues'>, 'identifier' | 'title' | 'state'>;
type RunAttemptWithIssue = Tables<'run_attempts'> & { issues: IssueSummary | null };
type RetryWithIssue = Tables<'retry_queue'> & {
  issues: Pick<Tables<'issues'>, 'identifier' | 'title'> | null;
};
type AgentEventRow = Tables<'agent_events'>;
type LatestEventRow = Tables<'agent_events_latest'>;

const HEARTBEAT_STALE_MS = 15_000;

export default async function FleetPage() {
  const supabase = await createSupabaseServerClient();

  const [
    running,
    retries,
    recentFails,
    pastRuns,
    sessions,
    issuesCount,
    heartbeatRes,
    workflowRes,
  ] = await Promise.all([
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
    supabase
      .from('run_attempts')
      .select('*, issues(identifier, title)')
      .in('status', ['success', 'cancelled'])
      .order('ended_at', { ascending: false })
      .limit(20),
    supabase.from('live_sessions').select('*'),
    supabase.from('issues').select('id', { count: 'exact', head: true }),
    supabase.from('worker_heartbeat').select('*').eq('id', 'worker').maybeSingle(),
    supabase
      .from('workflows')
      .select('parsed')
      .order('loaded_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const runningRows = (running.data ?? []) as unknown as RunAttemptWithIssue[];
  const retryRows = (retries.data ?? []) as unknown as RetryWithIssue[];
  const failedRows = (recentFails.data ?? []) as unknown as RunAttemptWithIssue[];
  const pastRows = (pastRuns.data ?? []) as unknown as RunAttemptWithIssue[];
  const sessionRows = sessions.data ?? [];

  // Second-pass fetch: only look up latest-event-per-attempt when we have
  // running attempts. agent_events_latest is a DISTINCT ON view, still cheap,
  // but skipping it keeps the empty-fleet page round-trip minimal.
  const runningIds = runningRows.map((r) => r.id);
  const latestEventsRes =
    runningIds.length > 0
      ? await supabase.from('agent_events_latest').select('*').in('run_attempt_id', runningIds)
      : { data: [] as LatestEventRow[] };

  const liveTokens = sessionRows.reduce((sum, s) => sum + s.total_tokens, 0);
  const trackedIssues = issuesCount.count ?? 0;
  const allQuiet = runningRows.length === 0 && retryRows.length === 0;

  const heartbeat = heartbeatRes.data ?? null;
  const runtimeMs = heartbeat ? Date.now() - new Date(heartbeat.started_at).getTime() : null;
  const stalenessMs = heartbeat ? Date.now() - new Date(heartbeat.last_beat_at).getTime() : null;
  const workerAlive = stalenessMs !== null && stalenessMs <= HEARTBEAT_STALE_MS;

  const frontMatter = extractFrontMatter(workflowRes.data?.parsed);
  const maxConcurrent = frontMatter?.agent?.max_concurrent_agents ?? null;
  const projectUrl = frontMatter?.tracker ? trackerProjectUrl(frontMatter.tracker) : null;

  const latestEventByAttempt = new Map<string, AgentEventRow>();
  for (const row of (latestEventsRes.data ?? []) as LatestEventRow[]) {
    if (!row.run_attempt_id || row.id === null || row.kind === null) continue;
    latestEventByAttempt.set(row.run_attempt_id, {
      id: row.id,
      run_attempt_id: row.run_attempt_id,
      kind: row.kind,
      payload: row.payload ?? {},
      created_at: row.created_at ?? new Date(0).toISOString(),
    });
  }

  return (
    <>
      <RealtimeRefresh />
      <header className="mb-10">
        <div className="flex items-baseline gap-3 mb-2">
          <span className="smallcaps text-[10px] text-ink-3">fleet</span>
          <span className="text-ink-4">/</span>
          <FleetStateBadge allQuiet={allQuiet} runningCount={runningRows.length} />
        </div>
        <h1 className="font-display text-[34px] leading-[1.08] text-ink-0 tracking-[-0.01em] font-medium italic">
          Dashboard
        </h1>
        <div className="mt-5 grid grid-cols-2 sm:grid-cols-5 gap-x-10 gap-y-4 max-w-3xl">
          <KpiBlock
            label="active"
            value={
              maxConcurrent !== null
                ? `${runningRows.length}/${maxConcurrent}`
                : runningRows.length.toLocaleString()
            }
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
          <KpiBlock
            label="runtime"
            value={runtimeMs !== null ? formatDuration(runtimeMs) : '—'}
            live={workerAlive}
            valueClass={runtimeMs !== null && !workerAlive ? 'text-danger' : undefined}
          />
        </div>
        {liveTokens > 0 && (
          <div className="mt-3 smallcaps text-[10px] text-ink-3 inline-flex items-baseline gap-1.5">
            tokens in flight
            <span className="font-mono normal-case tracking-normal text-ink-1 tabular">
              {liveTokens.toLocaleString()}
            </span>
          </div>
        )}
        {projectUrl && (
          <div className="mt-3 smallcaps text-[10px] text-ink-3 inline-flex items-baseline gap-1.5">
            project
            <a
              href={projectUrl}
              target="_blank"
              rel="noreferrer"
              className="font-mono normal-case tracking-normal text-ink-1 link-hover"
            >
              {projectUrl}
            </a>
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
              pid={r.worker_pid}
              latestEvent={formatLatestEvent(latestEventByAttempt.get(r.id))}
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
            <RunRow
              key={r.issue_id}
              href={`/issues/${r.issue_id}`}
              identifier={r.issues?.identifier ?? r.issue_id}
              title={r.issues?.title ?? '—'}
              attemptNumber={r.attempt_number}
              status="queued"
              errorClass={r.error_class}
              when={relativeTime(r.due_at)}
              whenLabel="due"
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

        <Section title="Past runs" count={pastRows.length} tone="idle" empty="No past runs yet.">
          {pastRows.map((r) => (
            <RunRow
              key={r.id}
              href={`/issues/${r.issue_id}`}
              identifier={r.issues?.identifier ?? r.issue_id}
              title={r.issues?.title ?? '—'}
              attemptNumber={r.attempt_number}
              status={r.status}
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
  pid,
  latestEvent,
  errorClass,
  when,
  whenLabel,
}: {
  href: string;
  identifier: string;
  title: string;
  attemptNumber: number;
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
      <AttemptCounter n={attemptNumber} />
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

function AttemptCounter({ n }: { n: number }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="font-display text-[18px] tabular text-ink-0 leading-none">#{n}</span>
      <span className="smallcaps text-[9px] text-ink-3">attempt</span>
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

function formatLatestEvent(ev: AgentEventRow | undefined): string {
  if (!ev) return '';
  const payload = (ev.payload ?? {}) as Record<string, unknown>;
  switch (ev.kind) {
    case 'status':
      return truncate(`status: ${asString(payload.message)}`);
    case 'tool_call': {
      const tool = asString(payload.tool) || '?';
      const summary = asString(payload.result_summary);
      return truncate(summary ? `tool_call: ${tool} — ${summary}` : `tool_call: ${tool} running`);
    }
    case 'approval':
      return truncate(`approval: ${asString(payload.reason)}`);
    case 'token_count': {
      const total = typeof payload.total_tokens === 'number' ? payload.total_tokens : 0;
      return `token_count: ${total.toLocaleString()} total`;
    }
    case 'error':
      return truncate(
        `error (${asString(payload.class) || 'unknown'}): ${asString(payload.message)}`,
      );
    case 'user_input':
      return truncate(`user_input: ${asString(payload.text)}`);
    case 'humanized':
      return truncate(`humanized: ${asString(payload.summary)}`);
    case 'rate_limit':
      return truncate(
        `rate_limit: ${asString(payload.source)} remaining=${payload.remaining ?? 'n/a'}`,
      );
    default:
      return truncate(`${ev.kind}`);
  }
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function truncate(s: string, max = 70): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

/**
 * Workflow front matter is persisted as Json; pluck the subtree we care about
 * without re-validating (zod on the browser is overkill for a read-only view).
 */
function extractFrontMatter(parsed: unknown): Partial<WorkflowFrontMatter> | null {
  if (!parsed || typeof parsed !== 'object') return null;
  return parsed as Partial<WorkflowFrontMatter>;
}
