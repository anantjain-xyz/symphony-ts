import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createSupabaseServerClient } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';

export default async function IssuePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();
  const { data: issue } = await supabase.from('issues').select('*').eq('id', id).maybeSingle();
  if (!issue) notFound();
  const { data: attempts } = await supabase
    .from('run_attempts')
    .select('*')
    .eq('issue_id', id)
    .order('attempt_number', { ascending: false });

  return (
    <div className="space-y-6 max-w-4xl">
      <header>
        <div className="text-zinc-500 text-sm">{issue.identifier}</div>
        <h1 className="text-xl font-semibold">{issue.title}</h1>
        <div className="text-zinc-400 text-sm mt-1">
          state: <span className="text-zinc-200">{issue.state}</span>
          {' · '}priority: <span className="text-zinc-200">{issue.priority}</span>
          {issue.blockers.length > 0 && (
            <>
              {' · '}blocked by: <span className="text-amber-300">{issue.blockers.join(', ')}</span>
            </>
          )}
        </div>
      </header>

      <section>
        <h2 className="text-sm uppercase tracking-wider text-zinc-500 mb-2">Attempts</h2>
        <div className="rounded border border-zinc-800 divide-y divide-zinc-800">
          {(attempts ?? []).length === 0 ? (
            <div className="px-4 py-6 text-zinc-500 text-sm">No attempts yet.</div>
          ) : (
            (attempts ?? []).map((a) => (
              <div
                key={a.id}
                className="grid grid-cols-[100px_120px_1fr_180px] gap-4 px-4 py-2 items-center text-sm"
              >
                <div className="text-zinc-300">attempt {a.attempt_number}</div>
                <div className={statusColor(a.status)}>{a.status}</div>
                <div className="text-zinc-400 truncate">{a.error_message ?? '—'}</div>
                <div className="text-zinc-500 text-right">
                  <Link href={`/sessions/${a.id}`} className="hover:underline">
                    events →
                  </Link>
                </div>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}

function statusColor(status: string): string {
  switch (status) {
    case 'success':
      return 'text-emerald-400';
    case 'failure':
    case 'timeout':
      return 'text-red-400';
    case 'cancelled':
      return 'text-zinc-400';
    case 'running':
      return 'text-blue-400';
    default:
      return 'text-zinc-300';
  }
}
