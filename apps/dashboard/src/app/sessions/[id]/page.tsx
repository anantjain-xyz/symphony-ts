import { notFound } from 'next/navigation';
import Link from 'next/link';
import { createSupabaseServerClient } from '@/lib/supabase-server';
import type { Tables } from '@symphony/shared';
import { LiveStream } from './LiveStream';

export const dynamic = 'force-dynamic';

type AttemptWithIssue = Tables<'run_attempts'> & {
  issues: Pick<Tables<'issues'>, 'identifier' | 'title' | 'state'> | null;
};

const TERMINAL = new Set(['success', 'failure', 'timeout', 'cancelled']);

export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();
  const { data: rawAttempt } = await supabase
    .from('run_attempts')
    .select('*, issues(identifier, title, state)')
    .eq('id', id)
    .maybeSingle();
  if (!rawAttempt) notFound();
  const attempt = rawAttempt as unknown as AttemptWithIssue;

  const { data: initialEvents } = await supabase
    .from('agent_events')
    .select('*')
    .eq('run_attempt_id', id)
    .order('id', { ascending: true })
    .limit(500);

  const { data: liveSession } = await supabase
    .from('live_sessions')
    .select('*')
    .eq('run_attempt_id', id)
    .maybeSingle();

  const issue = attempt.issues;
  const terminal = TERMINAL.has(attempt.status);

  return (
    <>
      <Header attempt={attempt} issue={issue} terminal={terminal} />
      <LiveStream
        attemptId={id}
        attempt={attempt}
        initialEvents={initialEvents ?? []}
        initialTokens={liveSession?.total_tokens ?? 0}
        attemptIsTerminal={terminal}
      />
    </>
  );
}

function Header({
  attempt,
  issue,
  terminal,
}: {
  attempt: AttemptWithIssue;
  issue: AttemptWithIssue['issues'];
  terminal: boolean;
}) {
  const status = attempt.status;
  return (
    <header className="mb-8">
      <div className="flex items-baseline gap-3 mb-2">
        <Link
          href={`/issues/${attempt.issue_id}`}
          className="font-mono text-[12px] text-ink-2 link-hover tracking-wide"
        >
          {issue?.identifier ?? attempt.issue_id}
        </Link>
        <span className="text-ink-4">/</span>
        <StatusBadge status={status} />
        {attempt.error_class && (
          <span
            className="font-mono text-[11px] text-danger"
            title={attempt.error_message ?? undefined}
          >
            {attempt.error_class}
          </span>
        )}
      </div>
      <h1 className="font-display text-[34px] leading-[1.08] text-ink-0 tracking-[-0.01em] font-medium">
        {issue?.title ?? '—'}
      </h1>
      <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 smallcaps text-[10px] text-ink-3">
        <Stat label="attempt" value={`${attempt.attempt_number}`} />
        <Stat label="started" value={formatRelative(attempt.started_at)} />
        {attempt.ended_at && <Stat label="ended" value={formatRelative(attempt.ended_at)} />}
        <Stat label="duration" value={formatDuration(attempt.started_at, attempt.ended_at)} />
        {terminal && <Stat label="state" value="terminal" valueClass="text-ink-2" />}
      </div>
    </header>
  );
}

function Stat({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
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

function formatRelative(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  const abs = Math.abs(ms);
  const sign = ms >= 0 ? 'ago' : 'from now';
  if (abs < 60_000) return `${Math.round(abs / 1000)}s ${sign}`;
  if (abs < 3_600_000) return `${Math.round(abs / 60_000)}m ${sign}`;
  if (abs < 86_400_000) return `${Math.round(abs / 3_600_000)}h ${sign}`;
  return `${Math.round(abs / 86_400_000)}d ${sign}`;
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
