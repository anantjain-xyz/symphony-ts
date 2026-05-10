import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export type Db = ReturnType<typeof createDb>;

export interface CreateDbOptions {
  /** postgres-js connection pool size. Worker uses ~10; dashboard ~5. */
  max?: number;
}

/**
 * Create a Drizzle client with a postgres-js pool. Each call creates a new
 * pool — callers should treat the returned client as a singleton for their
 * process and never instantiate it per-request. Call `db.close()` on shutdown
 * (e.g. seed scripts) to drain the pool so the process exits promptly.
 */
export function createDb(url: string, opts: CreateDbOptions = {}) {
  const sql = postgres(url, {
    max: opts.max ?? 10,
    onnotice: () => {},
    prepare: true,
  });
  const db = drizzle(sql, { schema });
  return Object.assign(db, {
    close: (closeOpts?: { timeout?: number }) => sql.end(closeOpts),
  });
}

/**
 * Dedicated postgres-js client used to hold a long-lived `LISTEN` connection.
 * Separate from the query pool because LISTEN occupies the connection for the
 * lifetime of the subscription. `prepare: false` is required for postgres-js's
 * `sql.listen()`.
 */
export function createListener(url: string) {
  return postgres(url, {
    max: 1,
    prepare: false,
    onnotice: () => {},
  });
}
