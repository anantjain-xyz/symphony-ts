// Stringify an `unknown` thrown value for logs and error fields. Without this,
// non-Error throws fall through to `String(err)` and render plain objects as
// the useless literal "[object Object]".
export function formatError(err: unknown, opts?: { includeStack?: boolean }): string {
  if (err instanceof Error) {
    if (opts?.includeStack && err.stack) return err.stack;
    return err.message;
  }
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const maybeMsg = (err as { message?: unknown }).message;
    if (typeof maybeMsg === 'string' && maybeMsg.length > 0) return maybeMsg;
    try {
      return JSON.stringify(err);
    } catch {
      return Object.prototype.toString.call(err);
    }
  }
  return String(err);
}
