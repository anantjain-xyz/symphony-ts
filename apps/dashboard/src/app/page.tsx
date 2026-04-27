import {
  agentEventsLatest,
  issues as issuesT,
  liveSessions,
  rateLimitState,
  retryQueue,
  runs,
  type Tables,
  type WorkflowFrontMatter,
  workerHeartbeat,
  workflows,
} from '@symphony/shared';
import { trackerProjectUrl } from '@symphony/shared/schema';
import { and, desc, eq, getTableColumns, gt, inArray, like, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { KpiBlock } from './KpiBlock';
import { LiveRuntime } from './LiveRuntime';
import { RateLimitPauseKpi } from './RateLimitPauseKpi';
import { RealtimeRefresh } from './RealtimeRefresh';
import { RunRow, relativeTime } from './RunRow';

export const dynamic = 'force-dynamic';

type IssueSummary = Pick<Tables<'issues'>, 'identifier' | 'title' | 'state'>;
type RunWithIssue = Tables<'runs'> & { issues: IssueSummary | null };
type RetryWithIssue = Tables<'retry_queue'> & {
  issues: Pick<Tables<'issues'>, 'identifier' | 'title'> | null;
};
type AgentEventRow = Tables<'agent_events'>;
type LatestEventRow = Tables<'agent_events_latest'>;

export default async function FleetPage() {
  const [running, retries, recentFails, liveTokens, issuesCountRow, heartbeat, workflowRow] =
    await Promise.all([
      db
        .select({
          ...getTableColumns(runs),
          issues: {
            identifier: issuesT.identifier,
            title: issuesT.title,
            state: issuesT.state,
          },
        })
        .from(runs)
        .leftJoin(issuesT, eq(runs.issue_id, issuesT.id))
        .where(eq(runs.status, 'running'))
        .orderBy(desc(runs.started_at)) as Promise<RunWithIssue[]>,
      db
        .select({
          ...getTableColumns(retryQueue),
          issues: {
            identifier: issuesT.identifier,
            title: issuesT.title,
          },
        })
        .from(retryQueue)
        .leftJoin(issuesT, eq(retryQueue.issue_id, issuesT.id))
        .orderBy(retryQueue.due_at)
        .limit(20) as Promise<RetryWithIssue[]>,
      db
        .select({
          ...getTableColumns(runs),
          issues: {
            identifier: issuesT.identifier,
            title: issuesT.title,
            state: issuesT.state,
          },
        })
        .from(runs)
        .leftJoin(issuesT, eq(runs.issue_id, issuesT.id))
        .where(inArray(runs.status, ['failure', 'timeout']))
        .orderBy(desc(runs.ended_at))
        .limit(10) as Promise<RunWithIssue[]>,
      db.select().from(liveSessions),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(issuesT)
        .then((r) => r[0]),
      db
        .select()
        .from(workerHeartbeat)
        .where(eq(workerHeartbeat.id, 'worker'))
        .limit(1)
        .then((r) => r[0] ?? null),
      db
        .select({ parsed: workflows.parsed })
        .from(workflows)
        .orderBy(desc(workflows.loaded_at))
        .limit(1)
        .then((r) => r[0] ?? null),
    ]);

  const runningRows = running;
  const retryRows = retries;
  const failedRows = recentFails;
  const liveTokenRows = liveTokens;

  const runningIds = runningRows.map((r) => r.id);
  const latestEvents: LatestEventRow[] =
    runningIds.length > 0
      ? await db
          .select()
          .from(agentEventsLatest)
          .where(inArray(agentEventsLatest.run_id, runningIds))
      : [];

  const liveTokenTotal = liveTokenRows.reduce((sum, s) => sum + s.total_tokens, 0);
  const trackedIssues = issuesCountRow?.count ?? 0;
  const allQuiet = runningRows.length === 0 && retryRows.length === 0;

  const frontMatter = extractFrontMatter(workflowRow?.parsed);
  const configuredBackend = frontMatter?.agent?.backend ?? 'codex';
  const maxConcurrent = frontMatter?.agent?.max_concurrent_agents ?? null;
  const projectUrl = frontMatter?.tracker ? trackerProjectUrl(frontMatter.tracker) : null;
  const rateLimitNowIso = new Date().toISOString();
  const ratePause =
    (
      await db
        .select()
        .from(rateLimitState)
        .where(
          and(
            gt(rateLimitState.reset_at, rateLimitNowIso),
            like(rateLimitState.source, `${configuredBackend}_%`),
          ),
        )
        .orderBy(desc(rateLimitState.reset_at))
        .limit(1)
    )[0] ?? null;

  const latestEventByRun = new Map<string, AgentEventRow>();
  for (const row of latestEvents) {
    if (!row.run_id || row.id === null || row.kind === null) continue;
    latestEventByRun.set(row.run_id, {
      id: row.id,
      run_id: row.run_id,
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
        <h1 className="font-display text-[34px] leading-[1.08] text-ink-0 tracking-[-0.01em] font-medium">
          Dashboard
        </h1>
        <div className="mt-5 grid grid-cols-2 sm:grid-cols-5 gap-x-10 gap-y-4 max-w-3xl">
          {ratePause ? (
            <RateLimitPauseKpi source={ratePause.source} resetAt={ratePause.reset_at} />
          ) : (
            <KpiBlock
              label="active"
              value={
                maxConcurrent !== null
                  ? `${runningRows.length}/${maxConcurrent}`
                  : runningRows.length.toLocaleString()
              }
              live={runningRows.length > 0}
            />
          )}
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
          <LiveRuntime
            startedAt={heartbeat?.started_at ?? null}
            lastBeatAt={heartbeat?.last_beat_at ?? null}
          />
        </div>
        {liveTokenTotal > 0 && (
          <div className="mt-3 smallcaps text-[10px] text-ink-3 inline-flex items-baseline gap-1.5">
            tokens in flight
            <span className="font-mono normal-case tracking-normal text-ink-1 tabular">
              {liveTokenTotal.toLocaleString()}
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
              href={`/runs/${r.id}`}
              identifier={r.issues?.identifier ?? r.issue_id}
              title={r.issues?.title ?? '—'}
              runNumber={r.run_number}
              status={r.status}
              pid={r.worker_pid}
              latestEvent={formatLatestEvent(latestEventByRun.get(r.id))}
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
              runNumber={r.run_number}
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
              href={`/runs/${r.id}`}
              identifier={r.issues?.identifier ?? r.issue_id}
              title={r.issues?.title ?? '—'}
              runNumber={r.run_number}
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

/* ---------- helpers ---------- */

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
      return truncate(asString(payload.summary));
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
