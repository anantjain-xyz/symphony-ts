import {
  issues as issuesT,
  liveSessions,
  runs as runsT,
  type Tables,
  type WorkflowFrontMatter,
  workflows,
} from '@symphony/shared';
import { desc, eq, inArray } from 'drizzle-orm';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { IssueLinks } from '@/components/IssueLinks';
import { db } from '@/lib/db';
import { RelativeTime } from '../../RelativeTime';

export const dynamic = 'force-dynamic';

type Issue = Tables<'issues'>;
type Run = Tables<'runs'>;

const TERMINAL = new Set(['success', 'failure', 'timeout', 'cancelled']);

export default async function IssuePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [issueRaw] = await db.select().from(issuesT).where(eq(issuesT.id, id)).limit(1);
  if (!issueRaw) notFound();
  const issue = issueRaw as Issue;

  const runRows = (await db
    .select()
    .from(runsT)
    .where(eq(runsT.issue_id, id))
    .orderBy(desc(runsT.run_number))) as Run[];

  const runIds = runRows.map((r) => r.id);
  const sessions =
    runIds.length > 0
      ? await db
          .select({ run_id: liveSessions.run_id, total_tokens: liveSessions.total_tokens })
          .from(liveSessions)
          .where(inArray(liveSessions.run_id, runIds))
      : [];

  const workflowRow = await db
    .select({ parsed: workflows.parsed })
    .from(workflows)
    .orderBy(desc(workflows.loaded_at))
    .limit(1)
    .then((r) => r[0] ?? null);

  const tracker = (workflowRow?.parsed as Partial<WorkflowFrontMatter> | null)?.tracker ?? null;

  const tokensByRun = new Map<string, number>(sessions.map((s) => [s.run_id, s.total_tokens]));

  const counts = countByStatus(runRows);
  const lastRun = runRows[0];
  const totalTokens = [...tokensByRun.values()].reduce((a, b) => a + b, 0);

  return (
    <>
      <Header issue={issue} lastRun={lastRun} />

      <div className="grid grid-cols-1 lg:grid-cols-[220px_minmax(0,1fr)] gap-6">
        {/* Left rail — issue telemetry */}
        <aside className="lg:sticky lg:top-4 lg:self-start space-y-5">
          <Telemetry label="runs" value={runRows.length.toString()} />
          {counts.success > 0 && (
            <Telemetry
              label="success"
              value={counts.success.toString()}
              valueClass="text-success"
            />
          )}
          {counts.failure + counts.timeout > 0 && (
            <Telemetry
              label="failed"
              value={(counts.failure + counts.timeout).toString()}
              valueClass="text-danger"
            />
          )}
          {totalTokens > 0 && (
            <Telemetry label="tokens spent" value={totalTokens.toLocaleString()} />
          )}
          {issue.branch && (
            <div>
              <div className="smallcaps text-[10px] text-ink-3 mb-1">branch</div>
              <div
                className="font-mono text-[11px] text-ink-1 leading-snug"
                style={{ wordBreak: 'break-word', overflowWrap: 'anywhere' }}
                title={issue.branch}
              >
                {issue.branch}
              </div>
            </div>
          )}
          {issue.labels.length > 0 && (
            <div>
              <div className="smallcaps text-[10px] text-ink-3 mb-1">labels</div>
              <div className="flex flex-wrap gap-1">
                {issue.labels.map((l) => (
                  <span
                    key={l}
                    className="font-mono text-[10.5px] text-ink-1 border border-hairline rounded px-1.5 py-0.5"
                  >
                    {l}
                  </span>
                ))}
              </div>
            </div>
          )}
          {issue.blockers.length > 0 && (
            <div>
              <div className="smallcaps text-[10px] text-signal mb-1">blocked by</div>
              <div className="flex flex-wrap gap-1">
                {issue.blockers.map((b) => (
                  <span
                    key={b}
                    className="font-mono text-[10.5px] text-signal border border-signal/40 rounded px-1.5 py-0.5"
                  >
                    {b}
                  </span>
                ))}
              </div>
            </div>
          )}
          <IssueLinks identifier={issue.identifier} prUrls={issue.pr_urls} tracker={tracker} />
        </aside>

        {/* Center — description + runs */}
        <section className="min-w-0 space-y-8">
          {issue.description && (
            <div>
              <div className="smallcaps text-[10px] text-ink-3 mb-2">description</div>
              <div className="text-[14px] text-ink-0 leading-[1.65]">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={descriptionMarkdown}>
                  {issue.description}
                </ReactMarkdown>
              </div>
            </div>
          )}

          <div>
            <div className="smallcaps text-[10px] text-ink-3 mb-3 flex items-center gap-2">
              runs
              <span className="text-ink-4">·</span>
              <span className="font-mono normal-case tracking-normal text-ink-1">
                {runRows.length}
              </span>
            </div>
            {runRows.length === 0 ? (
              <EmptyRuns />
            ) : (
              <ol className="space-y-2">
                {runRows.map((a) => (
                  <li key={a.id}>
                    <RunCard run={a} tokens={tokensByRun.get(a.id) ?? 0} />
                  </li>
                ))}
              </ol>
            )}
          </div>
        </section>
      </div>
    </>
  );
}

function Header({ issue, lastRun }: { issue: Issue; lastRun: Run | undefined }) {
  return (
    <header className="mb-8">
      <div className="flex items-baseline gap-3 mb-2">
        <span className="font-mono text-[12px] text-ink-2 tracking-wide">{issue.identifier}</span>
        <span className="text-ink-4">/</span>
        <IssueStateBadge state={issue.state} />
        {issue.priority > 0 && (
          <span className="smallcaps text-[10px] text-ink-3">
            priority{' '}
            <span className="font-mono normal-case tracking-normal text-ink-1">
              {issue.priority}
            </span>
          </span>
        )}
      </div>
      <h1 className="font-display text-[34px] leading-[1.08] text-ink-0 tracking-[-0.01em] font-medium">
        {issue.title}
      </h1>
      <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 smallcaps text-[10px] text-ink-3">
        <Stat label="last seen" value={<RelativeTime iso={issue.last_seen_at} />} />
        {lastRun && (
          <>
            <Stat label="latest" value={`#${lastRun.run_number} · ${lastRun.status}`} />
            <Stat label="started" value={<RelativeTime iso={lastRun.started_at} />} />
            {lastRun.ended_at && (
              <Stat label="duration" value={formatDuration(lastRun.started_at, lastRun.ended_at)} />
            )}
          </>
        )}
      </div>
    </header>
  );
}

function RunCard({ run, tokens }: { run: Run; tokens: number }) {
  const terminal = TERMINAL.has(run.status);
  const duration = run.started_at
    ? formatDuration(
        run.started_at,
        run.ended_at ?? (terminal ? run.started_at : new Date().toISOString()),
      )
    : null;

  return (
    <Link
      href={`/runs/${run.id}`}
      className="block group rounded border border-hairline bg-surface-1 hover:border-hairline-strong hover:bg-surface-2 transition-colors"
    >
      <div className="grid grid-cols-[88px_180px_minmax(0,1fr)_auto] gap-4 px-4 py-3 items-center">
        <div className="flex items-baseline gap-2">
          <span className="font-display text-[22px] tabular text-ink-0 leading-none">
            {run.run_number}
          </span>
          <span className="smallcaps text-[9px] text-ink-3">run</span>
        </div>
        <div>
          <RunStatusBadge status={run.status} />
          {run.error_class && (
            <div className="font-mono text-[10.5px] text-danger mt-1 truncate">
              {run.error_class}
            </div>
          )}
        </div>
        <div className="min-w-0">
          {run.error_message ? (
            <div className="text-[12.5px] text-ink-1 truncate">{run.error_message}</div>
          ) : (
            <div className="text-[12.5px] text-ink-3 italic">
              {run.status === 'success' ? 'Completed without error.' : '—'}
            </div>
          )}
          <div className="mt-1 flex items-center gap-3 font-mono text-[10.5px] text-ink-3 tabular">
            {duration && (
              <span>
                <span className="text-ink-4">dur</span> {duration}
              </span>
            )}
            {tokens > 0 && (
              <span>
                <span className="text-ink-4">tok</span> {tokens.toLocaleString()}
              </span>
            )}
            {run.started_at && <RelativeTime className="text-ink-3" iso={run.started_at} />}
          </div>
        </div>
        <span className="smallcaps text-[10px] text-ink-3 group-hover:text-signal pr-1">run →</span>
      </div>
    </Link>
  );
}

/* ---------- markdown ---------- */

const descriptionMarkdown: Components = {
  p: ({ children }) => <p className="my-3 first:mt-0 last:mb-0">{children}</p>,
  a: ({ children, href }) => (
    <a
      href={href}
      className="text-info underline decoration-info/40 underline-offset-2 hover:decoration-info"
      target="_blank"
      rel="noreferrer"
    >
      {children}
    </a>
  ),
  strong: ({ children }) => <strong className="font-semibold text-ink-0">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  code: ({ className, children }) => {
    if (className?.startsWith('language-')) {
      return <code className="font-mono text-[12.5px] text-ink-1 whitespace-pre">{children}</code>;
    }
    return (
      <code className="font-mono text-[0.86em] text-ink-0 bg-surface-2 rounded px-1 py-px">
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre className="my-4 overflow-x-auto rounded border border-hairline bg-surface-1 p-3 leading-[1.55]">
      {children}
    </pre>
  ),
  ul: ({ children }) => (
    <ul className="my-3 ml-5 list-disc space-y-1 marker:text-ink-3">{children}</ul>
  ),
  ol: ({ children, start }) => (
    <ol start={start} className="my-3 ml-5 list-decimal space-y-1 marker:text-ink-3">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="pl-1">{children}</li>,
  h1: ({ children }) => (
    <h1 className="font-display text-[20px] leading-[1.25] text-ink-0 tracking-[-0.005em] mt-6 mb-3 first:mt-0">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="font-display text-[17px] leading-[1.3] text-ink-0 tracking-[-0.005em] mt-6 mb-2 first:mt-0">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="text-[14px] font-semibold uppercase tracking-[0.08em] text-ink-1 mt-5 mb-2 first:mt-0">
      {children}
    </h3>
  ),
  h4: ({ children }) => (
    <h4 className="text-[13px] font-semibold text-ink-1 mt-4 mb-1.5 first:mt-0">{children}</h4>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-3 border-l-2 border-hairline-strong pl-3 text-ink-2 italic">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-5 border-hairline" />,
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto rounded border border-hairline">
      <table className="w-full text-[13px] border-collapse">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-surface-2">{children}</thead>,
  th: ({ children, style }) => (
    <th
      style={style}
      className="border-b border-hairline px-3 py-1.5 text-left text-ink-1 font-semibold"
    >
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td style={style} className="border-b border-hairline px-3 py-1.5 text-ink-0 last:border-b-0">
      {children}
    </td>
  ),
  input: ({ type, checked, disabled }) =>
    type === 'checkbox' ? (
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        readOnly
        className="mr-2 align-middle accent-signal"
      />
    ) : null,
  img: ({ src, alt }) =>
    typeof src === 'string' ? (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={src} alt={alt ?? ''} className="my-3 max-w-full rounded border border-hairline" />
    ) : null,
};

/* ---------- atoms ---------- */

function IssueStateBadge({ state }: { state: string }) {
  const norm = state.toLowerCase();
  const conf = norm.includes('progress')
    ? { color: 'text-info', dot: 'bg-info dot-live' }
    : norm.includes('review')
      ? { color: 'text-think', dot: 'bg-think' }
      : norm.includes('done') || norm.includes('complete')
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

function RunStatusBadge({ status }: { status: string }) {
  const conf: Record<string, { color: string; dot: string }> = {
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
      <span className={`smallcaps text-[10px] ${c.color}`}>{status}</span>
    </span>
  );
}

function Telemetry({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div>
      <div className="smallcaps text-[10px] text-ink-3">{label}</div>
      <div
        className={`font-display text-[26px] tracking-tight tabular leading-none mt-1 ${valueClass ?? 'text-ink-0'}`}
      >
        {value}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="text-ink-4">{label}</span>
      <span className="font-mono normal-case text-[12px] tracking-normal tabular text-ink-1">
        {value}
      </span>
    </span>
  );
}

function EmptyRuns() {
  return (
    <div className="rounded border border-dashed border-hairline px-4 py-8 text-[13px] text-ink-3 italic font-display">
      No runs for this issue yet.
    </div>
  );
}

function countByStatus(runs: Run[]) {
  const c = { success: 0, failure: 0, timeout: 0, cancelled: 0, running: 0, pending: 0 };
  for (const a of runs) {
    const k = a.status as keyof typeof c;
    if (k in c) c[k]++;
  }
  return c;
}

function formatDuration(start: string | null, end: string | null): string {
  if (!start || !end) return '—';
  const ms = Math.max(0, new Date(end).getTime() - new Date(start).getTime());
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}
