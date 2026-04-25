/**
 * Validate a `?next=…` redirect target against open-redirect attacks. The
 * surface looks small ("must start with /") but the URL parser is permissive:
 *   - `//evil.com`      → protocol-relative, off-origin
 *   - `/\\evil.com`     → backslash gets normalized to `/`, off-origin
 *   - `https://evil.com` → obvious off-origin
 *   - `/foo bar?x=1`    → fine, but tricky non-ASCII can confuse downstream
 *
 * We resolve the candidate against the request URL and require the resulting
 * origin to match. On any failure we fall back to `/`. The returned string is
 * always a same-origin path (path + search + hash) so callers can hand it to
 * `new URL(safe, req.url)` without re-checking.
 */
export function safeNextPath(input: string | null | undefined, requestUrl: string): string {
  if (!input || typeof input !== 'string') return '/';
  if (!input.startsWith('/') || input.includes('\\')) return '/';
  try {
    const base = new URL(requestUrl);
    const target = new URL(input, base);
    if (target.origin !== base.origin) return '/';
    const path = target.pathname + target.search + target.hash;
    return path.startsWith('/') ? path : '/';
  } catch {
    return '/';
  }
}
