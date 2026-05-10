import { formatError } from '@symphony/shared';
import type { Logger } from 'pino';

/**
 * Run `promise` and log a warning if it rejects, but never re-throw. The single
 * named pattern for cleanup writes whose failure must not propagate — most
 * commonly DB cleanup-after-failure paths like `repo.deleteLiveSession(...)`
 * inside a `catch` that is already reporting a primary error.
 *
 * Use this instead of inlining `.catch(() => {})` so every cleanup site logs
 * with the same shape and there is one place to change the policy.
 *
 * @param promise  the cleanup work
 * @param log      pino logger (or compatible)
 * @param context  short string identifying the cleanup site, e.g.
 *                 `'deleteLiveSession during dispatch error path'`
 * @param extra    optional structured fields merged into the warn record
 */
export function bestEffort(
  promise: Promise<unknown>,
  log: Pick<Logger, 'warn'>,
  context: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  return promise.then(
    () => undefined,
    (err: unknown) => {
      log.warn({ ...extra, err: formatError(err) }, `best-effort cleanup failed: ${context}`);
    },
  );
}
