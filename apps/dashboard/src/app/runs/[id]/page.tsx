import {
  agentEvents,
  issues as issuesT,
  runs as runsT,
  type Tables,
  type WorkflowFrontMatter,
  workflows,
} from '@symphony/shared';
import { asc, desc, eq, getTableColumns } from 'drizzle-orm';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { db } from '@/lib/db';
import { RelativeTime } from '../../RelativeTime';
import { LiveStream } from './LiveStream';

export const dynamic = 'force-dynamic';

type RunWithIssue = Tables<'runs'> & {
  issues: Pick<Tables<'issues'>, 'identifier' | 'title' | 'state' | 'pr_urls'> | null;
};

const TERMINAL = new Set(['success', 'failure', 'timeout', 'cancelled']);

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const [rawRun, initialEvents, workflowRow] = await Promise.all([
    db
      .select({
        ...getTableColumns(runsT),
        issues: {
          identifier: issuesT.identifier,
          title: issuesT.title,
          state: issuesT.state,
          pr_urls: issuesT.pr_urls,
        },
      })
      .from(runsT)
      .leftJoin(issuesT, eq(runsT.issue_id, issuesT.id))
      .where(eq(runsT.id, id))
      .limit(1)
      .then((r) => r[0] ?? null) as Promise<RunWithIssue | null>,
    db
      .select()
      .from(agentEvents)
      .where(eq(agentEvents.run_id, id))
      .orderBy(asc(agentEvents.id))
      .limit(10000),
    db
      .select({ parsed: workflows.parsed })
      .from(workflows)
      .orderBy(desc(workflows.loaded_at))
      .limit(1)
      .then((r) => r[0] ?? null),
  ]);

  if (!rawRun) notFound();
  const run = rawRun;

  const issue = run.issues;
  const terminal = TERMINAL.has(run.status);
  const tracker = (workflowRow?.parsed as Partial<WorkflowFrontMatter> | null)?.tracker ?? null;

  return (
    <>
      <Header run={run} issue={issue} terminal={terminal} />
      <LiveStream
        runId={id}
        run={run}
        initialEvents={initialEvents}
        runIsTerminal={terminal}
        issueIdentifier={issue?.identifier ?? null}
        prUrls={issue?.pr_urls ?? []}
        tracker={tracker}
      />
    </>
  );
}

function Header({
  run,
  issue,
  terminal,
}: {
  run: RunWithIssue;
  issue: RunWithIssue['issues'];
  terminal: boolean;
}) {
  const status = run.status;
  return (
    <header className="mb-8">
      <div className="flex items-baseline gap-3 mb-2">
        <Link
          href={`/issues/${run.issue_id}`}
          className="font-mono text-[12px] text-ink-2 link-hover tracking-wide"
        >
          {issue?.identifier ?? run.issue_id}
        </Link>
        <span className="text-ink-4">/</span>
        <span className="smallcaps text-[10px] text-ink-3">
          run{' '}
          <span className="font-mono normal-case tracking-normal text-ink-1">
            #{run.run_number}
          </span>
        </span>
        <span className="text-ink-4">/</span>
        <StatusBadge status={status} />
        {run.error_class && (
          <span
            className="font-mono text-[11px] text-danger"
            title={run.error_message ?? undefined}
          >
            {run.error_class}
          </span>
        )}
      </div>
      <h1 className="font-display text-[34px] leading-[1.08] text-ink-0 tracking-[-0.01em] font-medium">
        {issue?.title ?? '—'}
      </h1>
      <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 smallcaps text-[10px] text-ink-3">
        <Stat label="started" value={<RelativeTime iso={run.started_at} />} />
        {run.ended_at && <Stat label="ended" value={<RelativeTime iso={run.ended_at} />} />}
        <Stat label="duration" value={formatDuration(run.started_at, run.ended_at)} />
        {terminal && <Stat label="state" value="terminal" valueClass="text-ink-2" />}
      </div>
    </header>
  );
}

function Stat({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: React.ReactNode;
  valueClass?: string;
}) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="text-ink-4">{label}</span>
      <span
        className={`font-mono normal-case text-[12px] tracking-normal tabular ${valueClass ?? 'text-ink-1'}`}
      >
        {value}
      </span>
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const conf: Record<string, { label: string; dot: string; text: string }> = {
    running: { label: 'running', dot: 'bg-success dot-live', text: 'text-success' },
    pending: { label: 'pending', dot: 'bg-signal', text: 'text-signal' },
    success: { label: 'success', dot: 'bg-success', text: 'text-success' },
    failure: { label: 'failure', dot: 'bg-danger', text: 'text-danger' },
    timeout: { label: 'timeout', dot: 'bg-danger', text: 'text-danger' },
    cancelled: { label: 'cancelled', dot: 'bg-ink-3', text: 'text-ink-2' },
  };
  const c = conf[status] ?? { label: status, dot: 'bg-ink-3', text: 'text-ink-2' };
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`h-1.5 w-1.5 rounded-full ${c.dot}`} aria-hidden />
      <span className={`smallcaps text-[10px] ${c.text}`}>{c.label}</span>
    </span>
  );
}

function formatDuration(start: string | null, end: string | null): string {
  if (!start) return '—';
  const endMs = end ? new Date(end).getTime() : Date.now();
  const ms = Math.max(0, endMs - new Date(start).getTime());
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}
