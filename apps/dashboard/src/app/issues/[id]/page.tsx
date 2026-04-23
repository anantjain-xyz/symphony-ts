import Link from 'next/link';
import { notFound } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { createSupabaseServerClient } from '@/lib/supabase-server';
import type { Tables } from '@symphony/shared';

export const dynamic = 'force-dynamic';

type Issue = Tables<'issues'>;
type Attempt = Tables<'run_attempts'>;

const TERMINAL = new Set(['success', 'failure', 'timeout', 'cancelled']);

export default async function IssuePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();
  const { data: issueRaw } = await supabase.from('issues').select('*').eq('id', id).maybeSingle();
  if (!issueRaw) notFound();
  const issue = issueRaw as Issue;

  const [{ data: attempts }, { data: sessions }] = await Promise.all([
    supabase
      .from('run_attempts')
      .select('*')
      .eq('issue_id', id)
      .order('attempt_number', { ascending: false }),
    supabase
      .from('live_sessions')
      .select('run_attempt_id, total_tokens')
      .in(
        'run_attempt_id',
        ((await supabase.from('run_attempts').select('id').eq('issue_id', id)).data ?? []).map(
          (r) => r.id,
        ),
      ),
  ]);

  const attemptRows = (attempts ?? []) as Attempt[];
  const tokensByAttempt = new Map<string, number>(
    (sessions ?? []).map((s) => [s.run_attempt_id, s.total_tokens]),
  );

  const counts = countByStatus(attemptRows);
  const lastAttempt = attemptRows[0];
  const totalTokens = [...tokensByAttempt.values()].reduce((a, b) => a + b, 0);

  return (
    <>
      <Header issue={issue} lastAttempt={lastAttempt} />

      <div className="grid grid-cols-1 lg:grid-cols-[220px_minmax(0,1fr)] gap-6">
        {/* Left rail — issue telemetry */}
        <aside className="lg:sticky lg:top-4 lg:self-start space-y-5">
          <Telemetry label="attempts" value={attemptRows.length.toString()} />
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
        </aside>

        {/* Center — description + attempts */}
        <section className="min-w-0 space-y-8">
          {issue.description && (
            <div>
              <div className="smallcaps text-[10px] text-ink-3 mb-2">description</div>
              <div className="text-[14px] text-ink-0 leading-[1.65] prose-tight">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{issue.description}</ReactMarkdown>
              </div>
            </div>
          )}

          <div>
            <div className="smallcaps text-[10px] text-ink-3 mb-3 flex items-center gap-2">
              attempts
              <span className="text-ink-4">·</span>
              <span className="font-mono normal-case tracking-normal text-ink-1">
                {attemptRows.length}
              </span>
            </div>
            {attemptRows.length === 0 ? (
              <EmptyAttempts />
            ) : (
              <ol className="space-y-2">
                {attemptRows.map((a) => (
                  <li key={a.id}>
                    <AttemptCard attempt={a} tokens={tokensByAttempt.get(a.id) ?? 0} />
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

function Header({
  issue,
  lastAttempt,
}: {
  issue: Issue;
  lastAttempt: Attempt | undefined;
}) {
  return (
    <header className="-mx-8 px-8 mb-6 pb-5 border-b border-hairline">
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
        <Stat label="last seen" value={formatRelative(issue.last_seen_at)} />
        {lastAttempt && (
          <>
            <Stat
              label="latest"
              value={`#${lastAttempt.attempt_number} · ${lastAttempt.status}`}
            />
            <Stat label="started" value={formatRelative(lastAttempt.started_at)} />
            {lastAttempt.ended_at && (
              <Stat label="duration" value={formatDuration(lastAttempt.started_at, lastAttempt.ended_at)} />
            )}
          </>
        )}
      </div>
    </header>
  );
}

function AttemptCard({ attempt, tokens }: { attempt: Attempt; tokens: number }) {
  const terminal = TERMINAL.has(attempt.status);
  const duration = attempt.started_at
    ? formatDuration(
        attempt.started_at,
        attempt.ended_at ?? (terminal ? attempt.started_at : new Date().toISOString()),
      )
    : null;

  return (
    <Link
      href={`/sessions/${attempt.id}`}
      className="block group rounded border border-hairline bg-surface-1 hover:border-hairline-strong hover:bg-surface-2 transition-colors"
    >
      <div className="grid grid-cols-[88px_180px_minmax(0,1fr)_auto] gap-4 px-4 py-3 items-center">
        <div className="flex items-baseline gap-2">
          <span className="font-display text-[22px] tabular text-ink-0 leading-none">
            {attempt.attempt_number}
          </span>
          <span className="smallcaps text-[9px] text-ink-3">attempt</span>
        </div>
        <div>
          <AttemptStatusBadge status={attempt.status} />
          {attempt.error_class && (
            <div className="font-mono text-[10.5px] text-danger mt-1 truncate">
              {attempt.error_class}
            </div>
          )}
        </div>
        <div className="min-w-0">
          {attempt.error_message ? (
            <div className="text-[12.5px] text-ink-1 truncate">{attempt.error_message}</div>
          ) : (
            <div className="text-[12.5px] text-ink-3 italic">
              {attempt.status === 'success' ? 'Completed without error.' : '—'}
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
            {attempt.started_at && (
              <span className="text-ink-3">{formatRelative(attempt.started_at)}</span>
            )}
          </div>
        </div>
        <span className="smallcaps text-[10px] text-ink-3 group-hover:text-signal pr-1">
          session →
        </span>
      </div>
    </Link>
  );
}

/* ---------- atoms ---------- */

function IssueStateBadge({ state }: { state: string }) {
  // Linear states are free-form strings; map common ones.
  const norm = state.toLowerCase();
  const conf =
    norm.includes('progress')
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

function AttemptStatusBadge({ status }: { status: string }) {
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

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="text-ink-4">{label}</span>
      <span className="font-mono normal-case text-[12px] tracking-normal tabular text-ink-1">
        {value}
      </span>
    </span>
  );
}

function EmptyAttempts() {
  return (
    <div className="rounded border border-dashed border-hairline px-4 py-8 text-[13px] text-ink-3 italic font-display">
      No attempts have run for this issue yet.
    </div>
  );
}

function countByStatus(attempts: Attempt[]) {
  const c = { success: 0, failure: 0, timeout: 0, cancelled: 0, running: 0, pending: 0 };
  for (const a of attempts) {
    const k = a.status as keyof typeof c;
    if (k in c) c[k]++;
  }
  return c;
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
  if (!start || !end) return '—';
  const ms = Math.max(0, new Date(end).getTime() - new Date(start).getTime());
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}
