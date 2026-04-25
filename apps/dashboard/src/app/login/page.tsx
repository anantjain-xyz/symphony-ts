type Search = { sent?: string; error?: string; next?: string };

export const dynamic = 'force-dynamic';

export default async function LoginPage({ searchParams }: { searchParams: Promise<Search> }) {
  const params = await searchParams;
  const sent = params.sent === '1';
  const errored = params.error === '1';
  const next = typeof params.next === 'string' ? params.next : '';

  return (
    <div className="min-h-[60vh] flex items-start justify-center pt-16">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-baseline gap-3">
          <span className="smallcaps text-[10px] text-ink-3">access</span>
          <span className="text-ink-4">/</span>
          <span className="smallcaps text-[10px] text-ink-2">operator login</span>
        </div>
        <h1 className="font-display text-[28px] leading-[1.1] text-ink-0 tracking-[-0.01em] font-medium mb-2">
          Sign in
        </h1>
        <p className="text-[13px] text-ink-3 leading-relaxed mb-6">
          Enter your operator email. A magic link will be sent to your terminal — check the
          dashboard server&apos;s stdout for the URL.
        </p>

        {sent && (
          <div className="mb-4 rounded border border-hairline bg-surface-1 px-3 py-2 text-[12.5px] text-ink-1">
            <span className="smallcaps text-[10px] text-success">link issued</span>
            <span className="block mt-1 text-ink-2">
              If the email is on the operator allowlist, a magic link has been printed to the
              dashboard server console. Open it within 15 minutes.
            </span>
          </div>
        )}

        {errored && (
          <div className="mb-4 rounded border border-danger/40 bg-danger/5 px-3 py-2 text-[12.5px] text-danger">
            <span className="smallcaps text-[10px]">denied</span>
            <span className="block mt-1">That magic link is invalid or expired.</span>
          </div>
        )}

        <form method="post" action="/api/auth/login" className="space-y-3">
          {next && <input type="hidden" name="next" value={next} />}
          <label className="block">
            <span className="smallcaps text-[10px] text-ink-3">email</span>
            <input
              type="email"
              name="email"
              required
              autoFocus
              autoComplete="email"
              spellCheck={false}
              placeholder="you@example.com"
              className="mt-1 w-full bg-surface-1 border border-hairline rounded px-3 py-2 font-mono text-[13px] text-ink-0 placeholder:text-ink-4 outline-none focus:border-hairline-strong"
            />
          </label>
          <button
            type="submit"
            className="w-full rounded border border-hairline bg-surface-2 hover:bg-surface-1 px-3 py-2 smallcaps text-[11px] text-ink-0 transition-colors"
          >
            request magic link →
          </button>
        </form>
      </div>
    </div>
  );
}
