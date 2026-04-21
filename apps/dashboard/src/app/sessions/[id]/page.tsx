import { notFound } from 'next/navigation';
import { createSupabaseServerClient } from '@/lib/supabase-server';
import type { Tables } from '@symphony/shared';
import { LiveStream } from './LiveStream';

export const dynamic = 'force-dynamic';

type AttemptWithIssue = Tables<'run_attempts'> & {
  issues: Pick<Tables<'issues'>, 'identifier' | 'title' | 'state'> | null;
};

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

  return (
    <div className="space-y-4 max-w-5xl">
      <header className="flex items-baseline justify-between">
        <div>
          <div className="text-zinc-500 text-sm">{issue?.identifier ?? attempt.issue_id}</div>
          <h1 className="text-lg font-semibold">{issue?.title ?? '—'}</h1>
          <div className="text-zinc-400 text-sm mt-1">
            attempt {attempt.attempt_number} · status:{' '}
            <span className="text-zinc-200">{attempt.status}</span>
            {attempt.error_class && (
              <>
                {' '}
                · <span className="text-red-400">{attempt.error_class}</span>
              </>
            )}
          </div>
        </div>
      </header>

      <LiveStream
        attemptId={id}
        initialEvents={initialEvents ?? []}
        initialTokens={liveSession?.total_tokens ?? 0}
        attemptIsTerminal={
          attempt.status === 'success' ||
          attempt.status === 'failure' ||
          attempt.status === 'timeout' ||
          attempt.status === 'cancelled'
        }
      />
    </div>
  );
}
